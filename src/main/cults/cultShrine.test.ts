/**
 * Publishing a run's Shrine (DM-632 c1, c3): every unsafe candidate refused (outside the work dir, `..`, a symlink out
 * of it, another type, over 10 MiB); a publish and each change of the published file bump the revision and are told as a
 * run change; the watch is debounced, scoped to that one file, and stops when the run ends, is published over or the
 * service is disposed. Over the real cult store and real files; the watcher and clock are fakes the test drives, except
 * in the last test, which edits the file under the real `fs.watch`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../../core/db/database'
import { DomainError } from '../../core/errors'
import type { CultMemberView, CultRunView } from '../../shared/cults/cult'
import { SHRINE_MAX_BYTES } from '../../shared/cults/shrine'
import { openAppDatabase } from '../desktop/appDatabase'
import { eventually, FakeClock } from '../terminals/__mocks__/terminalSessionsRig'
import { createCultShrines, type CultShrines, readShrine, resolveShrine } from './cultShrine'
import { createCultStore, type CultStore } from './cultStore'
import type { CultRunSnapshot } from './cultSupervisor'

interface FakeWatcher {
  dir: string
  closed: boolean
  fire(filename: string | null): void
}

interface Fixture {
  root: string
  work: string
  outside: string
  db: Db
  store: CultStore
  run: CultRunView
  clock: FakeClock
  watchers: FakeWatcher[]
  changed: string[]
  listeners: Set<(snapshot: CultRunSnapshot) => void>
  shrines: CultShrines
}

let f: Fixture

const MAGOS = { displayName: 'Magos Vettius' } as CultMemberView

function fixture(): Fixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-shrine-')))
  const work = join(root, 'work')
  const outside = join(root, 'outside')
  mkdirSync(work)
  mkdirSync(outside)
  const db = openAppDatabase(mkdtempSync(join(root, 'app-')))
  const store = createCultStore({ db })
  const cult = store.createCult({ name: 'Gerry the plant', charter: 'Grow.', scope: 'sanctum', folderPath: null, archetype: 'general', magosName: 'Magos Vettius', magosModelId: null, defaultTimeLimitMs: null })
  const run = store.startRun(cult.id, { workDir: work })
  const clock = new FakeClock()
  const watchers: FakeWatcher[] = []
  const changed: string[] = []
  const listeners = new Set<(snapshot: CultRunSnapshot) => void>()
  const shrines = createCultShrines({
    cults: store,
    supervisor: {
      on: (_event, listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      changed: (runId) => void changed.push(runId)
    },
    clock,
    watch: (dir, onChange) => {
      const watcher: FakeWatcher = { dir, closed: false, fire: (name) => { if (!watcher.closed) onChange(name) } }
      watchers.push(watcher)
      return { close: () => void (watcher.closed = true) }
    }
  })
  return { root, work, outside, db, store, run, clock, watchers, changed, listeners, shrines }
}

beforeEach(() => {
  f = fixture()
})

afterEach(() => {
  f.shrines.dispose()
  f.db.close()
  rmSync(f.root, { recursive: true, force: true })
})

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const write = (path: string, content: string | Buffer = PNG): string => {
  writeFileSync(path, content)
  return path
}
const run = (): CultRunView => f.store.getRun(f.run.id)!

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    return error instanceof DomainError ? error.code : `raw:${String(error)}`
  }
  return 'accepted'
}

/** A real change of the file: new content, so its size and modified time differ. */
function edit(path: string, content: string): void {
  writeFileSync(path, content)
}

describe('publish_shrine refusals (c1)', () => {
  it('refuses a file outside the work dir, by absolute path and by ..', async () => {
    write(join(f.outside, 'secret.png'))
    expect(await codeOf(f.shrines.publish(run(), MAGOS, join(f.outside, 'secret.png')))).toBe('shrine_refused')
    expect(await codeOf(f.shrines.publish(run(), MAGOS, '../outside/secret.png'))).toBe('shrine_refused')
    expect(await codeOf(f.shrines.publish(run(), MAGOS, f.work))).toBe('shrine_refused')
    expect(f.watchers).toHaveLength(0)
    expect(run().shrinePath).toBeNull()
  })

  it('refuses a symlink escape: a linked folder inside the work dir that leads out of it', async () => {
    write(join(f.outside, 'secret.png'))
    // A junction needs no privilege on Windows; elsewhere the type is ignored and it is a directory symlink.
    symlinkSync(f.outside, join(f.work, 'door'), 'junction')
    expect(await codeOf(f.shrines.publish(run(), MAGOS, 'door/secret.png'))).toBe('shrine_refused')
    expect(run().shrinePath).toBeNull()
  })

  it.runIf(process.platform !== 'win32')('refuses a file symlink out of the work dir and accepts one that stays inside, as its real path', async () => {
    write(join(f.outside, 'secret.html'), '<p>secret</p>')
    symlinkSync(join(f.outside, 'secret.html'), join(f.work, 'escape.html'))
    expect(await codeOf(f.shrines.publish(run(), MAGOS, 'escape.html'))).toBe('shrine_refused')
    const real = write(join(f.work, 'real.png'))
    symlinkSync(real, join(f.work, 'alias.png'))
    expect(await f.shrines.publish(run(), MAGOS, 'alias.png')).toEqual({ shrinePath: real, kind: 'image', revision: '1' })
  })

  it('refuses every other type, a folder and a missing file; accepts png, jpg, jpeg, svg and html in any case', async () => {
    for (const name of ['notes.txt', 'page.htm', 'tool.exe', 'shrine', 'image.png.txt', 'x.svgz']) {
      write(join(f.work, name))
      expect(await codeOf(f.shrines.publish(run(), MAGOS, name)), name).toBe('shrine_refused')
    }
    mkdirSync(join(f.work, 'folder.html'))
    expect(await codeOf(f.shrines.publish(run(), MAGOS, 'folder.html'))).toBe('shrine_refused')
    expect(await codeOf(f.shrines.publish(run(), MAGOS, 'missing.png'))).toBe('shrine_refused')
    for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.svg', 'e.html', 'F.PNG']) {
      write(join(f.work, name))
      expect(await codeOf(f.shrines.publish(run(), MAGOS, name)), name).toBe('accepted')
    }
  })

  it('refuses a file over 10 MiB and accepts one of exactly 10 MiB', async () => {
    const big = write(join(f.work, 'big.png'))
    truncateSync(big, SHRINE_MAX_BYTES + 1)
    expect(await codeOf(f.shrines.publish(run(), MAGOS, 'big.png'))).toBe('shrine_refused')
    truncateSync(big, SHRINE_MAX_BYTES)
    expect(await codeOf(f.shrines.publish(run(), MAGOS, 'big.png'))).toBe('accepted')
  })

  it('refuses a paused or ended run', async () => {
    write(join(f.work, 'a.png'))
    expect(await codeOf(f.shrines.publish({ ...run(), state: 'paused' }, MAGOS, 'a.png'))).toBe('run_paused')
    expect(await codeOf(f.shrines.publish({ ...run(), state: 'ended' }, MAGOS, 'a.png'))).toBe('run_ending')
  })
})

describe('the published Shrine, live (c3)', () => {
  it('records the real path, its kind, the publisher and a new revision on every publish', async () => {
    const html = write(join(f.work, 'index.html'), '<h1>Gerry</h1>')
    expect(await f.shrines.publish(run(), MAGOS, 'index.html')).toEqual({ shrinePath: html, kind: 'html', revision: '1' })
    expect(run()).toMatchObject({ shrinePath: html, shrineRevision: '1' })
    expect(await f.shrines.publish(run(), { displayName: 'Acolyte Brass' } as CultMemberView, 'index.html')).toMatchObject({ revision: '2' })
    expect(f.store.latestShrineEvent(f.run.id)).toMatchObject({ memberName: 'Acolyte Brass' })
    expect(f.store.pageEvents(f.run.id).events.filter((event) => event.kind === 'shrine_published')).toHaveLength(2)
  })

  it('bumps the revision once per settled edit of the published file and tells the run changed', async () => {
    const path = write(join(f.work, 'index.html'), '<h1>v1</h1>')
    await f.shrines.publish(run(), MAGOS, 'index.html')
    const [watcher] = f.watchers
    expect(watcher).toMatchObject({ dir: f.work, closed: false })

    edit(path, '<h1>version two</h1>')
    watcher!.fire('index.html')
    f.clock.advance(100)
    watcher!.fire('index.html')
    f.clock.advance(299)
    expect(run().shrineRevision).toBe('1')
    f.clock.advance(1)
    await f.shrines.settled()
    expect(run().shrineRevision).toBe('2')
    expect(f.changed).toEqual([f.run.id])
    expect(f.store.latestShrineEvent(f.run.id)).toMatchObject({ memberName: 'Magos Vettius' })

    // Another file of the folder arms nothing; an event that leaves the file as it was tells nothing.
    watcher!.fire('other.html')
    expect(f.clock.pending).toBe(0)
    watcher!.fire('index.html')
    f.clock.advance(1_000)
    await f.shrines.settled()
    expect(run().shrineRevision).toBe('2')
    expect(f.changed).toHaveLength(1)
  })

  it('watches only the latest published file: a republish closes the earlier watch', async () => {
    write(join(f.work, 'a.png'))
    write(join(f.work, 'b.png'))
    await f.shrines.publish(run(), MAGOS, 'a.png')
    await f.shrines.publish(run(), MAGOS, 'b.png')
    expect(f.watchers.map((watcher) => watcher.closed)).toEqual([true, false])
  })

  it('stops the watch when the run ends: a later edit changes nothing', async () => {
    const path = write(join(f.work, 'index.html'), '<h1>v1</h1>')
    await f.shrines.publish(run(), MAGOS, 'index.html')
    expect(f.shrines.watching(f.run.id)).toBe(true)
    for (const listener of f.listeners) listener({ run: { ...run(), state: 'running' }, members: [], petitions: [] })
    expect(f.shrines.watching(f.run.id)).toBe(true)
    for (const listener of f.listeners) listener({ run: { ...run(), state: 'ended' }, members: [], petitions: [] })
    expect(f.shrines.watching(f.run.id)).toBe(false)
    expect(f.watchers[0]!.closed).toBe(true)
    edit(path, '<h1>after the end</h1>')
    f.watchers[0]!.fire('index.html')
    f.clock.advance(1_000)
    expect(f.clock.pending).toBe(0)
    expect(run().shrineRevision).toBe('1')
  })

  it('stops every watch and hears no more run changes once disposed', async () => {
    write(join(f.work, 'a.png'))
    await f.shrines.publish(run(), MAGOS, 'a.png')
    f.shrines.dispose()
    expect(f.watchers[0]!.closed).toBe(true)
    expect(f.listeners.size).toBe(0)
  })
})

describe('reading the recorded Shrine', () => {
  it('reads the bytes again under the same checks, and refuses a file grown past 10 MiB or replaced by a link', async () => {
    const path = write(join(f.work, 'a.png'))
    expect(await readShrine(f.work, path)).toEqual({ bytes: new Uint8Array(PNG), extension: 'png' })
    truncateSync(path, SHRINE_MAX_BYTES + 1)
    expect(await codeOf(readShrine(f.work, path))).toBe('shrine_refused')
    expect(await codeOf(readShrine(f.work, join(f.outside, 'a.png')))).toBe('shrine_refused')
    expect(await codeOf(resolveShrine(f.work, join(f.work, '..', 'outside')))).toBe('shrine_refused')
  })

  it.runIf(process.platform !== 'win32')('refuses a recorded path that has since become a symlink', async () => {
    const path = write(join(f.work, 'a.png'))
    const inside = write(join(f.work, 'b.png'))
    rmSync(path)
    symlinkSync(inside, path)
    expect(await codeOf(readShrine(f.work, path))).toBe('shrine_refused')
  })
})

describe('the real file watch', () => {
  it('bumps the revision when the published file is edited on disk, and closes its watcher on dispose', async () => {
    const work = f.work
    const store = f.store
    const changed: string[] = []
    const shrines = createCultShrines({ cults: store, supervisor: { on: () => () => {}, changed: (runId) => void changed.push(runId) } })
    try {
      const path = write(join(work, 'live.html'), '<p>one</p>')
      await shrines.publish(run(), MAGOS, 'live.html')
      edit(path, '<p>two, longer</p>')
      await eventually(() => run().shrineRevision === '2', 'the real watch to bump the revision')
      expect(changed).toEqual([f.run.id])
    } finally {
      shrines.dispose()
    }
    expect(shrines.watching(f.run.id)).toBe(false)
  })
})
