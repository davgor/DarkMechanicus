import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getAgentAuthStatus, planSignIn } from './agentAuth'
import { launchTerminal } from './agentAuthNode'
import { inspectExecutable, runProcess } from './agentProbeNode'

/** The real launcher is exercised against Node itself, started detached with nothing to show. */
describe('launchTerminal', () => {
  it('resolves ok once the program has started, without waiting for it to finish', async () => {
    const started = Date.now()

    const outcome = await launchTerminal({
      file: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 1500)'],
      verbatimArguments: false
    })

    expect(outcome).toEqual({ ok: true })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('reports a program that does not exist with its error code, without throwing', async () => {
    const outcome = await launchTerminal({
      file: 'dm-no-such-terminal-program',
      args: [],
      verbatimArguments: false
    })

    expect(outcome).toEqual({ ok: false, code: 'ENOENT' })
  })
})

/**
 * A folder named like a command chain. DM-47 supports `&` in paths, so the path must reach the one
 * cmd.exe that parses it as a single quoted token: anything in it that ran would print INJECTED on a
 * line of its own. The stand-in CLI is a harmless `.cmd` that records the arguments it received.
 */
const HOSTILE_FOLDER = 'x & echo INJECTED & y'
const FAKE_CLI = ['@echo off', 'echo %*>"%~dp0args.txt"', 'echo Logged in using ChatGPT', ''].join('\r\n')

function outputLines(outcome: { kind: string; output?: string } | null): string[] {
  return (outcome?.output ?? '').split(/\r?\n/).map((line) => line.trim())
}

describe.skipIf(process.platform !== 'win32')('the Windows commands keep the path literal', () => {
  let scratch = ''
  let fakeCli = ''
  const argsFile = (): string => join(scratch, HOSTILE_FOLDER, 'args.txt')

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'dm-auth-'))
    mkdirSync(join(scratch, HOSTILE_FOLDER))
    fakeCli = join(scratch, HOSTILE_FOLDER, 'codex.cmd')
    writeFileSync(fakeCli, FAKE_CLI)
  })

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  const deps = (): Parameters<typeof planSignIn>[2] => ({
    platform: 'win32',
    inspect: inspectExecutable,
    ...(process.env['ComSpec'] === undefined ? {} : { comspec: process.env['ComSpec'] })
  })

  it('runs the planned sign-in command line: the stand-in gets exactly the login args and nothing else runs', async () => {
    const plan = planSignIn('codex', fakeCli, deps())
    const launch = plan.ok ? plan.launches[0] : undefined
    expect(launch).toBeDefined()

    // The console would stay open at a prompt; with no stdin it reads end-of-file and exits.
    const outcome = launch === undefined ? null : await runProcess(launch, 15_000)

    expect(outcome).toMatchObject({ kind: 'exited' })
    const lines = outputLines(outcome?.kind === 'exited' ? outcome : null)
    expect(lines).not.toContain('INJECTED')
    expect(lines).toContain('Logged in using ChatGPT')
    expect(readFileSync(argsFile(), 'utf8').trim()).toBe('login')
  })

  it('runs the status command line: the stand-in gets exactly the status args and nothing else runs', async () => {
    const outputs: string[] = []

    const status = await getAgentAuthStatus('codex', fakeCli, {
      ...deps(),
      run: async (launch, timeoutMs) => {
        const outcome = await runProcess(launch, timeoutMs)
        outputs.push(...outputLines(outcome.kind === 'exited' ? outcome : null))
        return outcome
      }
    })

    expect(status.state).toBe('signed_in')
    expect(outputs).not.toContain('INJECTED')
    expect(readFileSync(argsFile(), 'utf8').trim()).toBe('login status')
  })
})
