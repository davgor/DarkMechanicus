/**
 * The member's cult status writer (`resources/skitarii/extension/cultStatus.ts`) on a scratch userData, read back by
 * main's real activity tracker (`src/main/cults/memberActivity.ts`) on a fake clock.
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachCultStatus,
  CULT_STATUS_FILE,
  cultStatusWriter,
  type CultStatusApi,
  type CultStatusContext
} from '../../../resources/skitarii/extension/cultStatus'
import { DM_CLIENT_DESCRIPTOR_ENV } from '../../../resources/skitarii/extension/dmClient'
import { ACTIVITY_THROTTLE_MS, createMemberActivity } from '../cults/memberActivity'
import { FakeClock } from './__mocks__/terminalSessionsRig'
import { ompFilePaths } from './ompSession'

const CHAT = 'chat_member'
const MAIN: CultStatusContext = { agent: { kind: 'main' } }
const TOOL_EVENT = { toolName: 'bash', toolCallId: 't1', args: { command: 'cat /secret/peer-body.txt' } }

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'dm-cult-status-'))
  mkdirSync(dirname(ompFilePaths(userData, CHAT).config), { recursive: true })
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

const chatDir = (): string => dirname(ompFilePaths(userData, CHAT).config)
const statusPath = (): string => join(chatDir(), CULT_STATUS_FILE)
const env = (): Record<string, string> => ({ [DM_CLIENT_DESCRIPTOR_ENV]: join(chatDir(), 'dm-client', 'launch-1.json') })

function fakePi() {
  const handlers = new Map<string, ((event: unknown, ctx: CultStatusContext) => unknown)[]>()
  const pi: CultStatusApi = { on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]) }
  const emit = (event: string, ctx: CultStatusContext, payload: unknown = { type: event }): void => {
    for (const handler of handlers.get(event) ?? []) handler(payload, ctx)
  }
  return { pi, handlers, emit }
}

/** A writer on the real disk; awaiting `writer.write(state)` with the state just emitted waits for the queued writes. */
function member() {
  const writer = cultStatusWriter(env())
  if (writer === null) throw new Error('no writer')
  const { pi, handlers, emit } = fakePi()
  attachCultStatus(pi, writer)
  return { handlers, emit, writer }
}

const onDisk = (): unknown => JSON.parse(readFileSync(statusPath(), 'utf8'))
/** The writer's paths relative to the chat folder, so the expected calls read the same on every platform. */
const inChat = (path: string): string => relative(chatDir(), path)
const busy = (code: string): Error => Object.assign(new Error(`${code}: rename refused`), { code })

describe('cult status writer', () => {
  it('writes idle at session start and working at turn start, in a 0600 file with nothing beside it', async () => {
    const { handlers, emit, writer } = member()
    expect([...handlers.keys()]).toEqual(['session_start', 'agent_start', 'tool_execution_start', 'agent_end'])
    emit('session_start', MAIN)
    await writer.write('idle')
    expect(onDisk()).toEqual({ state: 'idle' })
    emit('agent_start', MAIN)
    await writer.write('working')
    expect(onDisk()).toEqual({ state: 'working' })
    // Windows keeps no POSIX mode bits: a file there reads back as 0666 whatever mode it was written with.
    if (process.platform !== 'win32') expect(statSync(statusPath()).mode & 0o777).toBe(0o600)
    expect(readdirSync(chatDir())).toEqual([CULT_STATUS_FILE])
  })

  it('writes working at tool start without the tool\'s input, and idle at turn end', async () => {
    const { emit, writer } = member()
    emit('agent_end', MAIN)
    await writer.write('idle')
    emit('tool_execution_start', MAIN, TOOL_EVENT)
    await writer.write('working')
    const text = readFileSync(statusPath(), 'utf8')
    expect(JSON.parse(text)).toEqual({ state: 'working' })
    expect(text).not.toContain('secret')
    emit('agent_end', MAIN)
    await writer.write('idle')
    expect(onDisk()).toEqual({ state: 'idle' })
  })

  it('ignores a subagent\'s and an unidentified session\'s events', async () => {
    const io = { writeFile: vi.fn(async () => {}), rename: vi.fn(async () => {}), pause: vi.fn(async () => {}) }
    const { pi, emit } = fakePi()
    attachCultStatus(pi, cultStatusWriter(env(), io)!)
    for (const event of ['session_start', 'agent_start', 'tool_execution_start', 'agent_end']) {
      emit(event, { agent: { kind: 'sub' } })
      emit(event, {})
    }
    await Promise.resolve()
    expect(io.writeFile).not.toHaveBeenCalled()
  })
})

describe('cult status writes', () => {
  it('writes in event order, through a temp file renamed over the status file, and skips an unchanged state', async () => {
    const calls: string[] = []
    // The repository's ES library predates Promise.withResolvers.
    let release = (): void => {}
    const first = new Promise<void>((resolve) => { release = resolve })
    const io = {
      writeFile: vi.fn(async (path: string, text: string, options: { mode: number }) => {
        calls.push(`write ${inChat(path)} ${text} ${options.mode.toString(8)}`)
        if (calls.length === 1) await first
      }),
      rename: vi.fn(async (from: string, to: string) => { calls.push(`rename ${inChat(from)} ${inChat(to)}`) }),
      pause: vi.fn(async () => {})
    }
    const writer = cultStatusWriter(env(), io, 42)!
    void writer.write('working')
    void writer.write('working')
    const last = writer.write('idle')
    release()
    await last
    expect(calls).toEqual([
      '.cult-status.json.42.tmp {"state":"working"} 600', '.cult-status.json.42.tmp cult-status.json',
      '.cult-status.json.42.tmp {"state":"idle"} 600', '.cult-status.json.42.tmp cult-status.json'
    ].map((line, i) => (i % 2 === 0 ? `write ${line}` : `rename ${line}`)))
  })

  it('writes again after a failed write', async () => {
    const io = {
      writeFile: vi.fn().mockRejectedValueOnce(new Error('EACCES')).mockResolvedValue(undefined),
      rename: vi.fn(async () => {}),
      pause: vi.fn(async () => {})
    }
    const writer = cultStatusWriter(env(), io)!
    await writer.write('working')
    await writer.write('working')
    expect(io.writeFile).toHaveBeenCalledTimes(2)
    expect(io.rename).toHaveBeenCalledTimes(1)
  })

  it('has no writer without an absolute descriptor path', () => {
    expect(cultStatusWriter({})).toBeNull()
    expect(cultStatusWriter({ [DM_CLIENT_DESCRIPTOR_ENV]: 'rel/launch-1.json' })).toBeNull()
    expect(cultStatusWriter({ [DM_CLIENT_DESCRIPTOR_ENV]: '/u/agents/omp/chat/dm-client/launch-1.txt' })).toBeNull()
  })
})

describe('a busy rename onto the status file', () => {
  it('asks again after a 50 ms pause each time Windows refuses it as busy, then renames', async () => {
    const io = {
      writeFile: vi.fn(async () => {}),
      rename: vi.fn().mockRejectedValueOnce(busy('EPERM')).mockRejectedValueOnce(busy('EBUSY')).mockResolvedValue(undefined),
      pause: vi.fn(async () => {})
    }
    const writer = cultStatusWriter(env(), io)!
    await writer.write('working')
    expect(io.rename).toHaveBeenCalledTimes(3)
    expect(io.pause.mock.calls).toEqual([[50], [50]])
    await writer.write('working')
    expect(io.writeFile).toHaveBeenCalledTimes(1)
  })

  it('gives up after ten busy refusals, or at once on any other error, and writes again on the next event', async () => {
    const io = { writeFile: vi.fn(async () => {}), rename: vi.fn().mockRejectedValue(busy('EACCES')), pause: vi.fn(async () => {}) }
    const writer = cultStatusWriter(env(), io)!
    await writer.write('working')
    expect([io.rename.mock.calls.length, io.pause.mock.calls.length]).toEqual([10, 9])
    io.rename.mockReset().mockRejectedValueOnce(busy('ENOENT')).mockResolvedValue(undefined)
    await writer.write('working')
    expect([io.rename.mock.calls.length, io.pause.mock.calls.length]).toEqual([1, 9])
    await writer.write('working')
    expect([io.writeFile.mock.calls.length, io.rename.mock.calls.length]).toEqual([3, 2])
  })

  it('replaces the status file while main holds it open to read it', async () => {
    writeFileSync(statusPath(), JSON.stringify({ state: 'idle' }))
    // As main's activity tracker does each poll. Windows may refuse a rename onto the open file; it is closed after
    // the first rename asked, whatever that rename answered, so a refused one succeeds when asked again.
    let reader: number | null = openSync(statusPath(), 'r')
    const closeReader = (): void => {
      if (reader !== null) closeSync(reader)
      reader = null
    }
    const io = {
      writeFile: (path: string, text: string, options: { mode: number }) => writeFile(path, text, options),
      rename: (from: string, to: string) => rename(from, to).finally(closeReader),
      pause: async () => {}
    }
    try {
      await cultStatusWriter(env(), io)!.write('working')
    } finally {
      closeReader()
    }
    expect(onDisk()).toEqual({ state: 'working' })
    expect(readdirSync(chatDir())).toEqual([CULT_STATUS_FILE])
  })
})

describe('cult status read by main', () => {
  it('main\'s activity tracker reads working from the file the writer wrote, then idle after the turn ends', async () => {
    const clock = new FakeClock()
    const tracker = createMemberActivity({
      userData, clock: { now: () => new Date(clock.now).toISOString(), after: (callback, ms) => clock.after(callback, ms) }
    })
    const { emit, writer } = member()
    try {
      tracker.track('run_1', CHAT)
      emit('agent_start', MAIN)
      emit('tool_execution_start', MAIN, TOOL_EVENT)
      await writer.write('working')
      clock.advance(ACTIVITY_THROTTLE_MS)
      expect(tracker.of(CHAT)).toMatchObject({ working: true, tool: null })
      emit('agent_end', MAIN)
      await writer.write('idle')
      clock.advance(ACTIVITY_THROTTLE_MS)
      expect(tracker.of(CHAT)).toMatchObject({ working: false, tool: null })
    } finally {
      tracker.dispose()
    }
    expect(clock.pending).toBe(0)
  })
})
