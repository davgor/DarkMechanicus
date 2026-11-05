import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import type { AgentAuthStatus, AgentView, BuiltInAgentKind } from '../../shared/desktop/api'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import { DOCTOR_NO_PROFILE, DOCTOR_SIGNED_OUT } from './__mocks__/autonomousDoctor'
import { createAgentAuthHandlers, getAgentAuthStatus } from './agentAuth'
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
/**
 * Autonomous `a8s doctor`: the signed-in lines are the report's recording (docs/reports/autonomous-acp.md),
 * with the email replaced. The signed-out outputs are recorded too (`autonomousDoctor.ts`, DM-307): an
 * isolated profile with no model sign-in, with the person's personal profile (a failed "Claude subscription
 * is not ready") and with none (a warning "not signed in to Claude").
 */
const A8S_SIGNED_IN =
  '✓ Okta  signed in as dev@example.com\n✓ Model route  Claude subscription · anthropic/claude-opus-5-5 · signed in\n! gh  not found\n0 problems, 3 warnings.\n'
const A8S_OKTA_ONLY = '✓ Okta  signed in as dev@example.com\n0 problems, 0 warnings.\n'
const A8S_ROUTE_FAILED = '✗ Model route  Claude subscription · anthropic/claude-opus-5-5 · signed in · token refresh failed\n'

/**
 * OMP `omp usage --json`. The signed-out sample is the recording (docs/reports/omp-cli.md section 5, exit 0). The
 * signed-in sample is built from the source shape (`usage-cli.ts`, one `reports` entry per account), not recorded.
 */
const OMP_SIGNED_OUT = `{
  "generatedAt": 1793674471240,
  "reports": [],
  "accountsWithoutUsage": [],
  "disabledCredentials": [],
  "capacity": {}
}
`
const OMP_SIGNED_IN = `{
  "generatedAt": 1793674471240,
  "reports": [{ "provider": "anthropic", "fetchedAt": 1793674471000, "limits": [] }],
  "accountsWithoutUsage": [],
  "disabledCredentials": [],
  "capacity": {}
}
`

const POSIX_PATHS: Record<BuiltInAgentKind, string> = {
  claude: '/home/me/.local/bin/claude',
  codex: '/usr/local/bin/codex',
  cursor: '/home/me/.local/bin/agent',
  autonomous: '/home/me/.local/bin/a8s',
  omp: '/home/me/.local/bin/omp'
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

async function statusOf(kind: BuiltInAgentKind, outcome: ProcessOutcome): Promise<AgentAuthStatus> {
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
    ['cursor', 0, CURSOR_NOT_AUTHENTICATED, 'signed_out'],
    ['autonomous', 0, A8S_SIGNED_IN, 'signed_in'],
    ['autonomous', DOCTOR_SIGNED_OUT.exitCode, DOCTOR_SIGNED_OUT.output, 'signed_out'],
    ['autonomous', DOCTOR_NO_PROFILE.exitCode, DOCTOR_NO_PROFILE.output, 'signed_out'],
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
    ['cursor', 0, 'agent 2026.01.01-abcdef0\n'],
    ['autonomous', 0, A8S_OKTA_ONLY],
    ['autonomous', 1, A8S_ROUTE_FAILED],
    ['autonomous', 0, 'Autonomous 0.79.0 · darwin-arm64 · OMP 18.11.2\n']
  ] as const)('%s exit %i with an error or unrecognised output is unknown, with a reason', async (kind, exitCode, output) => {
    const status = await statusOf(kind, exited(exitCode, output))

    expect(status.state).toBe('unknown')
    expect(status.reason).not.toBe('')
  })

  // The other signed-out wordings of a8s 0.79.0's `Model route` check (`dist/omp/route-step.js`, reason
  // `signed-out`), not observed; and a failure that signing in does not fix (reason `policy-restricted`).
  it.each([
    ['✗ Model route             Codex subscription is not ready\n', 'signed_out'],
    ['✗ Model route             Claude subscription is not ready; an API key is not subscription authentication\n', 'signed_out'],
    ['✗ Model route             anthropic/claude-opus-5-5 is not ready\n', 'signed_out'],
    ["✗ Model route             company sessions can't start: $ONEBRIEF_MODEL_KEY is unset\n", 'unknown']
  ] as const)('autonomous: the route line %j is %s', async (output, state) => {
    expect((await statusOf('autonomous', exited(1, output))).state).toBe(state)
  })

})

describe('status for OMP reads the account lists of `omp usage --json`', () => {
  it.each([
    ['signed in: an account in reports', 0, OMP_SIGNED_IN, 'signed_in'],
    ['signed out: every list empty', 0, OMP_SIGNED_OUT, 'signed_out'],
    ['signed out, ANSI-coloured', 0, `\u001b[32m${OMP_SIGNED_OUT}\u001b[0m`, 'signed_out'],
    ['signed out with a text message and exit 1', 1, 'No credentials found. Run `omp` and use /login to add accounts.\n', 'unknown'],
    ['a signed-out JSON document with exit 1', 1, OMP_SIGNED_OUT, 'unknown'],
    ['not JSON', 0, 'not json at all\n', 'unknown'],
    ['a models list is not a sign-in answer', 0, '{"models":[]}\n', 'unknown'],
    ['only a disabled credential', 0, '{"reports":[],"accountsWithoutUsage":[],"disabledCredentials":[{"provider":"anthropic"}],"capacity":{}}\n', 'unknown']
  ] as const)('%s', async (_label, exitCode, output, state) => {
    expect((await statusOf('omp', exited(exitCode, output))).state).toBe(state)
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
    ['cursor', ['status']],
    ['autonomous', ['doctor']]
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

describe('status gives each CLI its own time limit', () => {
  /** A fake runner whose CLI answers after `answerAfterMs`: past the runner's limit it times out, like the real one. */
  function slowWorld(answerAfterMs: number, output: string): { timeouts: number[]; deps: Parameters<typeof getAgentAuthStatus>[2] } {
    const timeouts: number[] = []
    const deps = statusWorld(exited(0, output)).deps
    deps.run = (_launch, timeoutMs) => {
      timeouts.push(timeoutMs)
      return Promise.resolve(answerAfterMs > timeoutMs ? { kind: 'timed_out' } : exited(0, output))
    }
    return { timeouts, deps }
  }

  it('waits up to 30 s for Autonomous, so a signed-in a8s doctor answering after 12 s is signed_in', async () => {
    const { timeouts, deps } = slowWorld(12_000, A8S_SIGNED_IN)

    const status = await getAgentAuthStatus('autonomous', POSIX_PATHS.autonomous, deps)

    expect(timeouts).toEqual([30_000])
    expect(status.state).toBe('signed_in')
  })

  it('reports unknown with the timeout message when a8s doctor answers after 30 s', async () => {
    const { deps } = slowWorld(30_001, A8S_SIGNED_IN)

    expect(await getAgentAuthStatus('autonomous', POSIX_PATHS.autonomous, deps)).toEqual({
      state: 'unknown',
      reason: 'Autonomous did not answer in time.'
    })
  })

  it.each([
    ['claude', CLAUDE_SIGNED_IN],
    ['codex', CODEX_CHATGPT],
    ['cursor', CURSOR_SIGNED_IN]
  ] as const)('%s keeps the 10 s limit: answering after 12 s is unknown with the timeout message', async (kind, output) => {
    const { timeouts, deps } = slowWorld(12_000, output)

    const status = await getAgentAuthStatus(kind, POSIX_PATHS[kind], deps)

    expect(timeouts).toEqual([10_000])
    expect(status.state).toBe('unknown')
    expect(status.reason).toMatch(/ did not answer in time\.$/)
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

  it('has a status bridge method that takes the agent id and nothing else', () => {
    const api = readFileSync(fileURLToPath(new URL('../../shared/desktop/api.ts', import.meta.url)), 'utf8')

    expect(api).toContain('agentStatus(id: AgentId): Promise<AgentAuthStatus>')
  })
})

function connectedAgent(kind: BuiltInAgentKind): AgentView {
  return builtInAgent(kind, { executablePath: POSIX_PATHS[kind], connectedAt: '2026-01-01T00:00:00.000Z', lastProbed: '2026-01-01T00:00:00.000Z' })
}

const CUSTOM_ID = 'cu_01m65kwqqeyajbj5bnq81gngrb'

interface HandlerWorld {
  handlers: ReturnType<typeof createAgentAuthHandlers>
  checked: [string, string][]
}

function handlerWorld(connected: BuiltInAgentKind[], extra: AgentView[] = []): HandlerWorld {
  const world: HandlerWorld = { handlers: undefined as never, checked: [] }
  const agents = [...connected.map(connectedAgent), ...extra]
  world.handlers = createAgentAuthHandlers(
    { get: (id) => agents.find((agent) => agent.id === id) ?? null },
    {
      checkAuth: (agent) => {
        world.checked.push([agent.id, agent.executablePath])
        return Promise.resolve({ state: 'signed_in', reason: 'ok' })
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

describe('agents:status handler', () => {
  it('check the registered executable for the agent id, never one from the request', async () => {
    const world = handlerWorld(['codex'])

    expect(await world.handlers.agentStatus('codex')).toEqual({ state: 'signed_in', reason: 'ok' })

    expect(world.checked).toEqual([['codex', POSIX_PATHS.codex]])
  })

  it('refuse an agent id that is not connected with not_found, without running anything', async () => {
    const world = handlerWorld(['claude'])

    for (const id of ['cursor', CUSTOM_ID]) {
      expect(await rejectionCode(world.handlers.agentStatus(id))).toBe('not_found')
    }
    expect(world.checked).toEqual([])
  })
})

describe('agents:status for a custom agent', () => {
  it('reports a connected custom agent as unchecked, without running anything', async () => {
    const custom = builtInAgent('cursor', { id: CUSTOM_ID, kind: 'custom', displayName: 'My agent', executablePath: '/opt/mine' })
    const world = handlerWorld([], [custom])

    expect(await world.handlers.agentStatus(CUSTOM_ID)).toEqual({ state: 'unchecked', reason: expect.stringContaining('My agent') })
    expect(world.checked).toEqual([])
  })
})

describe('agents:status inputs', () => {
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

    expect(world.checked).toEqual([])
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
