/**
 * The Shrine at its file-system boundaries, where the real disk cannot be made to misbehave on cue: a file that grows
 * past 10 MiB between the publish-time check and the open, a platform without `O_NOFOLLOW` (Windows), and the real
 * `fs.watch` listener (an event without a filename, one for another file, one for the Shrine, and a watcher error).
 * `node:fs` and `node:fs/promises` are the real modules with only those seams wrapped.
 */
import type { EventEmitter } from 'node:events'
import { constants, mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../../core/db/database'
import { DomainError } from '../../core/errors'
import type { CultMemberView, CultRunView } from '../../shared/cults/cult'
import { SHRINE_MAX_BYTES } from '../../shared/cults/shrine'
import { openAppDatabase } from '../desktop/appDatabase'
import { FakeClock } from '../terminals/__mocks__/terminalSessionsRig'
import { createCultShrines, readShrine } from './cultShrine'
import { createCultStore, type CultStore } from './cultStore'

type Listener = (event: string, filename: string | Buffer | null) => void

interface WatchSeam {
  dir: string
  listener: Listener
  emitter: EventEmitter
  closed: boolean
}

const seams = vi.hoisted(() => ({ beforeOpen: undefined as ((path: string) => void) | undefined, watchers: [] as WatchSeam[] }))

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof NodeFs>()
  // The factory is hoisted above every static import, so it loads the event emitter itself.
  const { EventEmitter: Emitter } = await import('node:events')
  return {
    ...fs,
    // A copy, so a test can take O_NOFOLLOW away as on Windows.
    constants: { ...fs.constants },
    watch: (dir: string, _options: unknown, listener: Listener) => {
      const entry: WatchSeam = { dir, listener, emitter: new Emitter(), closed: false }
      seams.watchers.push(entry)
      return Object.assign(entry.emitter, { close: () => void (entry.closed = true) })
    }
  }
})

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof NodeFsPromises>()
  return {
    ...fs,
    open: (path: string, flags: number) => {
      seams.beforeOpen?.(path)
      return fs.open(path, flags)
    }
  }
})

interface Fixture {
  root: string
  work: string
  db: Db
  store: CultStore
  run: CultRunView
}

let f: Fixture
const MAGOS = { displayName: 'Magos Vettius' } as CultMemberView
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
/** The mocked module's own copy of the constants, which the module under test reads. */
const flags: { O_NOFOLLOW?: number } = constants
const noFollow = constants.O_NOFOLLOW

beforeEach(() => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-shrine-fs-')))
  const work = join(root, 'work')
  mkdirSync(work)
  const db = openAppDatabase(mkdtempSync(join(root, 'app-')))
  const store = createCultStore({ db })
  const cult = store.createCult({ name: 'Gerry the plant', charter: 'Grow.', scope: 'sanctum', folderPath: null, archetype: 'general', magosName: 'Magos Vettius', magosModelId: null, defaultTimeLimitMs: null })
  f = { root, work, db, store, run: store.startRun(cult.id, { workDir: work }) }
})

afterEach(() => {
  seams.beforeOpen = undefined
  seams.watchers.length = 0
  flags.O_NOFOLLOW = noFollow
  f.db.close()
  rmSync(f.root, { recursive: true, force: true })
})

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    return error instanceof DomainError ? `${error.code}: ${error.message}` : `raw:${String(error)}`
  }
  return 'accepted'
}

describe('reading the recorded Shrine at the open', () => {
  it('refuses a file that grew past 10 MiB after it was checked and before it was opened', async () => {
    const path = join(f.work, 'a.png')
    writeFileSync(path, PNG)
    seams.beforeOpen = (opened) => truncateSync(opened, SHRINE_MAX_BYTES + 1)
    expect(await codeOf(readShrine(f.work, path))).toBe('shrine_refused: The Shrine file changed while it was read.')
  })

  it('reads the file where the platform has no O_NOFOLLOW', async () => {
    const path = join(f.work, 'a.png')
    writeFileSync(path, PNG)
    delete flags.O_NOFOLLOW
    expect(await readShrine(f.work, path)).toEqual({ bytes: new Uint8Array(PNG), extension: 'png' })
  })
})

describe('the real fs.watch listener', () => {
  it('checks the Shrine for an event without a filename or naming it, ignores another file, and reports a watcher error', async () => {
    const clock = new FakeClock()
    const errors: unknown[] = []
    const changed: string[] = []
    const shrines = createCultShrines({ cults: f.store, clock, onError: (error) => errors.push(error), supervisor: { on: () => () => {}, changed: (runId) => void changed.push(runId) } })
    try {
      const path = join(f.work, 'index.html')
      writeFileSync(path, '<h1>v1</h1>')
      await shrines.publish(f.store.getRun(f.run.id)!, MAGOS, 'index.html')
      clock.advance(0)
      await shrines.settled()
      const [watcher] = seams.watchers
      expect(watcher?.dir).toBe(f.work)

      watcher!.listener('rename', 'other.html')
      expect(clock.pending).toBe(1)
      writeFileSync(path, '<h1>version two</h1>')
      watcher!.listener('change', null)
      clock.advance(300)
      await shrines.settled()
      expect(f.store.getRun(f.run.id)?.shrineRevision).toBe('2')

      writeFileSync(path, '<h1>version three, longer</h1>')
      watcher!.listener('change', Buffer.from('index.html'))
      clock.advance(300)
      await shrines.settled()
      expect(f.store.getRun(f.run.id)?.shrineRevision).toBe('3')
      expect(changed).toEqual([f.run.id, f.run.id])

      const failure = new Error('EMFILE')
      watcher!.emitter.emit('error', failure)
      expect(errors).toEqual([failure])
    } finally {
      shrines.dispose()
    }
    expect(seams.watchers[0]?.closed).toBe(true)
    expect(clock.pending).toBe(0)
  })
})
