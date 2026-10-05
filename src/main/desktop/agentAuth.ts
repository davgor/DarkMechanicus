/**
 * Sign-in state and sign-in launch for each agent CLI, using only the CLI's own commands.
 *
 * - Status runs the CLI's own status command (a constant per kind, with a timeout, through the same
 *   launch rules as the version probe) and classifies what it says as `signed_in`, `signed_out`, or
 *   `unknown`. Only the classification and a fixed sentence leave this module: the command's output
 *   (which can hold an account email) is read to classify and then dropped, never stored or returned.
 * - Sign in opens a terminal window that runs the CLI's own login command (a constant per kind). The
 *   vendor's flow opens its own browser page, and prompts (such as a pasted code) happen in that
 *   window. This app never shows a password or key field and never reads or stores a credential:
 *   the only input any channel takes is the agent kind.
 *
 * What each status command prints, and where that is known from:
 * - Claude Code `auth status`: a JSON document with a boolean `loggedIn` (exit 1 when signed out).
 *   Checked against a real signed-out Windows install. Only `loggedIn` is read.
 * - Codex `login status`: stderr `Logged in using ...` and exit 0, `Not logged in` and exit 1, or
 *   `Error checking login status: ...` and exit 1 (from the openai/codex source).
 * - Cursor `agent status`: the vendor documents the command but not its wording, so the match is
 *   tolerant: a "not logged in / not authenticated" style message is signed out, and a "logged in" /
 *   "authenticated" message with exit 0 is signed in. Anything else is `unknown`.
 */
import { z } from 'zod'
import { parseInput } from '../../core/schemas'
import { AGENT_DEFINITIONS } from '../../shared/desktop/agentKinds'
import type { AgentAuthState, AgentAuthStatus, AgentKind, AgentSignInResult } from '../../shared/desktop/api'
import { agentKindSchema } from './agentHandlers'
import { planShimLaunch } from '../agents/shimLaunch'
import { checkFile, planCliLaunch, windowsProgramKind, type AgentProbeDeps, type ProcessOutcome } from './agentProbe'
import type { AgentRegistry } from './agentRegistry'

/** The status command can be slow on a cold start or a slow network, but a person is waiting for it. */
const STATUS_TIMEOUT_MS = 10_000

/** Constant arguments only: on Windows they go through the shared shim launcher's command line, so no user text ever goes here. */
const STATUS_ARGS: Readonly<Record<AgentKind, readonly string[]>> = {
  claude: ['auth', 'status'],
  codex: ['login', 'status'],
  cursor: ['status']
}

/** Each CLI's own login command: no key, token, email, or password option. */
const LOGIN_ARGS: Readonly<Record<AgentKind, readonly string[]>> = {
  claude: ['auth', 'login'],
  codex: ['login'],
  cursor: ['login']
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

const CLASSIFIERS: Readonly<Record<AgentKind, Classifier>> = {
  claude: classifyClaude,
  codex: classifyCodex,
  cursor: classifyCursor
}

function unknown(reason: string): AgentAuthStatus {
  return { state: 'unknown', reason }
}

function statusFor(state: Exclude<AgentAuthState, 'unknown'>, kind: AgentKind): AgentAuthStatus {
  const name = AGENT_DEFINITIONS[kind].displayName
  return {
    state,
    reason: state === 'signed_in' ? `${name} reports it is signed in.` : `${name} reports it is not signed in.`
  }
}

function interpretStatus(kind: AgentKind, outcome: ProcessOutcome): AgentAuthStatus {
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
  kind: AgentKind,
  executablePath: string,
  deps: AgentProbeDeps
): Promise<AgentAuthStatus> {
  const plan = planCliLaunch(executablePath, STATUS_ARGS[kind], deps)
  if ('ok' in plan) {
    return unknown(plan.reason)
  }
  return interpretStatus(kind, await deps.run(plan.launch, deps.timeoutMs ?? STATUS_TIMEOUT_MS))
}

/** One terminal program to start. Like a probe launch there is no shell option: the path is one argument. */
export interface TerminalLaunch {
  file: string
  args: readonly string[]
  /** Windows only: hand `args` to the process unquoted, because they already carry their own quoting. */
  verbatimArguments: boolean
}

export type TerminalOutcome = { ok: true } | { ok: false; code: string | null }

/** Starts a terminal window, resolving once it has started (not once the sign-in is done), never rejecting. */
export type TerminalLauncher = (launch: TerminalLaunch) => Promise<TerminalOutcome>

interface AgentSignInDeps extends Pick<AgentProbeDeps, 'platform' | 'inspect' | 'comspec'> {
  launch: TerminalLauncher
}

type SignInPlan = { ok: true; launches: TerminalLaunch[] } | { ok: false; reason: string }

/**
 * The console is cmd.exe itself, started detached so Windows gives it a window of its own, running
 * with `/k` (so the window stays up for the CLI's messages) through the shared launcher
 * (`planShimLaunch`): exactly one cmd.exe parse, the path in its own pair of quotes. Do not add a
 * `start` or a nested cmd.exe: that parses the line a second time with the path outside quotes, and
 * an `&` in the path would end the command. A path with `%` or `"` is refused, never escaped.
 */
function planWindows(path: string, loginArgs: readonly string[], comspec: string | undefined): SignInPlan {
  if (windowsProgramKind(path) === null) {
    return { ok: false, reason: 'That file is not a program Windows can run (.exe or .cmd).' }
  }
  const plan = planShimLaunch(path, loginArgs, { comspec, keepOpen: true })
  return plan.ok ? { ok: true, launches: [plan.launch] } : { ok: false, reason: plan.reason }
}

/** The executable path is an argument of the AppleScript (`argv`), shell-quoted by AppleScript itself, never spliced into its source. */
function planMac(path: string, login: string): SignInPlan {
  const script = [
    'on run argv',
    'tell application "Terminal"',
    'activate',
    `do script ((quoted form of (item 1 of argv)) & " ${login}")`,
    'end tell',
    'end run'
  ]
  return {
    ok: true,
    launches: [{ file: 'osascript', args: [...script.flatMap((line) => ['-e', line]), path], verbatimArguments: false }]
  }
}

/** Runs the command given as arguments, then waits for Enter so the window does not vanish with the CLI's last message. */
const LINUX_WRAPPER = '"$@"; printf "\\nPress Enter to close this window. "; read -r _'

/** Terminal programs to try in order, each with the flag that makes it run the rest of the line. */
const LINUX_TERMINALS: readonly { file: string; lead: readonly string[] }[] = [
  { file: 'x-terminal-emulator', lead: ['-e'] },
  { file: 'gnome-terminal', lead: ['--'] },
  { file: 'konsole', lead: ['-e'] },
  { file: 'xfce4-terminal', lead: ['-x'] },
  { file: 'xterm', lead: ['-e'] }
]

/** The path and the login args are separate positional arguments of `sh -c`, never part of its script text. */
function planLinux(path: string, loginArgs: readonly string[]): SignInPlan {
  return {
    ok: true,
    launches: LINUX_TERMINALS.map(({ file, lead }) => ({
      file,
      args: [...lead, 'sh', '-c', LINUX_WRAPPER, 'sh', path, ...loginArgs],
      verbatimArguments: false
    }))
  }
}

/** The terminal launches (in the order to try them) that run `kind`'s own login command on its executable. */
export function planSignIn(
  kind: AgentKind,
  executablePath: string,
  deps: Pick<AgentProbeDeps, 'platform' | 'inspect' | 'comspec'>
): SignInPlan {
  const refusal = checkFile(executablePath, deps)
  if (refusal !== null) {
    return { ok: false, reason: refusal.reason }
  }
  const loginArgs = LOGIN_ARGS[kind]
  if (deps.platform === 'win32') {
    return planWindows(executablePath, loginArgs, deps.comspec)
  }
  return deps.platform === 'darwin'
    ? planMac(executablePath, loginArgs.join(' '))
    : planLinux(executablePath, loginArgs)
}

function failed(reason: string): AgentSignInResult {
  return { outcome: 'failed', reason }
}

/** Starts the first terminal that exists; a missing program moves on to the next, any other failure stops. */
async function launchFirstTerminal(
  launches: readonly TerminalLaunch[],
  launch: TerminalLauncher
): Promise<AgentSignInResult> {
  const [next, ...rest] = launches
  if (next === undefined) {
    return failed('No terminal program was found to run the sign-in in.')
  }
  const outcome = await launch(next)
  if (outcome.ok) {
    return { outcome: 'started' }
  }
  if (outcome.code === 'ENOENT') {
    return launchFirstTerminal(rest, launch)
  }
  return failed(
    outcome.code === null ? 'Could not open a terminal window.' : `Could not open a terminal window (${outcome.code}).`
  )
}

/** Opens a terminal window running the kind's own login command on its registered executable. */
export async function signInAgent(
  kind: AgentKind,
  executablePath: string,
  deps: AgentSignInDeps
): Promise<AgentSignInResult> {
  const plan = planSignIn(kind, executablePath, deps)
  return plan.ok ? launchFirstTerminal(plan.launches, deps.launch) : failed(plan.reason)
}

/** What main wires in: the real runner and terminal launcher, bound to the platform. */
export interface AgentAuthHooks {
  checkAuth: (kind: AgentKind, executablePath: string) => Promise<AgentAuthStatus>
  signIn: (kind: AgentKind, executablePath: string) => Promise<AgentSignInResult>
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface AgentAuthHandlers {
  agentStatus(kind: unknown): Promise<AgentAuthStatus>
  signInAgent(kind: unknown): Promise<AgentSignInResult>
}

/**
 * The behavior behind `agents:status` and `agents:signIn`. The only input is the kind (anything else,
 * such as an object carrying a key or a path, is rejected before anything runs); the executable
 * comes from the registry entry, never from the renderer.
 */
export function createAgentAuthHandlers(agents: Pick<AgentRegistry, 'list'>, hooks: AgentAuthHooks): AgentAuthHandlers {
  const connected = (input: unknown): { kind: AgentKind; executablePath: string | null } => {
    const kind = parseInput(agentKindSchema, input, 'agent kind')
    return { kind, executablePath: agents.list().find((agent) => agent.kind === kind)?.executablePath ?? null }
  }
  const notConnected = (kind: AgentKind): string => `${AGENT_DEFINITIONS[kind].displayName} is not connected yet.`
  return {
    agentStatus: async (input) => {
      const { kind, executablePath } = connected(input)
      return executablePath === null ? unknown(notConnected(kind)) : hooks.checkAuth(kind, executablePath)
    },
    signInAgent: async (input) => {
      const { kind, executablePath } = connected(input)
      return executablePath === null
        ? { outcome: 'not_connected', reason: notConnected(kind) }
        : hooks.signIn(kind, executablePath)
    }
  }
}
