import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { probeAgent, type ProbeLaunch } from './agentProbe'
import { inspectExecutable, runProcess } from './agentProbeNode'

/** The real runner is exercised against Node itself, which every machine running these tests has. */
function node(...args: string[]): ProbeLaunch {
  return { file: process.execPath, args, verbatimArguments: false }
}

let scratch = ''

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dm-probe-'))
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('runProcess', () => {
  it('captures what the program prints and its exit code', async () => {
    const outcome = await runProcess(node('--version'), 10_000)

    expect(outcome).toMatchObject({ kind: 'exited', exitCode: 0 })
    expect(outcome.kind === 'exited' && outcome.output).toMatch(/^v\d+\.\d+\.\d+/)
  })

  it('combines stdout and stderr and reports a failing exit code', async () => {
    const script = "console.log('to-out'); console.error('to-err'); process.exit(3)"

    const outcome = await runProcess(node('-e', script), 10_000)

    expect(outcome).toMatchObject({ kind: 'exited', exitCode: 3 })
    expect(outcome.kind === 'exited' && outcome.output).toContain('to-out')
    expect(outcome.kind === 'exited' && outcome.output).toContain('to-err')
  })

  it('gives the program an already closed stdin so one that waits for input cannot hang', async () => {
    const script = "process.stdin.on('end', () => console.log('eof')); process.stdin.resume()"

    const outcome = await runProcess(node('-e', script), 10_000)

    expect(outcome.kind === 'exited' && outcome.output).toContain('eof')
  })

  it('reports a program that cannot be started with its error code', async () => {
    const outcome = await runProcess({ file: join(scratch, 'missing'), args: [], verbatimArguments: false }, 10_000)

    expect(outcome).toMatchObject({ kind: 'spawn_failed', code: 'ENOENT' })
  })

  it('stops a program that runs past the timeout', async () => {
    const started = Date.now()

    const outcome = await runProcess(node('-e', 'setInterval(() => {}, 1000)'), 300)

    expect(outcome).toEqual({ kind: 'timed_out' })
    expect(Date.now() - started).toBeLessThan(8_000)
  })

  it('cuts off a program that prints without end', async () => {
    const outcome = await runProcess(node('-e', "console.log('x'.repeat(2_000_000))"), 10_000)

    expect(outcome.kind === 'exited' && outcome.output.length).toBeLessThanOrEqual(64 * 1024)
  })
})

describe('the real runner', () => {
  it('starts programs with spawn and shell: false, never through exec or a shell option', () => {
    const source = readFileSync(new URL('./agentProbeNode.ts', import.meta.url), 'utf8')

    expect(source).toContain('shell: false')
    expect(source).not.toMatch(/shell:\s*true/)
    expect(source).not.toMatch(/\bexec(?:File)?(?:Sync)?\(/)
  })
})

describe('inspectExecutable', () => {
  it('accepts a regular file the system can run', () => {
    const file = join(scratch, 'tool.cmd')
    writeFileSync(file, '@echo off\r\n')
    chmodSync(file, 0o755)

    expect(inspectExecutable(file)).toBe('ok')
  })

  it('rejects a folder and a path that does not exist as not a file', () => {
    const folder = join(scratch, 'folder')
    mkdirSync(folder)

    expect(inspectExecutable(folder)).toBe('not_a_file')
    expect(inspectExecutable(join(scratch, 'nothing-here'))).toBe('not_a_file')
  })

  it.runIf(process.platform !== 'win32')('rejects a file without the execute permission', () => {
    const file = join(scratch, 'notes.txt')
    writeFileSync(file, 'hello')
    chmodSync(file, 0o644)

    expect(inspectExecutable(file)).toBe('not_executable')
  })
})

describe('probeAgent with the real runner', () => {
  const deps = {
    platform: process.platform,
    run: runProcess,
    inspect: inspectExecutable,
    ...(process.env['ComSpec'] === undefined ? {} : { comspec: process.env['ComSpec'] })
  }

  it('refuses a real program that is not the expected CLI', async () => {
    expect(await probeAgent('codex', process.execPath, deps)).toEqual({
      ok: false,
      code: 'wrong_program',
      reason: 'This is not the Codex CLI.'
    })
  })

  it('refuses a real file that is not a program', async () => {
    const file = join(scratch, 'plain.txt')
    writeFileSync(file, 'hello')

    expect(await probeAgent('claude', file, deps)).toMatchObject({ ok: false })
  })
})

describe.runIf(process.platform === 'win32')('probeAgent with a real Windows .cmd shim', () => {
  const deps = { platform: 'win32', run: runProcess, inspect: inspectExecutable, comspec: process.env['ComSpec'] ?? 'cmd.exe' }

  function makeShim(folder: string, body: string): string {
    const dir = join(scratch, folder)
    mkdirSync(dir, { recursive: true })
    const shim = join(dir, 'codex.cmd')
    writeFileSync(shim, body)
    return shim
  }

  it('connects a shim whose path has spaces, ampersands and parentheses', async () => {
    const shim = makeShim('Program Files (x86) & tools', '@echo off\r\necho codex-cli 9.9.9\r\n')

    expect(await probeAgent('codex', shim, deps)).toEqual({ ok: true, version: '9.9.9' })
  })

  it('does not let a command hidden in the path run', async () => {
    const shim = makeShim('x & echo INJECTED & y', '@echo off\r\necho codex-cli 1.2.3\r\n')

    const outcome = await runProcess(
      { file: deps.comspec, args: ['/d', '/v:off', '/s', '/c', `""${shim}" --version"`], verbatimArguments: true },
      10_000
    )

    expect(outcome).toMatchObject({ kind: 'exited', exitCode: 0 })
    expect(outcome.kind === 'exited' && outcome.output).toContain('codex-cli 1.2.3')
    expect(outcome.kind === 'exited' && outcome.output).not.toContain('INJECTED')
    expect(await probeAgent('codex', shim, deps)).toEqual({ ok: true, version: '1.2.3' })
  })

  it('refuses a shim path with a percent sign instead of letting cmd.exe expand it', async () => {
    const shim = makeShim('100%COMSPEC%', '@echo off\r\necho codex-cli 1.2.3\r\n')

    expect(await probeAgent('codex', shim, deps)).toMatchObject({ ok: false, code: 'unsafe_path' })
  })

  it('refuses a shim of another program', async () => {
    const shim = makeShim('other', '@echo off\r\necho 2.1.281 (Claude Code)\r\n')

    expect(await probeAgent('codex', shim, deps)).toMatchObject({ ok: false, code: 'wrong_program' })
  })
})
