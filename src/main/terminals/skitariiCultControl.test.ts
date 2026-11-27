import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  attachCultControl,
  CULT_CONTROL_POLL_MS,
  CULT_CONTROL_TYPE,
  CultControlWatcher,
  parseCultControl,
  type CultControlApi,
  type CultControlContext
} from '../../../resources/skitarii/extension/cultControl'
import { DM_CLIENT_DESCRIPTOR_ENV } from '../../../resources/skitarii/extension/dmClient'
import type { Timers } from '../../../resources/skitarii/extension/skitarii'
import { createCultControl, cultControlPath } from '../cults/cultControl'

const CHAT = 'chat-1'
const P = '[Dark Mechanicus desktop] The person '

function fakeTimers(): Timers & { live: Map<number, number> } {
  const live = new Map<number, number>()
  let next = 1
  return {
    live,
    setInterval: (_callback, ms) => {
      const id = next++
      live.set(id, ms)
      return id
    },
    clearInterval: (handle) => {
      live.delete(handle as number)
    }
  }
}

/** The launch generation that names the client descriptor (`.../dm-client/<generation>.json`). */
const EPOCH = 'launch-1'

const doc = (actions: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, chatId: CHAT, epoch: EPOCH, actions, ...extra })

function harness(files: string[] | (() => Promise<string>)) {
  const calls: string[] = []
  const sent: [string, boolean][] = []
  const readFile = Array.isArray(files)
    ? vi.fn(async () => {
        const next = files.shift()
        if (next === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return next
      })
    : vi.fn(files)
  const timers = fakeTimers()
  const watcher = new CultControlWatcher({
    readFile,
    timers,
    path: '/x/cult-control.json',
    chatId: CHAT,
    epoch: EPOCH,
    abort: () => calls.push('abort'),
    shutdown: () => calls.push('shutdown'),
    send: (content, trigger) => {
      calls.push('send')
      sent.push([content, trigger])
    }
  })
  return { watcher, calls, sent, timers }
}

describe('parseCultControl', () => {
  it('accepts a valid file', () => {
    const entries = parseCultControl(
      doc([
        { seq: 1, action: 'interrupt' },
        { seq: 3, action: 'petition', petition: { kind: 'folder_access', approved: true, folder: '/a', tokenFile: '/t' } }
      ]),
      CHAT,
      EPOCH
    )
    expect(entries).toEqual([
      { seq: 1, action: 'interrupt' },
      { seq: 3, action: 'petition', petition: { kind: 'folder_access', approved: true, folder: '/a', tokenFile: '/t' } }
    ])
  })

  const bad: [string, string][] = [
    ['wrong version', JSON.stringify({ version: 2, chatId: CHAT, actions: [] })],
    ['chat mismatch', doc([], { chatId: 'other' })],
    ['unknown action', doc([{ seq: 1, action: 'explode' }])],
    ['petition missing', doc([{ seq: 1, action: 'petition' }])],
    ['petition on other', doc([{ seq: 1, action: 'resume', petition: { kind: 'allow_save', approved: true } }])],
    ['fractional seq', doc([{ seq: 1.5, action: 'resume' }])],
    ['zero seq', doc([{ seq: 0, action: 'resume' }])],
    ['granted 0', doc([{ seq: 1, action: 'petition', petition: { kind: 'acolytes', approved: true, granted: 0 } }])],
    ['granted 25', doc([{ seq: 1, action: 'petition', petition: { kind: 'acolytes', approved: true, granted: 25 } }])],
    ['granted fractional', doc([{ seq: 1, action: 'petition', petition: { kind: 'acolytes', approved: true, granted: 2.5 } }])],
    ['relative folder', doc([{ seq: 1, action: 'petition', petition: { kind: 'folder_access', approved: true, folder: 'a' } }])],
    ['long path', doc([{ seq: 1, action: 'petition', petition: { kind: 'folder_access', approved: true, tokenFile: '/' + 'a'.repeat(4096) } }])],
    ['unknown key', doc([{ seq: 1, action: 'resume', note: 'hi' }])],
    ['unknown top key', doc([], { note: 'hi' })],
    ['unknown petition key', doc([{ seq: 1, action: 'petition', petition: { kind: 'allow_save', approved: true, why: 'x' } }])],
    ['unknown kind', doc([{ seq: 1, action: 'petition', petition: { kind: 'other', approved: true } }])],
    ['too many', doc(Array.from({ length: 33 }, (_, i) => ({ seq: i + 1, action: 'resume' })))],
    ['not increasing', doc([{ seq: 2, action: 'resume' }, { seq: 2, action: 'resume' }])],
    ['endpoint id', doc([], { endpointId: 'me_x' })],
    ['another launch', doc([{ seq: 1, action: 'resume' }], { epoch: 'launch-0' })],
    ['no launch', JSON.stringify({ version: 1, chatId: CHAT, actions: [] })],
    ['too large', doc([{ seq: 1, action: 'resume', pad: 'x'.repeat(70_000) }])],
    ['a list file', JSON.stringify([])],
    ['a null entry', doc([null])],
    ['a list petition', doc([{ seq: 1, action: 'petition', petition: [] }])],
    ['approved as text', doc([{ seq: 1, action: 'petition', petition: { kind: 'allow_save', approved: 'yes' } }])]
  ]
  it.each(bad)('rejects %s', (_name, text) => {
    expect(() => parseCultControl(text, CHAT, EPOCH)).toThrow()
  })
})

describe('parseCultControl refusals', () => {
  it('names why a file is refused', () => {
    expect(() => parseCultControl(JSON.stringify(null), CHAT, EPOCH)).toThrow('invalid cult control: file is not an object')
    expect(() => parseCultControl(doc(['resume']), CHAT, EPOCH)).toThrow('invalid cult control: entry is not an object')
    expect(() => parseCultControl(doc([{ seq: 1, action: 'petition', petition: { kind: 'acolytes', approved: 1 } }]), CHAT, EPOCH))
      .toThrow('invalid cult control: petition approved is not a boolean')
  })
})

describe('CultControlWatcher actions', () => {
  it('interrupt aborts then sends the paused notice without a turn', async () => {
    const h = harness([doc([{ seq: 1, action: 'interrupt' }])])
    await h.watcher.tick()
    expect(h.calls).toEqual(['abort', 'send'])
    expect(h.sent).toEqual([[`${P}paused this cult. Stop and wait; you will be told when it resumes.`, false]])
  })

  it('applies resume, wind_down and petitions with exact text', async () => {
    const h = harness([
      doc([
        { seq: 1, action: 'resume' },
        { seq: 2, action: 'wind_down' },
        { seq: 3, action: 'conclude' },
        { seq: 4, action: 'petition', petition: { kind: 'acolytes', approved: true, granted: 4 } },
        { seq: 5, action: 'petition', petition: { kind: 'allow_save', approved: true } },
        { seq: 6, action: 'petition', petition: { kind: 'folder_access', approved: true, folder: '/r "x"', tokenFile: '/t' } },
        { seq: 7, action: 'petition', petition: { kind: 'folder_access', approved: false } }
      ])
    ])
    await h.watcher.tick()
    expect(h.sent).toEqual([
      [`${P}resumed this cult. Continue your current task.`, true],
      ['[Dark Mechanicus desktop] This cult run is ending. Order every acolyte to conclude now, then write the chronicle and conclude the run within the times your cult rules give.', true],
      ['[Dark Mechanicus desktop] This cult run is ending. Finish now, send your final report and conclude within the time your cult rules give.', true],
      [`${P}approved your petition: the cap rose by 4 acolytes.`, true],
      [`${P}approved your petition to save: Allow save is on for this run.`, true],
      [`${P}approved your petition for folder access: run dm --repo "/r \\"x\\"" --token-file "/t" <command> to act in that folder for this run.`, true],
      [`${P}denied your petition (folder_access).`, true]
    ])
  })

  it('shutdown interrupts the turn, closes the session and stops polling', async () => {
    const h = harness([doc([{ seq: 1, action: 'shutdown' }])])
    h.watcher.start()
    expect([...h.timers.live.values()]).toEqual([CULT_CONTROL_POLL_MS])
    await h.watcher.tick()
    expect(h.calls).toEqual(['abort', 'shutdown'])
    expect(h.timers.live.size).toBe(0)
  })
})

describe('CultControlWatcher edge cases', () => {
  it('says an approval without its grant or folder plainly, rather than inventing one', async () => {
    const h = harness([
      doc([
        { seq: 1, action: 'petition', petition: { kind: 'acolytes', approved: true } },
        { seq: 2, action: 'petition', petition: { kind: 'folder_access', approved: true } }
      ])
    ])
    await h.watcher.tick()
    expect(h.sent).toEqual([
      [`${P}approved your petition: the cap rose by 0 acolytes.`, true],
      [`${P}approved your petition for folder access: run dm --repo "" --token-file "" <command> to act in that folder for this run.`, true]
    ])
  })

  it('polls on one timer however often it is started', () => {
    const h = harness([])
    h.watcher.start()
    h.watcher.start()
    expect(h.timers.live.size).toBe(1)
    h.watcher.stop()
    expect(h.timers.live.size).toBe(0)
  })
})

describe('CultControlWatcher polling', () => {
  it('applies only new seqs across ticks, in order', async () => {
    const h = harness([
      doc([{ seq: 1, action: 'resume' }]),
      doc([{ seq: 1, action: 'resume' }, { seq: 2, action: 'interrupt' }, { seq: 3, action: 'resume' }])
    ])
    await h.watcher.tick()
    await h.watcher.tick()
    expect(h.calls).toEqual(['send', 'abort', 'send', 'send'])
    expect(h.sent.map(([, t]) => t)).toEqual([true, false, true])
  })

  it('ignores ENOENT, chat mismatch, another launch and reads with unknown keys', async () => {
    const h = harness([
      doc([{ seq: 1, action: 'resume' }], { chatId: 'other' }),
      doc([{ seq: 1, action: 'shutdown' }], { epoch: 'launch-0' }),
      doc([{ seq: 1, action: 'resume' }, { seq: 2, action: 'resume', text: 'evil' }])
    ])
    await h.watcher.tick()
    await h.watcher.tick()
    await h.watcher.tick()
    await h.watcher.tick()
    expect(h.calls).toEqual([])
  })

  it('skips a tick while one is running', async () => {
    // `Promise.withResolvers` is outside this project's ES2022 lib.
    let release: (text: string) => void = () => {}
    const promise = new Promise<string>((resolve) => {
      release = resolve
    })
    const h = harness(() => promise)
    const first = h.watcher.tick()
    await h.watcher.tick()
    release(doc([{ seq: 1, action: 'resume' }]))
    await first
    expect(h.sent).toHaveLength(1)
  })
})

describe('attachCultControl', () => {
  function api() {
    const handlers = new Map<string, ((event: unknown, ctx: CultControlContext) => unknown)[]>()
    const pi: CultControlApi & { emit: (event: string, ctx: CultControlContext) => void } = {
      on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      sendMessage: vi.fn(async () => {}),
      emit: (event, ctx) => handlers.get(event)?.forEach((h) => h(undefined, ctx))
    }
    return pi
  }
  const env = { [DM_CLIENT_DESCRIPTOR_ENV]: `/u/agents/omp/chat-1/dm-client/${EPOCH}.json` }

  it('starts only for the main agent and stops on shutdown', () => {
    const pi = api()
    const timers = fakeTimers()
    attachCultControl(pi, timers, env)
    pi.emit('session_start', { agent: { kind: 'sub' } })
    pi.emit('session_start', {})
    expect(timers.live.size).toBe(0)
    pi.emit('session_start', { agent: { kind: 'main' } })
    expect(timers.live.size).toBe(1)
    pi.emit('session_shutdown', {})
    expect(timers.live.size).toBe(0)
  })

  it('does nothing without an absolute descriptor path', () => {
    const pi = api()
    const timers = fakeTimers()
    attachCultControl(pi, timers, { [DM_CLIENT_DESCRIPTOR_ENV]: 'rel/3.json' })
    pi.emit('session_start', { agent: { kind: 'main' } })
    expect(timers.live.size).toBe(0)
    expect(CULT_CONTROL_TYPE).toBe('dm-cult-control')
  })
})

/** Main's real writer on a scratch userData, and a member watcher of one launch reading the file it writes. */
function member(userData: string, epoch: string, cursor = { lastApplied: 0 }) {
  const calls: string[] = []
  const watcher = new CultControlWatcher({
    readFile: (file) => readFile(file, 'utf8'), timers: fakeTimers(), path: cultControlPath(userData, CHAT), chatId: CHAT, epoch, cursor,
    abort: () => calls.push('abort'), shutdown: () => calls.push('shutdown'), send: (content) => calls.push(content)
  })
  return { watcher, calls }
}

function scratch<T>(test: (userData: string) => Promise<T>): Promise<T> {
  const userData = mkdtempSync(join(tmpdir(), 'dm-cult-control-'))
  return test(userData).finally(() => rmSync(userData, { recursive: true, force: true }))
}

describe('cult control across member restarts', () => {
  it('a restarted member does not re-apply the actions an earlier launch was told', () =>
    scratch(async (userData) => {
      let launch: string | null = 'launch-1'
      const control = createCultControl({ userData, epochOf: () => launch })
      await control.send(CHAT, { action: 'interrupt' })
      await control.send(CHAT, { action: 'shutdown' })
      const first = member(userData, 'launch-1')
      await first.watcher.tick()
      expect(first.calls).toEqual(['abort', `${P}paused this cult. Stop and wait; you will be told when it resumes.`, 'abort', 'shutdown'])

      // The member starts again: a new process of a new launch, the earlier launch's file still on disk.
      launch = 'launch-2'
      const second = member(userData, 'launch-2')
      await second.watcher.tick()
      expect(second.calls).toEqual([])

      // Main's first action for the new launch starts the list afresh, and is applied once.
      await control.send(CHAT, { action: 'resume' })
      expect(JSON.parse(await readFile(cultControlPath(userData, CHAT), 'utf8'))).toEqual({
        version: 1, chatId: CHAT, epoch: 'launch-2', actions: [{ seq: 3, action: 'resume' }]
      })
      await second.watcher.tick()
      await second.watcher.tick()
      expect(second.calls).toEqual([`${P}resumed this cult. Continue your current task.`])
    }))

  it('drops an action while no launch of the member runs', () =>
    scratch(async (userData) => {
      const control = createCultControl({ userData, epochOf: () => null })
      await control.send(CHAT, { action: 'interrupt' })
      await expect(readFile(cultControlPath(userData, CHAT), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }))

  it('a session restarted within one launch keeps the launch\'s applied seq', () =>
    scratch(async (userData) => {
      const control = createCultControl({ userData, epochOf: () => EPOCH })
      await control.send(CHAT, { action: 'resume' })
      const cursor = { lastApplied: 0 }
      const before = member(userData, EPOCH, cursor)
      await before.watcher.tick()
      const after = member(userData, EPOCH, cursor)
      await after.watcher.tick()
      expect([before.calls.length, after.calls.length]).toEqual([1, 0])
    }))
})

describe('cult control of a launch', () => {
  it('attaches the watcher for the launch its descriptor names', () =>
    scratch(async (userData) => {
      await createCultControl({ userData, epochOf: () => 'launch-7' }).send(CHAT, { action: 'resume' })
      const handlers = new Map<string, (event: unknown, ctx: CultControlContext) => unknown>()
      const sendMessage = vi.fn(async () => {})
      const ticks: (() => void)[] = []
      const timers: Timers = { setInterval: (callback) => ticks.push(callback), clearInterval: () => {} }
      const descriptor = join(dirname(cultControlPath(userData, CHAT)), 'dm-client', 'launch-7.json')
      attachCultControl({ on: (event, handler) => handlers.set(event, handler), sendMessage }, timers, { [DM_CLIENT_DESCRIPTOR_ENV]: descriptor })
      handlers.get('session_start')?.(undefined, { agent: { kind: 'main' } })
      ticks[0]?.()
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    }))
})
