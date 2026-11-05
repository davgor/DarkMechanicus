/**
 * Merges the Dark Mechanicus server into the text of a Claude Code `.mcp.json`. Pure: no I/O and no
 * Electron imports. Every other server and every other top-level key is kept; only the
 * `darkmechanicus` entry is added or, when the caller asks, replaced.
 */
import { canonicalJson } from '../../core/canonical'
import type { ChatRole } from '../../shared/agents/chat'
import type { ClaudeCodeRole, McpConfigView } from '../../shared/desktop/api'

/** The `mcpServers` key Dark Mechanicus owns. */
const SERVER_NAME = 'darkmechanicus'
/** The session name the desktop app shows for these connections. */
const SESSION_LABEL = 'Claude Code'
const FIX_HINT = 'Fix or remove it, then try again.'

export interface McpServerEntry {
  command: string
  args: string[]
  env?: Record<string, string>
}

interface ClaudeCodeLaunch {
  role: ClaudeCodeRole
  allowSave: boolean
}

/** Created, added and replaced carry the full new file text; the others mean nothing is written. */
type McpMergeResult =
  | { outcome: 'created' | 'added' | 'replaced'; text: string }
  | { outcome: 'unchanged' }
  | { outcome: 'conflict'; existing: string }
  | { outcome: 'invalid'; message: string }

type JsonObject = Record<string, unknown>

type LaunchConfig = Pick<McpConfigView, 'command' | 'args' | 'env'>

/** The app's launch command plus role, save permission and the session label the app shows. */
export function darkMechanicusServer(
  config: LaunchConfig,
  launch: { role: ChatRole; allowSave: boolean; label: string }
): McpServerEntry {
  const saving = launch.allowSave ? ['--allow-save'] : []
  const args = [...config.args, '--role', launch.role, ...saving, '--label', launch.label]
  if (Object.keys(config.env).length === 0) {
    return { command: config.command, args }
  }
  return { command: config.command, args, env: { ...config.env } }
}

/** The server entry for Claude Code: the app's launch command plus role, save permission and label. */
export function claudeCodeServer(config: LaunchConfig, launch: ClaudeCodeLaunch): McpServerEntry {
  return darkMechanicusServer(config, { ...launch, label: SESSION_LABEL })
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Two-space JSON with a trailing newline, like the hand-written file. */
function render(config: JsonObject): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

/** The parsed file, or why it cannot be merged. */
function parseConfig(text: string): JsonObject | string {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return `.mcp.json is not valid JSON (${reason}), so it was left untouched. ${FIX_HINT}`
  }
  if (!isObject(value)) {
    return `.mcp.json does not hold a JSON object, so it was left untouched. ${FIX_HINT}`
  }
  if (value.mcpServers !== undefined && !isObject(value.mcpServers)) {
    return `"mcpServers" in .mcp.json is not an object, so the file was left untouched. ${FIX_HINT}`
  }
  return value
}

/**
 * Merges `server` into the current file text (null when there is no file). An identical existing
 * entry is `unchanged` whatever its key order; a different one is a `conflict` unless `replace`.
 */
export function mergeMcpServer(current: string | null, server: McpServerEntry, options: { replace: boolean }): McpMergeResult {
  if (current === null) {
    return { outcome: 'created', text: render({ mcpServers: { [SERVER_NAME]: server } }) }
  }
  const config = parseConfig(current)
  if (typeof config === 'string') {
    return { outcome: 'invalid', message: config }
  }
  const servers = (config.mcpServers ?? {}) as JsonObject
  const existing = servers[SERVER_NAME]
  if (existing !== undefined) {
    if (canonicalJson(existing) === canonicalJson(server)) {
      return { outcome: 'unchanged' }
    }
    if (!options.replace) {
      return { outcome: 'conflict', existing: JSON.stringify(existing, null, 2) }
    }
  }
  // Spreading keeps every other key in place; an existing entry is overwritten where it stands.
  const text = render({ ...config, mcpServers: { ...servers, [SERVER_NAME]: server } })
  return { outcome: existing === undefined ? 'added' : 'replaced', text }
}

/** What a start-up refresh of a folder's entry did: `refreshed` carries the full new file text. */
type McpRefreshResult = { outcome: 'refreshed'; text: string } | { outcome: 'current' } | { outcome: 'skipped' }

interface RefreshContext {
  /** The tracked folder's canonical path; the entry must name it after `--repo`. */
  repoRoot: string
  /** Whether a file exists; injected so this module stays free of I/O. */
  exists: (path: string) => boolean
}

const RUNTIME_ENV_KEY = 'ELECTRON_RUN_AS_NODE'

function sameFolder(a: string, b: string): boolean {
  const strip = (path: string): string => path.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const normal = (path: string): string => (/^[A-Za-z]:/.test(path) ? strip(path).toLowerCase() : strip(path))
  return normal(a) === normal(b)
}

function isAbsoluteAnyOs(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}

interface OwnedEntry {
  command: string
  args: string[]
  env: JsonObject
}

/** Whether `args` name the app's own script, this folder and the Claude Code label. */
function namesThisApp(args: readonly string[], repoRoot: string): boolean {
  const repo = valueAfter(args, '--repo')
  return (
    /(^|[\\/])mcp\.js$/.test(args[0] ?? '') &&
    repo !== undefined &&
    sameFolder(repo, repoRoot) &&
    valueAfter(args, '--label') === SESSION_LABEL
  )
}

/** The entry's parts when this app wrote it (script, `--repo` this folder, the Claude Code label); else null. */
function ownedEntry(entry: unknown, repoRoot: string): OwnedEntry | null {
  if (!isObject(entry) || typeof entry.command !== 'string' || !Array.isArray(entry.args)) {
    return null
  }
  const args: unknown[] = entry.args
  const env = entry.env ?? {}
  if (!args.every((arg): arg is string => typeof arg === 'string') || !isObject(env) || !namesThisApp(args, repoRoot)) {
    return null
  }
  return { command: entry.command, args, env }
}

/**
 * Points a folder's entry at the running build when the build that wrote it is gone: the script or the
 * absolute launch command it names no longer exists. An entry whose build still exists is left alone
 * (so two builds installed side by side never rewrite each other's file), as is any entry this app
 * did not write and any running build whose own script is missing. Only the build path, the command
 * and the runtime variable change; the role, label, other arguments and the person's other
 * variables, servers and keys stay as they are.
 */
export function refreshStaleServer(current: string, config: LaunchConfig, context: RefreshContext): McpRefreshResult {
  const parsed = parseConfig(current)
  const runningScript = config.args[0]
  if (typeof parsed === 'string' || runningScript === undefined || !context.exists(runningScript)) {
    return { outcome: 'skipped' }
  }
  const servers = (parsed.mcpServers ?? {}) as JsonObject
  const entry = ownedEntry(servers[SERVER_NAME], context.repoRoot)
  if (entry === null) {
    return { outcome: 'skipped' }
  }
  const recordedScript = entry.args[0] as string
  const gone = (path: string): boolean => isAbsoluteAnyOs(path) && !context.exists(path)
  if (!gone(recordedScript) && !gone(entry.command)) {
    return { outcome: 'current' }
  }
  const { [RUNTIME_ENV_KEY]: _runtime, ...kept } = entry.env
  const env = { ...config.env, ...kept, ...(config.env[RUNTIME_ENV_KEY] === undefined ? {} : { [RUNTIME_ENV_KEY]: config.env[RUNTIME_ENV_KEY] }) }
  const refreshed: McpServerEntry = {
    command: config.command,
    args: [runningScript, ...entry.args.slice(1)],
    ...(Object.keys(env).length === 0 ? {} : { env: env as Record<string, string> })
  }
  return { outcome: 'refreshed', text: render({ ...parsed, mcpServers: { ...servers, [SERVER_NAME]: refreshed } }) }
}
