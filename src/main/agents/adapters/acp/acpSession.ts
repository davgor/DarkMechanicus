/**
 * One ACP agent process and the session in it: the handshake, `session/new` or `session/load`, prompt
 * turns, cancelling, and everything the agent asks of the client while a turn runs. A chat that
 * restarts its process (model change, crash) gets a new `AcpSession`. What differs between agents
 * (the auth method, the client capabilities beyond the common ones, the request methods beyond
 * `session/request_permission`) comes from the flavor.
 *
 * Source (read 2026-10-04): https://agentclientprotocol.com/protocol (initialization, `authenticate`,
 * session setup, prompt turn, `session/cancel`, tool calls and `session/request_permission`).
 *
 * Every request the agent sends is answered: a `session/request_permission` becomes an approval
 * request that is answered exactly once with the person's decision (or `cancelled`, which never
 * allows anything), a method the flavor declares is answered by its handler (at once, or when the
 * promise it returns settles), and every other method gets a JSON-RPC method-not-found error, because
 * an unanswered request would leave the agent waiting for ever.
 */
import type { ApprovalDecision, ChatAdapterEmit, ChatItem, DarkMechanicusCli, ModelOption } from '../../../../shared/agents/chat'
import type { ProbeLaunch } from '../../../desktop/agentProbe'
import {
  AcpError,
  openAcpConnection,
  RPC_INTERNAL_ERROR,
  RPC_METHOD_NOT_FOUND,
  type AcpConnection,
  type RpcId,
  type TransportFactory
} from '../acpClient'
import { isAuthRequired } from './acpAuth'
import { modelConfigOf, type ModelConfig } from './acpConfigOptions'
import { objectOf } from './acpJson'
import { chooseOptionId, describePermission, type PermissionDetails } from './acpPermissions'
import { stringOf } from './acpToolCalls'
import { UpdateTranslator } from './acpUpdates'

/** The ACP protocol version this client speaks. */
const PROTOCOL_VERSION = 1

/** The `initialize` params every session sends (no file system, no terminal), plus a flavor's own capabilities. */
export function acpInitializeParams(clientVersion: string, capabilities: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, ...capabilities },
    clientInfo: { name: 'dark-mechanicus', version: clientVersion }
  }
}

/** What an extension handler may do besides answering: put items (approval requests included) in the chat. */
export interface ExtensionContext {
  /** Reaches the chat; silent once the adapter is disposed. */
  emit: ChatAdapterEmit
  newId(): string
  now(): string
  /** Aborted when the turn is cancelled while the handler's promise is still pending; it should then settle with its "cancelled" answer. */
  signal: AbortSignal
  /**
   * The person refused the session's latest tool call still pending, for a request that names no
   * tool call (it must come right after that call): its failure is shown as a refusal.
   */
  denyPendingCall(): void
}

/**
 * Answers one request the agent sends under a method the flavor declares. What it returns is the
 * JSON-RPC result; a promise is answered when it settles (a rejection as an internal error), so a
 * handler can wait for the person.
 */
type ExtensionHandler = (params: unknown, chat: ExtensionContext) => unknown

/** A flavor's `authMethodId` that signs in with the first method `initialize` lists, and with none when it lists none. */
export const LISTED_AUTH_METHOD: unique symbol = Symbol('the first listed auth method')

/** The parts of a flavor the session speaks for. */
export interface SessionFlavor {
  /** How the agent is named in what the chat shows. */
  displayName: string
  /** The `authenticate` method sent after `initialize`: a fixed id, the one it lists (`LISTED_AUTH_METHOD`), or none (null). */
  authMethodId: string | null | typeof LISTED_AUTH_METHOD
  /** Added to the client capabilities every session declares in `initialize` (no file system, no terminal). */
  clientCapabilities?: Readonly<Record<string, unknown>>
  /** Agent-to-client request methods beyond `session/request_permission`, by method name. */
  extensions: Readonly<Record<string, ExtensionHandler>>
}

interface SessionEnv {
  transport: TransportFactory
  newId(): string
  now(): string
  clientVersion: string
}

interface SessionContext {
  folder: string
  /** The chat's `dm` invocation; only its environment is used, to carry the grant. */
  server: DarkMechanicusCli
  /** How to reach Dark Mechanicus (the `dm` command line, never the token): leads the process's first prompt. */
  instructions: string
  /** Reaches the chat; the adapter makes it silent once it is disposed. */
  emit: ChatAdapterEmit
}

interface BegunSession {
  sessionId: string
  /** Why the session that was asked for could not be resumed; null when it was resumed or none was asked for. */
  lost: string | null
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The answer that never allows anything: the request is withdrawn (ACP's outcome for a cancelled turn). */
export const CANCELLED = { outcome: 'cancelled' } as const

export class AcpSession {
  private sessionId = ''
  /**
   * True while the session is being opened: what the agent says then is not the chat's news (the
   * history `session/load` replays, and a notice a8s sends before `session/new` answers).
   */
  private opening = false
  /** Whether a prompt the agent took has carried the chat's instructions; a process started again is sent them again. */
  private instructed = false
  private readonly connection: AcpConnection
  private readonly translator: UpdateTranslator
  /** Requests still waiting for an answer (permissions, pending extensions): what answers each as cancelled. */
  private readonly waiting = new Map<RpcId, () => void>()
  /** The session's model and the ones it offers, as its config options last said; null until they say. */
  private modelConfig: ModelConfig | null = null

  constructor(
    private readonly flavor: SessionFlavor,
    private readonly env: SessionEnv,
    launch: ProbeLaunch,
    private readonly context: SessionContext
  ) {
    this.translator = new UpdateTranslator(env, (event) => {
      context.emit(event)
    })
    this.connection = openAcpConnection(env.transport, launch, { cwd: context.folder, env: context.server.env, agentName: flavor.displayName }, {
      notification: (method, params) => {
        this.onNotification(method, params)
      },
      request: (id, method, params) => {
        this.onRequest(id, method, params)
      },
      closed: () => {}
    })
  }

  isClosed(): boolean {
    return this.connection.isClosed()
  }

  /** The models the session offers, from its config options; empty when it offers none. */
  models(): ModelOption[] {
    return this.modelConfig?.options ?? []
  }

  /** The model the session runs on, as its config options last said; null when they did not say. */
  currentModel(): string | null {
    return this.modelConfig?.current ?? null
  }

  /** Switches the running session to `model` with `session/set_config_option`; rejects when the agent refuses. */
  async switchModel(model: string): Promise<void> {
    const result = objectOf(await this.connection.request('session/set_config_option', { sessionId: this.sessionId, configId: 'model', value: model }))
    this.modelConfig = modelConfigOf(result?.configOptions) ?? { current: model, options: this.models() }
  }

  /** Ends the session with `session/close`, best effort: an agent that refuses it, or lacks it, keeps the session. */
  async close(): Promise<void> {
    try {
      await this.connection.request('session/close', { sessionId: this.sessionId })
    } catch {
      // Nothing to undo: the process is ended next either way.
    }
  }

  /** Ends the process tree; resolves once it is gone. */
  kill(): Promise<void> {
    return this.connection.kill()
  }

  /**
   * Initializes, signs in with the flavor's auth method (if it has one), and loads `resumeId` (or
   * opens a new session when there is none or it cannot be loaded). A process that dies on the way rejects.
   */
  async begin(resumeId: string | null): Promise<BegunSession> {
    this.opening = true
    try {
      return await this.open(resumeId)
    } finally {
      this.opening = false
    }
  }

  private async open(resumeId: string | null): Promise<BegunSession> {
    const canLoad = await this.handshake()
    // No MCP server: the agent reaches Dark Mechanicus by running `dm`, authorized by the grant
    // in its environment.
    const params = { cwd: this.context.folder, mcpServers: [] }
    let lost: string | null = null
    if (resumeId !== null) {
      lost = canLoad ? await this.load(resumeId, params) : 'resuming is not supported'
      if (lost === null) {
        this.sessionId = resumeId
        return { sessionId: resumeId, lost }
      }
    }
    const created = objectOf(await this.connection.request('session/new', params))
    this.modelConfig = modelConfigOf(created?.configOptions)
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error(`${this.flavor.displayName} did not return a session id.`)
    }
    this.sessionId = sessionId
    return { sessionId, lost }
  }

  /**
   * Runs one turn; resolves with the ACP stop reason when the agent ends it.
   *
   * The process's first prompt is led by the chat's instructions. ACP has no system prompt, so they
   * travel as a text block marked for the agent alone (`audience`); the chat never shows them,
   * because the person's message is the app's own item and the agent's echo of it
   * (`user_message_chunk`) is not translated. A prompt the agent answers with an error took none of
   * it, so the next one is led by them again.
   */
  async prompt(text: string): Promise<string> {
    const instructing = !this.instructed && this.context.instructions !== ''
    const said = { type: 'text', text }
    const blocks = instructing ? [{ type: 'text', text: this.context.instructions, annotations: { audience: ['assistant'] } }, said] : [said]
    this.instructed ||= instructing
    try {
      const result = objectOf(await this.connection.request('session/prompt', { sessionId: this.sessionId, prompt: blocks }))
      const reason = result?.stopReason
      return typeof reason === 'string' ? reason : 'end_turn'
    } catch (error) {
      if (instructing) {
        this.instructed = false
      }
      throw error
    } finally {
      this.translator.flush()
    }
  }

  /** Asks the agent to stop the turn; permission requests still waiting are answered as cancelled, and pending extensions are told through their signal. */
  cancel(): void {
    this.connection.notify('session/cancel', { sessionId: this.sessionId })
    for (const cancel of this.waiting.values()) {
      cancel()
    }
  }

  /** initialize, and authenticate when the flavor has an auth method; true unless the agent says it cannot load sessions. */
  private async handshake(): Promise<boolean> {
    const initialized = objectOf(
      await this.connection.request('initialize', acpInitializeParams(this.env.clientVersion, this.flavor.clientCapabilities))
    )
    const methodId = this.authMethodOf(initialized)
    if (methodId !== null) {
      try {
        await this.connection.request('authenticate', { methodId })
      } catch (error) {
        // An agent without the method has nothing to sign in to; any other refusal is the person's to fix.
        if (!(error instanceof AcpError && error.code === RPC_METHOD_NOT_FOUND)) {
          throw error
        }
      }
    }
    return objectOf(initialized?.agentCapabilities)?.loadSession !== false
  }

  /** The `authenticate` method to send: the flavor's own, or for `LISTED_AUTH_METHOD` the first one `initialize` listed. */
  private authMethodOf(initialized: Record<string, unknown> | null): string | null {
    if (this.flavor.authMethodId !== LISTED_AUTH_METHOD) {
      return this.flavor.authMethodId
    }
    const methods = initialized?.authMethods
    return Array.isArray(methods) ? stringOf(objectOf(methods[0])?.id) : null
  }

  /** `session/load`; null when it worked, else why not. */
  private async load(sessionId: string, params: Record<string, unknown>): Promise<string | null> {
    try {
      const loaded = objectOf(await this.connection.request('session/load', { sessionId, ...params }))
      this.modelConfig = modelConfigOf(loaded?.configOptions)
      return null
    } catch (error) {
      // A refused login is not a lost session: it is reported as it is, and the session is loaded once signed in.
      if (this.connection.isClosed() || isAuthRequired(error)) {
        throw error
      }
      return reasonOf(error)
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update' || this.opening) {
      return
    }
    const body = objectOf(params)
    const update = objectOf(body?.update)
    if (update?.sessionUpdate === 'config_option_update') {
      this.modelConfig = modelConfigOf(update.configOptions) ?? this.modelConfig
    }
    this.translator.apply(typeof body?.sessionId === 'string' ? body.sessionId : this.sessionId, body?.update)
  }

  private onRequest(id: RpcId, method: string, params: unknown): void {
    if (method === 'session/request_permission') {
      this.onPermission(id, params)
      return
    }
    // Own keys only: a method named `toString` or `__proto__` is not a declared extension.
    const handler = Object.hasOwn(this.flavor.extensions, method) ? this.flavor.extensions[method] : undefined
    if (handler === undefined) {
      this.connection.fail(id, RPC_METHOD_NOT_FOUND, `Method not supported: ${method}`)
      return
    }
    const controller = new AbortController()
    const chat: ExtensionContext = {
      emit: this.context.emit,
      newId: () => this.env.newId(),
      now: () => this.env.now(),
      signal: controller.signal,
      denyPendingCall: () => {
        this.translator.denyPending()
      }
    }
    const result = handler(params, chat)
    if (!(result instanceof Promise)) {
      this.connection.respond(id, result)
      return
    }
    this.waiting.set(id, () => {
      controller.abort()
    })
    void result.then(
      (answer: unknown) => {
        this.waiting.delete(id)
        this.connection.respond(id, answer)
      },
      (error: unknown) => {
        this.waiting.delete(id)
        this.connection.fail(id, RPC_INTERNAL_ERROR, reasonOf(error))
      }
    )
  }

  private onPermission(id: RpcId, params: unknown): void {
    const details = describePermission(params, this.flavor.displayName)
    const options = objectOf(params)?.options
    let answered = false
    const answer = (outcome: unknown): void => {
      if (!answered) {
        answered = true
        this.waiting.delete(id)
        this.connection.respond(id, { outcome })
      }
    }
    const respond = (decision: ApprovalDecision): void => {
      if (answered) {
        return
      }
      const optionId = chooseOptionId(options, decision)
      if (decision === 'deny' && details.toolCallId !== null) {
        this.translator.markDenied(this.sessionId, details.toolCallId)
      }
      answer(optionId === null ? CANCELLED : { outcome: 'selected', optionId })
    }
    this.waiting.set(id, () => {
      answer(CANCELLED)
    })
    try {
      this.context.emit({ type: 'approval_request', request: this.requestItem(details), respond })
    } catch {
      // Whatever went wrong on the way to the person, the agent is not left waiting.
      answer(CANCELLED)
    }
  }

  private requestItem(details: PermissionDetails): Extract<ChatItem, { kind: 'approval_request' }> {
    const { category, tool, summary, input } = details
    return {
      id: this.env.newId(),
      at: this.env.now(),
      kind: 'approval_request',
      requestId: this.env.newId(),
      category,
      tool,
      summary,
      ...(input === undefined ? {} : { input })
    }
  }
}
