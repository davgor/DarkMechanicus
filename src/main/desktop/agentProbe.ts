/**
 * Verifies that a picked executable really is the CLI of an agent kind: it is run once with its
 * version flag (no shell, short timeout) and its output must identify the expected CLI. Anything
 * else is refused with a specific reason, and the caller stores nothing.
 *
 * The executable path only ever comes from the main-process file dialog, the installer, or the
 * registry, never from the renderer. This module is pure: spawning and file checks are injected, so
 * tests drive it with a fake process runner.
 *
 * What each CLI prints for `--version` (the assumption the matchers encode; matched per line, so
 * warnings printed before it are ignored, and the version is optional so a format change that keeps
 * the product name still connects):
 * - Claude Code: `2.1.281 (Claude Code)` (checked on a Windows install). Matched on the words "Claude Code".
 * - Codex: `codex-cli 0.46.0`. Matched on a line that starts with `codex` or `codex-cli`.
 * - Cursor: `agent --version` prints only a date-and-hash build such as `2025.09.18-7ae6800` (it does
 *   not name the product), so that exact shape is accepted, as is any line naming "cursor".
 */
import { posix, win32 } from 'node:path'
import { AGENT_DEFINITIONS, expectedExecutableNames } from '../../shared/desktop/agentKinds'
import type { AgentKind, AgentRefusalCode } from '../../shared/desktop/api'

const VERSION_FLAG = '--version'
/** Long enough for a cold Node start behind antivirus scanning, short enough to feel like a refusal. */
const DEFAULT_TIMEOUT_MS = 8_000

/** What the file check says about a picked path. */
export type FileCheck = 'ok' | 'not_a_file' | 'not_executable'

/**
 * One process to start. There is deliberately no `shell` option: the runner never starts a shell
 * for a user-chosen path, so a path is one argv entry (or, for a Windows shim, one quoted token).
 */
export interface ProbeLaunch {
  file: string
  args: readonly string[]
  /** Windows only: hand `args` to the process unquoted, because they already carry their own quoting. */
  verbatimArguments: boolean
}

export type ProcessOutcome =
  /** The process ran to completion; `output` is stdout and stderr together. */
  | { kind: 'exited'; exitCode: number; output: string }
  | { kind: 'timed_out' }
  /** The process could not be started (`code` is the OS error code such as ENOENT or EACCES). */
  | { kind: 'spawn_failed'; code: string | null; message: string }

export type ProcessRunner = (launch: ProbeLaunch, timeoutMs: number) => Promise<ProcessOutcome>

export interface AgentProbeDeps {
  platform: string
  run: ProcessRunner
  inspect: (path: string) => FileCheck
  /** How long the version flag may take before the pick is refused. */
  timeoutMs?: number
  /** The Windows command interpreter used for `.cmd` shims; defaults to `cmd.exe` on PATH lookup. */
  comspec?: string
}

interface AgentRefusal {
  ok: false
  code: AgentRefusalCode
  reason: string
}

export type AgentProbeResult = { ok: true; version: string | null } | AgentRefusal

function refuse(code: AgentRefusalCode, reason: string): AgentRefusal {
  return { ok: false, code, reason }
}

const SEMVER = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/
const CURSOR_BUILD = /^\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]{6,}$/i
/** Terminal colour codes some CLIs print even when piped. */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

interface Identity {
  version: string | null
}

type LineMatcher = (line: string) => boolean

const LINE_MATCHERS: Record<AgentKind, LineMatcher> = {
  claude: (line) => /\bClaude Code\b/i.test(line),
  codex: (line) => /^codex(?:-cli)?\b/i.test(line),
  cursor: (line) => CURSOR_BUILD.test(line) || /\bcursor\b/i.test(line)
}

/** The first output line that names the CLI, with the version found on it, or null for a stranger. */
function identify(kind: AgentKind, output: string): Identity | null {
  const lines = output
    .replace(ANSI_ESCAPE, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
  const line = lines.find((candidate) => candidate !== '' && LINE_MATCHERS[kind](candidate))
  return line === undefined ? null : { version: SEMVER.exec(line)?.[0] ?? null }
}

/** OS error codes that mean the file exists but the system will not run it. */
const NOT_EXECUTABLE_CODES = new Set(['EACCES', 'EPERM', 'ENOEXEC', 'EFTYPE'])

function refuseSpawnFailure(code: string | null): AgentRefusal {
  if (code !== null && NOT_EXECUTABLE_CODES.has(code)) {
    return refuse('not_executable', 'That file is not executable.')
  }
  return refuse('did_not_start', code === null ? 'It did not start.' : `It did not start (${code}).`)
}

function interpret(kind: AgentKind, outcome: ProcessOutcome): AgentProbeResult {
  if (outcome.kind === 'timed_out') {
    return refuse('timed_out', 'It timed out.')
  }
  if (outcome.kind === 'spawn_failed') {
    return refuseSpawnFailure(outcome.code)
  }
  if (outcome.exitCode !== 0) {
    return refuse('failed', `It exited with an error (code ${outcome.exitCode}) when asked for its version.`)
  }
  const identity = identify(kind, outcome.output)
  if (identity === null) {
    return refuse('wrong_program', `This is not the ${AGENT_DEFINITIONS[kind].displayName} CLI.`)
  }
  return { ok: true, version: identity.version }
}

const SHIM_EXTENSIONS = new Set(['.cmd', '.bat'])
const PROGRAM_EXTENSIONS = new Set(['.exe', '.com'])

/** How Windows runs a path: `.cmd`/`.bat` shims go through cmd.exe, `.exe`/`.com` run directly, anything else cannot run. */
export function windowsProgramKind(path: string): 'shim' | 'program' | null {
  const extension = win32.extname(path).toLowerCase()
  if (SHIM_EXTENSIONS.has(extension)) {
    return 'shim'
  }
  return PROGRAM_EXTENSIONS.has(extension) ? 'program' : null
}

/**
 * cmd.exe still reads inside quotes: `%` expands even there and a `"` would end the quoted path.
 * Windows file names cannot hold a quote or a control character, so a path with one did not come
 * from a real file; none of these is escaped, they are refused.
 */
export function isQuotableForCmd(path: string): boolean {
  return [...path].every((char) => char !== '"' && char !== '%' && char.charCodeAt(0) >= 32)
}

export type LaunchPlan = { launch: ProbeLaunch } | AgentRefusal

/**
 * Node refuses to spawn `.cmd` files without a shell, and npm installs agents as `.cmd` shims. The
 * shim is run as `cmd.exe /d /v:off /s /c ""<path>" --version"`: the version flag is a constant, the
 * path is the only user-controlled text and sits inside one pair of quotes (so `&`, `^`, `(` and
 * spaces are literal), `/v:off` rules out `!` expansion, `/d` skips AutoRun commands, and `/s` makes
 * cmd strip exactly the outer pair of quotes.
 */
function planShim(path: string, args: readonly string[], comspec: string): LaunchPlan {
  if (!isQuotableForCmd(path)) {
    return refuse(
      'unsafe_path',
      'The path has a character (a quote, "%", or a control character) that cannot be launched safely.'
    )
  }
  const command = `""${path}" ${args.join(' ')}"`
  return { launch: { file: comspec, args: ['/d', '/v:off', '/s', '/c', command], verbatimArguments: true } }
}

function planLaunch(path: string, args: readonly string[], deps: Pick<AgentProbeDeps, 'platform' | 'comspec'>): LaunchPlan {
  if (deps.platform !== 'win32') {
    return { launch: { file: path, args, verbatimArguments: false } }
  }
  const kind = windowsProgramKind(path)
  if (kind === 'shim') {
    return planShim(path, args, deps.comspec ?? 'cmd.exe')
  }
  if (kind === 'program') {
    return { launch: { file: path, args, verbatimArguments: false } }
  }
  return refuse('not_executable', 'That file is not a program Windows can run (.exe or .cmd).')
}

/** A path must be absolute and name a regular file the system would let us run. */
export function checkFile(path: string, deps: Pick<AgentProbeDeps, 'platform' | 'inspect'>): AgentRefusal | null {
  const absolute = deps.platform === 'win32' ? win32.isAbsolute(path) : posix.isAbsolute(path)
  const check: FileCheck = absolute ? deps.inspect(path) : 'not_a_file'
  if (check === 'not_a_file') {
    return refuse('not_a_file', 'That is not a file.')
  }
  return check === 'not_executable' ? refuse('not_executable', 'That file is not executable.') : null
}

/**
 * Plans one run of a registered executable with constant `args` (never user text): the file check
 * and the platform launch rules (shim quoting, no shell) shared by the version probe and by the
 * sign-in status check.
 */
export function planCliLaunch(
  executablePath: string,
  args: readonly string[],
  deps: Pick<AgentProbeDeps, 'platform' | 'inspect' | 'comspec'>
): LaunchPlan {
  return checkFile(executablePath, deps) ?? planLaunch(executablePath, args, deps)
}

/** Runs the picked executable with its version flag and decides whether it is `kind`'s CLI. */
export async function probeAgent(
  kind: AgentKind,
  executablePath: string,
  deps: AgentProbeDeps
): Promise<AgentProbeResult> {
  const plan = planCliLaunch(executablePath, [VERSION_FLAG], deps)
  if ('ok' in plan) {
    return plan
  }
  return interpret(kind, await deps.run(plan.launch, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS))
}

/** The shape of the native open dialog for an agent's executable (assignable to Electron's options). */
interface AgentDialogOptions {
  title: string
  properties: ('openFile' | 'showHiddenFiles')[]
  filters: { name: string; extensions: string[] }[]
}

/**
 * Windows lists `.exe` and `.cmd` first, since that is how agents are installed there. Elsewhere the
 * executables have no extension, which a dialog filter cannot express, so the title names the
 * expected file names and hidden folders such as `~/.local/bin` stay reachable.
 */
export function agentDialogOptions(kind: AgentKind, platform: string): AgentDialogOptions {
  const names = expectedExecutableNames(kind, platform)
  const all = { name: 'All files', extensions: ['*'] }
  return {
    title: `Locate the ${AGENT_DEFINITIONS[kind].displayName} CLI (${names.join(' or ')})`,
    properties: ['openFile', 'showHiddenFiles'],
    filters: platform === 'win32' ? [{ name: 'Programs', extensions: ['exe', 'cmd'] }, all] : [all]
  }
}
