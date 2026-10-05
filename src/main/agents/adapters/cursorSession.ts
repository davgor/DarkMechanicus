/**
 * One `agent acp` process and the ACP session in it: the handshake, `session/new` or
 * `session/load`, prompt turns, cancelling, and everything the agent asks of the client while a turn
 * runs. A chat that restarts its process (model change, crash) gets a new `CursorSession`.
 *
 * Sources (read 2026-10-04): https://cursor.com/docs/cli/acp (initialize, `authenticate` with
 * `cursor_login`, `session/new`, `session/load`, `session/prompt`, `session/cancel`,
 * `session/request_permission`, the `cursor/*` extension methods and the answers they expect) and
 * https://agentclientprotocol.com/protocol (session setup, prompt turn, tool calls).
 *
 * Every request the agent sends is answered: a `session/request_permission` becomes an approval
 * request that is answered exactly once with the person's decision (or `cancelled`, which never
 * allows anything), and the methods this client does not offer get a JSON-RPC error, because an
 * unanswered request would leave the agent waiting for ever.
 */
import type { ApprovalDecision, ChatAdapterEmit, ChatItem, McpServerSpec } from '../../../shared/agents/chat'
import type { ProbeLaunch } from '../../desktop/agentProbe'
import {
  AcpError,
  openAcpConnection,
  RPC_METHOD_NOT_FOUND,
  type AcpConnection,
  type RpcId,
  type TransportFactory
} from './acpClient'
import { isAuthRequired } from './cursorAuth'
import { chooseOptionId, objectOf, permissionDetails } from './cursorProtocol'
import { UpdateTranslator } from './cursorUpdates'

/** The name the Dark Mechanicus server is registered under, as in the other agents' MCP configs. */
const MCP_SERVER_NAME = 'darkmechanicus'

/** ACP protocol version 1 is the one Cursor's page documents. */
const PROTOCOL_VERSION = 1

interface SessionEnv {
  transport: TransportFactory
  newId(): string
  now(): string
  clientVersion: string
}

interface SessionContext {
  folder: string
  server: McpServerSpec
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
const CANCELLED = { outcome: 'cancelled' } as const

/** The questions Cursor asked, for the notice that says they were declined. */
function questionsOf(params: unknown): string {
  const questions = objectOf(params)?.questions
  const prompts = Array.isArray(questions)
    ? questions.flatMap((question: unknown) => {
        const prompt = objectOf(question)?.prompt
        return typeof prompt === 'string' ? [prompt] : []
      })
    : []
  return prompts.length === 0 ? 'a question' : prompts.join(' / ')
}

export class CursorSession {
  private sessionId = ''
  private replaying = false
  private readonly connection: AcpConnection
  private readonly translator: UpdateTranslator
  /** Waiting permission requests: what answers each as cancelled. */
  private readonly waiting = new Map<RpcId, () => void>()

  constructor(
    private readonly env: SessionEnv,
    launch: ProbeLaunch,
    private readonly context: SessionContext
  ) {
    this.translator = new UpdateTranslator(env, (event) => {
      context.emit(event)
    })
    this.connection = openAcpConnection(env.transport, launch, context.folder, {
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

  /** Ends the process tree; resolves once it is gone. */
  kill(): Promise<void> {
    return this.connection.kill()
  }

  /**
   * Initializes, signs in with the stored Cursor login, and loads `resumeId` (or opens a new session
   * when there is none or it cannot be loaded). A process that dies on the way rejects.
   */
  async begin(resumeId: string | null): Promise<BegunSession> {
    const canLoad = await this.handshake()
    const params = { cwd: this.context.folder, mcpServers: [this.mcpServer()] }
    let lost: string | null = null
    if (resumeId !== null) {
      lost = canLoad ? await this.load(resumeId, params) : 'resuming is not supported'
      if (lost === null) {
        this.sessionId = resumeId
        return { sessionId: resumeId, lost }
      }
    }
    const created = objectOf(await this.connection.request('session/new', params))
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('Cursor did not return a session id.')
    }
    this.sessionId = sessionId
    return { sessionId, lost }
  }

  /** Runs one turn; resolves with the ACP stop reason when the agent ends it. */
  async prompt(text: string): Promise<string> {
    try {
      const result = objectOf(
        await this.connection.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] })
      )
      const reason = result?.stopReason
      return typeof reason === 'string' ? reason : 'end_turn'
    } finally {
      this.translator.flush()
    }
  }

  /** Asks the agent to stop the turn; permission requests still waiting are answered as cancelled. */
  cancel(): void {
    this.connection.notify('session/cancel', { sessionId: this.sessionId })
    for (const cancel of this.waiting.values()) {
      cancel()
    }
  }

  private mcpServer(): Record<string, unknown> {
    const { command, args, env = {} } = this.context.server
    return { name: MCP_SERVER_NAME, command, args, env: Object.entries(env).map(([name, value]) => ({ name, value })) }
  }

  /** initialize and authenticate; true unless Cursor says it cannot load sessions. */
  private async handshake(): Promise<boolean> {
    const initialized = objectOf(
      await this.connection.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'dark-mechanicus', version: this.env.clientVersion }
      })
    )
    try {
      await this.connection.request('authenticate', { methodId: 'cursor_login' })
    } catch (error) {
      // A Cursor without the method has nothing to sign in to; any other refusal is the person's to fix.
      if (!(error instanceof AcpError && error.code === RPC_METHOD_NOT_FOUND)) {
        throw error
      }
    }
    return objectOf(initialized?.agentCapabilities)?.loadSession !== false
  }

  /** `session/load`; null when it worked, else why not. The history it replays is not the chat's news. */
  private async load(sessionId: string, params: Record<string, unknown>): Promise<string | null> {
    this.replaying = true
    try {
      await this.connection.request('session/load', { sessionId, ...params })
      return null
    } catch (error) {
      // A refused login is not a lost session: it is reported as it is, and the session is loaded once signed in.
      if (this.connection.isClosed() || isAuthRequired(error)) {
        throw error
      }
      return reasonOf(error)
    } finally {
      this.replaying = false
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update' || this.replaying) {
      return
    }
    const body = objectOf(params)
    this.translator.apply(typeof body?.sessionId === 'string' ? body.sessionId : this.sessionId, body?.update)
  }

  private onRequest(id: RpcId, method: string, params: unknown): void {
    switch (method) {
      case 'session/request_permission':
        this.onPermission(id, params)
        return
      case 'cursor/ask_question':
        this.decline(
          id,
          'cursor_question',
          `Cursor asked "${questionsOf(params)}", but this chat cannot show Cursor's questions yet, so it was declined. Answer in a message instead.`
        )
        return
      case 'cursor/create_plan':
        this.decline(
          id,
          'cursor_plan',
          'Cursor proposed a plan for approval, but this chat cannot show plans yet, so it was declined. Ask for the plan in a message instead.'
        )
        return
      case 'cursor/update_todos':
        this.connection.respond(id, { outcome: { outcome: 'accepted', todos: objectOf(params)?.todos ?? [] } })
        return
      case 'cursor/task':
        this.connection.respond(id, { outcome: { outcome: 'completed', ...taskResult(params) } })
        return
      default:
        this.connection.fail(id, RPC_METHOD_NOT_FOUND, `Method not supported: ${method}`)
    }
  }

  /** A blocking Cursor extension this chat has no way to put to the person: noted in the transcript, answered cancelled. */
  private decline(id: RpcId, code: string, message: string): void {
    const item: ChatItem = { id: this.env.newId(), at: this.env.now(), kind: 'error', message, code }
    this.context.emit({ type: 'item', item })
    this.connection.respond(id, { outcome: CANCELLED })
  }

  private onPermission(id: RpcId, params: unknown): void {
    const details = permissionDetails(params)
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

  private requestItem(details: ReturnType<typeof permissionDetails>): Extract<ChatItem, { kind: 'approval_request' }> {
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

function taskResult(params: unknown): Record<string, unknown> {
  const body = objectOf(params)
  return {
    ...(typeof body?.agentId === 'string' ? { agentId: body.agentId } : {}),
    ...(typeof body?.durationMs === 'number' ? { durationMs: body.durationMs } : {})
  }
}
