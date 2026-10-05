/**
 * The Codex chat adapter: one `codex app-server` process per chat, spoken to in JSON-RPC over stdio.
 *
 * Protocol (https://github.com/openai/codex, `codex-rs/app-server-protocol`, `schema/typescript`:
 * ClientRequest, ServerRequest, ServerNotification and the v2 types; `src/rpc.rs` for the wire
 * format, which is JSON-RPC 2.0 without the `jsonrpc` field, one message per line):
 * - `initialize` + `initialized`, then `thread/start` (or `thread/resume` with the stored thread id).
 * - `turn/start` runs a turn: `{ threadId, input, model, approvalPolicy }`. The turn ends with the
 *   `turn/completed` notification (`completed`, `interrupted` or `failed`); `turn/interrupt` is Stop.
 * - Progress arrives as `item/started`, `item/agentMessage/delta` and `item/completed` notifications.
 * - Before an edit or a command the server sends `item/fileChange/requestApproval` or
 *   `item/commandExecution/requestApproval` and waits for the person's decision (`codexApprovals.ts`).
 * - `model/list` is the model catalog; the model of a turn goes on `turn/start`.
 *
 * Approval policy and sandbox. Every thread starts with approval policy `untrusted` and sandbox
 * `workspace-write`. Under `untrusted` Codex runs only commands it knows are safe reads without
 * asking, and asks before any other command and before every file change, so reads proceed and
 * every edit and command is the person's call, whatever the sandbox does. The sandbox is the second
 * line: an approved command still runs confined to the chat's folder (plus temporary files),
 * without network, unless Codex asks for more and the person allows that too. On Windows how much
 * of that the sandbox enforces is up to Codex's own Windows sandbox support; the approvals do not
 * depend on it. `on-request` would leave the model deciding when to ask, and `read-only` would
 * turn every edit into a failure plus an escalation, so neither gives the "everything asks"
 * behavior the chat promises.
 *
 * The Dark Mechanicus server. It is handed over as a config override on `thread/start` and
 * `thread/resume` (`config: { "mcp_servers.darkmechanicus": { command, args, env } }`), which
 * Codex applies for that thread only and merges with whatever servers the person configured.
 * Nothing is written to the person's Codex configuration, and none of this code touches the file
 * system. Codex asks before running a tool of an MCP server (`mcpServer/elicitation/request`);
 * that reaches the person as an approval request like the others.
 *
 * Sign-in. A login that Codex cannot use is reported as one `auth_required` item and the turn
 * ends cleanly: a turn that fails with `codexErrorInfo` `unauthorized` (or an HTTP 401), or a
 * `thread/start`, `thread/resume` or `turn/start` the app-server refuses with `action: "relogin"`.
 * The process is then killed, so none runs on the old login, and the next message starts a new one that
 * reads the person's new login and resumes the same thread. A refusal while the chat is being started
 * is held until the first message (`start` resolves, so the chat still opens), which tries again.
 * The shapes are from the Codex source (see `__mocks__/codexSignedOut.ts`), not from a real session.
 *
 * Subagents. A subagent Codex starts is a thread of its own whose notifications and requests arrive
 * on the same connection with its own `threadId`. They are filed as nested threads of the chat
 * (`codexThreads.ts`): a `thread` item after the spawning tool call, the subagent's items and
 * deltas with the thread's id, its approval requests with the thread's id and label. A notification
 * for a thread that no spawn announced is dropped, as before; an approval request from one is raised
 * in the chat's own thread so that the server is never left waiting.
 *
 * Resume. A stored thread id is resumed with `thread/resume`. When Codex refuses (the thread is
 * gone), a `context_reset` item says so and a new thread starts. A new thread's id is reported as
 * the chat's session once its first turn starts (see `useThread`). A process that dies between
 * turns is replaced on the next message, resuming the same thread.
 */
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import type {
  ApprovalDecision,
  ApprovalRequestItem,
  ChatAdapter,
  ChatAdapterEmit,
  ChatAdapterEvent,
  ChatAdapterStartOptions,
  ModelOption
} from '../../../shared/agents/chat'
import type { AgentKind } from '../../../shared/desktop/api'
import type { ChatAdapterDefinition } from '../adapterRegistry'
import { answerFor, describeApproval, type ApprovalDescription } from './codexApprovals'
import { asRecord, asText, fileChangeOf, itemFor, reloginMessage, scopedId, turnEnd, type ChangedFile, type Phase } from './codexItems'
import { spawnCodexTransport } from './codexProcess'
import { createRpcClient, RpcError, type RpcClient, type RpcTransport } from './codexRpc'
import { CodexThreads, inThread, type ThreadRef } from './codexThreads'

/** Ask before every command that is not a known-safe read, and before every file change. */
const APPROVAL_POLICY = 'untrusted'
/** Writes only inside the chat's folder, no network. */
const SANDBOX_MODE = 'workspace-write'
/** The name the Dark Mechanicus MCP server has in Codex's configuration. */
const SERVER_NAME = 'darkmechanicus'
const DEFAULT_INTERRUPT_GRACE_MS = 5_000
/** A guard against a server that never stops paging. */
const MAX_MODEL_PAGES = 20

export interface CodexDeps {
  /** Starts `codex app-server` (the registry's executable) in `folder`. */
  connect(executablePath: string, folder: string): RpcTransport
  /** A fresh id for what the adapter makes up itself (approval requests, notices). */
  newId(): string
  now(): string
  /** Sent to Codex as the client version. */
  clientVersion?: string
  /** How long to wait for a turn to report that it ended after `turn/interrupt` was accepted. */
  interruptGraceMs?: number
}

// ---- The turn that is running ----

interface ActiveTurn {
  /** The id Codex gave the turn; null until `turn/start` is answered. */
  turnId: string | null
  /** Resolves with the turn id once known, or null when the turn never started. */
  readonly started: Promise<string | null>
  /** Settles when the turn ends: resolved when finished or interrupted, rejected when it failed. */
  readonly done: Promise<void>
  interrupting: boolean
  /** True once the turn ended or failed. */
  settled: boolean
  begin(turnId: string | null): void
  finish(): void
  fail(error: Error): void
  /** Ends the turn locally if Codex has not reported its end `ms` from now. */
  armGrace(ms: number): void
  disarm(): void
}

function createTurn(): ActiveTurn {
  let begun: (turnId: string | null) => void = () => {}
  let ended: () => void = () => {}
  let failed: (error: Error) => void = () => {}
  let timer: ReturnType<typeof setTimeout> | null = null
  const started = new Promise<string | null>((resolve) => {
    begun = resolve
  })
  const done = new Promise<void>((resolve, reject) => {
    ended = resolve
    failed = reject
  })
  // `send` awaits `done`, but a failure can come while it still waits for `turn/start`.
  done.catch(() => {})
  const turn: ActiveTurn = {
    turnId: null,
    started,
    done,
    interrupting: false,
    settled: false,
    begin: (turnId) => {
      turn.turnId = turn.turnId ?? turnId
      begun(turnId)
    },
    finish: () => {
      turn.settled = true
      turn.disarm()
      ended()
      begun(null)
    },
    fail: (error) => {
      turn.settled = true
      turn.disarm()
      failed(error)
      begun(null)
    },
    armGrace: (ms) => {
      turn.disarm()
      timer = setTimeout(turn.finish, ms)
    },
    disarm: () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
  return turn
}

// ---- Handshake and catalog, shared by chats and by the model picker ----

async function handshake(rpc: RpcClient, deps: CodexDeps): Promise<void> {
  await rpc.request('initialize', {
    clientInfo: { name: 'dark-mechanicus', title: 'Dark Mechanicus', version: deps.clientVersion ?? 'unknown' },
    capabilities: null
  })
  rpc.notify('initialized')
}

function modelOption(entry: unknown): ModelOption | null {
  const fields = asRecord(entry)
  const id = asText(fields?.model) ?? asText(fields?.id)
  if (fields === null || id === null || fields.hidden === true) {
    return null
  }
  return { id, label: asText(fields.displayName) ?? id }
}

/** Every model the picker shows (hidden ones are left out), following the catalog's pages. */
async function fetchModels(rpc: RpcClient): Promise<ModelOption[]> {
  const models: ModelOption[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const response = asRecord(await rpc.request('model/list', cursor === null ? {} : { cursor }))
    const entries: unknown[] = Array.isArray(response?.data) ? response.data : []
    models.push(...entries.flatMap((entry) => modelOption(entry) ?? []))
    cursor = asText(response?.nextCursor)
    if (cursor === null) {
      break
    }
  }
  return models
}

const NO_REQUESTS: Parameters<typeof createRpcClient>[1] = {
  onNotification: () => {},
  onRequest: (method) => Promise.reject(new RpcError(-32601, `Dark Mechanicus does not handle the Codex request ${method}.`))
}

/** The models without a chat: a process of its own, stopped as soon as the catalog is read. */
async function listCodexModels(deps: CodexDeps, executablePath: string): Promise<ModelOption[]> {
  const transport = deps.connect(executablePath, tmpdir())
  const rpc = createRpcClient(transport, NO_REQUESTS)
  try {
    await handshake(rpc, deps)
    return await fetchModels(rpc)
  } finally {
    rpc.close('Listing models is done.')
    await transport.kill()
  }
}

// ---- The adapter ----

function turnIdOf(response: unknown): string {
  const id = asText(asRecord(asRecord(response)?.turn)?.id)
  if (id === null) {
    throw new Error('Codex did not say which turn it started.')
  }
  return id
}

class CodexAdapter implements ChatAdapter {
  readonly kind: AgentKind = 'codex'
  private options: ChatAdapterStartOptions | null = null
  private emit: ChatAdapterEmit | null = null
  private rpc: RpcClient | null = null
  private transport: RpcTransport | null = null
  private threadId: string | null = null
  /** A new thread's id, held back until its first turn starts (see `useThread`). */
  private unreported: string | null = null
  private model: string | null = null
  private turn: ActiveTurn | null = null
  private disposed = false
  /** The login was rejected during the turn that is running; its process is let go of when the turn ends. */
  private signedOut = false
  /** The files of each file-change item, so its approval request can name them. */
  private readonly fileChanges = new Map<string, ChangedFile[]>()
  /** The subagent threads of the chat. */
  private readonly threads = new CodexThreads(() => this.deps.now())

  constructor(
    private readonly executablePath: string,
    private readonly deps: CodexDeps
  ) {}

  async start(options: ChatAdapterStartOptions, emit: ChatAdapterEmit): Promise<void> {
    this.options = options
    this.emit = emit
    this.model = options.model
    this.threadId = options.sessionId
    try {
      await this.open(options.sessionId)
    } catch (error) {
      // A login Codex refuses is reported by the first message, which tries again; the process is already gone.
      if (reloginMessage(error) === null) {
        throw error
      }
    }
  }

  async send(text: string): Promise<void> {
    if (this.disposed) {
      throw new Error('The Codex chat has ended.')
    }
    if (this.options === null) {
      throw new Error('The Codex chat has not started.')
    }
    if (this.turn !== null) {
      throw new Error('The Codex chat is still answering.')
    }
    // Registered before anything is awaited, so a Stop right after this call finds the turn.
    const turn = createTurn()
    this.turn = turn
    try {
      await this.runTurn(turn, text)
    } finally {
      turn.begin(null)
      turn.disarm()
      if (this.turn === turn) {
        this.turn = null
      }
    }
    await this.releaseAfterSignOut()
  }

  private async runTurn(turn: ActiveTurn, text: string): Promise<void> {
    try {
      const rpc = await this.connected()
      turn.begin(turnIdOf(await rpc.request('turn/start', this.turnParams(text))))
      this.reportSession()
      await turn.done
    } catch (error) {
      const refusal = reloginMessage(error)
      if (refusal === null) {
        throw error
      }
      this.reportSignedOut(refusal)
    }
  }

  /** One `auth_required` item for the turn; the process is let go of by `releaseAfterSignOut`. */
  private reportSignedOut(message: string): void {
    this.signedOut = true
    this.out({ type: 'item', item: { id: `codex_auth_${this.deps.newId()}`, at: this.deps.now(), kind: 'auth_required', agent: 'codex', message } })
  }

  /** Kills the process that ran on a login that was rejected (one that is already gone is left alone). */
  private async releaseAfterSignOut(): Promise<void> {
    if (!this.signedOut) {
      return
    }
    this.signedOut = false
    const { rpc, transport } = this
    if (rpc !== null && !rpc.closed) {
      rpc.close('The Codex login was rejected.')
      await transport?.kill()
      this.outAll(this.threads.end())
    }
  }

  setModel(model: string): Promise<void> {
    // Codex takes the model with each turn; this one goes out on the next `turn/start`.
    this.model = model
    return Promise.resolve()
  }

  async stop(): Promise<void> {
    const { turn, rpc } = this
    if (turn === null || rpc === null || turn.interrupting) {
      return
    }
    turn.interrupting = true
    const turnId = await turn.started
    if (turnId === null || this.threadId === null) {
      return
    }
    try {
      await rpc.request('turn/interrupt', { threadId: this.threadId, turnId })
    } catch (error) {
      // A refused interrupt is a failure only while the turn still runs; one that just ended needs none.
      if (!turn.settled) {
        throw error
      }
      return
    }
    if (!turn.settled) {
      turn.armGrace(this.deps.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS)
    }
  }

  listModels(): Promise<ModelOption[]> {
    return this.rpc !== null && !this.rpc.closed ? fetchModels(this.rpc) : listCodexModels(this.deps, this.executablePath)
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.turn?.finish()
    this.rpc?.close('The Codex chat has ended.')
    await this.transport?.kill()
  }

  // ---- Process and thread ----

  /** The live connection; a process that died since the last turn is replaced and its thread resumed. */
  private async connected(): Promise<RpcClient> {
    if (this.rpc !== null && !this.rpc.closed) {
      return this.rpc
    }
    void this.transport?.kill()
    await this.open(this.threadId)
    return this.rpc as RpcClient
  }

  private async open(resumeId: string | null): Promise<void> {
    const options = this.options as ChatAdapterStartOptions
    const transport = this.deps.connect(this.executablePath, options.folder)
    const rpc: RpcClient = createRpcClient(transport, {
      onNotification: (method, params) => {
        this.onNotification(method, params)
      },
      onRequest: (method, params) => this.onRequest(method, params),
      onClose: (reason) => {
        if (this.rpc === rpc) {
          this.turn?.fail(new Error(reason))
          this.outAll(this.threads.end())
        }
      }
    })
    this.transport = transport
    this.rpc = rpc
    try {
      await handshake(rpc, this.deps)
      await this.openThread(rpc, resumeId)
    } catch (error) {
      rpc.close('Codex did not start.')
      await transport.kill()
      throw error
    }
  }

  /** The settings every thread gets, new or resumed. */
  private threadSettings(): Record<string, unknown> {
    const { folder, darkMechanicus } = this.options as ChatAdapterStartOptions
    const { command, args, env } = darkMechanicus
    const server = { command, args, ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }) }
    return {
      cwd: folder,
      ...(this.model === null ? {} : { model: this.model }),
      approvalPolicy: APPROVAL_POLICY,
      sandbox: SANDBOX_MODE,
      config: { [`mcp_servers.${SERVER_NAME}`]: server }
    }
  }

  private async openThread(rpc: RpcClient, resumeId: string | null): Promise<void> {
    if (resumeId !== null) {
      try {
        this.useThread(await rpc.request('thread/resume', { threadId: resumeId, ...this.threadSettings() }), false)
        return
      } catch (error) {
        // A refused login is not a lost thread: it is reported as it is, and the thread is resumed once signed in.
        if (!(error instanceof RpcError) || reloginMessage(error) !== null) {
          throw error
        }
        this.out({
          type: 'item',
          item: {
            id: `reset_${this.deps.newId()}`,
            at: this.deps.now(),
            kind: 'context_reset',
            reason: 'session_lost',
            message: `Codex could not resume the earlier conversation (${error.message}), so this chat continues in a new one.`
          }
        })
      }
    }
    this.useThread(await rpc.request('thread/start', this.threadSettings()), true)
  }

  /**
   * Adopts the thread the server answered with. A resumed thread is already the chat's session. A
   * new one has no conversation yet, and Codex does not keep an empty thread to resume later, so
   * its id is reported (`reportSession`) once its first turn is under way: a chat that is opened
   * and never used then never stores an id it could not resume.
   */
  private useThread(response: unknown, fresh: boolean): void {
    const id = asText(asRecord(asRecord(response)?.thread)?.id)
    if (id === null) {
      throw new Error('Codex did not return a thread id.')
    }
    this.threadId = id
    this.unreported = fresh ? id : null
  }

  private reportSession(): void {
    if (this.unreported !== null) {
      this.out({ type: 'session', sessionId: this.unreported })
      this.unreported = null
    }
  }

  private turnParams(text: string): Record<string, unknown> {
    return {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      ...(this.model === null ? {} : { model: this.model }),
      approvalPolicy: APPROVAL_POLICY
    }
  }

  // ---- What the server tells ----

  private out(event: ChatAdapterEvent): void {
    if (!this.disposed) {
      this.emit?.(event)
    }
  }

  private outAll(events: ChatAdapterEvent[]): void {
    for (const event of events) {
      this.out(event)
    }
  }

  private onNotification(method: string, params: unknown): void {
    const fields = asRecord(params)
    if (this.disposed || fields === null) {
      return
    }
    switch (method) {
      case 'item/started':
        this.onItem(fields, 'started')
        return
      case 'item/completed':
        this.onItem(fields, 'completed')
        return
      case 'item/agentMessage/delta':
        this.onDelta(fields)
        return
      case 'turn/started':
        this.onTurnStarted(fields)
        return
      case 'turn/completed':
        this.onTurnCompleted(fields)
        return
      case 'mcpServer/startupStatus/updated':
        this.onServerStatus(fields)
    }
  }

  private ownThread(fields: Record<string, unknown>): boolean {
    return fields.threadId === this.threadId
  }

  /**
   * Where a notification or request belongs: the chat's own thread (null), the thread of a subagent
   * a spawn announced (its reference), or no thread this chat knows (undefined).
   */
  private scopeOf(fields: Record<string, unknown>): ThreadRef | null | undefined {
    if (this.ownThread(fields)) {
      return null
    }
    return this.threads.find(asText(fields.threadId) ?? '') ?? undefined
  }

  /** The turn an event belongs to: the one it names, else the one running. */
  private turnIdOf(fields: Record<string, unknown>): string {
    return asText(fields.turnId) ?? this.turn?.turnId ?? 'turn'
  }

  private onItem(fields: Record<string, unknown>, phase: Phase): void {
    const scope = this.scopeOf(fields)
    if (scope === undefined) {
      return
    }
    const threadId = scope?.id
    const change = fileChangeOf(fields.item)
    if (change !== null) {
      this.fileChanges.set(change.id, change.files)
    }
    const turnId = this.turnIdOf(fields)
    const item = itemFor(fields.item, phase, turnId, this.deps.now())
    if (item !== null) {
      this.out({ type: 'item', item: inThread(item, threadId) })
    }
    this.outAll(this.threads.observe(fields.item, { phase, turnId, inThread: threadId }))
  }

  private onDelta(fields: Record<string, unknown>): void {
    const scope = this.scopeOf(fields)
    const itemId = asText(fields.itemId)
    const delta = asText(fields.delta)
    if (scope !== undefined && itemId !== null && delta !== null) {
      const threadId = scope === null ? {} : { threadId: scope.id }
      this.out({ type: 'assistant_delta', itemId: scopedId(this.turnIdOf(fields), itemId), delta, ...threadId })
    }
  }

  private onTurnStarted(fields: Record<string, unknown>): void {
    if (!this.ownThread(fields)) {
      this.outAll(this.threads.turnStarted(asText(fields.threadId) ?? ''))
    }
  }

  private onTurnCompleted(fields: Record<string, unknown>): void {
    if (!this.ownThread(fields)) {
      this.outAll(this.threads.turnEnded(asText(fields.threadId) ?? '', fields.turn))
      return
    }
    const { turn } = this
    const end = turn === null ? null : turnEnd(fields.turn, turn.turnId)
    if (turn === null || end === null) {
      return
    }
    this.fileChanges.clear()
    if (end.failure === null) {
      turn.finish()
    } else if (end.signedOut) {
      this.reportSignedOut(end.failure)
      turn.finish()
    } else {
      turn.fail(new Error(end.failure))
    }
  }

  private onServerStatus(fields: Record<string, unknown>): void {
    if (fields.name === SERVER_NAME && fields.status === 'failed') {
      this.out({
        type: 'item',
        item: {
          id: `mcp_${this.deps.newId()}`,
          at: this.deps.now(),
          kind: 'error',
          message: `The Dark Mechanicus server could not start: ${asText(fields.error) ?? 'no reason given'}`,
          code: 'mcp_startup_failed'
        }
      })
    }
  }

  // ---- What the server asks ----

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    const fields = asRecord(params) ?? {}
    const description = describeApproval(method, fields, this.fileChanges)
    if (description !== null) {
      return this.askPerson(method, fields, description)
    }
    if (method === 'item/tool/requestUserInput') {
      // Questions for the person have no place in the chat yet: answer without answers rather than hold the turn.
      return { answers: {} }
    }
    throw new RpcError(-32601, `Dark Mechanicus does not handle the Codex request ${method}.`)
  }

  /** Raises an approval request and holds the server until the person decides. */
  private async askPerson(method: string, params: Record<string, unknown>, description: ApprovalDescription): Promise<unknown> {
    const requestId = this.deps.newId()
    const thread = this.scopeOf(params) ?? null
    const request: ApprovalRequestItem = {
      id: `approval_${requestId}`,
      at: this.deps.now(),
      kind: 'approval_request',
      requestId,
      ...description,
      ...(thread === null ? {} : { threadId: thread.id, threadLabel: thread.label })
    }
    const decision = await new Promise<ApprovalDecision>((respond) => {
      this.out({ type: 'approval_request', request, respond })
    })
    return answerFor(method, params, decision)
  }
}

export function createCodexAdapter(executablePath: string, deps: CodexDeps): ChatAdapter {
  return new CodexAdapter(executablePath, deps)
}

export function codexAdapterDefinition(deps: CodexDeps): ChatAdapterDefinition {
  return {
    // The handshake and the thread resume take a moment; doing them when the chat opens makes the
    // first message quick and reports a lost thread (a context reset) as soon as the chat is open.
    startOnOpen: true,
    create: (executablePath) => createCodexAdapter(executablePath, deps),
    listModels: (executablePath) => listCodexModels(deps, executablePath)
  }
}

/** The definition the app registers: real processes, random ids, the wall clock. */
export const CODEX_ADAPTER: ChatAdapterDefinition = codexAdapterDefinition({
  connect: spawnCodexTransport,
  newId: () => randomUUID(),
  now: () => new Date().toISOString()
})
