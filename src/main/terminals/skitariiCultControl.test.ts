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

const doc = (actions: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, chatId: CHAT, endpointId: null, actions, ...extra })

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
      CHAT
    )
    expect(entries).toEqual([
      { seq: 1, action: 'interrupt' },
      { seq: 3, action: 'petition', petition: { kind: 'folder_access', approved: true, folder: '/a', tokenFile: '/t' } }
    ])
  })

  const bad: [string, string][] = [
    ['wrong version', JSON.stringify({ version: 2, chatId: CHAT, endpointId: null, actions: [] })],
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
    ['too large', doc([], { endpointId: 'x'.repeat(70_000) })]
  ]
  it.each(bad)('rejects %s', (_name, text) => {
    expect(() => parseCultControl(text, CHAT)).toThrow()
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
        { seq: 3, action: 'petition', petition: { kind: 'acolytes', approved: true, granted: 4 } },
        { seq: 4, action: 'petition', petition: { kind: 'allow_save', approved: true } },
        { seq: 5, action: 'petition', petition: { kind: 'folder_access', approved: true, folder: '/r "x"', tokenFile: '/t' } },
        { seq: 6, action: 'petition', petition: { kind: 'folder_access', approved: false } }
      ])
    ])
    await h.watcher.tick()
    expect(h.sent).toEqual([
      [`${P}resumed this cult. Continue your current task.`, true],
      ['[Dark Mechanicus desktop] This cult run is ending. Order every acolyte to conclude now, then write the chronicle and conclude the run within the times your cult rules give.', true],
      [`${P}approved your petition: the cap rose by 4 acolytes.`, true],
      [`${P}approved your petition to save: Allow save is on for this run.`, true],
      [`${P}approved your petition for folder access: run dm --repo "/r \\"x\\"" --token-file "/t" <command> to act in that folder for this run.`, true],
      [`${P}denied your petition (folder_access).`, true]
    ])
  })

  it('shutdown calls shutdown and stops polling', async () => {
    const h = harness([doc([{ seq: 1, action: 'shutdown' }])])
    h.watcher.start()
    expect([...h.timers.live.values()]).toEqual([CULT_CONTROL_POLL_MS])
    await h.watcher.tick()
    expect(h.calls).toEqual(['shutdown'])
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

  it('ignores ENOENT, chat mismatch and reads with unknown keys', async () => {
    const h = harness([
      doc([{ seq: 1, action: 'resume' }], { chatId: 'other' }),
      doc([{ seq: 1, action: 'resume' }, { seq: 2, action: 'resume', text: 'evil' }])
    ])
    await h.watcher.tick()
    await h.watcher.tick()
    await h.watcher.tick()
    expect(h.calls).toEqual([])
  })

  it('skips a tick while one is running', async () => {
    const { promise, resolve: release } = Promise.withResolvers<string>()
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
  const env = { [DM_CLIENT_DESCRIPTOR_ENV]: '/u/agents/omp/chat-1/dm-client/3.json' }

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
