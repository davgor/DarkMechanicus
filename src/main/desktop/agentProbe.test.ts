import { describe, expect, it } from 'vitest'
import type { AgentKind } from '../../shared/desktop/api'
import {
  agentDialogOptions,
  probeAgent,
  type AgentProbeDeps,
  type FileCheck,
  type ProbeLaunch,
  type ProcessOutcome
} from './agentProbe'

interface Harness {
  deps: AgentProbeDeps
  /** Every launch the fake runner was asked to run, in order. */
  launches: ProbeLaunch[]
  /** The timeout each launch was given. */
  timeouts: number[]
}

interface HarnessOptions {
  platform?: string
  inspect?: FileCheck
  timeoutMs?: number
}

const COMSPEC = 'C:\\Windows\\System32\\cmd.exe'

/** A probe with a fake process runner that answers every launch with `outcome`; nothing is spawned. */
function harness(outcome: ProcessOutcome, options: HarnessOptions = {}): Harness {
  const launches: ProbeLaunch[] = []
  const timeouts: number[] = []
  const deps: AgentProbeDeps = {
    platform: options.platform ?? 'linux',
    comspec: COMSPEC,
    inspect: () => options.inspect ?? 'ok',
    run: (launch, timeoutMs) => {
      launches.push(launch)
      timeouts.push(timeoutMs)
      return Promise.resolve(outcome)
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  }
  return { deps, launches, timeouts }
}

function exited(output: string, exitCode = 0): ProcessOutcome {
  return { kind: 'exited', exitCode, output }
}

/** What each real CLI prints for its version flag (the assumption documented in agentProbe.ts). */
const VERSION_OUTPUT: Record<AgentKind, string> = {
  claude: '2.1.281 (Claude Code)\n',
  codex: 'codex-cli 0.46.0\n',
  cursor: '2025.09.18-7ae6800\n'
}

const KINDS: AgentKind[] = ['claude', 'codex', 'cursor']

const CLI_NAMES: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' }

const IDENTIFIED: [AgentKind, string, string | null][] = [
  ['claude', '2.1.281 (Claude Code)\n', '2.1.281'],
  ['claude', 'Claude Code v3.0.0-beta.1\n', '3.0.0-beta.1'],
  ['claude', 'Claude Code\n', null],
  ['codex', 'codex-cli 0.46.0\n', '0.46.0'],
  ['codex', 'codex 1.2.3\r\n', '1.2.3'],
  ['cursor', '2025.09.18-7ae6800\n', '2025.09.18-7ae6800'],
  ['cursor', 'cursor-agent 1.0.2\n', '1.0.2']
]

describe('probeAgent identification', () => {
  it.each(IDENTIFIED)('identifies %s from %j and records its version', async (kind, output, version) => {
    const { deps } = harness(exited(output))

    expect(await probeAgent(kind, '/usr/local/bin/tool', deps)).toEqual({ ok: true, version })
  })

  it('looks past warnings and colour codes printed before the version', async () => {
    const output = '(node:42) [DEP0040] DeprecationWarning: punycode\n\u001b[1m2.1.281\u001b[0m (Claude Code)\n'
    const { deps } = harness(exited(output))

    expect(await probeAgent('claude', '/bin/claude', deps)).toEqual({ ok: true, version: '2.1.281' })
  })

  it('asks for the version flag with no other arguments', async () => {
    const { deps, launches } = harness(exited(VERSION_OUTPUT.codex))

    await probeAgent('codex', '/opt/codex', deps)

    expect(launches).toEqual([{ file: '/opt/codex', args: ['--version'], verbatimArguments: false }])
  })
})

describe('probeAgent refuses a different program', () => {
  it.each(KINDS)('says it is not the %s CLI when another agent answers', async (kind) => {
    const other = KINDS.find((candidate) => candidate !== kind) ?? 'claude'
    const { deps } = harness(exited(VERSION_OUTPUT[other]))

    expect(await probeAgent(kind, '/bin/other', deps)).toEqual({
      ok: false,
      code: 'wrong_program',
      reason: `This is not the ${CLI_NAMES[kind]} CLI.`
    })
  })

  it.each([['hello world 1.0.0\n'], ['Usage: tool [options]\n'], ['']])('refuses unrelated output %j', async (output) => {
    const { deps } = harness(exited(output))

    const result = await probeAgent('codex', '/bin/tool', deps)

    expect(result).toEqual({ ok: false, code: 'wrong_program', reason: 'This is not the Codex CLI.' })
  })

  it('does not accept the product name appearing mid-line in unrelated text', async () => {
    const { deps } = harness(exited('wrapper for codex 1.0.0\n'))

    expect(await probeAgent('codex', '/bin/wrapper', deps)).toMatchObject({ ok: false, code: 'wrong_program' })
  })

  it('refuses a program that exits with an error even when it names the CLI', async () => {
    const { deps } = harness(exited('2.1.281 (Claude Code)\n', 3))

    expect(await probeAgent('claude', '/bin/claude', deps)).toEqual({
      ok: false,
      code: 'failed',
      reason: 'It exited with an error (code 3) when asked for its version.'
    })
  })
})

describe('probeAgent refuses what cannot run', () => {
  it('refuses a program that runs past the timeout', async () => {
    const { deps } = harness({ kind: 'timed_out' })

    expect(await probeAgent('claude', '/bin/slow', deps)).toEqual({
      ok: false,
      code: 'timed_out',
      reason: 'It timed out.'
    })
  })

  it.each(['EACCES', 'EPERM', 'ENOEXEC'])('treats a %s start failure as a non-executable file', async (code) => {
    const { deps } = harness({ kind: 'spawn_failed', code, message: `spawn ${code}` })

    expect(await probeAgent('claude', '/bin/file', deps)).toEqual({
      ok: false,
      code: 'not_executable',
      reason: 'That file is not executable.'
    })
  })

  it('reports a program that did not start', async () => {
    const { deps } = harness({ kind: 'spawn_failed', code: 'ENOENT', message: 'spawn ENOENT' })

    expect(await probeAgent('claude', '/bin/gone', deps)).toEqual({
      ok: false,
      code: 'did_not_start',
      reason: 'It did not start (ENOENT).'
    })
  })

  it.each<[FileCheck, string, string]>([
    ['not_a_file', 'not_a_file', 'That is not a file.'],
    ['not_executable', 'not_executable', 'That file is not executable.']
  ])('refuses a pick the file check calls %s without running it', async (inspect, code, reason) => {
    const { deps, launches } = harness(exited(VERSION_OUTPUT.claude), { inspect })

    expect(await probeAgent('claude', '/home/me/notes.txt', deps)).toEqual({ ok: false, code, reason })
    expect(launches).toEqual([])
  })

  it('refuses a relative path without running it', async () => {
    const { deps, launches } = harness(exited(VERSION_OUTPUT.claude))

    expect(await probeAgent('claude', 'bin/claude', deps)).toMatchObject({ ok: false, code: 'not_a_file' })
    expect(launches).toEqual([])
  })
})

describe('probeAgent timeout', () => {
  it('gives the runner a short, bounded timeout by default', async () => {
    const { deps, timeouts } = harness(exited(VERSION_OUTPUT.claude))

    await probeAgent('claude', '/bin/claude', deps)

    expect(timeouts).toHaveLength(1)
    expect(timeouts[0]).toBeGreaterThan(0)
    expect(timeouts[0]).toBeLessThanOrEqual(15_000)
  })

  it('uses the timeout it is given', async () => {
    const { deps, timeouts } = harness(exited(VERSION_OUTPUT.claude), { timeoutMs: 250 })

    await probeAgent('claude', '/bin/claude', deps)

    expect(timeouts).toEqual([250])
  })
})

describe('probeAgent never uses a shell off Windows', () => {
  it('passes a hostile path as one argv entry, not as text to interpret', async () => {
    const path = '/tmp/a b; rm -rf ~ & echo $(id) `id` | tee x.cmd'
    const { deps, launches } = harness(exited(VERSION_OUTPUT.claude))

    await probeAgent('claude', path, deps)

    expect(launches).toEqual([{ file: path, args: ['--version'], verbatimArguments: false }])
    expect('shell' in (launches[0] ?? {})).toBe(false)
  })

  it('runs a file named like a Windows shim directly on other platforms', async () => {
    const { deps, launches } = harness(exited(VERSION_OUTPUT.claude), { platform: 'darwin' })

    await probeAgent('claude', '/Users/me/bin/claude.cmd', deps)

    expect(launches[0]?.file).toBe('/Users/me/bin/claude.cmd')
  })
})

describe('probeAgent on Windows', () => {
  it('runs an .exe directly', async () => {
    const { deps, launches } = harness(exited(VERSION_OUTPUT.claude), { platform: 'win32' })

    const result = await probeAgent('claude', 'C:\\Users\\me\\.local\\bin\\claude.exe', deps)

    expect(result).toEqual({ ok: true, version: '2.1.281' })
    expect(launches).toEqual([
      { file: 'C:\\Users\\me\\.local\\bin\\claude.exe', args: ['--version'], verbatimArguments: false }
    ])
  })

  it('refuses a file that is not a Windows program', async () => {
    const { deps, launches } = harness(exited(VERSION_OUTPUT.claude), { platform: 'win32' })

    const result = await probeAgent('claude', 'C:\\Users\\me\\Documents\\notes.txt', deps)

    expect(result).toEqual({
      ok: false,
      code: 'not_executable',
      reason: 'That file is not a program Windows can run (.exe or .cmd).'
    })
    expect(launches).toEqual([])
  })

  it('refuses a relative path', async () => {
    const { deps, launches } = harness(exited(VERSION_OUTPUT.claude), { platform: 'win32' })

    expect(await probeAgent('claude', 'bin\\claude.exe', deps)).toMatchObject({ ok: false, code: 'not_a_file' })
    expect(launches).toEqual([])
  })
})

describe('probeAgent on a Windows .cmd shim', () => {
  const SHIM = 'C:\\Program Files\\npm & tools\\codex.cmd'

  it('probes the shim through cmd.exe with only the quoted path as user-controlled text', async () => {
    const { deps, launches } = harness(exited(VERSION_OUTPUT.codex), { platform: 'win32' })

    const result = await probeAgent('codex', SHIM, deps)

    expect(result).toEqual({ ok: true, version: '0.46.0' })
    expect(launches).toEqual([
      {
        file: COMSPEC,
        args: ['/d', '/v:off', '/s', '/c', `""${SHIM}" --version"`],
        verbatimArguments: true
      }
    ])
  })

  it('keeps the path out of everything but the single quoted command string', async () => {
    const { deps, launches } = harness(exited(VERSION_OUTPUT.codex), { platform: 'win32' })

    await probeAgent('codex', SHIM, deps)

    const launch = launches[0]
    const everythingElse = [launch?.file, ...(launch?.args.slice(0, -1) ?? [])].join(' ')
    expect(everythingElse).not.toContain('&')
    expect(everythingElse).not.toContain('Program Files')
    expect(launch?.args.at(-1)).toBe(`""${SHIM}" --version"`)
    expect('shell' in (launch ?? {})).toBe(false)
  })

  it.each(['C:\\x\\codex.CMD', 'C:\\x\\codex.bat'])('treats %s as a shim too', async (path) => {
    const { deps, launches } = harness(exited(VERSION_OUTPUT.codex), { platform: 'win32' })

    await probeAgent('codex', path, deps)

    expect(launches[0]?.file).toBe(COMSPEC)
    expect(launches[0]?.args.at(-1)).toBe(`""${path}" --version"`)
  })

  it('falls back to cmd.exe when no ComSpec is given', async () => {
    const { deps, launches } = harness(exited(VERSION_OUTPUT.codex), { platform: 'win32' })
    const { comspec: _unused, ...withoutComspec } = deps

    await probeAgent('codex', SHIM, withoutComspec)

    expect(launches[0]?.file).toBe('cmd.exe')
  })
})

describe('probeAgent refuses a shim path cmd.exe could misread', () => {
  it.each([
    ['percent expansion', 'C:\\x\\%COMSPEC%\\codex.cmd'],
    ['a quote that ends the quoted path', 'C:\\x" & calc & "\\codex.cmd'],
    ['a line break', 'C:\\x\ncalc\\codex.cmd'],
    ['a NUL', 'C:\\x\u0000\\codex.cmd']
  ])('refuses %s without running anything', async (_label, path) => {
    const { deps, launches } = harness(exited(VERSION_OUTPUT.codex), { platform: 'win32' })

    const result = await probeAgent('codex', path, deps)

    expect(result).toMatchObject({ ok: false, code: 'unsafe_path' })
    expect(launches).toEqual([])
  })

  it('does not apply the shell limits to an .exe, which no shell sees', async () => {
    const { deps } = harness(exited(VERSION_OUTPUT.codex), { platform: 'win32' })

    expect(await probeAgent('codex', 'C:\\100%\\codex.exe', deps)).toEqual({ ok: true, version: '0.46.0' })
  })
})

describe('agentDialogOptions', () => {
  it('lists the Windows program types first and names the expected files in the title', () => {
    const options = agentDialogOptions('claude', 'win32')

    expect(options.title).toBe('Locate the Claude Code CLI (claude.exe or claude.cmd)')
    expect(options.filters).toEqual([
      { name: 'Programs', extensions: ['exe', 'cmd'] },
      { name: 'All files', extensions: ['*'] }
    ])
    expect(options.properties).toEqual(['openFile', 'showHiddenFiles'])
  })

  it('names every executable Cursor may be installed under', () => {
    expect(agentDialogOptions('cursor', 'darwin').title).toBe('Locate the Cursor CLI (agent or cursor-agent)')
  })

  it('shows all files where executables have no extension to filter on', () => {
    expect(agentDialogOptions('codex', 'linux').filters).toEqual([{ name: 'All files', extensions: ['*'] }])
  })

  it('only ever picks a file, never a folder', () => {
    for (const kind of KINDS) {
      expect(agentDialogOptions(kind, 'win32').properties).not.toContain('openDirectory')
    }
  })
})
