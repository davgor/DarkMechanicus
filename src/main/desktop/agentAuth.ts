/**
 * Sign-in state for each agent CLI, and its login command, using only the CLI's own commands.
 *
 * - Status runs the CLI's own status command (a constant per kind, with a timeout, through the same
 *   launch rules as the version probe) and classifies what it says as `signed_in`, `signed_out`, or
 *   `unknown`. Only the classification and a fixed sentence leave this module: the command's output
 *   (which can hold an account email) is read to classify and then dropped, never stored or returned.
 * - Signing in runs the CLI's own login command (`LOGIN_ARGS`, a constant per kind) in a terminal in the
 *   app's window (`terminalLoginSpec` and `loginTerminals.ts`). The vendor's flow opens its own browser
 *   page, and prompts (such as a pasted code) happen in that terminal. This app never shows a password or
 *   key field and never reads or stores a credential: the only input the channel takes is the agent id.
 *
 * What each status command prints, and where that is known from:
 * - Claude Code `auth status`: a JSON document with a boolean `loggedIn` (exit 1 when signed out).
 *   Checked against a real signed-out Windows install. Only `loggedIn` is read.
 * - Codex `login status`: stderr `Logged in using ...` and exit 0, `Not logged in` and exit 1, or
 *   `Error checking login status: ...` and exit 1 (from the openai/codex source).
 * - Cursor `agent status`: the vendor documents the command but not its wording, so the match is
 *   tolerant: a "not logged in / not authenticated" style message is signed out, and a "logged in" /
 *   "authenticated" message with exit 0 is signed in. Anything else is `unknown`.
 * - OMP `usage --json` (docs/reports/omp-cli.md section 5): signed out it prints empty lists (`reports`,
 *   `accountsWithoutUsage`, `disabledCredentials`) with exit 0. The signed-in shape is from source, not a
 *   recording: `packages/coding-agent/src/cli/usage-cli.ts` lines 1700-1722 put one entry per stored account in
 *   `reports` or `accountsWithoutUsage`. Only the counts are read. A signed-in run fetches live usage over the
 *   network, so it may pass the timeout, which is `unknown`.
 * - Autonomous `a8s doctor` (docs/reports/autonomous-acp.md, the only command that showed a sign-in
 *   state): its `Model route` line. Signed in: `✓ Model route  Claude subscription · <model> · signed in`.
 *   Signed out, recorded with an isolated profile (DM-307): `✗ Model route  Claude subscription is not
 *   ready` with a personal profile, `! Model route  not signed in to Claude, so sessions open without a
 *   default model` with none; a8s's other signed-out wordings also say "is not ready" ("Codex
 *   subscription is not ready", "<model> is not ready"). So a `Model route` line that says "is not ready"
 *   or "not signed in" / "signed out" is signed out; any other line, or none (the `Okta` line is the
 *   company sign-in, not the model's, and `gh` and the MCP lines say "not signed in" of their own), is
 *   `unknown`. It exits 1 on any failed check (a missing profile is one), so the exit code is not read. Its
 *   output holds the account email and local paths, which are dropped like every status output. The
 *   model sign-in is `a8s init`; `a8s login` is the company Okta sign-in and is never run.
 */
import { z } from 'zod'
import { AGENT_DEFINITIONS } from '../../shared/desktop/agentKinds'
import type { AgentAuthState, AgentAuthStatus, AgentView, BuiltInAgentKind } from '../../shared/desktop/api'
import { connectedAgent } from './agentHandlers'
import { planCliLaunch, type AgentProbeDeps, type ProcessOutcome } from './agentProbe'
import type { AgentRegistry } from './agentRegistry'

/**
 * The status command can be slow on a cold start or a slow network, but a person is waiting for it.
 * `a8s doctor` checks Okta, the model route and tools in one go and takes about 12 s, so it gets longer.
 */
const STATUS_TIMEOUT_MS: Readonly<Record<BuiltInAgentKind, number>> = {
  claude: 10_000,
  codex: 10_000,
  cursor: 10_000,
  autonomous: 30_000,
  omp: 10_000
}

/** Constant arguments only: on Windows they go through the shared shim launcher's command line, so no user text ever goes here. */
const STATUS_ARGS: Readonly<Record<BuiltInAgentKind, readonly string[]>> = {
  claude: ['auth', 'status'],
  codex: ['login', 'status'],
  cursor: ['status'],
  autonomous: ['doctor'],
  omp: ['usage', '--json'] // account lists tell signed in from signed out, see the classifier
}

/** Each CLI's own login command: no key, token, email, or password option. Run in the sign-in terminal. */
export const LOGIN_ARGS: Readonly<Record<BuiltInAgentKind, readonly string[]>> = {
  claude: ['auth', 'login'],
  codex: ['login'],
  cursor: ['login'],
  autonomous: ['init'],
  omp: ['login'] // no provider: OMP picks one in the terminal (docs/reports/omp-cli.md section 5)
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

type Verdict = 'signed_in' | 'signed_out' | null

/** A classifier says what the command meant, or null when it said something unrecognised or an error. */
type Classifier = (exitCode: number, text: string) => Verdict

function outputLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

const claudeStatusSchema = z.object({ loggedIn: z.boolean() })

/** The JSON document in the output, tolerating a warning line before or after it. */
function parseJsonDocument(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  try {
    return start >= 0 && end > start ? (JSON.parse(text.slice(start, end + 1)) as unknown) : null
  } catch {
    return null
  }
}

function classifyClaude(_exitCode: number, text: string): Verdict {
  const status = claudeStatusSchema.safeParse(parseJsonDocument(text))
  if (!status.success) {
    return null
  }
  return status.data.loggedIn ? 'signed_in' : 'signed_out'
}

function classifyCodex(exitCode: number, text: string): Verdict {
  const lines = outputLines(text)
  if (lines.some((line) => /^Error checking login status\b/i.test(line))) {
    return null
  }
  if (exitCode === 0 && lines.some((line) => /^Logged in using\b/i.test(line))) {
    return 'signed_in'
  }
  return lines.some((line) => /^Not logged in\b/i.test(line)) ? 'signed_out' : null
}

const CURSOR_SIGNED_OUT = /\b(?:not (?:logged|signed) in|not authenticated|unauthenticated|logged out|signed out)\b/i
const CURSOR_SIGNED_IN = /\b(?:logged in|signed in|authenticated)\b/i

function classifyCursor(exitCode: number, text: string): Verdict {
  if (CURSOR_SIGNED_OUT.test(text)) {
    return 'signed_out'
  }
  return exitCode === 0 && CURSOR_SIGNED_IN.test(text) ? 'signed_in' : null
}

const A8S_MODEL_ROUTE = /^\W*Model route\b/i
const A8S_SIGNED_OUT = /\b(?:not (?:logged|signed) in|signed out|logged out|is not ready)\b/i

function classifyAutonomous(_exitCode: number, text: string): Verdict {
  const route = outputLines(text).find((line) => A8S_MODEL_ROUTE.test(line))
  if (route === undefined) {
    return null
  }
  if (A8S_SIGNED_OUT.test(route)) {
    return 'signed_out'
  }
  // A passed check (✓) that says signed in; a failed one with other words is not a verdict.
  return route.startsWith('✓') && /\bsigned in\b/i.test(route) ? 'signed_in' : null
}

const ompUsageSchema = z.object({
  reports: z.array(z.unknown()),
  accountsWithoutUsage: z.array(z.unknown()),
  disabledCredentials: z.array(z.unknown())
})

/**
 * Signed in when the usage document lists an account (`reports` or `accountsWithoutUsage`). Signed out, every
 * list is empty. A document with only disabled credentials is neither clearly, so it is unknown.
 */
function classifyOmp(exitCode: number, text: string): Verdict {
  if (exitCode !== 0) {
    return null
  }
  const usage = ompUsageSchema.safeParse(parseJsonDocument(text))
  if (!usage.success) {
    return null
  }
  const { reports, accountsWithoutUsage, disabledCredentials } = usage.data
  if (reports.length > 0 || accountsWithoutUsage.length > 0) {
    return 'signed_in'
  }
  return disabledCredentials.length === 0 ? 'signed_out' : null
}

const CLASSIFIERS: Readonly<Record<BuiltInAgentKind, Classifier>> = {
  claude: classifyClaude,
  codex: classifyCodex,
  cursor: classifyCursor,
  autonomous: classifyAutonomous,
  omp: classifyOmp
}

function unknown(reason: string): AgentAuthStatus {
  return { state: 'unknown', reason }
}

function statusFor(state: Exclude<AgentAuthState, 'unknown'>, kind: BuiltInAgentKind): AgentAuthStatus {
  const name = AGENT_DEFINITIONS[kind].displayName
  return {
    state,
    reason: state === 'signed_in' ? `${name} reports it is signed in.` : `${name} reports it is not signed in.`
  }
}

function interpretStatus(kind: BuiltInAgentKind, outcome: ProcessOutcome): AgentAuthStatus {
  const name = AGENT_DEFINITIONS[kind].displayName
  if (outcome.kind === 'timed_out') {
    return unknown(`${name} did not answer in time.`)
  }
  if (outcome.kind === 'spawn_failed') {
    return unknown(outcome.code === null ? `${name} did not start.` : `${name} did not start (${outcome.code}).`)
  }
  const verdict = CLASSIFIERS[kind](outcome.exitCode, outcome.output.replace(ANSI_ESCAPE, ''))
  if (verdict !== null) {
    return statusFor(verdict, kind)
  }
  return unknown(
    outcome.exitCode === 0
      ? `${name} answered in a way this app does not recognise.`
      : `${name}'s status command reported an error (exit code ${outcome.exitCode}).`
  )
}

/** Runs the kind's own status command on its registered executable and classifies the answer. */
export async function getAgentAuthStatus(
  kind: BuiltInAgentKind,
  executablePath: string,
  deps: AgentProbeDeps
): Promise<AgentAuthStatus> {
  const plan = planCliLaunch(executablePath, STATUS_ARGS[kind], deps)
  if ('ok' in plan) {
    return unknown(plan.reason)
  }
  return interpretStatus(kind, await deps.run(plan.launch, deps.timeoutMs ?? STATUS_TIMEOUT_MS[kind]))
}

/** A connected built-in agent: the only kind whose status and login commands the app knows. */
type BuiltInAgentView = AgentView & { kind: BuiltInAgentKind }

/** What main wires in: the real runner, bound to the platform. */
export interface AgentAuthHooks {
  checkAuth: (agent: BuiltInAgentView) => Promise<AgentAuthStatus>
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface AgentAuthHandlers {
  agentStatus(id: unknown): Promise<AgentAuthStatus>
}

function isBuiltIn(agent: AgentView): agent is BuiltInAgentView {
  return agent.kind !== 'custom'
}

/**
 * The behavior behind `agents:status`. The only input is the agent id: anything else (such as an object
 * carrying a key or a path) is refused with `invalid_input`, and an id that is not connected with
 * `not_found`, before anything runs. The executable comes from the registry entry, never from the
 * renderer. A custom agent has no known status command, so nothing runs for it: its status is `unchecked`.
 */
export function createAgentAuthHandlers(agents: Pick<AgentRegistry, 'get'>, hooks: AgentAuthHooks): AgentAuthHandlers {
  return {
    agentStatus: async (input) => {
      const agent = connectedAgent(agents, input)
      return isBuiltIn(agent)
        ? hooks.checkAuth(agent)
        : { state: 'unchecked', reason: `The app cannot check whether ${agent.displayName} is signed in; sign it in from a terminal if it needs that.` }
    }
  }
}
