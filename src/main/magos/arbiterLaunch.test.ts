import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SHIM_HELP } from '../terminals/agentExecutable'
import { arbiterLaunch } from './arbiterLaunch'

type Input = Parameters<typeof arbiterLaunch>[0]
const SYSTEM = 'Return strict JSON.\nLiteral {folder} "quotes" & --resume stay text.'
const REQUEST = 'Private approval request must travel on stdin only.'
let tempDir: string
beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'dm-arbiter-launch-')) })
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }) })

function inputFor(kind: 'claude' | 'omp', platform: NodeJS.Platform = 'win32'): Input {
  return {
    agent: { kind, executablePath: platform === 'win32' ? win32.join('C:\\bin', `${kind}.exe`) : join('/usr', 'bin', kind) },
    platform, tempDir, systemPrompt: SYSTEM, ompConfig: kind === 'omp' ? join(tempDir, 'candidate overlay.yml') : undefined,
    baseEnv: { DM_SESSION_TOKEN: 'foreign-grant', DM_DESKTOP_PIPE: 'foreign-pipe', ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1', TERM: 'xterm', COLORTERM: 'truecolor' }
  }
}

const FORBIDDEN = ['--permission-prompt-tool', '--resume', '--session-id', '--settings', '--append-system-prompt-file', '--input-format', '--dangerously-skip-permissions', '--bare', '-e', '--extension']

describe('arbiterLaunch', () => {
  it.each(['win32', 'darwin', 'linux'] as const)('builds exact Claude argv including empty tools and safe-mode on %s', platform => {
    const input = inputFor('claude', platform)
    const spec = arbiterLaunch(input)
    expect(spec.args).toEqual(['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--safe-mode', '--system-prompt', SYSTEM])
    expect(spec.args[spec.args.indexOf('--tools') + 1]).toBe('')
    expect(spec.args).toContain('--safe-mode')
    expect(spec).toMatchObject({ file: input.agent.executablePath, cwd: tempDir, protocol: 'claude', env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } })
    expect(readdirSync(tempDir)).toEqual([])
  })

  it('builds candidate OMP argv with a required overlay and without the Skitarii extension', () => {
    const input = inputFor('omp')
    const spec = arbiterLaunch(input)
    expect(spec.args).toEqual(['-p', '--mode', 'text', '--no-session', '--no-tools', '--no-lsp', '--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-title', '--max-time', '60', '--system-prompt', SYSTEM, '--cwd', tempDir, '--config', input.ompConfig])
    expect(spec).toMatchObject({ file: input.agent.executablePath, cwd: tempDir, protocol: 'omp', env: { PI_FORCE_HYPERLINKS: '1', PI_FORCE_SYNC_OUTPUT: '1' } })
  })

  it.each([undefined, ''])('refuses an OMP candidate without an overlay (config=%s)', ompConfig => {
    expect(() => arbiterLaunch({ ...inputFor('omp'), ompConfig })).toThrow('An OMP arbiter candidate requires a config overlay')
  })

  it.each(['claude', 'omp'] as const)('passes only the system prompt once, no request/extra agent args or capabilities for %s', kind => {
    const input = inputFor(kind)
    const spec = arbiterLaunch({ ...input, agent: { ...input.agent, args: ['--resume', REQUEST] }, request: REQUEST } as Input)
    expect(spec.args.filter(arg => arg === SYSTEM)).toHaveLength(1)
    expect(spec.args).not.toContain(REQUEST)
    for (const flag of FORBIDDEN) expect(spec.args).not.toContain(flag)
    expect(spec.env).toEqual(kind === 'claude' ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : { PI_FORCE_HYPERLINKS: '1', PI_FORCE_SYNC_OUTPUT: '1' })
    expect(spec).not.toHaveProperty('shell')
    expect(spec.cwd).toBe(tempDir)
  })

  it.each(['codex', 'cursor', 'autonomous', 'custom'] as const)('refuses unsupported %s rather than silently using another kind', kind => {
    const input = inputFor('claude')
    input.agent.kind = kind
    expect(() => arbiterLaunch(input)).toThrow('This agent has no arbiter protocol.')
  })
})

describe('Windows arbiter program resolution', () => {
  it.each([true, false])('follows an npm .cmd to node.exe and the .js target, adjacent node=%s', adjacent => {
    const input = inputFor('claude')
    input.agent.executablePath = 'C:\\npm\\claude.cmd'
    input.baseEnv = { Path: 'C:\\runtime;C:\\Windows' }
    const node = adjacent ? 'C:\\npm\\node.exe' : 'C:\\runtime\\node.exe'
    const script = win32.join('C:\\npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    input.shimFs = { readFile: () => '@echo off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n', isFile: path => path === node }
    const spec = arbiterLaunch(input)
    expect(spec.file).toBe(node)
    expect(spec.args.slice(0, 2)).toEqual([script, '-p'])
    expect(spec.args.filter(arg => arg === SYSTEM)).toHaveLength(1)
    expect(spec).not.toHaveProperty('shell')
  })

  it.each(['claude', 'omp'] as const)('refuses unresolved %s shims with existing guidance', kind => {
    const input = inputFor(kind)
    input.agent.executablePath = win32.join('C:\\bin', `${kind}.cmd`)
    input.shimFs = { readFile: () => 'not a followable shim', isFile: () => false }
    expect(() => arbiterLaunch(input)).toThrow(SHIM_HELP)
  })
})
