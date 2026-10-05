import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { AGENT_KINDS } from '../../shared/desktop/agentKinds'
import type { AgentAuthStatus, AgentKind, AgentView } from '../../shared/desktop/api'
import {
  createAgentAuthHandlers,
  getAgentAuthStatus,
  planSignIn,
  signInAgent,
  type TerminalLaunch,
  type TerminalOutcome
} from './agentAuth'
import type { FileCheck, ProbeLaunch, ProcessOutcome } from './agentProbe'

/**
 * Recorded outputs of each CLI's own status command. Where each sample came from:
 * - Claude Code signed out: a real run of `claude auth status` on a Windows install (2.1.x), exit 1,
 *   with the local directory paths removed. The signed-in sample is the same document with
 *   `loggedIn: true` and the account fields Claude Code adds (a signed-in account is not available
 *   on the machine these were recorded on, so that one is built from the same shape, not recorded).
 * - Codex: the messages in `run_login_status` of openai/codex (codex-rs/cli/src/login.rs): every
 *   message goes to stderr, exit 0 when signed in and 1 for "Not logged in" and for errors.
 * - Cursor: the vendor documents the `agent status` command but not its wording, so these are
 *   assumed shapes, not recordings; the classifier is deliberately tolerant of them.
 */
const CLAUDE_SIGNED_OUT = `{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty",
  "analyticsDisabled": false
}
`
const CLAUDE_SIGNED_IN = `{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "dev@example.com",
  "orgName": "Example Org",
  "subscriptionType": "max"
}
`
const CODEX_CHATGPT = 'Logged in using ChatGPT\n'
const CODEX_API_KEY = 'Logged in using an API key - sk-proj-***tUvW\n'
const CODEX_SIGNED_OUT = 'Not logged in\n'
const CODEX_ERROR = 'Error checking login status: failed to read the auth file\n'
const CURSOR_SIGNED_IN = '✓ Logged in as dev@example.com\n'
const CURSOR_SIGNED_OUT = '✗ Not logged in\nRun `agent login` to authenticate.\n'
const CURSOR_NOT_AUTHENTICATED = 'Not authenticated\n'
const CURSOR_ERROR = 'Error: could not reach api2.cursor.sh\n'

const POSIX_PATHS: Record<AgentKind, string> = {
  claude: '/home/me/.local/bin/claude',
  codex: '/usr/local/bin/codex',
  cursor: '/home/me/.local/bin/agent'
}

interface Run {
  launches: ProbeLaunch[]
  outcome: ProcessOutcome
}

function statusWorld(
  outcome: ProcessOutcome,
  options: { platform?: string; inspect?: FileCheck } = {}
): { run: Run; deps: Parameters<typeof getAgentAuthStatus>[2] } {
  const run: Run = { launches: [], outcome }
  return {
    run,
    deps: {
      platform: options.platform ?? 'linux',
      inspect: () => options.inspect ?? 'ok',
      run: (launch) => {
        run.launches.push(launch)
        return Promise.resolve(run.outcome)
      },
      comspec: 'C:\\Windows\\System32\\cmd.exe'
    }
  }
}

function exited(exitCode: number, output: string): ProcessOutcome {
  return { kind: 'exited', exitCode, output }
}

async function statusOf(kind: AgentKind, outcome: ProcessOutcome): Promise<AgentAuthStatus> {
  return getAgentAuthStatus(kind, POSIX_PATHS[kind], statusWorld(outcome).deps)
}

describe('status maps each CLI output to signed_in, signed_out or unknown', () => {
  it.each([
    ['claude', 0, CLAUDE_SIGNED_IN, 'signed_in'],
    ['claude', 1, CLAUDE_SIGNED_OUT, 'signed_out'],
    ['claude', 0, CLAUDE_SIGNED_OUT, 'signed_out'],
    ['codex', 0, CODEX_CHATGPT, 'signed_in'],
    ['codex', 0, CODEX_API_KEY, 'signed_in'],
    ['codex', 1, CODEX_SIGNED_OUT, 'signed_out'],
    ['cursor', 0, CURSOR_SIGNED_IN, 'signed_in'],
    ['cursor', 1, CURSOR_SIGNED_OUT, 'signed_out'],
    ['cursor', 0, CURSOR_NOT_AUTHENTICATED, 'signed_out']
  ] as const)('%s exit %i with a recorded output is %s', async (kind, exitCode, output, state) => {
    expect((await statusOf(kind, exited(exitCode, output))).state).toBe(state)
  })

  it.each([
    ['claude', 1, "error: unknown command 'auth'\n"],
    ['claude', 0, 'not json at all\n'],
    ['claude', 0, '{"authMethod":"none"}'],
    ['codex', 1, CODEX_ERROR],
    ['codex', 0, CODEX_ERROR],
    ['codex', 0, 'something new\n'],
    ['cursor', 1, CURSOR_ERROR],
    ['cursor', 0, 'agent 2026.01.01-abcdef0\n']
  ] as const)('%s exit %i with an error or unrecognised output is unknown, with a reason', async (kind, exitCode, output) => {
    const status = await statusOf(kind, exited(exitCode, output))

    expect(status.state).toBe('unknown')
    expect(status.reason).not.toBe('')
  })

})

describe('status reads only what the CLI said', () => {
  it('is signed out only when the CLI says so: a "logged in" line with a failing exit code is unknown', async () => {
    expect((await statusOf('codex', exited(1, CODEX_CHATGPT))).state).toBe('unknown')
    expect((await statusOf('cursor', exited(1, CURSOR_SIGNED_IN))).state).toBe('unknown')
  })

  it('treats a timeout and a program that cannot start as unknown, with the reason', async () => {
    const timedOut = await statusOf('codex', { kind: 'timed_out' })
    const missing = await statusOf('codex', { kind: 'spawn_failed', code: 'ENOENT', message: 'spawn ENOENT' })

    expect(timedOut).toEqual({ state: 'unknown', reason: expect.stringMatching(/did not answer in time/i) })
    expect(missing).toEqual({ state: 'unknown', reason: expect.stringMatching(/did not start \(ENOENT\)/i) })
  })

  it('refuses to run a path that is not a file, reporting unknown without starting anything', async () => {
    const { run, deps } = statusWorld(exited(0, CODEX_CHATGPT), { inspect: 'not_a_file' })

    const status = await getAgentAuthStatus('codex', '/gone/codex', deps)

    expect(status.state).toBe('unknown')
    expect(run.launches).toEqual([])
  })

  it('never carries the status output, such as an account email, into the result', async () => {
    const results = [
      await statusOf('claude', exited(0, CLAUDE_SIGNED_IN)),
      await statusOf('cursor', exited(0, CURSOR_SIGNED_IN)),
      await statusOf('codex', exited(0, CODEX_API_KEY))
    ]

    const text = JSON.stringify(results)
    expect(text).not.toContain('dev@example.com')
    expect(text).not.toContain('Example Org')
    expect(text).not.toContain('sk-proj')
    expect(Object.keys(results[0] ?? {}).sort()).toEqual(['reason', 'state'])
  })

  it('strips terminal colour codes before reading the answer', async () => {
    const esc = String.fromCharCode(27)

    expect((await statusOf('codex', exited(0, `${esc}[32mLogged in using ChatGPT${esc}[0m\n`))).state).toBe('signed_in')
  })
})

describe('status runs only the CLI own status command, with a timeout', () => {
  it.each([
    ['claude', ['auth', 'status']],
    ['codex', ['login', 'status']],
    ['cursor', ['status']]
  ] as const)('%s runs %j on its registered executable', async (kind, args) => {
    const { run, deps } = statusWorld(exited(0, ''))

    await getAgentAuthStatus(kind, POSIX_PATHS[kind], deps)

    expect(run.launches).toEqual([{ file: POSIX_PATHS[kind], args, verbatimArguments: false }])
  })

  it('passes a timeout to the runner', async () => {
    const timeouts: number[] = []
    const deps = { ...statusWorld(exited(0, '')).deps, timeoutMs: 1234 }
    deps.run = (_launch, timeoutMs) => {
      timeouts.push(timeoutMs)
      return Promise.resolve(exited(0, CODEX_CHATGPT))
    }

    await getAgentAuthStatus('codex', POSIX_PATHS.codex, deps)

    expect(timeouts).toEqual([1234])
  })

  it('runs a Windows npm shim through cmd.exe with the constant args inside one quoted command', async () => {
    const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd'
    const { run, deps } = statusWorld(exited(0, CODEX_CHATGPT), { platform: 'win32' })

    await getAgentAuthStatus('codex', shim, deps)

    expect(run.launches).toEqual([
      {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/v:off', '/s', '/c', `""${shim}" login status"`],
        verbatimArguments: true
      }
    ])
  })

  it('runs a Windows .exe directly and refuses a shim path cmd.exe would expand', async () => {
    const direct = statusWorld(exited(0, CODEX_CHATGPT), { platform: 'win32' })
    const unsafe = statusWorld(exited(0, CODEX_CHATGPT), { platform: 'win32' })

    await getAgentAuthStatus('cursor', 'C:\\Tools\\agent.exe', direct.deps)
    const refused = await getAgentAuthStatus('codex', 'C:\\100%\\codex.cmd', unsafe.deps)

    expect(direct.run.launches).toEqual([{ file: 'C:\\Tools\\agent.exe', args: ['status'], verbatimArguments: false }])
    expect(refused.state).toBe('unknown')
    expect(unsafe.run.launches).toEqual([])
  })
})

interface SignInWorld {
  launched: TerminalLaunch[]
  deps: Parameters<typeof signInAgent>[2]
}

function signInWorld(
  platform: string,
  outcomes: TerminalOutcome[] = [{ ok: true }],
  inspect: FileCheck = 'ok'
): SignInWorld {
  const world: SignInWorld = {
    launched: [],
    deps: {
      platform,
      inspect: () => inspect,
      comspec: 'C:\\Windows\\System32\\cmd.exe',
      launch: (launch) => {
        world.launched.push(launch)
        return Promise.resolve(outcomes[world.launched.length - 1] ?? { ok: true })
      }
    }
  }
  return world
}

const LOGIN_ARGS: Record<AgentKind, string[]> = { claude: ['auth', 'login'], codex: ['login'], cursor: ['login'] }

describe('sign in starts the CLI own login command in a visible terminal', () => {
  it.each(AGENT_KINDS)('%s: on Windows, one new console runs the shim with only its login args, parsed by one cmd.exe', async (kind) => {
    const shim = `C:\\Users\\me\\AppData\\Roaming\\npm\\${kind}.cmd`
    const world = signInWorld('win32')

    expect(await signInAgent(kind, shim, world.deps)).toEqual({ outcome: 'started' })

    const login = LOGIN_ARGS[kind].join(' ')
    expect(world.launched).toEqual([
      {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/v:off', '/s', '/k', `""${shim}" ${login}"`],
        verbatimArguments: true
      }
    ])
  })

  it('on Windows, runs an .exe the same way', async () => {
    const world = signInWorld('win32')

    await signInAgent('cursor', 'C:\\Tools\\agent.exe', world.deps)

    expect(world.launched[0]?.args.at(-1)).toBe('""C:\\Tools\\agent.exe" login"')
  })

  it('on Windows, parses the path in exactly one cmd.exe: no start, no nested cmd.exe, no second command line', async () => {
    const world = signInWorld('win32')
    const path = 'C:\\tools & calc & x\\claude.cmd'

    await signInAgent('claude', path, world.deps)

    const [launch] = world.launched
    expect(launch?.args).toEqual(['/d', '/v:off', '/s', '/k', `""${path}" auth login"`])
    expect(launch?.args.join(' ')).not.toMatch(/\bstart\b|cmd\.exe|\/c\b/i)
    expect(launch?.args.filter((arg) => arg.includes(path))).toHaveLength(1)
  })
})

describe('sign in on macOS and Linux', () => {
  it.each(AGENT_KINDS)('%s: on macOS, Terminal runs the quoted executable path and the login args', async (kind) => {
    const world = signInWorld('darwin')

    expect(await signInAgent(kind, POSIX_PATHS[kind], world.deps)).toEqual({ outcome: 'started' })

    expect(world.launched).toHaveLength(1)
    const [launch] = world.launched
    expect(launch?.file).toBe('osascript')
    expect(launch?.verbatimArguments).toBe(false)
    expect(launch?.args).toContain(`do script ((quoted form of (item 1 of argv)) & " ${LOGIN_ARGS[kind].join(' ')}")`)
    // The path travels as an argument of the script, never spliced into its source.
    expect(launch?.args.at(-1)).toBe(POSIX_PATHS[kind])
    expect(launch?.args.slice(0, -1).join('\n')).not.toContain(POSIX_PATHS[kind])
  })

  it.each(AGENT_KINDS)('%s: on Linux, a terminal runs the executable path and the login args as separate arguments', async (kind) => {
    const world = signInWorld('linux')

    expect(await signInAgent(kind, POSIX_PATHS[kind], world.deps)).toEqual({ outcome: 'started' })

    const [launch] = world.launched
    expect(launch?.file).toBe('x-terminal-emulator')
    expect(launch?.args.slice(-(LOGIN_ARGS[kind].length + 1))).toEqual([POSIX_PATHS[kind], ...LOGIN_ARGS[kind]])
  })

  it('on Linux, tries the next terminal program when one is not installed', async () => {
    const world = signInWorld('linux', [
      { ok: false, code: 'ENOENT' },
      { ok: false, code: 'ENOENT' },
      { ok: true }
    ])

    expect(await signInAgent('codex', POSIX_PATHS.codex, world.deps)).toEqual({ outcome: 'started' })

    expect(world.launched.map((launch) => launch.file)).toEqual(['x-terminal-emulator', 'gnome-terminal', 'konsole'])
  })

  it('on Linux, says so when no terminal program exists', async () => {
    const world = signInWorld('linux', Array.from({ length: 10 }, () => ({ ok: false, code: 'ENOENT' }) as const))

    const result = await signInAgent('codex', POSIX_PATHS.codex, world.deps)

    expect(result).toEqual({ outcome: 'failed', reason: expect.stringMatching(/no terminal/i) })
  })

})

describe('sign in refuses what it cannot launch', () => {
  it('stops at a terminal that exists but cannot start, with its error code', async () => {
    const world = signInWorld('darwin', [{ ok: false, code: 'EACCES' }])

    const result = await signInAgent('claude', POSIX_PATHS.claude, world.deps)

    expect(result).toEqual({ outcome: 'failed', reason: expect.stringContaining('EACCES') })
    expect(world.launched).toHaveLength(1)
  })

  it.each([
    ['linux', 'not_a_file'],
    ['darwin', 'not_executable']
  ] as const)('on %s, launches nothing for a file the check says is %s', async (platform, check) => {
    const world = signInWorld(platform, [{ ok: true }], check)

    const result = await signInAgent('codex', POSIX_PATHS.codex, world.deps)

    expect(result.outcome).toBe('failed')
    expect(world.launched).toEqual([])
  })

  it.each(['C:\\100%\\codex.cmd', 'C:\\a"b\\codex.cmd', 'C:\\Users\\me\\codex.ps1', 'codex.cmd'])(
    'on Windows, launches nothing for the unsafe or unrunnable path %s',
    async (path) => {
      const world = signInWorld('win32')

      const result = await signInAgent('codex', path, world.deps)

      expect(result.outcome).toBe('failed')
      expect(world.launched).toEqual([])
    }
  )
})

describe('sign in carries no credential', () => {
  const PLATFORM_PATHS: [string, (kind: AgentKind) => string][] = [
    ['win32', (kind) => `C:\\Users\\me\\AppData\\Roaming\\npm\\${kind}.cmd`],
    ['darwin', (kind) => POSIX_PATHS[kind]],
    ['linux', (kind) => POSIX_PATHS[kind]]
  ]

  it.each(PLATFORM_PATHS)('%s: every launch is the executable plus only that kind login args', (platform, pathFor) => {
    for (const kind of AGENT_KINDS) {
      const plan = planSignIn(kind, pathFor(kind), { platform, inspect: () => 'ok', comspec: 'cmd.exe' })

      expect(plan.ok).toBe(true)
      const text = plan.ok ? plan.launches.map((launch) => [launch.file, ...launch.args].join(' ')).join('\n') : ''
      expect(text).toContain(LOGIN_ARGS[kind].join(' '))
      expect(text).not.toMatch(/api[-_ ]?key|token|password|passwd|secret|--email|--with-/i)
    }
  })

  it('has exactly one login command per kind, and none of them takes a credential option', () => {
    expect(LOGIN_ARGS).toEqual({ claude: ['auth', 'login'], codex: ['login'], cursor: ['login'] })
    for (const args of Object.values(LOGIN_ARGS)) {
      expect(args.every((arg) => /^[a-z]+$/.test(arg))).toBe(true)
    }
  })
})

/** Every non-test source file under the renderer (the views), as [path, text]. */
function rendererSources(): [string, string][] {
  const root = fileURLToPath(new URL('../../renderer/src', import.meta.url))
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
    .map((entry) => {
      const path = `${entry.parentPath}/${entry.name}`
      return [path, readFileSync(path, 'utf8')]
    })
}

describe('no view accepts a credential', () => {
  it('has no password field or credential input anywhere in the renderer', () => {
    const sources = rendererSources()

    expect(sources.length).toBeGreaterThan(0)
    for (const [path, text] of sources) {
      expect(text, path).not.toMatch(/type\s*=\s*\{?\s*['"]password['"]|autoComplete\s*=\s*['"](?:current|new)-password['"]/i)
      expect(text, path).not.toMatch(/(?:api[-_ ]?key|apikey|password)\s*(?:input|field)/i)
    }
  })

  it('has bridge methods that take the kind and nothing else', () => {
    const api = readFileSync(fileURLToPath(new URL('../../shared/desktop/api.ts', import.meta.url)), 'utf8')

    expect(api).toContain('agentStatus(kind: AgentKind): Promise<AgentAuthStatus>')
    expect(api).toContain('signInAgent(kind: AgentKind): Promise<AgentSignInResult>')
  })
})

function connectedAgent(kind: AgentKind): AgentView {
  return {
    kind,
    executablePath: POSIX_PATHS[kind],
    version: '1.0.0',
    connectedVia: 'found',
    connectedAt: '2026-01-01T00:00:00.000Z',
    lastProbed: '2026-01-01T00:00:00.000Z'
  }
}

interface HandlerWorld {
  handlers: ReturnType<typeof createAgentAuthHandlers>
  checked: [AgentKind, string][]
  signedIn: [AgentKind, string][]
}

function handlerWorld(connected: AgentKind[]): HandlerWorld {
  const world: HandlerWorld = { handlers: undefined as never, checked: [], signedIn: [] }
  world.handlers = createAgentAuthHandlers(
    { list: () => connected.map(connectedAgent) },
    {
      checkAuth: (kind, path) => {
        world.checked.push([kind, path])
        return Promise.resolve({ state: 'signed_in', reason: 'ok' })
      },
      signIn: (kind, path) => {
        world.signedIn.push([kind, path])
        return Promise.resolve({ outcome: 'started' })
      }
    }
  )
  return world
}

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof DomainError ? error.code : 'unexpected'
  }
  return 'resolved'
}

describe('agents:status and agents:signIn handlers', () => {
  it('check the registered executable for the kind, never one from the request', async () => {
    const world = handlerWorld(['codex'])

    expect(await world.handlers.agentStatus('codex')).toEqual({ state: 'signed_in', reason: 'ok' })
    expect(await world.handlers.signInAgent('codex')).toEqual({ outcome: 'started' })

    expect(world.checked).toEqual([['codex', POSIX_PATHS.codex]])
    expect(world.signedIn).toEqual([['codex', POSIX_PATHS.codex]])
  })

  it('answer unknown, with a reason, for a kind that is not connected, without running anything', async () => {
    const world = handlerWorld(['claude'])

    expect(await world.handlers.agentStatus('cursor')).toEqual({
      state: 'unknown',
      reason: expect.stringMatching(/Cursor is not connected/)
    })
    expect(await world.handlers.signInAgent('cursor')).toEqual({
      outcome: 'not_connected',
      reason: expect.stringMatching(/Cursor is not connected/)
    })
    expect(world.checked).toEqual([])
    expect(world.signedIn).toEqual([])
  })

  it.each([
    { kind: 'claude', apiKey: 'sk-ant-secret' },
    { kind: 'codex', password: 'hunter2' },
    { kind: 'cursor', token: 'tok' },
    { kind: 'claude', executablePath: '/bin/sh' },
    'sk-ant-secret',
    '/bin/sh',
    ['claude'],
    'Claude',
    null,
    undefined
  ])('accept the kind only: %j is rejected before anything runs', async (payload) => {
    const world = handlerWorld(['claude', 'codex', 'cursor'])

    expect(await rejectionCode(world.handlers.agentStatus(payload))).toBe('invalid_input')
    expect(await rejectionCode(world.handlers.signInAgent(payload))).toBe('invalid_input')

    expect(world.checked).toEqual([])
    expect(world.signedIn).toEqual([])
  })

  it('does not echo a rejected credential back in the error', async () => {
    const world = handlerWorld([])

    const message = await world.handlers.agentStatus({ kind: 'claude', apiKey: 'sk-ant-secret' }).then(
      () => '',
      (error: unknown) => String(error)
    )

    expect(message).not.toContain('sk-ant-secret')
  })
})
