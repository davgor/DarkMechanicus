/**
 * Entry point of the headless MCP process (`out/main/mcp.js`).
 *
 * stdout carries JSON-RPC only. Everything human-readable goes to stderr, and `console.log` is
 * redirected there too so a stray log line can never corrupt the protocol stream.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { DomainError } from '../core/errors'
import { MCP_SERVER_NAME } from '../core/version'
import { openWorkspace, type OpenWorkspaceOptions, type Workspace } from '../core/workspace'
import { MCP_USAGE, parseMcpArgs, type McpOptions } from './args'
import { createMcpServer } from './server'

/** A session that stops heartbeating drops out of the desktop's active list after 60 seconds. */
const HEARTBEAT_INTERVAL_MS = 15_000
const FALLBACK_VERSION = '0.0.0'
const ENTRY_SCRIPT = /(?:^|[\\/])mcp\.js$/

/** Repeating timer, injectable so tests can drive heartbeats without real time. */
export interface Scheduler {
  every(ms: number, callback: () => void): { cancel(): void }
}

const realScheduler: Scheduler = {
  every(ms, callback) {
    const timer = setInterval(callback, ms)
    timer.unref()
    return { cancel: () => clearInterval(timer) }
  }
}

interface StartMcpServerOptions {
  argv: string[]
  env: Record<string, string | undefined>
  cwd: string
  open: (options: OpenWorkspaceOptions) => Workspace
  transport: Transport
  /** Diagnostics, one line per call. Must not write to stdout. */
  log: (line: string) => void
  version: string
  scheduler?: Scheduler
  /** Called once after shutdown finished (a failure is passed when closing went wrong). */
  onClosed?: (failure?: unknown) => void
}

interface McpHandle {
  close(): Promise<void>
}

interface ServeContext {
  workspace: Workspace
  args: McpOptions
  info: { name: string; version: string }
  options: StartMcpServerOptions
}

interface ShutdownParts {
  server: McpServer
  workspace: Workspace
  heartbeat: { cancel(): void }
  onClosed: StartMcpServerOptions['onClosed']
}

function describeError(error: unknown): string {
  if (error instanceof DomainError) {
    return `${error.code}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

function beat(workspace: Workspace, log: (line: string) => void): void {
  try {
    workspace.heartbeat()
  } catch (error) {
    log(`Session heartbeat failed: ${describeError(error)}`)
  }
}

/** Stops the heartbeat, closes the transport, then the workspace, and always reports completion. */
async function shutdown(parts: ShutdownParts): Promise<void> {
  parts.heartbeat.cancel()
  const failures: unknown[] = []
  await parts.server.close().catch((error: unknown) => failures.push(error))
  try {
    parts.workspace.close()
  } catch (error) {
    failures.push(error)
  }
  parts.onClosed?.(failures[0])
  if (failures.length > 0) {
    throw failures[0]
  }
}

/** One shutdown per process, however many times or from wherever it is requested. */
function createShutdown(parts: ShutdownParts): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => {
    // Deferred a tick so `pending` is set before a synchronous transport close re-enters here.
    pending ??= Promise.resolve().then(() => shutdown(parts))
    return pending
  }
}

function logReady({ workspace, args, options }: ServeContext): void {
  const save = args.allowSave ? 'allowed' : 'not allowed'
  const session = workspace.sessionId() ?? 'none'
  options.log(
    `${MCP_SERVER_NAME} ${options.version} ready: repo=${workspace.repoRoot} role=${args.role} save=${save} session=${session}`
  )
  if (!workspace.isInitialized()) {
    options.log(
      'This repository is not initialized yet. Call the initialize_repository tool (planner or orchestrator role) to set it up.'
    )
  }
}

async function serve(context: ServeContext): Promise<McpHandle> {
  const { workspace, options } = context
  const server = createMcpServer(workspace, context.info)
  const heartbeat = (options.scheduler ?? realScheduler).every(HEARTBEAT_INTERVAL_MS, () =>
    beat(workspace, options.log)
  )
  const close = createShutdown({ server, workspace, heartbeat, onClosed: options.onClosed })
  server.server.onerror = (error) => options.log(`MCP error: ${error.message}`)
  server.server.onclose = () => void close().catch(() => undefined)
  try {
    await server.connect(options.transport)
  } catch (error) {
    heartbeat.cancel()
    throw error
  }
  logReady(context)
  return { close }
}

/**
 * Parses the launch flags, opens the workspace as a `stdio` session with the requested role,
 * serves the tools on the transport, and keeps the session alive with a heartbeat.
 */
export async function startMcpServer(options: StartMcpServerOptions): Promise<McpHandle> {
  const args = parseMcpArgs(options.argv, options.env, options.cwd)
  const info = { name: MCP_SERVER_NAME, version: options.version }
  const workspace = options.open({
    repoRoot: args.repo,
    role: args.role,
    label: args.label,
    transport: 'stdio',
    allowSave: args.allowSave,
    pid: process.pid,
    serverInfo: info
  })
  try {
    return await serve({ workspace, args, info, options })
  } catch (error) {
    workspace.close()
    throw error
  }
}

interface WarningSource {
  removeAllListeners(event: 'warning'): unknown
  on(event: 'warning', listener: (warning: Error) => void): unknown
}

function isSqliteExperimental(warning: Error): boolean {
  return warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)
}

/**
 * Replaces Node's default warning printer so the harmless "SQLite is an experimental feature"
 * notice does not clutter host logs. Other warnings are still reported through `log`.
 * Install it synchronously at startup: warnings are delivered on the next tick.
 */
export function installWarningFilter(source: WarningSource, log: (line: string) => void): void {
  source.removeAllListeners('warning')
  source.on('warning', (warning) => {
    if (!isSqliteExperimental(warning)) {
      log(`${warning.name}: ${warning.message}`)
    }
  })
}

export function redirectConsoleToStderr(target: Pick<Console, 'log' | 'info' | 'debug' | 'error'>): void {
  target.log = target.error
  target.info = target.error
  target.debug = target.error
}

/** Resolves symlinks so the desktop and this process agree on the repository's identity. */
export function canonicalRepoRoot(path: string, realpath: (path: string) => string): string {
  try {
    return realpath(path)
  } catch {
    throw new Error(`Repository folder not found or unreadable: ${path}`)
  }
}

/** The app version lives in the package.json two folders above `out/main/mcp.js`, also inside app.asar. */
export function readPackageVersion(scriptPath: string, readText: (path: string) => string): string {
  try {
    const parsed: unknown = JSON.parse(readText(join(dirname(scriptPath), '..', '..', 'package.json')))
    const version = typeof parsed === 'object' && parsed !== null && 'version' in parsed ? parsed.version : undefined
    return typeof version === 'string' ? version : FALLBACK_VERSION
  } catch {
    return FALLBACK_VERSION
  }
}

/** Everything the entry point needs from the outside world, so it can be driven by tests. */
export interface McpHost {
  argv: string[]
  env: Record<string, string | undefined>
  cwd: string
  version: string
  open: (options: OpenWorkspaceOptions) => Workspace
  createTransport: () => Transport
  writeStdout: (text: string) => void
  writeStderr: (text: string) => void
  exit: (code: number) => void
  /** Registers the listener for SIGINT, SIGTERM, and the host closing stdin. */
  onShutdown: (listener: () => void) => void
  scheduler?: Scheduler
}

function reportAndExit(host: McpHost, error: unknown, code: number): void {
  host.writeStderr(`${MCP_SERVER_NAME}: ${describeError(error)}\n`)
  host.exit(code)
}

function parseForHost(host: McpHost): McpOptions | undefined {
  try {
    return parseMcpArgs(host.argv, host.env, host.cwd)
  } catch (error) {
    reportAndExit(host, error, 2)
    return undefined
  }
}

function startOptionsFor(host: McpHost): StartMcpServerOptions {
  return {
    argv: host.argv,
    env: host.env,
    cwd: host.cwd,
    open: host.open,
    transport: host.createTransport(),
    log: (line) => host.writeStderr(`${line}\n`),
    version: host.version,
    scheduler: host.scheduler,
    onClosed: (failure) => {
      if (failure !== undefined) {
        host.writeStderr(`${MCP_SERVER_NAME}: shutdown failed: ${describeError(failure)}\n`)
      }
      host.exit(failure === undefined ? 0 : 1)
    }
  }
}

/**
 * Runs the server for a host process. Exit codes: 2 for bad arguments, 1 when startup or shutdown
 * fails, 0 after a clean shutdown (SIGINT, SIGTERM, or the host closing stdin).
 */
export async function runMcpMain(host: McpHost): Promise<void> {
  const args = parseForHost(host)
  if (args === undefined) {
    return
  }
  if (args.help) {
    host.writeStdout(`${MCP_USAGE}\n`)
    return
  }
  try {
    const handle = await startMcpServer(startOptionsFor(host))
    host.onShutdown(() => void handle.close().catch(() => undefined))
  } catch (error) {
    reportAndExit(host, error, 1)
  }
}

/** Runs `run` with the script path only when node was started with `.../mcp.js`. */
export function runIfEntry(entry: string | undefined, run: (script: string) => void): boolean {
  if (entry === undefined || !ENTRY_SCRIPT.test(entry)) {
    return false
  }
  run(entry)
  return true
}

function nodeHost(script: string): McpHost {
  return {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    version: readPackageVersion(script, (path) => readFileSync(path, 'utf8')),
    open: (options) =>
      openWorkspace({ ...options, repoRoot: canonicalRepoRoot(options.repoRoot, realpathSync) }),
    createTransport: () => new StdioServerTransport(),
    writeStdout: (text) => {
      process.stdout.write(text)
    },
    writeStderr: (text) => {
      process.stderr.write(text)
    },
    exit: (code) => process.exit(code),
    onShutdown: (listener) => {
      process.once('SIGINT', listener)
      process.once('SIGTERM', listener)
      process.stdin.once('end', listener)
      process.stdin.once('close', listener)
    }
  }
}

runIfEntry(process.argv[1], (script) => {
  installWarningFilter(process, (line) => process.stderr.write(`${line}\n`))
  redirectConsoleToStderr(console)
  void runMcpMain(nodeHost(script))
})
