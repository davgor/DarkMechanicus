/**
 * Checks that a custom CLI speaks the protocol the person chose, before it is stored: the launch spec is
 * started once in a fresh, empty temp folder (which is both `{folder}` and the working folder) and has
 * HANDSHAKE_TIMEOUT_MS to finish its protocol's own handshake:
 * - ACP: `initialize` must answer with a JSON-RPC result carrying a numeric `protocolVersion`;
 * - Codex app-server: `initialize`, then `model/list`, whose result must hold a `data` list;
 * - Claude Code SDK: the SDK's model probe (`supportedModels`) must answer with a list. When Claude Code
 *   refuses the probe's `--strict-mcp-config` because an enterprise MCP config is present, the probe asks
 *   once more without it (see `startClaudeProbe`); both tries share the one time limit and are stopped.
 *
 * Whatever happens (an answer, an error, an early exit, the time limit), the exchange is stopped, which
 * ends the process tree through `killProcessTree`, and the folder is removed before the outcome is
 * returned. (A program that already exited is left alone by `killProcessTree`, as its pid may be reused;
 * what it started in the background then outlives it, as for every agent.) A CLI that refuses the
 * handshake or answers in the wrong shape is `wrong_program`, one that ends or cannot start before
 * answering `did_not_start`, and one that never answers `timed_out`. Each protocol's process comes from
 * its adapter (`exchanges`), so tests drive this with fake transports and never a real CLI.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProtocol, AgentRefusalCode } from '../../shared/desktop/api'
import { planCliLaunch, type AgentProbeDeps } from '../desktop/agentProbe'
import { AcpError, openAcpConnection, RPC_METHOD_NOT_FOUND, type TransportFactory, type TransportHandle } from './adapters/acpClient'
import { objectOf } from './adapters/acp/acpJson'
import { acpInitializeParams } from './adapters/acp/acpSession'
import { RpcError } from './adapters/codexRpc'
import { withFolder, type AgentLaunchSpec } from './launchSpec'

/** How long a custom CLI has to finish its handshake. */
export const HANDSHAKE_TIMEOUT_MS = 20_000

/** A refusal reason is shown to the person: it is kept short. */
const MAX_REASON_CHARS = 300
const MAX_VERSION_CHARS = 64
/** What a version may look like to be stored and shown: plain version text, nothing else. */
const VERSION_TEXT = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/
const SEMVER = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/
/** Control and formatting characters (colour codes included) a CLI's error text may carry. */
const HIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu

/** A protocol exchange started in a folder: `answer` settles with what the CLI said; `stop` ends its process tree. */
export interface ProtocolExchange<T = unknown> {
  answer: Promise<T>
  stop(): Promise<void>
}

/** Starts `spec` in `folder` and begins its protocol's handshake; throws when it cannot be started at all. */
export type StartExchange = (spec: AgentLaunchSpec, folder: string) => ProtocolExchange

export type HandshakeOutcome = { ok: true; version: string | null } | { ok: false; code: AgentRefusalCode; reason: string }

interface HandshakeFolders {
  /** A fresh, empty folder (its canonical path) only this handshake uses. */
  makeTempDir(): string
  removeDir(path: string): void
}

export interface HandshakeDeps extends HandshakeFolders {
  exchanges: Readonly<Record<AgentProtocol, StartExchange>>
  /** Defaults to HANDSHAKE_TIMEOUT_MS. */
  timeoutMs?: number
}

interface ProtocolRules {
  name: string
  /** The outcome for what the exchange answered. */
  read(answer: unknown): HandshakeOutcome
  /** True for an error the CLI answered with (it refused), false for one that means it ended or never started. */
  refused(error: unknown): boolean
}

function refuse(code: AgentRefusalCode, reason: string): HandshakeOutcome {
  return { ok: false, code, reason }
}

function versionText(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_VERSION_CHARS && VERSION_TEXT.test(value) ? value : null
}

function readAcp(answer: unknown): HandshakeOutcome {
  const result = objectOf(answer)
  if (result === null || typeof result.protocolVersion !== 'number') {
    return refuse('wrong_program', 'It answered initialize without a protocolVersion, so it does not speak ACP.')
  }
  return { ok: true, version: versionText(objectOf(result.agentInfo)?.version) }
}

function readCodex(answer: unknown): HandshakeOutcome {
  const { initialized, catalog } = objectOf(answer) ?? {}
  const userAgent = objectOf(initialized)?.userAgent
  if (objectOf(initialized) === null || !Array.isArray(objectOf(catalog)?.data)) {
    return refuse('wrong_program', 'Its answers to initialize and model/list are not shaped like the Codex app-server’s.')
  }
  return { ok: true, version: typeof userAgent === 'string' ? versionText(SEMVER.exec(userAgent)?.[0]) : null }
}

function readClaude(answer: unknown): HandshakeOutcome {
  return Array.isArray(answer)
    ? { ok: true, version: null }
    : refuse('wrong_program', 'It did not list its models the way the Claude Code SDK expects.')
}

const RULES: Readonly<Record<AgentProtocol, ProtocolRules>> = {
  acp: { name: 'ACP', read: readAcp, refused: (error) => error instanceof AcpError && error.code !== null },
  codex: { name: 'Codex app-server', read: readCodex, refused: (error) => error instanceof RpcError },
  claude: { name: 'Claude Code SDK', read: readClaude, refused: () => false }
}

/** Plain text a person can read: no control or formatting characters, and short. */
function cleanText(text: string): string {
  const plain = text.replace(HIDDEN_TEXT, ' ').replace(/\s+/g, ' ').trim()
  return plain.length > MAX_REASON_CHARS ? `${plain.slice(0, MAX_REASON_CHARS)}…` : plain
}

function messageOf(error: unknown): string {
  return cleanText(error instanceof Error ? error.message : String(error))
}

const TIMED_OUT = Symbol('timed out')

/** `work`'s value, or TIMED_OUT once `ms` have passed; the timer never outlives the race. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMED_OUT)
    }, ms)
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}

/** Waits for the answer within the limit and reads it; the caller ends the process whatever this returns. */
async function judge(exchange: ProtocolExchange, rules: ProtocolRules, timeoutMs: number): Promise<HandshakeOutcome> {
  // An answer that comes after the limit is nobody's to read.
  exchange.answer.catch(() => {})
  try {
    const answer = await within(exchange.answer, timeoutMs)
    if (answer === TIMED_OUT) {
      return refuse('timed_out', `It did not finish the ${rules.name} handshake within ${Math.round(timeoutMs / 1000)} seconds.`)
    }
    return rules.read(answer)
  } catch (error) {
    return rules.refused(error)
      ? refuse('wrong_program', `It refused the ${rules.name} handshake: ${messageOf(error)}`)
      : refuse('did_not_start', `It stopped before it finished the ${rules.name} handshake: ${messageOf(error)}`)
  }
}

async function handshakeIn(spec: AgentLaunchSpec, folder: string, deps: HandshakeDeps): Promise<HandshakeOutcome> {
  const rules = RULES[spec.protocol]
  let exchange: ProtocolExchange
  try {
    exchange = deps.exchanges[spec.protocol](spec, folder)
  } catch (error) {
    return refuse('did_not_start', `It did not start: ${messageOf(error)}`)
  }
  try {
    return await judge(exchange, rules, deps.timeoutMs ?? HANDSHAKE_TIMEOUT_MS)
  } finally {
    // Each transport logs a tree that outlived its kill (`endAgentTree`, `CodexProcess.kill`, `ClaudeProcesses.killAll`); the outcome stands.
    await exchange.stop().catch(() => {})
  }
}

/** Runs the spec's handshake in a fresh temp folder, ending its process tree and removing the folder afterwards. */
export async function runHandshake(spec: AgentLaunchSpec, deps: HandshakeDeps): Promise<HandshakeOutcome> {
  const folder = deps.makeTempDir()
  try {
    return await handshakeIn(spec, folder, deps)
  } finally {
    try {
      deps.removeDir(folder)
    } catch {
      // A temp folder left behind (a file still held open on Windows) is the system's to clean up.
    }
  }
}

/** Fresh folders under `root` (the system temp folder), by their canonical path, so `{folder}` is what a chat would get. */
export function createHandshakeFolders(root: string = tmpdir()): HandshakeFolders {
  return {
    makeTempDir: () => realpathSync(mkdtempSync(join(root, 'dm-agent-handshake-'))),
    removeDir: (path) => {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 })
    }
  }
}

interface AcpExchangeDeps extends Pick<AgentProbeDeps, 'platform' | 'inspect' | 'comspec'> {
  transport: TransportFactory
  /** Sent to the agent as the client version. */
  clientVersion: string
}

/**
 * The ACP exchange: the spec's argv (`{folder}` replaced) through the launch rules, then `initialize`.
 * Whatever the agent asks meanwhile is answered method-not-found, so it is never left waiting. `stop`
 * kills through the transport itself when the connection already saw the process end (a connection's own
 * kill skips that case), so every stop reaches `killProcessTree`.
 */
export function acpExchange(deps: AcpExchangeDeps): StartExchange {
  return (spec, folder) => {
    const plan = planCliLaunch(spec.executablePath, withFolder(spec.args, folder), deps)
    if ('ok' in plan) {
      throw new Error(plan.reason)
    }
    let handle: TransportHandle | null = null
    const transport: TransportFactory = (...start) => (handle = deps.transport(...start))
    const connection = openAcpConnection(transport, plan.launch, { cwd: folder, agentName: spec.displayName }, {
      notification: () => {},
      request: (id, method) => {
        connection.fail(id, RPC_METHOD_NOT_FOUND, `Dark Mechanicus does not answer ${method} while it checks the CLI.`)
      },
      closed: () => {}
    })
    return {
      answer: connection.request('initialize', acpInitializeParams(deps.clientVersion)),
      stop: async () => {
        if (connection.isClosed()) {
          await handle?.kill()
        } else {
          await connection.kill()
        }
      }
    }
  }
}
