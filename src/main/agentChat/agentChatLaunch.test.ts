import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SHIM_HELP } from '../terminals/claudeExecutable'
import { claudeProjectName, claudeSessionExists } from '../terminals/claudeSession'
import { claudeSettings, writeClaudeSettings } from '../terminals/claudeSettingsFile'
import { ompSessionId } from '../terminals/ompSession'
import { instructionsTextFor, terminalLaunchSpec, windowsAgentProgram } from '../terminals/terminalLaunchSpec'
import { terminalInstructions } from '../terminals/terminalFiles'
import { agentChatLaunch, type AgentChatLaunchInput } from './agentChatLaunch'

const SESSION = '0b6f6c1e-3c58-4f8e-9a0b-3d2f4b7c9e11'
const FRESH = '7d1c2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
const KICKOFF = 'Run the epic now.'
const TOKEN = 'dmg_fixture_not_a_real_grant'
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dm-agent-launch-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function inputFor(kind: 'claude' | 'omp', platform: 'win32' | 'darwin' = 'win32'): AgentChatLaunchInput {
  const folder = join(root, 'repo')
  return {
    chat: { id: 'ch_test', folder, agent: kind, model: 'haiku', role: 'orchestrator', allowSave: false, title: 'Test', createdAt: '', updatedAt: '', sessionId: SESSION, sessionStarted: false, kickoffSent: false },
    agent: { id: kind, kind, displayName: kind, executablePath: platform === 'win32' ? `C:\\bin\\${kind}.exe` : `/bin/${kind}`, args: [], version: null, needsReview: false, connectedVia: 'found', connectedAt: '', lastProbed: '' },
    folder,
    grant: { command: process.execPath, args: [join(root, 'out', 'cli.js'), '--repo', folder], env: { DM_SESSION_TOKEN: TOKEN } },
    paths: { instructions: join(root, 'instructions.md'), launcherDir: platform === 'win32' ? null : '/app/agents/bin/ch_test', ...(kind === 'omp' ? { omp: { sessionDir: join(root, 'sessions'), config: join(root, 'config.yml'), extension: join(root, 'extension.ts'), dmClient: join(root, 'dm-client.json') } } : {}) },
    platform, env: { HOME: root, USERPROFILE: root, TERM: 'dumb', term: 'xterm', COLORTERM: 'truecolor', colorterm: 'other', dm_session_token: 'foreign', DM_SKITARII_CLIENT_DESCRIPTOR: 'foreign', NODE_OPTIONS: '--inspect', ELECTRON_ENABLE_LOGGING: '1' },
    newSessionId: () => FRESH, kickoff: KICKOFF
  }
}

/** Main's preparation uses the existing disk probes, not a renderer-provided resume flag. */
function prepareResume(input: AgentChatLaunchInput, exists: boolean): void {
  if (input.agent.kind === 'claude') {
    if (exists) {
      const project = join(root, '.claude', 'projects', claudeProjectName(input.folder))
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, `${SESSION}.jsonl`), '{}\n')
    }
    input.chat.sessionStarted = claudeSessionExists({ env: input.env, platform: input.platform, folder: input.folder, sessionId: SESSION })
  } else {
    const sessionDir = input.paths.omp!.sessionDir
    if (exists) {
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, `2026-11-24T00-00-00-000Z_${SESSION}.jsonl`), '{}\n')
    }
    input.chat.sessionId = ompSessionId(sessionDir)
    input.chat.sessionStarted = input.chat.sessionId !== null
  }
}

function expectedArgs(input: AgentChatLaunchInput, resumed: boolean): (string | undefined)[] {
  return input.agent.kind === 'claude' ? [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--forward-subagent-text', '--permission-prompt-tool', 'stdio',
    '--append-system-prompt-file', input.paths.instructions, '--settings', input.paths.claudeSettings,
    '--model', 'haiku', resumed ? '--resume' : '--session-id', SESSION
  ] : [
    '--mode', 'rpc-ui', '--cwd', input.folder, '--append-system-prompt', input.paths.instructions,
    '--config', input.paths.omp!.config, '-e', input.paths.omp!.extension, '--session-dir', input.paths.omp!.sessionDir,
    '--model', 'haiku', ...(resumed ? ['--resume', SESSION] : [])
  ]
}

describe('agentChatLaunch', () => {
  it.each((['win32', 'darwin'] as const).flatMap(platform => (['claude', 'omp'] as const).flatMap(kind => [false, true].map(resumed => ({ platform, kind, resumed })))))
    ('builds exact $kind argv, resumed=$resumed on $platform', ({ platform, kind, resumed }) => {
      const input = inputFor(kind, platform)
      prepareResume(input, resumed)
      input.paths.claudeSettings = kind === 'claude' ? join(root, 'settings.json') : undefined
      const spec = agentChatLaunch(input)
      expect(spec.args).toEqual(expectedArgs(input, resumed))
      expect(spec).toMatchObject({ file: input.agent.executablePath, cwd: input.folder, resumed, protocol: kind, sessionId: kind === 'claude' || resumed ? SESSION : null, firstMessage: resumed ? null : KICKOFF })
      expect(spec.args.join(' ')).not.toContain(TOKEN)
      expect(spec.args).not.toContain(KICKOFF)
      for (const flag of ['--bare', '--no-session-persistence', '--dangerously-skip-permissions']) expect(spec.args).not.toContain(flag)
      expect(Object.keys(spec.env).some(key => /^(?:TERM|COLORTERM|NODE_OPTIONS|ELECTRON_.*)$/i.test(key))).toBe(false)
      expect(spec.env['DM_SESSION_TOKEN']).toBe(TOKEN)
      expect(spec.env['dm_session_token']).toBeUndefined()
      expect(spec.env['DM_SKITARII_CLIENT_DESCRIPTOR']).toBe(input.paths.omp?.dmClient)
      if (platform === 'darwin') expect(spec.env['PATH']).toBe(input.paths.launcherDir)
    })

})

describe('shared launch files', () => {
  it.each(['win32', 'darwin'] as const)('uses exactly the terminal settings path and memory-guard content on %s', async platform => {
    const input = inputFor('claude', platform)
    const options = { userData: root, chatId: input.chat.id, platform, folder: input.folder, cli: input.grant, home: root, tmp: root }
    input.paths.claudeSettings = await writeClaudeSettings(options)
    const before = readFileSync(input.paths.claudeSettings, 'utf8')
    const terminal = terminalLaunchSpec({ ...input, cli: input.grant, files: input.paths })
    const gui = agentChatLaunch(input)
    expect(gui.args[gui.args.indexOf('--settings') + 1]).toBe(input.paths.claudeSettings)
    if (terminal.args !== undefined) expect(terminal.args[terminal.args.indexOf('--settings') + 1]).toBe(input.paths.claudeSettings)
    else expect(terminal.commandLine).toContain(input.paths.claudeSettings)
    expect(readFileSync(gui.args[gui.args.indexOf('--settings') + 1]!, 'utf8')).toBe(before)
    expect(JSON.parse(before)).toEqual(claudeSettings(options))
    expect(JSON.parse(before).hooks.PreToolUse[0].hooks[0].type).toBe('command')
    expect(instructionsTextFor({ chat: input.chat, cli: input.grant }, input.paths.launcherDir)).toBe(terminalInstructions({ cli: input.grant, role: input.chat.role, allowSave: input.chat.allowSave, launcherDir: input.paths.launcherDir, orchestratesRun: false }))
  })

})

describe('Windows GUI programs', () => {
  it.each(['claude', 'omp'] as const)('follows a Windows %s npm shim to node.exe and its JS target without a shell', kind => {
    const input = inputFor(kind)
    input.agent.executablePath = `C:\\npm\\${kind}.cmd`
    const script = win32.join('C:\\npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    input.shimFs = { readFile: () => '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*', isFile: path => path === 'C:\\npm\\node.exe' }
    const spec = agentChatLaunch(input)
    expect(spec.file).toBe('C:\\npm\\node.exe')
    expect(spec.args[0]).toBe(script)
    expect(spec.args[1]).toBe(kind === 'claude' ? '-p' : '--mode')
    expect(spec).not.toHaveProperty('shell')
    expect(windowsAgentProgram(input.agent, input.env, 'win32', input.shimFs)).toEqual({ file: spec.file, leading: [script], viaShim: false })
  })

  it.each(['claude', 'omp'] as const)('finds node.exe on the existing case-insensitive Path for a followed %s shim', kind => {
    const input = inputFor(kind)
    input.agent.executablePath = `C:\\npm\\${kind}.cmd`
    input.env = { Path: 'C:\\runtime;C:\\Windows' }
    input.shimFs = { readFile: () => '"%dp0%\\cli.js"', isFile: path => path === 'C:\\runtime\\node.exe' }
    expect(agentChatLaunch(input).file).toBe('C:\\runtime\\node.exe')
  })

  it.each(['claude', 'omp'] as const)('refuses an unresolved %s .cmd instead of spawning a shell', kind => {
    const input = inputFor(kind)
    input.agent.executablePath = `C:\\bin\\${kind}.cmd`
    input.shimFs = { readFile: () => 'not a followable npm shim', isFile: () => false }
    expect(() => agentChatLaunch(input)).toThrow(SHIM_HELP)
  })

  it.each(['claude', 'omp'] as const)('refuses a followable %s shim without an absolute node.exe', kind => {
    const input = inputFor(kind)
    input.agent.executablePath = `C:\\npm\\${kind}.cmd`
    input.env = { Path: 'relative;C:\\runtime' }
    input.shimFs = { readFile: () => '"%dp0%\\cli.js"', isFile: () => false }
    expect(() => agentChatLaunch(input)).toThrow(/node\.exe/)
  })

})

describe('launch input boundaries', () => {
  it('returns literal kickoff text separately, including option-like first prompts', () => {
    const input = inputFor('claude')
    input.chat.firstPrompt = '--do-not-parse-as-an-option'
    expect(agentChatLaunch(input).firstMessage).toBe(input.chat.firstPrompt)
    expect(agentChatLaunch(input).args).not.toContain(input.chat.firstPrompt)
    input.chat.kickoffSent = true
    expect(agentChatLaunch(input).firstMessage).toBeNull()
    input.chat.kickoffSent = false
    for (const delivery of ['submitted', 'uncertain'] as const) {
      input.chat.firstPromptDelivery = delivery
      expect(agentChatLaunch(input).firstMessage).toBeNull()
    }
  })

  it('mints a fresh Claude UUID for a missing or invalid stored id and omits unsafe/default models', () => {
    const input = inputFor('claude')
    for (const sessionId of [null, '--invalid']) {
      input.chat.sessionId = sessionId
      input.chat.model = '--bad-model'
      const spec = agentChatLaunch(input)
      expect(spec.args.slice(-2)).toEqual(['--session-id', FRESH])
      expect(spec.args).not.toContain('--model')
    }
    input.chat.model = 'default'
    expect(agentChatLaunch(input).args).not.toContain('--model')
    input.newSessionId = () => '--invalid'
    expect(() => agentChatLaunch(input)).toThrow('UUID')
  })

  it('refuses mismatched agents, unsupported kinds and an unpinned grant', () => {
    const input = inputFor('claude')
    expect(() => agentChatLaunch({ ...input, chat: { ...input.chat, agent: 'omp' } })).toThrow('do not match')
    expect(() => agentChatLaunch({ ...input, agent: { ...input.agent, kind: 'codex' } })).toThrow('no GUI protocol')
    input.grant.args = [join(root, 'cli.js'), '--repo', join(root, 'other')]
    expect(() => agentChatLaunch(input)).toThrow()
  })
})
