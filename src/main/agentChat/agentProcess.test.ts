import { ChildProcess, spawn, type SpawnOptions } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeScratch } from '../../test/removeScratch'
import * as processTree from '../agents/processTree'
import { startAgentProcess, type AgentProcess, type AgentProcessExit } from './agentProcess'

const FAKE_CLI = resolve('src/main/agentChat/__fixtures__/fakeAgentCli.mjs')
const runners: AgentProcess[] = []
let scratch: string

beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'dm-agent-process 猫-')) })
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(runners.splice(0).map((runner) => runner.stop()))
  removeScratch(scratch)
})

function run(args: string[], injectedSpawn?: Parameters<typeof startAgentProcess>[1]) {
  const runner = startAgentProcess({
    file: process.execPath, args, cwd: scratch,
    env: { ...process.env, FAKE_AGENT_LOG: join(scratch, 'fake.jsonl') }
  }, injectedSpawn)
  runners.push(runner)
  return runner
}

function exited(runner: AgentProcess): Promise<AgentProcessExit> {
  return new Promise((resolveExit) => runner.onExit(resolveExit))
}

function nextLine(runner: AgentProcess): Promise<string> {
  return new Promise((resolveLine) => {
    const unsubscribe = runner.onLine((line) => { unsubscribe(); resolveLine(line) })
  })
}

function stub(stdin: Writable = new PassThrough()) {
  const child = new ChildProcess()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = stdin
  const launch = vi.fn((_file: string, _args: string[], _options: SpawnOptions) => child)
  const runner = run([], launch)
  const finish = (code = 0): void => {
    Object.defineProperty(child, 'exitCode', { value: code, configurable: true })
    child.stdout?.emit('end')
    child.emit('exit', code, null)
    child.emit('close', code, null)
  }
  return { child, launch, runner, finish }
}

it('spawns shell-free with piped stdio, hidden Windows windows and a POSIX process group', () => {
  const { launch, finish } = stub()
  expect(launch).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
    cwd: scratch, stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32'
  }))
  if (process.platform === 'win32') {
    expect(launch.mock.calls[0][0]).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/)
    expect(launch.mock.calls[0][1].slice(0, 6)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand'])
  } else {
    expect(launch.mock.calls[0].slice(0, 2)).toEqual([process.execPath, []])
  }
  expect(launch.mock.calls[0][2]).not.toHaveProperty('shell')
  finish()
})

it('preserves literal argv, Unicode cwd and env-only values through the owned launcher', async () => {
  const args = ['space value', '猫', 'a"b', 'tail\\', '', '$(exit 99); & echo injected']
  const sentinel = 'env-only-process-fixture'
  const runner = run([FAKE_CLI, '--mode', 'rpc-ui', ...args], (file, argv, options) => {
    expect(argv.join(' ')).not.toContain(sentinel)
    return spawn(file, argv, { ...options, env: { ...options.env, DM_SESSION_TOKEN: sentinel } })
  })
  await nextLine(runner)
  const record = JSON.parse(readFileSync(join(scratch, 'fake.jsonl'), 'utf8'))
  expect(record).toMatchObject({ argv: ['--mode', 'rpc-ui', ...args], cwd: scratch, env: { DM_SESSION_TOKEN: 'present' } })
  await runner.stop()
})

it.runIf(process.platform === 'win32')('kills the retained job when the supervisor alone is terminated', async () => {
  const runner = run([FAKE_CLI, '--mode', 'rpc-ui'])
  await nextLine(runner)
  const { pid } = JSON.parse(readFileSync(join(scratch, 'fake.jsonl'), 'utf8')) as { pid: number }
  const result = exited(runner)
  process.kill(runner.pid!, 'SIGKILL')
  await result
  expect(() => process.kill(runner.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
  expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
})

it.runIf(process.platform === 'win32')('terminates an owned suspended child if setup fails before resume', async () => {
  const runner = run([FAKE_CLI, '--mode', 'rpc-ui'], (file, argv, options) => {
    const encoded = argv.indexOf('-EncodedCommand') + 1
    const script = Buffer.from(argv[encoded], 'base64').toString('utf16le')
    const resume = 'Check(ResumeThread(child.Thread) != UInt32.MaxValue);'
    expect(script).toContain(resume)
    const failure = 'Console.Error.WriteLine("suspended-child:" + child.ProcessId); if (child.ProcessId != 0) throw new Exception("injected pre-resume failure");'
    const args = [...argv]
    args[encoded] = Buffer.from(script.replace(resume, failure), 'utf16le').toString('base64')
    return spawn(file, args, options)
  })
  const result = await exited(runner)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('injected pre-resume failure')
  const pid = Number(result.stderr.match(/suspended-child:(\d+)/)?.[1])
  expect(pid).toBeGreaterThan(0)
  expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
  expect(() => process.kill(runner.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
})

it.runIf(process.platform === 'win32')('launches a real fake CLI with an unchanged 8 KiB literal argument', async () => {
  const literal = 'a'.repeat(8192)
  const runner = run([FAKE_CLI, '--mode', 'rpc-ui', literal])
  await nextLine(runner)
  const record = JSON.parse(readFileSync(join(scratch, 'fake.jsonl'), 'utf8'))
  expect(record.argv).toEqual(['--mode', 'rpc-ui', literal])
  await runner.stop()
  expect(() => process.kill(runner.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
  expect(() => process.kill(record.pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
})

it.runIf(process.platform === 'win32')('queues metadata before immediate public JSONL writes and stdin EOF', async () => {
  const writes: Buffer[] = []
  const input = new Writable({ write(chunk: Buffer, _encoding, callback) { writes.push(Buffer.from(chunk)); callback() } })
  const { runner, finish } = stub(input)
  expect(runner.write('{"type":"prompt","message":"immediate"}')).toBe(true)
  const stopped = runner.stop()
  expect(input.writableEnded).toBe(true)
  expect(writes).toHaveLength(2)
  expect(writes[0].subarray(0, 4).toString()).toBe('DMJ1')
  expect(writes[0].length).toBe(12 + writes[0].readUInt32LE(4) + writes[0].readUInt32LE(8))
  expect(writes[1].toString()).toBe('{"type":"prompt","message":"immediate"}\n')
  finish()
  await stopped
})

it.runIf(process.platform === 'win32')('swallows a synchronous EPIPE while queuing launch metadata', () => {
  const input = new PassThrough()
  vi.spyOn(input, 'write').mockImplementation(() => { throw Object.assign(new Error('closed bootstrap'), { code: 'EPIPE' }) })
  const { runner, finish } = stub(input)
  expect(runner.write('not sent')).toBe(false)
  finish()
})

it('delivers actual fake CLI output split at every byte, including a trailing line without LF', async () => {
  // Transport-only wrapper: the shared CLI is unchanged and still runs via process.execPath.
  const runner = run(['-e', `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, [process.argv[1], '--version'], {stdio:['ignore','pipe','inherit']});
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('close', code => {
      const bytes = Buffer.concat(chunks).subarray(0, -1);
      let i = 0;
      function send() {
        if (i === bytes.length) { process.exitCode = code; return; }
        process.stdout.write(bytes.subarray(i, ++i), () => setImmediate(send));
      }
      send();
    });
  `, FAKE_CLI])
  const lines: string[] = []
  runner.onLine((line) => lines.push(line))
  const result = await exited(runner)
  expect(result).toEqual({ code: 0, signal: null, stderr: '' })
  expect(lines).toEqual(['2.1.329 (Claude Code)'])
  expect(JSON.parse(readFileSync(join(scratch, 'fake.jsonl'), 'utf8'))).toMatchObject({ mode: 'version' })
})

it('frames byte-split UTF-8, CRLF, empty lines and a final unterminated line', () => {
  const { runner, child, finish } = stub()
  const lines: string[] = []
  runner.onLine((line) => lines.push(line))
  const bytes = Buffer.from('a🐈\r\n\nlast')
  for (const byte of bytes) child.stdout?.emit('data', Buffer.from([byte]))
  expect(lines).toEqual(['a🐈', ''])
  finish()
  expect(lines).toEqual(['a🐈', '', 'last'])
})

it('accepts exactly 8 MiB and drops oversized lines once each, recovering at LF and EOF', () => {
  const { runner, child, finish } = stub()
  const lines: string[] = []
  let tail = ''
  runner.onLine((line) => lines.push(line))
  runner.onStderr((value) => { tail = value })
  const max = Buffer.alloc(8 * 1024 * 1024, 120)
  child.stdout?.emit('data', max)
  child.stdout?.emit('data', Buffer.from('\n'))
  child.stdout?.emit('data', max)
  child.stdout?.emit('data', Buffer.from('too large'))
  child.stdout?.emit('data', Buffer.from('still dropped\r\nok\n'))
  child.stdout?.emit('data', Buffer.concat([max, Buffer.from('x')]))
  finish()
  expect(lines.map((line) => line.length)).toEqual([max.length, 2])
  expect(lines[1]).toBe('ok')
  expect(tail).toBe('Agent stdout line exceeded 8 MiB; dropped.\n'.repeat(2))
})

it('keeps only the last 64 KiB of stderr and replays diagnostics and final exit to late listeners', async () => {
  const { runner, child, finish } = stub()
  let tail = ''
  runner.onStderr((value) => { tail = value })
  child.stderr?.emit('data', Buffer.from('discard me'))
  child.stderr?.emit('data', Buffer.alloc(64 * 1024, 97))
  child.stderr?.emit('data', Buffer.from('END'))
  expect(tail).toBe('a'.repeat(64 * 1024 - 3) + 'END')
  finish(3)
  expect(await exited(runner)).toEqual({ code: 3, signal: null, stderr: tail })
  let replay = ''
  runner.onStderr((value) => { replay = value })
  expect(replay).toBe(tail)
})

it('reports real fake CLI crash code 3 and stderr before harmless writes after exit', async () => {
  const runner = run([FAKE_CLI, '--mode', 'rpc-ui'])
  await nextLine(runner)
  const result = exited(runner)
  expect(runner.write(JSON.stringify({ type: 'prompt', message: '[crash]' }))).toBe(true)
  expect(await result).toEqual({ code: 3, signal: null, stderr: 'fake-agent crash\n' })
  expect(() => runner.write('after exit')).not.toThrow()
  expect(runner.write('after exit')).toBe(false)
})

it('appends LF and swallows synchronous and asynchronous EPIPE without inventing an exit code', async () => {
  const { runner, child, finish } = stub()
  const write = vi.spyOn(child.stdin!, 'write')
  runner.write('hello')
  expect(write.mock.calls[0][0]).toBe('hello\n')
  write.mockImplementationOnce(() => { throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' }) })
  expect(runner.write('closed')).toBe(false)
  expect(() => child.stdin?.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).not.toThrow()
  expect(runner.write('closed again')).toBe(false)
  finish(3)
  expect((await exited(runner)).code).toBe(3)
})

it('handles a write-callback EPIPE and a failed executable without an unhandled error', async () => {
  const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('closed'), { code: 'EPIPE' })) } })
  const { runner, finish } = stub(stdin)
  expect(() => runner.write('closed')).not.toThrow()
  await new Promise<void>((resolveError) => stdin.once('error', () => resolveError()))
  expect(runner.write('closed again')).toBe(false)
  const failed = run([FAKE_CLI], (file, args, options) => spawn(`${file}.missing`, args, options))
  const result = await exited(failed)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('ENOENT')
  finish()
  expect(runner.write('done')).toBe(false)
})

it('ends the real fake CLI on stdin EOF and leaves neither runner nor logged pid alive', async () => {
  const runner = run([FAKE_CLI, '--mode', 'rpc-ui'])
  await nextLine(runner)
  const logged = JSON.parse(readFileSync(join(scratch, 'fake.jsonl'), 'utf8')) as { pid: number }
  const start = performance.now()
  await runner.stop()
  expect(performance.now() - start).toBeLessThan(5_000)
  expect(() => process.kill(runner.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
  expect(() => process.kill(logged.pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
})

it('escalates a real process tree ignoring EOF and kills both wrapper and fake descendant within 5 seconds', async () => {
  const runner = run(['-e', `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, [process.argv[1], '--mode', 'rpc-ui'], {stdio:'pipe'});
    process.stdin.resume();
    child.stdout.once('data', () => process.stdout.write(JSON.stringify({pid:child.pid})+'\\n'));
    child.stderr.pipe(process.stderr);
  `, FAKE_CLI])
  const descendant = JSON.parse(await nextLine(runner)) as { pid: number }
  const logged = JSON.parse(readFileSync(join(scratch, 'fake.jsonl'), 'utf8')) as { pid: number }
  expect(descendant.pid).toBe(logged.pid)
  expect(descendant.pid).not.toBe(runner.pid)
  const start = performance.now()
  await runner.stop()
  expect(performance.now() - start).toBeLessThan(5_000)
  expect(() => process.kill(runner.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
  expect(() => process.kill(logged.pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
})

it('cleans a naturally ended POSIX group immediately and never checks its id again at delayed disposal', async () => {
  vi.spyOn(processTree, 'startsOwnGroup').mockReturnValue(true)
  let resolveCleanup!: (gone: boolean) => void
  const cleanup = new Promise<boolean>((resolve) => { resolveCleanup = resolve })
  const kill = vi.spyOn(processTree, 'killProcessTree').mockReturnValue(cleanup)
  const { runner, child, finish } = stub()
  finish()
  expect(kill).toHaveBeenCalledExactlyOnceWith(child)
  // Disposal can happen many event-loop turns after exit; it must await the retained result.
  await new Promise<void>((resolve) => setImmediate(resolve))
  let stopped = false
  const disposal = runner.stop().then(() => { stopped = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(stopped).toBe(false)
  resolveCleanup(true)
  await disposal
  await runner.stop()
  expect(kill).toHaveBeenCalledTimes(1)
})

it('retains descendant ownership when stdin EOF exits the parent but its fake child remains alive', async () => {
  const runner = run(['-e', `
    const {spawn} = require('node:child_process');
    const {watch, readFileSync} = require('node:fs');
    const watcher = watch(process.cwd(), () => {
      try {
        const record = JSON.parse(readFileSync(process.env.FAKE_AGENT_LOG, 'utf8'));
        watcher.close();
        process.stdout.write(JSON.stringify({pid:record.pid})+'\\n');
      } catch {}
    });
    spawn(process.execPath, [process.argv[1], '-p', '--no-tools'], {
      stdio:'ignore', env:{...process.env, FAKE_ARBITER_VERDICT:'hang'}
    }).unref();
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write('parent received EOF\\n', () => process.exit(0));
    });
  `, FAKE_CLI])
  const descendant = JSON.parse(await nextLine(runner)) as { pid: number }
  const lines: string[] = []
  runner.onLine((line) => lines.push(line))
  const result = exited(runner)
  const start = performance.now()
  try {
    await runner.stop()
    expect(performance.now() - start).toBeLessThan(5_000)
    expect(await result).toMatchObject({ code: 0 })
    expect(lines).toContain('parent received EOF')
    expect(() => process.kill(runner.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
    expect(() => process.kill(descendant.pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
  } finally {
    // The regression must not leak its deliberately orphanable fixture if an assertion fails.
    try { process.kill(descendant.pid, 'SIGKILL') } catch { /* Already gone. */ }
  }
})

it('escalates at exactly 3 seconds, shares stop calls and bounds a stuck kill at 5 seconds', async () => {
  vi.useFakeTimers()
  const { runner, child, finish } = stub()
  const kill = vi.spyOn(processTree, 'killProcessTree').mockImplementation(() => new Promise(() => {}))
  const end = vi.spyOn(child.stdin!, 'end')
  const stopped = runner.stop()
  expect(runner.stop()).toBe(stopped)
  expect(end).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2_999)
  expect(kill).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(kill).toHaveBeenCalledWith(child)
  let settled = false
  void stopped.then(() => { settled = true })
  await vi.advanceTimersByTimeAsync(1_999)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await stopped
  expect(settled).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  finish()
})

for (const gracefulFirst of [false, true]) it(`force-stops immediately and retains cleanup (graceful first: ${gracefulFirst})`, async () => {
  vi.useFakeTimers()
  const { runner, child, finish } = stub()
  // The repository's ES library predates Promise.withResolvers.
  let release!: (result: boolean) => void
  const cleanup = new Promise<boolean>(resolve => { release = resolve })
  const kill = vi.spyOn(processTree, 'killProcessTree').mockReturnValue(cleanup)
  const graceful = gracefulFirst ? runner.stop() : undefined
  await vi.advanceTimersByTimeAsync(1000)
  expect(kill).not.toHaveBeenCalled()
  const stopped = runner.stop({ force: true })
  if (graceful) expect(stopped).toBe(graceful)
  expect(kill).toHaveBeenCalledExactlyOnceWith(child)
  expect(runner.stop({ force: true })).toBe(stopped)
  let settled = false
  void stopped.then(() => { settled = true })
  finish()
  await vi.advanceTimersByTimeAsync(0)
  expect(settled).toBe(false)
  release(true)
  await stopped
  expect(settled).toBe(true)
  expect(kill).toHaveBeenCalledTimes(1)
  expect(runner.stop({ force: true })).toBe(stopped)
  expect(kill).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('never initiates a force kill for an already ended process', async () => {
  const { runner, finish } = stub()
  const kill = vi.spyOn(processTree, 'killProcessTree').mockResolvedValue(true)
  finish()
  const naturalCleanupCalls = kill.mock.calls.length
  await runner.stop({ force: true })
  expect(kill).toHaveBeenCalledTimes(naturalCleanupCalls)
})
