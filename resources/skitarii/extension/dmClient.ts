import { callRecovery, readRecoveryContext } from './recoveryClient'
import { DM_WRITER_BUSY, SESSION_AUDIT_BUSY, SESSION_AUDIT_BUSY_STDERR } from './dmDiagnostics'
/**
 * The Skitarii extension's mail client: runs the chat's own pinned `dm` CLI for one mailbox command at a time,
 * without a shell, and returns its JSON result.
 *
 * Main writes a private descriptor for each eligible OMP launch (`src/main/terminals/terminalFiles.ts`,
 * `writeDmClientDescriptor`) and passes only its path in `DM_SKITARII_CLIENT_DESCRIPTOR`. The descriptor pins the
 * absolute runtime, the CLI script with `--repo <folder>`, the working folder, the runtime's own switches and the
 * names of the variables the child may inherit. It is routing, never authority: the chat's grant
 * (`DM_SESSION_TOKEN`, read from this process at each call) is what the CLI checks, and the descriptor never holds it.
 * A descriptor that is missing, malformed, of another version or written for another chat or launch is refused; there
 * is no fallback to PATH, a shell, a launcher or another chat's file.
 *
 * Each call spawns `<command> <...args> call <command name> -` with `shell: false`, writes the input as JSON on
 * stdin, and bounds the run: a 5 s inactivity watchdog renewed by SQLite writer contention, 2 MiB of stdout, 4 KiB of stderr kept (sanitized, the token redacted). A timeout,
 * an overflow, the caller's abort signal or `cancelAll` kills the child, and the call settles only once it has exited.
 * Results may carry message bodies: they go back to the caller only and are never logged here.
 *
 * `run` is the same path for any other Dark Mechanicus command (the `dm_call` tool): the same descriptor, grant,
 * spawn, caps and stopping, with a 60 s inactivity watchdog (`DM_RUN_LIMITS`). The command name must have the CLI's own shape (a
 * lowercase letter, then letters, digits or `_`), so it can never be read as a flag, a path or a second word; which
 * commands the chat may run is the grant's decision, checked by the CLI, never a list here. Its successful data comes
 * back with the grant redacted wherever it appears. A caller of its own (the standards read) may also give the call
 * an absolute lifetime (`DmRunOptions.lifetimeMs`) that writer contention never renews; an agent's `dm_call` gives none.
 *
 * Self-contained on purpose: OMP runs this file with its bundled Bun, from `<resources>/skitarii/extension/` when
 * packaged, so it imports Node built-ins only. The result types mirror `src/shared/domain/agentMail.ts`; the tests
 * check they stay equal.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { readFile as nodeReadFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { boardOutbox, CONTEXT_OUTBOX_FILE, type BoardContextBody, type BoardContextOutbox } from './contextDelivery'

/** The one variable main passes an eligible OMP launch: the absolute path of its descriptor. */
export const DM_CLIENT_DESCRIPTOR_ENV = 'DM_SKITARII_CLIENT_DESCRIPTOR'
/** The descriptor format this client reads; any other is refused as stale. */
export const DM_CLIENT_DESCRIPTOR_VERSION = 1
/** The folder, inside the chat's own OMP folder, that holds its launches' descriptors (`<generation>.json`). */
export const DM_CLIENT_DESCRIPTOR_DIR = 'dm-client'

interface DmClientLimits {
  timeoutMs: number
  stdoutBytes: number
  stderrBytes: number
}

export const DM_CLIENT_LIMITS: Readonly<DmClientLimits> = { timeoutMs: 5_000, stdoutBytes: 2 * 1024 * 1024, stderrBytes: 4 * 1024 }

/**
 * `run`'s limits: the mail caps, with 60 s instead of 5 s. A workflow command (claim, submit, review) opens the
 * workspace, may wait out SQLite's 5 s busy timeout more than once while the desktop or another chat writes, and may
 * touch git; 5 s would fail real calls. 60 s still stops a hung child well inside one agent turn.
 */
export const DM_RUN_LIMITS: Readonly<DmClientLimits> = { ...DM_CLIENT_LIMITS, timeoutMs: 60_000 }

/** A CLI command name in either spelling (`claim_ticket`, `claimTicket`): never a flag, a path or two words. */
export const DM_COMMAND_NAME = /^[a-z][A-Za-z0-9_]{0,63}$/

/** A descriptor is a few hundred bytes; anything past this is not one. */
const DESCRIPTOR_MAX_BYTES = 64 * 1024

/** The client's names for the mailbox commands, and the CLI command each runs. Nothing else can be called. */
const DM_MAIL_COMMANDS = {
  identity: 'get_agent_identity',
  peers: 'list_agent_peers',
  send: 'send_agent_message',
  read: 'read_agent_inbox',
  ack: 'acknowledge_agent_messages',
  status: 'get_agent_mail_status'
} as const

export type DmMailCommand = keyof typeof DM_MAIL_COMMANDS

// --- the mailbox contract (mirrors src/shared/domain/agentMail.ts) ------------------------------------------------

interface DmMailWindow {
  afterSeq?: number
  throughSeq?: number
  limit?: number
}

export interface DmMailIdentity {
  endpointId: string
  name: string
  role: 'desktop' | 'planner' | 'orchestrator' | 'worker' | 'reviewer' | 'reader'
  boundAt: string
}

/** A chat's Dark Mechanicus roles, as the desktop records them for a peer. */
export const DM_CHAT_ROLES = ['planner', 'orchestrator', 'worker', 'reviewer'] as const
type DmChatRole = (typeof DM_CHAT_ROLES)[number]

export interface DmMailPeersPage {
  /** `epicId` and `role` are trusted metadata the desktop recorded from the peer's chat record; `name` is only a label. */
  peers: { endpointId: string; name: string; epicId: string | null; role: DmChatRole | null }[]
  nextAfterId: string | null
  hasMore: boolean
}

interface DmMailReadInput extends DmMailWindow {
  unacknowledgedOnly?: boolean
}

interface DmMailSendInput {
  to: string
  clientMessageId: string
  body: string
  inReplyTo?: string
}

export interface DmMailAcceptance {
  messageId: string
  to: string
  clientMessageId: string
  inReplyTo: string | null
  acceptedAt: string
  duplicate: boolean
}

export interface DmMailMessageMeta {
  id: string
  seq: number
  from: { endpointId: string; name: string; deleted: boolean }
  inReplyTo: string | null
  bodyBytes: number
  acceptedAt: string
  acknowledgedAt: string | null
  expiresAt: string | null
}

export interface DmMailMessage extends DmMailMessageMeta {
  body: string
}

interface DmMailPage {
  snapshotHighWater: number
  nextCursor: number
  hasMore: boolean
}

export interface DmMailInboxPage extends DmMailPage {
  messages: DmMailMessage[]
}

export interface DmMailStatusPage extends DmMailPage {
  pendingCount: number
  messages: DmMailMessageMeta[]
}

export interface DmMailAcknowledged {
  acknowledged: { messageId: string; acknowledgedAt: string; expiresAt: string }[]
}


/** Each command's input and the `data` of its successful result. */
export interface DmMailCalls {
  identity: { input: Record<string, never>; output: DmMailIdentity }
  peers: { input: { afterId?: string; limit?: number; epicId?: string; role?: DmChatRole }; output: DmMailPeersPage }
  send: { input: DmMailSendInput; output: DmMailAcceptance }
  read: { input: DmMailReadInput; output: DmMailInboxPage }
  ack: { input: { messageIds: string[] }; output: DmMailAcknowledged }
  status: { input: DmMailWindow; output: DmMailStatusPage }
}

/**
 * Why a call failed. `source: 'dm'` is the CLI's own refusal, its code passed through (`unauthorized`,
 * `invalid_input`, `not_found`, `idempotency_mismatch`, `reply_unavailable`, `mailbox_full`, `receipt_quota_full`,
 * `conflict`, ...). `source: 'client'` is this client's: see `DmClientErrorCode`.
 */
type DmClientErrorCode =
  | 'descriptor_missing'
  | 'descriptor_invalid'
  | 'descriptor_stale'
  | 'context_unavailable'
  | 'recipient_mismatch'
  | 'command_not_allowed'
  | 'invalid_command'
  | 'invalid_input'
  | 'no_grant'
  | 'spawn_failed'
  | 'timeout'
  | 'output_too_large'
  | 'aborted'
  | 'cancelled'
  | 'process_failed'
  | 'malformed_output'

export type DmClientError = { source: 'client'; code: DmClientErrorCode; message: string } | { source: 'dm'; code: string; message: string }

export type DmCallResult<T> = { ok: true; data: T; warning?: typeof SESSION_AUDIT_BUSY } | { ok: false; error: DmClientError }

/** A `run` caller's own bounds. An agent's `dm_call` passes none, so it keeps `DM_RUN_LIMITS` exactly. */
interface DmRunOptions {
  /** Kills the child and settles `timeout` this long after it starts, however often writer contention renews the watchdog. */
  lifetimeMs?: number
}

export interface DmClient {
  /** Runs one mailbox command; never rejects. `signal` aborting kills the child and settles with `aborted`. */
  call<C extends DmMailCommand>(command: C, input: DmMailCalls[C]['input'], signal?: AbortSignal): Promise<DmCallResult<DmMailCalls[C]['output']>>
  /**
   * Runs any CLI command by name (`DM_COMMAND_NAME`) with a JSON object of arguments, under `DM_RUN_LIMITS` and any
   * absolute `options.lifetimeMs`; never rejects. The grant decides what is allowed: a refusal comes back as the CLI's own error.
   */
  run(command: string, input: unknown, signal?: AbortSignal, options?: DmRunOptions): Promise<DmCallResult<unknown>>
  /** Person messages come only from this launch's private desktop outbox, after current mailbox authorization. */
  readBoard(): Promise<DmCallResult<BoardContextBody[]>>
  /** Incident-scoped peer bodies from the same recipient-bound private outbox, never person authority. */
  readRecovery?(): Promise<DmCallResult<BoardContextBody[]>>
  /** Kills every running child (each call settles with `cancelled`) and resolves once all have exited. */
  cancelAll(): Promise<void>
}

/** What the client runs on; `nodeDmClientDeps` gives the real ones. */
export interface DmClientDeps {
  /** This process's environment, read at each call. */
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  readFile: (path: string) => Promise<string>
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  limits?: Readonly<DmClientLimits>
  /** `run`'s limits; `DM_RUN_LIMITS` unless a test gives others. */
  runLimits?: Readonly<DmClientLimits>
  /** A world-member route reads its own private grant file at every call; never another member's ambient token. */
  token?: () => Promise<string>
}

export function nodeDmClientDeps(): DmClientDeps {
  return { env: process.env, platform: process.platform, readFile: (path) => nodeReadFile(path, 'utf8'), spawn: nodeSpawn }
}

// --- the descriptor ---------------------------------------------------------------------------------------------

/** What main writes for one launch (`writeDmClientDescriptor`). */
export interface DmClientDescriptor {
  version: typeof DM_CLIENT_DESCRIPTOR_VERSION
  chatId: string
  /** The launch it was written for; also its file name, `<generation>.json`. */
  generation: string
  /** The chat's canonical folder: the CLI's `--repo` and the child's working folder. */
  folder: string
  /** The absolute runtime: the app executable (packaged) or the development build's Electron, run as Node. */
  command: string
  /** Exactly `[<absolute cli.js>, '--repo', folder]`. */
  args: string[]
  cwd: string
  /** The runtime's own switches, set on the child alone: `ELECTRON_RUN_AS_NODE=1` and the Dark Mechanicus home. */
  env: { ELECTRON_RUN_AS_NODE?: '1'; DARKMECHANICUS_HOME?: string }
  /** Names of this process's variables the child inherits; nothing else is passed on. */
  /** Optional recovery-only local control; conveys no generic mailbox or repository authority. */
  recoveryAddress?: string
  inherit: string[]
  /** The chat's role in a cult run; absent for any other chat, which then gets no cult tools and no cult wake. */
  cultRole?: 'magos' | 'acolyte'
}

const DESCRIPTOR_KEYS = ['version', 'chatId', 'generation', 'folder', 'command', 'args', 'cwd', 'env', 'inherit'] as const
const RUNTIME_ENV_KEYS: ReadonlySet<string> = new Set(['ELECTRON_RUN_AS_NODE', 'DARKMECHANICUS_HOME'])
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const ID = /^[A-Za-z0-9_-]{1,128}$/
/**
 * Names the child never inherits, whatever a descriptor says: grants and addresses, the runtime's switches, runtime
 * injection (`NODE_OPTIONS`, `BUN_*`, `LD_PRELOAD`, `DYLD_*`), OMP's own and anything that looks like a credential.
 */
const NEVER_INHERITED = /^(?:DM_|DARKMECHANICUS_|ELECTRON_|NODE_|BUN_|NPM_|LD_|DYLD_|PI_|OMP_)|KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH|COOKIE/i

type Checked<T> = { ok: true; value: T } | { ok: false; error: DmClientError }

function clientError(code: DmClientErrorCode, message: string): { ok: false; error: DmClientError } {
  return { ok: false, error: { source: 'client', code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function absolute(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && isAbsolute(value) && !value.split(/[\\/]/).includes('..')
}

function runtimeEnvOk(env: unknown): boolean {
  if (!isRecord(env)) return false
  return Object.entries(env).every(([name, value]) =>
    RUNTIME_ENV_KEYS.has(name) && (name === 'ELECTRON_RUN_AS_NODE' ? value === '1' : absolute(value)))
}

function inheritOk(inherit: unknown): boolean {
  return Array.isArray(inherit) && inherit.every((name) => typeof name === 'string' && ENV_NAME.test(name) && !NEVER_INHERITED.test(name))
}

function pinnedArgsOk(d: Record<string, unknown>): boolean {
  const args = d['args']
  if (!Array.isArray(args) || args.length !== 3) return false
  const [script, flag, repo] = args as unknown[]
  return absolute(script) && /(?:^|[\\/])cli\.js$/.test(script) && flag === '--repo' && repo === d['folder']
}

function keysOk(d: Record<string, unknown>): boolean {
  const keys = Object.keys(d)
  const optional = (d.recoveryAddress === undefined ? 0 : 1) + (d.cultRole === undefined ? 0 : 1)
  return keys.length === DESCRIPTOR_KEYS.length + optional && DESCRIPTOR_KEYS.every((key) => keys.includes(key)) &&
    (d.recoveryAddress === undefined || typeof d.recoveryAddress === 'string') &&
    (d.cultRole === undefined || d.cultRole === 'magos' || d.cultRole === 'acolyte')
}

/** The shape main writes, exactly: no other key, absolute normalized paths, the CLI pinned to the folder. */
function descriptorShapeOk(d: Record<string, unknown>): boolean {
  const ids = [d['chatId'], d['generation']].every((id) => typeof id === 'string' && ID.test(id))
  const paths = absolute(d['folder']) && absolute(d['command']) && d['cwd'] === d['folder']
  return keysOk(d) && ids && paths && pinnedArgsOk(d) && runtimeEnvOk(d['env']) && inheritOk(d['inherit'])
}

/** Whether `path` is the file main writes for this chat and launch: `.../<chatId>/dm-client/<generation>.json`. */
function targetOk(path: string, d: DmClientDescriptor): boolean {
  const dir = dirname(path)
  return basename(path) === `${d.generation}.json` && basename(dir) === DM_CLIENT_DESCRIPTOR_DIR && basename(dirname(dir)) === d.chatId
}

/** Checks descriptor text read from `path`. */
export function parseDmClientDescriptor(path: string, text: string): Checked<DmClientDescriptor> {
  if (text.length > DESCRIPTOR_MAX_BYTES) return clientError('descriptor_invalid', 'The DM client descriptor is too large.')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return clientError('descriptor_invalid', 'The DM client descriptor is not JSON.')
  }
  if (!isRecord(parsed)) return clientError('descriptor_invalid', 'The DM client descriptor is not an object.')
  if (parsed['version'] !== DM_CLIENT_DESCRIPTOR_VERSION) {
    return clientError('descriptor_stale', `The DM client descriptor is not version ${DM_CLIENT_DESCRIPTOR_VERSION}; restart the chat from the app.`)
  }
  if (!descriptorShapeOk(parsed)) return clientError('descriptor_invalid', 'The DM client descriptor does not pin an absolute runtime, CLI and folder.')
  const descriptor = parsed as unknown as DmClientDescriptor
  if (!targetOk(path, descriptor)) return clientError('descriptor_invalid', 'The DM client descriptor was written for another chat or launch.')
  return { ok: true, value: descriptor }
}

/** `name`'s value in `env`: exact on macOS and Linux, any letter case on Windows, which reads names without case. */
function envValue(env: DmClientDeps['env'], platform: NodeJS.Platform, name: string): string | undefined {
  if (platform !== 'win32') return env[name]
  const upper = name.toUpperCase()
  return Object.entries(env).find(([key, value]) => key.toUpperCase() === upper && value !== undefined)?.[1]
}

async function loadDescriptor(deps: DmClientDeps): Promise<Checked<DmClientDescriptor>> {
  const path = envValue(deps.env, deps.platform, DM_CLIENT_DESCRIPTOR_ENV)
  if (path === undefined || path === '') return clientError('descriptor_missing', 'This chat was not started with a DM client descriptor.')
  if (!absolute(path)) return clientError('descriptor_invalid', 'The DM client descriptor path is not absolute.')
  let text: string
  try {
    text = await deps.readFile(path)
  } catch (error) {
    const missing = (error as { code?: unknown } | null)?.code === 'ENOENT'
    return missing ? clientError('descriptor_missing', 'The DM client descriptor is gone; restart the chat from the app.') : clientError('descriptor_invalid', 'The DM client descriptor cannot be read.')
  }
  return parseDmClientDescriptor(path, text)
}

/** The `browser_*` commands, in the CLI's snake and camel spellings: only they reach the chat's browser pipe. */
const BROWSER_COMMANDS = new Set(['status', 'navigate', 'click', 'type', 'press', 'read', 'screenshot'].flatMap((op) => [
  `browser_${op}`, `browser${op[0]?.toUpperCase() ?? ''}${op.slice(1)}`
]))

/** The one live control address a call may receive: naming gets the desktop pipe, browser_* the browser pipe; all other DM addresses remain scrubbed. */
function controlAddressFor(cliName: string): 'DM_DESKTOP_PIPE' | 'DM_BROWSER_PIPE' | undefined {
  if (cliName === 'name_chat' || cliName === 'nameChat') return 'DM_DESKTOP_PIPE'
  return BROWSER_COMMANDS.has(cliName) ? 'DM_BROWSER_PIPE' : undefined
}

function dmChildEnv(descriptor: DmClientDescriptor, deps: DmClientDeps, token: string, cliName: string): Record<string, string> {
  const { env, platform } = deps
  const wanted = new Set(descriptor.inherit.map((name) => (platform === 'win32' ? name.toUpperCase() : name)))
  const child: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const name = platform === 'win32' ? key.toUpperCase() : key
    if (value !== undefined && wanted.has(name) && !NEVER_INHERITED.test(key)) child[key] = value
  }
  const route = controlAddressFor(cliName)
  if (route !== undefined) {
    const address = envValue(env, platform, route)
    if (address !== undefined && address !== '') child[route] = address
  }
  return Object.assign(child, descriptor.env, { DM_SESSION_TOKEN: token })
}

// --- running one call -------------------------------------------------------------------------------------------

/** Stderr as text a tool may show: the grant redacted, control characters and runs of space collapsed. */
function sanitizeStderr(bytes: Buffer, token: string): string {
  // oxlint-disable-next-line no-control-regex -- the control characters are exactly what is removed.
  const text = bytes.toString('utf8').replaceAll(token, '[redacted]').replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ')
  return text.trim()
}

interface Run {
  child: ChildProcess
  token: string
  limits: Readonly<DmClientLimits>
  /** An absolute bound on the child's life, never renewed; none for the mail calls and an agent's `dm_call`. */
  lifetimeMs: number | undefined
  signal: AbortSignal | undefined
  /** Whether successful data is redacted too (`run`); the mail calls keep theirs as before. */
  redact: boolean
}

type Envelope = { ok: true; data: unknown } | { ok: false; code: string; message: string } | null

function envelopeOf(text: string): Envelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed['ok'] === true && 'data' in parsed) return { ok: true, data: parsed['data'] }
  const error = parsed['error']
  if (parsed['ok'] === false && isRecord(error) && typeof error['code'] === 'string' && typeof error['message'] === 'string') {
    return { ok: false, code: error['code'], message: error['message'] }
  }
  return null
}

interface Exit {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: Buffer
  stderr: Buffer
}

function exitText(code: number | null, signal: NodeJS.Signals | null): string {
  return code === null ? `was stopped by ${signal ?? 'a signal'}` : `exited with code ${code}`
}

/** `value` with the grant replaced by `[redacted]` in every string and key, at any depth. */
function redacted(value: unknown, token: string): unknown {
  if (typeof value === 'string') return value.replaceAll(token, '[redacted]')
  if (Array.isArray(value)) return value.map((item) => redacted(item, token))
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    // defineProperty, so a key such as `__proto__` stays a plain key rather than setting the prototype.
    Object.defineProperty(out, key.replaceAll(token, '[redacted]'), { value: redacted(item, token), enumerable: true, writable: true, configurable: true })
  }
  return out
}

function ordinarySuccess(data: unknown, token: string, stderr: Buffer): DmCallResult<unknown> {
  const notices = stderr.toString('utf8').split(/\r?\n/)
  notices.pop() // The capped stderr buffer may end midway through a line.
  return {
    ok: true, data: redacted(data, token),
    ...(notices.includes(SESSION_AUDIT_BUSY_STDERR) ? { warning: SESSION_AUDIT_BUSY } : {})
  }
}

/** How an exited child's run ended, from its exit and its output; `redact` also clears the grant from its data. */
function outcome(exit: Exit, token: string, redact: boolean): DmCallResult<unknown> {
  const { code } = exit
  const envelope = envelopeOf(exit.stdout.toString('utf8'))
  if (code === 0 && envelope?.ok === true) {
    return redact ? ordinarySuccess(envelope.data, token, exit.stderr) : { ok: true, data: envelope.data }
  }
  if (code !== 0 && envelope?.ok === false) {
    return { ok: false, error: { source: 'dm', code: envelope.code.replaceAll(token, '[redacted]'), message: envelope.message.replaceAll(token, '[redacted]') } }
  }
  if (code === 0) return clientError('malformed_output', 'The dm CLI exited without a JSON result.')
  const stderr = sanitizeStderr(exit.stderr, token)
  return clientError('process_failed', `The dm CLI ${exitText(code, exit.signal)}${stderr === '' ? '.' : `: ${stderr}`}`)
}

const STOP_MESSAGES: Readonly<Record<'timeout' | 'output_too_large' | 'aborted' | 'cancelled' | 'process_failed' | 'spawn_failed', string>> = {
  timeout: 'The dm CLI did not answer in time and was stopped.',
  output_too_large: 'The dm CLI printed more than the client reads and was stopped.',
  aborted: 'The call was aborted and the dm CLI was stopped.',
  cancelled: 'The session ended and the dm CLI was stopped.',
  process_failed: 'The dm CLI could not be run to the end.',
  spawn_failed: 'The dm CLI could not be started.'
}

type StopReason = keyof typeof STOP_MESSAGES

/** Collects the child's capped output and settles once it has exited, killing it first when `stop` is called. */
function supervise(run: Run, settle: (result: DmCallResult<unknown>) => void): (reason: StopReason) => void {
  const { child, limits } = run
  const out: Buffer[] = []
  const err: Buffer[] = []
  let outBytes = 0
  let errBytes = 0
  let stopped: StopReason | null = null
  let exited = false
  const stop = (reason: StopReason): void => {
    stopped ??= reason
    child.stdout?.destroy()
    child.stderr?.destroy()
    if (exited) settle(clientError(stopped, STOP_MESSAGES[stopped]))
    else child.kill('SIGKILL')
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    outBytes += chunk.length
    if (outBytes > limits.stdoutBytes) stop('output_too_large')
    else out.push(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    if (errBytes < limits.stderrBytes) err.push(chunk.subarray(0, limits.stderrBytes - errBytes))
    errBytes += chunk.length
  })
  child.once('exit', () => {
    exited = true
    if (stopped !== null) settle(clientError(stopped, STOP_MESSAGES[stopped]))
  })
  // With no pid the child never started, and no exit follows; otherwise its exit settles the call.
  child.once('error', () => {
    exited ||= child.pid === undefined
    stop(child.pid === undefined ? 'spawn_failed' : 'process_failed')
  })
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    exited = true
    settle(stopped === null ? outcome({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }, run.token, run.redact) : clientError(stopped, STOP_MESSAGES[stopped]))
  })
  return stop
}

/** Spawns nothing on its own: wires a started child, its stdin, its time limits and the abort signal. */
function runChild(run: Run, input: string, cancels: Set<(reason: StopReason) => void>): Promise<DmCallResult<unknown>> {
  return new Promise((resolve) => {
    let settled = false
    const stop = supervise(run, (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(lifetime)
      run.signal?.removeEventListener('abort', onAbort)
      cancels.delete(stop)
      resolve(result)
    })
    const timer = setTimeout(() => stop('timeout'), run.limits.timeoutMs)
    // Writer contention renews the inactivity watchdog only; nothing renews the absolute lifetime.
    const lifetime = run.lifetimeMs === undefined ? undefined : setTimeout(() => stop('timeout'), run.lifetimeMs)
    run.child.on('message', (message) => {
      if (!settled && message === DM_WRITER_BUSY) timer.refresh()
    })
    const onAbort = (): void => stop('aborted')
    run.signal?.addEventListener('abort', onAbort, { once: true })
    cancels.add(stop)
    // A child that exits without reading its input breaks the pipe; its exit says what happened.
    run.child.stdin?.on('error', () => {})
    run.child.stdin?.end(input)
  })
}

function inputText(input: unknown): Checked<string> {
  if (!isRecord(input)) return clientError('invalid_input', 'The input must be a JSON object.')
  try {
    return { ok: true, value: JSON.stringify(input) }
  } catch {
    return clientError('invalid_input', 'The input cannot be written as JSON.')
  }
}

function startChild(deps: DmClientDeps, descriptor: DmClientDescriptor, cliName: string, token: string): Checked<ChildProcess> {
  try {
    const child = deps.spawn(descriptor.command, [...descriptor.args, 'call', cliName, '-'], {
      cwd: descriptor.cwd,
      env: dmChildEnv(descriptor, deps, token, cliName),
      shell: false,
      windowsHide: true,
      serialization: 'json',
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    })
    return { ok: true, value: child }
  } catch {
    return clientError('spawn_failed', 'The dm CLI could not be started.')
  }
}

/** The client's running children, and how many times `cancelAll` ran: a call that started before one spawns nothing. */
interface ClientState {
  cancels: Set<(reason: StopReason) => void>
  cancelEpoch: number
}

/** One call: a mailbox command by the client's name, or (`run`) any command by the CLI's. */
type Request = ({ kind: 'mail'; command: DmMailCommand } | { kind: 'run'; command: unknown; lifetimeMs: number | undefined }) & {
  input: unknown
  signal: AbortSignal | undefined
}

interface Prepared {
  descriptor: DmClientDescriptor
  token: string
  input: string
  cliName: string
}

/** The CLI command a request runs: a mailbox command's mapped name, or a `run` name of the CLI's own shape. */
function cliNameOf(request: Request): Checked<string> {
  if (request.kind === 'run') {
    const { command } = request
    if (typeof command === 'string' && DM_COMMAND_NAME.test(command)) return { ok: true, value: command }
    return clientError('invalid_command', 'The command must be one Dark Mechanicus command name, such as get_capabilities.')
  }
  if (!Object.hasOwn(DM_MAIL_COMMANDS, request.command)) return clientError('command_not_allowed', 'Only the mailbox commands can be called.')
  return { ok: true, value: DM_MAIL_COMMANDS[request.command] }
}

/** Everything a call needs before it spawns: an allowed command, JSON input, a valid descriptor and the grant. */
async function prepare(deps: DmClientDeps, request: Request): Promise<Checked<Prepared>> {
  const cliName = cliNameOf(request)
  if (!cliName.ok) return cliName
  const input = inputText(request.input)
  if (!input.ok) return input
  const descriptor = await loadDescriptor(deps)
  if (!descriptor.ok) return descriptor
  let token: string
  try { token = (deps.token === undefined ? envValue(deps.env, deps.platform, 'DM_SESSION_TOKEN') ?? '' : await deps.token()).trim() }
  catch { return clientError('no_grant', 'This project grant is no longer available; restart the chat.') }
  if (token === '') return clientError('no_grant', 'This chat holds no Dark Mechanicus grant.')
  return { ok: true, value: { descriptor: descriptor.value, token, input: input.value, cliName: cliName.value } }
}

async function callOnce(deps: DmClientDeps, state: ClientState, request: Request): Promise<DmCallResult<unknown>> {
  const epoch = state.cancelEpoch
  const prepared = await prepare(deps, request)
  if (!prepared.ok) return prepared
  if (epoch !== state.cancelEpoch) return clientError('cancelled', STOP_MESSAGES.cancelled)
  if (request.signal?.aborted === true) return clientError('aborted', STOP_MESSAGES.aborted)
  const { descriptor, token, input, cliName } = prepared.value
  const child = startChild(deps, descriptor, cliName, token)
  if (!child.ok) return child
  const run = request.kind === 'run'
  const limits = run ? (deps.runLimits ?? DM_RUN_LIMITS) : (deps.limits ?? DM_CLIENT_LIMITS)
  const lifetimeMs = run ? request.lifetimeMs : undefined
  return runChild({ child: child.value, token, limits, lifetimeMs, signal: request.signal, redact: run }, input, state.cancels)
}

function boardForIdentity(identity: DmCallResult<unknown>, outbox: BoardContextOutbox): DmCallResult<BoardContextBody[]> {
  if (!identity.ok) return identity
  if (!isRecord(identity.data) || identity.data.endpointId !== outbox.endpointId) {
    return clientError('recipient_mismatch', 'The current mailbox grant does not belong to this person-message recipient.')
  }
  return { ok: true, data: outbox.messages }
}

async function readBoardOnce(deps: DmClientDeps, state: ClientState): Promise<DmCallResult<BoardContextBody[]>> {
  const epoch = state.cancelEpoch
  const path = envValue(deps.env, deps.platform, DM_CLIENT_DESCRIPTOR_ENV)
  const descriptor = await loadDescriptor(deps)
  if (epoch !== state.cancelEpoch) return clientError('cancelled', STOP_MESSAGES.cancelled)
  if (!descriptor.ok) return descriptor
  if (path === undefined) return clientError('descriptor_missing', 'The recipient descriptor is unavailable.')
  let outbox: BoardContextOutbox
  try {
    const text = await deps.readFile(join(dirname(dirname(path)), CONTEXT_OUTBOX_FILE))
    outbox = boardOutbox(text, descriptor.value.chatId)
  } catch (error) {
    if (epoch !== state.cancelEpoch) return clientError('cancelled', STOP_MESSAGES.cancelled)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, data: [] }
    return clientError('context_unavailable', 'The person-message context outbox cannot be read for this recipient.')
  }
  if (epoch !== state.cancelEpoch) return clientError('cancelled', STOP_MESSAGES.cancelled)
  if (outbox.messages.length === 0) return { ok: true, data: [] }
  const identity = await callOnce(deps, state, { kind: 'mail', command: 'identity', input: {}, signal: undefined })
  if (epoch !== state.cancelEpoch) return clientError('cancelled', STOP_MESSAGES.cancelled)
  return boardForIdentity(identity, outbox)
}

export function createDmClient(deps: DmClientDeps): DmClient {
  const state: ClientState = { cancels: new Set(), cancelEpoch: 0 }
  const calls = new Set<Promise<unknown>>()
  const track = (request: Request): Promise<DmCallResult<unknown>> => {
    const call = callOnce(deps, state, request)
    calls.add(call)
    void call.finally(() => calls.delete(call))
    return call
  }
  return {
    call: (command, input, signal) => track({ kind: 'mail', command, input, signal }) as Promise<DmCallResult<never>>,
    run: (command, input, signal, options) => command === 'recover_tooling' || command === 'recoverTooling'
      ? callRecovery(deps, input, signal)
      : track({ kind: 'run', command, input, signal, lifetimeMs: options?.lifetimeMs }),
    readBoard: () => {
      const call = readBoardOnce(deps, state)
      calls.add(call)
      void call.finally(() => calls.delete(call))
      return call
    },
    readRecovery: () => readRecoveryContext(deps),
    cancelAll: async () => {
      state.cancelEpoch += 1
      for (const stop of state.cancels) stop('cancelled')
      await Promise.all(calls)
    }
  }
}
