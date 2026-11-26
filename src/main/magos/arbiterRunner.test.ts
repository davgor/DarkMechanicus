import { ChildProcess, type spawn as Spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { killProcessTree, startsOwnGroup } from '../agents/processTree'
import type * as ProcessTree from '../agents/processTree'
import { logger } from '../logger'
import { arbiterLaunch, type ArbiterLaunchSpec } from './arbiterLaunch'
import { ARBITER_SYSTEM_PROMPT, buildArbiterRequest } from './arbiterPrompt'
import { startArbiter } from './arbiterRunner'

vi.mock('../logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp), rm: vi.fn(actual.rm) }
})
vi.mock('../agents/processTree', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessTree>()
  return { ...actual, killProcessTree: vi.fn(actual.killProcessTree) }
})

const FAKE_CLI = resolve('src/main/agentChat/__fixtures__/fakeAgentCli.mjs')
const GRANT = 'dmg_0123456789abcdef0123456789abcdef'
const CLAIM = 'at_01j0000000000000000000000a.fixtureSecretAAAAAAAAAAAAAAAAAAA'
let root: string
let dirs: string[]
let runs: { result: Promise<unknown>; cancel(): void }[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dm-arbiter-test-'))
  dirs = []
  runs = []
  vi.clearAllMocks()
  vi.mocked(mkdtemp).mockReset()
  vi.mocked(rm).mockReset()
  vi.mocked(killProcessTree).mockReset()
})

afterEach(async () => {
  vi.useRealTimers()
  for (const run of runs) { run.cancel(); await run.result }
  try {
    for (const dir of dirs) expect(existsSync(dir), `runner leaked ${dir}`).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function launch(mode = 'allow'): (dir: string) => ArbiterLaunchSpec {
  return dir => {
    dirs.push(dir)
    expect(readdirSync(dir)).toEqual([])
    expect(dir.startsWith(join(root, 'dm-arbiter-'))).toBe(true)
    return {
      file: process.execPath, args: [FAKE_CLI, '-p', '--output-format', 'json'], cwd: dir,
      env: { ...process.env, FAKE_AGENT_LOG: join(root, 'fake.jsonl'), FAKE_ARBITER_VERDICT: mode },
      protocol: 'claude'
    }
  }
}

function runFake(mode: string, timeoutMs?: number) {
  const run = startArbiter({ launch: launch(mode), input: 'REQUEST:\n{}', tempRoot: root, timeoutMs })
  runs.push(run)
  return run
}

function logRecord(): { pid: number; cwd: string; stdinHasSecret: boolean; descendant?: number } {
  return JSON.parse(readFileSync(join(root, 'fake.jsonl'), 'utf8').trim())
}

function waitForLog(): Promise<void> {
  return new Promise((done, reject) => {
    const watcher = watch(root, check)
    const timer = setTimeout(() => { watcher.close(); reject(new Error('Fake CLI did not log startup')) }, 2_000)
    function check(): void {
      const path = join(root, 'fake.jsonl')
      if (!existsSync(path) || !readFileSync(path, 'utf8').endsWith('\n')) return
      clearTimeout(timer)
      watcher.close()
      done()
    }
    check()
  })
}

const verdicts = [
  ['allow', 'allow_once', undefined], ['deny', 'deny', undefined], ['escalate', 'escalate', 'verdict'],
  ['fenced', 'allow_once', undefined], ['garbage', 'escalate', 'invalid'], ['crash', 'escalate', 'error']
] as const

it.each(verdicts)('maps fake %s and removes its isolated directory', async (mode, decision, cause) => {
  const result = await runFake(mode).result
  expect(result).toMatchObject({ decision, ...(cause ? { cause } : {}) })
  if (!cause || cause === 'verdict') expect(result.reason).toBe(`fake ${decision}`)
  expect(logRecord()).toMatchObject({ cwd: dirs[0], stdinHasSecret: false })
  expect(existsSync(dirs[0])).toBe(false)
  expect(logger.warn).toHaveBeenCalledTimes(mode === 'crash' ? 1 : 0)
})

it('kills the hanging fake at 500 ms and confirms ESRCH before resolving', async () => {
  const started = performance.now()
  const result = await runFake('hang', 500).result
  expect(result).toMatchObject({ decision: 'escalate', cause: 'timeout' })
  expect(performance.now() - started).toBeLessThan(5_500)
  expect(() => process.kill(logRecord().pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  expect(existsSync(dirs[0])).toBe(false)
})

it('cancels a running hanging fake idempotently and confirms ESRCH', async () => {
  const run = runFake('hang')
  await waitForLog()
  run.cancel()
  run.cancel()
  expect(await run.result).toMatchObject({ decision: 'escalate', cause: 'cancelled' })
  expect(() => process.kill(logRecord().pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  run.cancel()
  expect(existsSync(dirs[0])).toBe(false)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it.each(['cancelled', 'timeout'] as const)('bounds %s during stalled creation and removes a late owned directory', async cause => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const creating = deferred<string>()
  const removed = deferred<void>()
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  vi.mocked(mkdtemp).mockReturnValueOnce(creating.promise)
  vi.mocked(rm).mockImplementationOnce(async (path, options) => {
    await actual.rm(path, options)
    removed.resolve(undefined)
  })
  const factory = vi.fn(launch())
  const run = startArbiter({ launch: factory, input: '', tempRoot: root, timeoutMs: 500 })
  runs.push(run)
  if (cause === 'cancelled') run.cancel()
  else await vi.advanceTimersByTimeAsync(500)
  expect(await run.result).toMatchObject({ cause, reason: 'Arbiter cleanup could not be confirmed.' })
  expect(factory).not.toHaveBeenCalled()
  const lateDir = mkdtempSync(join(root, 'dm-arbiter-'))
  dirs.push(lateDir)
  creating.resolve(lateDir)
  await removed.promise
  expect(existsSync(lateDir)).toBe(false)
  expect(factory).not.toHaveBeenCalled()
  expect(rm).toHaveBeenCalledExactlyOnceWith(lateDir, { recursive: true, force: true })
})

it('contains a late directory-creation rejection without changing cancellation', async () => {
  const creating = deferred<string>()
  vi.mocked(mkdtemp).mockReturnValueOnce(creating.promise)
  const factory = vi.fn(launch())
  const run = startArbiter({ launch: factory, input: '', tempRoot: root })
  runs.push(run)
  run.cancel()
  const result = await run.result
  creating.reject(new Error('late failure'))
  await creating.promise.catch(() => {})
  expect(await run.result).toEqual(result)
  expect(result).toMatchObject({ cause: 'cancelled' })
  expect(factory).not.toHaveBeenCalled()
})

it('sends buildArbiterRequest output without planted grant or claim secrets', async () => {
  const input = buildArbiterRequest({
    prompt: { title: GRANT, tool: { name: 'read', input: { token: GRANT, claim: CLAIM } } },
    ticket: null, intent: null, autoHandle: GRANT
  })
  expect(typeof input).toBe('string')
  if (typeof input !== 'string') throw new Error('Unexpected request refusal')
  const run = startArbiter({ launch: launch(), input, tempRoot: root })
  runs.push(run)
  expect(await run.result).toMatchObject({ decision: 'allow_once' })
  expect(logRecord().stdinHasSecret).toBe(false)
})

it('fails closed on a missing executable without throwing', async () => {
  const factory = launch()
  const run = startArbiter({ launch: dir => ({ ...factory(dir), file: join(root, 'missing.exe') }), input: '', tempRoot: root })
  runs.push(run)
  await expect(run.result).resolves.toMatchObject({ decision: 'escalate', cause: 'error' })
})

it('handles directory and factory failures without throwing', async () => {
  const missing = startArbiter({ launch: launch(), input: '', tempRoot: join(root, 'missing') })
  runs.push(missing)
  await expect(missing.result).resolves.toMatchObject({ cause: 'error' })
  const failed = startArbiter({ launch: dir => { dirs.push(dir); throw new Error(GRANT) }, input: '', tempRoot: root })
  runs.push(failed)
  expect(await failed.result).toMatchObject({ cause: 'error' })
  expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(GRANT)
})

it('refuses an OMP candidate with config before any spawn', async () => {
  const spawn = vi.fn()
  const run = startArbiter({
    launch: tempDir => {
      dirs.push(tempDir)
      return arbiterLaunch({ agent: { kind: 'omp', executablePath: process.execPath }, platform: process.platform,
        baseEnv: process.env, tempDir, systemPrompt: ARBITER_SYSTEM_PROMPT, ompConfig: join(root, 'overlay.json') })
    }, input: 'nonempty', tempRoot: root, spawn: spawn as unknown as typeof Spawn
  })
  runs.push(run)
  expect(await run.result).toEqual({ decision: 'escalate', cause: 'error', reason: 'unsupported_kind' })
  expect(spawn).not.toHaveBeenCalled()
})

function controlled(killTree = vi.fn(async () => true)) {
  // Synthetic PIDs must never reach the operating system; real fallback tests below use real children.
  vi.mocked(killProcessTree).mockResolvedValue(true)
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: 123456 })
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  let ready!: () => void
  const started = new Promise<void>(resolveReady => { ready = resolveReady })
  const spawn = vi.fn(() => { ready(); return child })
  const run = startArbiter({ launch: launch(), input: 'sent once', tempRoot: root,
    spawn: spawn as unknown as typeof Spawn, killTree })
  runs.push(run)
  return { child, run, started, spawn, killTree }
}

function emitVerdict(child: ChildProcess, reason = 'safe', padding = 0): void {
  const text = JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: JSON.stringify({ decision: 'allow_once', reason }) })
  child.stdout!.emit('data', Buffer.from(text + ' '.repeat(padding)))
  child.emit('exit', 0, null)
  child.emit('close', 0, null)
}

it('preserves launch argv/cwd/env and piped shell-free group options, writing input then EOF', async () => {
  const harness = controlled()
  await harness.started
  const [file, args, options] = harness.spawn.mock.calls[0] as unknown as [string, string[], object]
  expect(file).toBe(process.execPath)
  expect(args).toEqual([FAKE_CLI, '-p', '--output-format', 'json'])
  expect(options).toEqual({ cwd: dirs[0], env: expect.objectContaining({ FAKE_ARBITER_VERDICT: 'allow' }),
    stdio: 'pipe', windowsHide: true, detached: startsOwnGroup() })
  expect(harness.child.stdin!.writableEnded).toBe(true)
  expect((harness.child.stdin as PassThrough).read().toString()).toBe('sent once')
  emitVerdict(harness.child)
  expect(await harness.run.result).toMatchObject({ decision: 'allow_once' })
  expect(harness.killTree).toHaveBeenCalledOnce()
})

it('accepts exactly 256 KiB but kills overflow before parsing any verdict', async () => {
  const exact = controlled()
  await exact.started
  const base = JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: JSON.stringify({ decision: 'allow_once', reason: 'safe' }) })
  emitVerdict(exact.child, 'safe', 256 * 1024 - Buffer.byteLength(base))
  expect(await exact.run.result).toMatchObject({ decision: 'allow_once' })
  const overflow = controlled()
  await overflow.started
  overflow.child.stdout!.emit('data', Buffer.alloc(256 * 1024 + 1, 'x'))
  expect(await overflow.run.result).toMatchObject({ cause: 'invalid' })
  expect(overflow.killTree).toHaveBeenCalledOnce()
})

it('masks split secrets in reasons, accepts split UTF-8 and preserves strict parser length checks', async () => {
  const harness = controlled()
  await harness.started
  const bytes = Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: JSON.stringify({ decision: 'allow_once', reason: `é ${GRANT} ${CLAIM}` }) }))
  for (const byte of bytes) harness.child.stdout!.emit('data', Buffer.from([byte]))
  harness.child.emit('close', 0)
  const result = await harness.run.result
  expect(result.decision).toBe('allow_once')
  expect(result.reason).toContain('é')
  expect(result.reason).not.toContain(GRANT)
  expect(result.reason).not.toContain(CLAIM)
  expect(result.reason.length).toBeLessThanOrEqual(500)
  const long = controlled()
  await long.started
  emitVerdict(long.child, 'x'.repeat(501))
  expect(await long.run.result).toMatchObject({ cause: 'invalid' })
})

it('logs only a masked 4 KiB stderr tail on error, removing a truncated leading secret', async () => {
  const harness = controlled()
  await harness.started
  const stderr = `old-prefix\n${GRANT}\n${'x'.repeat(4_000)}\n${CLAIM}\n${GRANT}\n`
  for (const part of [stderr.slice(0, -20), stderr.slice(-20)]) harness.child.stderr!.emit('data', Buffer.from(part))
  harness.child.emit('close', 3)
  expect(await harness.run.result).toMatchObject({ cause: 'error' })
  const text = vi.mocked(logger.warn).mock.calls[0][1] as string
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4 * 1024)
  expect(text).not.toContain('old-prefix')
  expect(text).not.toContain(GRANT)
  expect(text).not.toContain(CLAIM)
  expect(JSON.stringify(await harness.run.result)).not.toContain('xxxx')
})

it('does not expose a token suffix cut by the stderr byte bound', async () => {
  const harness = controlled()
  await harness.started
  harness.child.stderr!.emit('data', Buffer.from(`${GRANT}\n${'z'.repeat(4_090)}`))
  harness.child.emit('close', 3)
  await harness.run.result
  expect(vi.mocked(logger.warn).mock.calls[0][1]).toBe('z'.repeat(4_090))
})

it('fails closed on synchronous spawn throws, emitted errors and stdin errors', async () => {
  const spawn = vi.fn(() => { throw new Error('EPERM ' + GRANT) })
  const run = startArbiter({ launch: launch(), input: '', tempRoot: root, spawn: spawn as unknown as typeof Spawn })
  runs.push(run)
  expect(await run.result).toMatchObject({ cause: 'error' })
  for (const streamError of [false, true]) {
    const harness = controlled()
    await harness.started
    ;(streamError ? harness.child.stdin! : harness.child).emit('error', new Error(GRANT))
    expect(await harness.run.result).toMatchObject({ cause: 'error' })
  }
  expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(GRANT)
})

it('uses the 60 s default and bounds finalization when neither killer settles', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const harness = controlled(vi.fn(() => new Promise<boolean>(() => {})))
  // Hold both killers so advancing to the outer bound does not also skip over real filesystem I/O.
  vi.mocked(killProcessTree).mockReturnValue(new Promise<boolean>(() => {}))
  await harness.started
  await vi.advanceTimersByTimeAsync(59_999)
  expect(harness.killTree).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(harness.killTree).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(4_000)
  expect(await harness.run.result).toMatchObject({ cause: 'timeout', reason: 'Arbiter cleanup could not be confirmed.' })
  expect(killProcessTree).toHaveBeenCalledOnce()
  expect(existsSync(dirs[0])).toBe(false)
})

it('bounds rejecting and throwing killers and never accepts an unconfirmed cleanup', async () => {
  for (const kill of [() => Promise.reject(new Error(GRANT)), () => { throw new Error(GRANT) }]) {
    const harness = controlled(vi.fn(kill))
    vi.mocked(killProcessTree).mockResolvedValue(false)
    await harness.started
    emitVerdict(harness.child)
    expect(await harness.run.result).toMatchObject({ decision: 'escalate', cause: 'error' })
  }
})

it('kills the real child tree on cancellation, not just its direct process', async () => {
  const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    fs.appendFileSync(process.env.FAKE_AGENT_LOG,JSON.stringify({pid:process.pid,descendant:child.pid})+'\\n');
    setInterval(()=>{},1000);`
  const factory = launch()
  const run = startArbiter({ launch: dir => ({ ...factory(dir), args: ['-e', script] }), input: '', tempRoot: root })
  runs.push(run)
  await waitForLog()
  run.cancel()
  // The reason shows cleanup was confirmed: an unconfirmed one keeps the cause but reads "could not be confirmed".
  expect(await run.result).toMatchObject({ cause: 'cancelled', reason: 'Arbiter cancelled.' })
  const record = logRecord()
  expect(() => process.kill(record.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  expect(() => process.kill(record.descendant!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
})

const removalError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: resource busy or locked, rmdir`), { code })

it('removes its directory after Windows reports it busy, as a killed descendant still releases its cwd', async () => {
  vi.mocked(rm).mockRejectedValueOnce(removalError('EBUSY'))
  expect(await runFake('allow').result).toEqual({ decision: 'allow_once', reason: 'fake allow_once' })
  expect(rm).toHaveBeenCalledTimes(2)
  expect(existsSync(dirs[0])).toBe(false)
})

it('stops asking after four busy removals and reports the cleanup unconfirmed', async () => {
  for (let attempt = 0; attempt < 4; attempt++) vi.mocked(rm).mockRejectedValueOnce(removalError('EPERM'))
  expect(await runFake('allow').result).toMatchObject({ decision: 'escalate', cause: 'error', reason: 'Arbiter cleanup could not be confirmed.' })
  expect(rm).toHaveBeenCalledTimes(4)
  rmSync(dirs[0], { recursive: true, force: true })
})

it('fails closed at once on a removal error that is not a busy directory', async () => {
  vi.mocked(rm).mockRejectedValueOnce(removalError('EIO'))
  expect(await runFake('allow').result).toMatchObject({ decision: 'escalate', cause: 'error', reason: 'Arbiter cleanup could not be confirmed.' })
  expect(rm).toHaveBeenCalledOnce()
  rmSync(dirs[0], { recursive: true, force: true })
})

const failureModes = ['throw', 'reject', 'hang', 'false'] as const
function brokenKiller(mode: typeof failureModes[number]): typeof killProcessTree {
  return () => {
    if (mode === 'throw') throw new Error('injected kill failure')
    if (mode === 'reject') return Promise.reject(new Error('injected kill failure'))
    if (mode === 'false') return Promise.resolve(false)
    return new Promise<boolean>(() => {})
  }
}

it.each(failureModes)('uses real tree fallback for %s during hanging fake timeout', async mode => {
  // Real process death and the platform deadline cannot be proved with a synthetic PID or fake clock.
  const started = performance.now()
  const killTree = vi.fn(brokenKiller(mode))
  const run = startArbiter({ launch: launch('hang'), input: '', tempRoot: root, timeoutMs: 500, killTree })
  runs.push(run)
  expect(await run.result).toMatchObject({ cause: 'timeout' })
  expect(performance.now() - started).toBeLessThan(5_500)
  expect(killTree).toHaveBeenCalledOnce()
  expect(() => process.kill(logRecord().pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  expect(existsSync(dirs[0])).toBe(false)
})

it.each(failureModes)('uses real tree fallback for %s during hanging fake cancellation', async mode => {
  const killTree = vi.fn(brokenKiller(mode))
  const run = startArbiter({ launch: launch('hang'), input: '', tempRoot: root, killTree })
  runs.push(run)
  await waitForLog()
  const started = performance.now()
  run.cancel()
  expect(await run.result).toMatchObject({ cause: 'cancelled' })
  expect(performance.now() - started).toBeLessThan(5_000)
  expect(killTree).toHaveBeenCalledOnce()
  expect(() => process.kill(logRecord().pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  expect(existsSync(dirs[0])).toBe(false)
})

it.each(failureModes)('fallback kills real descendants when injected kill %s', async mode => {
  const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    fs.appendFileSync(process.env.FAKE_AGENT_LOG,JSON.stringify({pid:process.pid,descendant:child.pid})+'\\n');
    setInterval(()=>{},1000);`
  const factory = launch()
  const run = startArbiter({ launch: dir => ({ ...factory(dir), args: ['-e', script] }), input: '', tempRoot: root,
    killTree: brokenKiller(mode) })
  runs.push(run)
  await waitForLog()
  const started = performance.now()
  run.cancel()
  expect(await run.result).toMatchObject({ cause: 'cancelled' })
  expect(performance.now() - started).toBeLessThan(5_000)
  const record = logRecord()
  expect(() => process.kill(record.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  expect(() => process.kill(record.descendant!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  expect(existsSync(dirs[0])).toBe(false)
})

it('captures the real tree at exit before a delayed injected killer can revisit its group', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const harness = controlled(vi.fn(() => new Promise<boolean>(() => {})))
  await harness.started
  emitVerdict(harness.child)
  expect(killProcessTree).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(250)
  expect(await harness.run.result).toMatchObject({ decision: 'allow_once' })
  expect(killProcessTree).toHaveBeenCalledOnce()
})
