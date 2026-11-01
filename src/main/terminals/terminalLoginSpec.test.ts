/**
 * What main starts in an agent's sign-in terminal (`docs/design/chat-shells.md`, "Sign-in detection"): the agent's
 * registered executable with the CLI's own login command (`LOGIN_ARGS`) and nothing else, in the home folder, with
 * the scrubbed environment and no grant. Pure, like the chat's launch spec.
 */
import { describe, expect, it } from 'vitest'
import type { BuiltInAgentKind } from '../../shared/desktop/api'
import { LOGIN_ARGS } from '../desktop/agentAuth'
import { terminalLoginSpec, type TerminalLoginInput } from './terminalLaunchSpec'
import { windowsCommandLine } from './windowsCommandLine'

const KINDS: BuiltInAgentKind[] = ['claude', 'codex', 'cursor', 'autonomous']

const MAC_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/me',
  TERM: 'dumb',
  ELECTRON_RUN_AS_NODE: '1',
  ELECTRON_ENABLE_LOGGING: '1',
  NODE_OPTIONS: '--inspect',
  DM_SESSION_TOKEN: 'dmg_leaked',
  dm_session_token: 'dmg_leaked_too'
}

const MAC_PATHS: Record<BuiltInAgentKind, string> = {
  claude: '/Users/me/.local/bin/claude',
  codex: '/opt/homebrew/bin/codex',
  cursor: '/Users/me/.local/bin/agent',
  autonomous: '/Users/me/.local/bin/a8s'
}

function macInput(kind: BuiltInAgentKind): TerminalLoginInput {
  return { agent: { id: kind, kind, executablePath: MAC_PATHS[kind] }, home: '/Users/me', platform: 'darwin', env: MAC_ENV }
}

const NATIVE_SHIM = 'endLocal & "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*'

describe('terminalLoginSpec', () => {
  it('names each kind its own login command, with no key, token, email or password option', () => {
    expect(LOGIN_ARGS).toEqual({ claude: ['auth', 'login'], codex: ['login'], cursor: ['login'], autonomous: ['init'] })
    for (const args of Object.values(LOGIN_ARGS)) {
      expect(args.every((arg) => /^[a-z]+$/.test(arg))).toBe(true)
    }
  })

  it.each(KINDS)('%s: runs the registered executable with only its login arguments, in the home folder', (kind) => {
    const spec = terminalLoginSpec(macInput(kind))

    expect(spec.file).toBe(MAC_PATHS[kind])
    expect(spec.args).toEqual([...LOGIN_ARGS[kind]])
    expect(spec.commandLine).toBeUndefined()
    expect(spec.cwd).toBe('/Users/me')
  })

  it('starts with the scrubbed environment and no grant: no Electron or Node switch, no DM_SESSION_TOKEN in any case', () => {
    const { env } = terminalLoginSpec(macInput('claude'))

    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/Users/me', TERM: 'xterm-256color', COLORTERM: 'truecolor' })
  })

  it('refuses a custom CLI: the app has no login command for it', () => {
    expect(() => terminalLoginSpec({ ...macInput('claude'), agent: { id: 'cu_01', kind: 'custom', executablePath: '/opt/mine' } })).toThrow(/no sign-in command/)
  })

  it('on Windows, quotes an .exe line as Node does, and follows a Claude .cmd to the program it runs', () => {
    const env = { Path: 'C:\\Windows', SystemRoot: 'D:\\Windows', ELECTRON_RUN_AS_NODE: '1' }
    const exe = terminalLoginSpec({ agent: { id: 'codex', kind: 'codex', executablePath: 'C:\\Tools\\codex.exe' }, home: 'C:\\Users\\me', platform: 'win32', env })
    const claude = terminalLoginSpec({
      agent: { id: 'claude', kind: 'claude', executablePath: 'C:\\npm\\claude.cmd' },
      home: 'C:\\Users\\me',
      platform: 'win32',
      env,
      shimFs: { readFile: () => NATIVE_SHIM, isFile: () => false }
    })

    expect([exe.file, exe.commandLine, exe.cwd]).toEqual(['C:\\Tools\\codex.exe', windowsCommandLine(['login']), 'C:\\Users\\me'])
    expect([claude.file, claude.commandLine]).toEqual(['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', windowsCommandLine(['auth', 'login'])])
    expect(exe.env['ELECTRON_RUN_AS_NODE']).toBeUndefined()
  })

  it('on Windows, runs an Autonomous .cmd through the one cmd.exe parse', () => {
    const spec = terminalLoginSpec({
      agent: { id: 'autonomous', kind: 'autonomous', executablePath: 'C:\\npm\\a8s.cmd' },
      home: 'C:\\Users\\me',
      platform: 'win32',
      env: { Path: 'C:\\Windows', SystemRoot: 'D:\\Windows' }
    })

    expect(spec.file).toBe('D:\\Windows\\System32\\cmd.exe')
    expect(spec.commandLine).toBe('/d /v:off /s /c ""C:\\npm\\a8s.cmd" init"')
  })
})
