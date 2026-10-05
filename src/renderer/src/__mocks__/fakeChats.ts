/**
 * `window.dm.chats` for renderer tests about chats: an in-memory store of chat records that
 * answers list, create, rename and delete the way the main process does (newest first, `not_found`
 * for a chat that is gone), answers `models` per agent kind, and records every call. Opening a chat
 * returns its stored transcript, and so does `read` (the panels' way to follow a chat), recorded as its own
 * call so a test can tell the two apart; sending, stopping and switching the model behave as the main
 * process does (a send stores the message and pushes it with the turn starting, a switch pushes the
 * model change). A test drives the rest through the push channel: `emit` for deltas and `emitItem`
 * for stored items, `finishTurn` for a turn ending. An approval request is pending while no decision
 * with its id is stored: `open` returns those, `list` counts them per chat, and `answerApproval`
 * stores the decision and pushes it (a request that is not pending is `not_found`, as in main).
 * A chat whose record has a `cutShortMessageId` can be retried: `retryTurn` clears it, starts the turn and
 * answers the stored message, and is `not_found` for a chat with nothing cut short, as in main (a test
 * makes it refuse as signed out through `failures`).
 * `threadBindings` answers what a test put in `bindings` for the chat (none by default); `boundThreads` answers what a test
 * put in `bound` for the attempt or run (none by default).
 * Starting an orchestrator needs `orchestration` (how to queue the run and what the epic is called):
 * it then queues the run, stores an orchestrator chat with Allow save off that records the run's id
 * and answers both, as main does, unless `orchestrationProblem` says the chat could not be started.
 * A create, a rename and a delete that succeed push `chats_changed` to every subscriber (the originating
 * window too), as main does, so a second subscriber stands for a second window.
 */
import type { ApprovalRequestItem, ChatItem, ChatRecord, ModelOption } from '../../../shared/agents/chat'
import type {
  AnswerApprovalRequest,
  BoundThread,
  BoundThreadsRequest,
  ChatOpenView,
  ChatPushEvent,
  ChatRequestRef,
  ChatsApi,
  ChatSummary,
  CreateChatRequest,
  SendChatRequest,
  SetChatModelRequest,
  StartOrchestratorRequest,
  StartOrchestratorResult,
  ThreadBinding
} from '../../../shared/agents/chatApi'
import type { AgentKind, CommandResult } from '../../../shared/desktop/api'
import type { DomainErrorShape } from '../../../shared/domain/errors'
import type { RunView } from '../../../shared/domain/views'
import { chatRecord } from './fixtures'
import { deferred } from './deferred'
import type { Deferred } from './deferred'

type Method =
  | 'list'
  | 'create'
  | 'startOrchestrator'
  | 'rename'
  | 'delete'
  | 'models'
  | 'open'
  | 'read'
  | 'send'
  | 'stop'
  | 'retryTurn'
  | 'threadBindings'
  | 'boundThreads'
  | 'setModel'
  | 'answerApproval'

/** What main does around an orchestrator chat that the fake cannot: queue the run, and name the epic. */
interface FakeOrchestration {
  epicTitle: string
  queueRun(folder: string, epicId: string): Promise<RunView>
}

const NOT_FOUND: DomainErrorShape = { code: 'not_found', message: 'Chat not found.' }

export class FakeChats implements ChatsApi {
  /** Every stored chat, across folders. */
  chats: ChatRecord[] = []
  /** The models each agent kind offers; a kind with no entry offers none. */
  modelLists: Partial<Record<AgentKind, ModelOption[]>> = {}
  /** A kind listed here answers `models` with this error. */
  modelFailures: Partial<Record<AgentKind, DomainErrorShape>> = {}
  /** A method listed here answers with this error instead of doing its work. */
  failures: Partial<Record<Method, DomainErrorShape>> = {}
  /** How `startOrchestrator` queues the run; without it the call is refused as unavailable. */
  orchestration: FakeOrchestration | null = null
  /** When set, `startOrchestrator` queues the run but starts no chat and answers with this problem. */
  orchestrationProblem: string | null = null
  /** Each chat's stored transcript, as `open` returns it. */
  transcripts: Record<string, ChatItem[]> = {}
  /** Each chat's thread bindings, as `threadBindings` answers them; a chat with no entry has none. */
  bindings: Record<string, ThreadBinding[]> = {}
  /** The threads bound to each attempt and each run, as `boundThreads` answers them; one with no entry has none. */
  bound: { attempts: Record<string, BoundThread[]>; runs: Record<string, BoundThread[]> } = { attempts: {}, runs: {} }
  /** The chats whose turn is running, as `open` reports it. */
  running = new Set<string>()
  /** Every call with exactly the arguments it was given, oldest first. */
  calls: { method: Method; args: unknown[] }[] = []
  private holds: Partial<Record<Method, Deferred[]>> = {}
  private listeners = new Set<(event: ChatPushEvent) => void>()
  private clock = 0
  private created = 0
  private stored = 0

  /** Makes the next call of `method` wait until the returned deferred is resolved. */
  hold(method: Method): Deferred {
    const hold = deferred()
    this.holds[method] = [...(this.holds[method] ?? []), hold]
    return hold
  }

  /** Pushes an event to every subscriber, as the main process does while a chat runs. */
  emit(event: ChatPushEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  /** How many views follow pushed events right now: a view that closed has unsubscribed. */
  subscribers(): number {
    return this.listeners.size
  }

  callsOf(method: Method): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args)
  }

  list(folder: string): Promise<CommandResult<ChatSummary[]>> {
    return this.call('list', [folder], () => ({ ok: true, data: this.inFolder(folder) }))
  }

  create(request: CreateChatRequest): Promise<CommandResult<ChatRecord>> {
    return this.call('create', [request], () => {
      this.created += 1
      const chat = chatRecord({
        id: `chat_new_${this.created}`,
        folder: request.folder,
        agent: request.agent,
        role: request.role,
        model: request.model ?? null,
        allowSave: request.allowSave ?? true,
        title: request.title ?? 'New chat',
        createdAt: this.tick(),
        updatedAt: this.tick()
      })
      this.chats.push(chat)
      this.changed(chat)
      return { ok: true, data: chat }
    })
  }

  startOrchestrator(request: StartOrchestratorRequest): Promise<CommandResult<StartOrchestratorResult>> {
    return this.call<StartOrchestratorResult>('startOrchestrator', [request], async () => {
      const orchestration = this.orchestration
      if (orchestration === null) {
        return { ok: false, error: { code: 'unsupported_capability', message: 'Orchestrators are not part of this test.' } }
      }
      const run = await orchestration.queueRun(request.folder, request.epicId)
      if (this.orchestrationProblem !== null) {
        return { ok: true, data: { run, chat: null, problem: this.orchestrationProblem } }
      }
      this.created += 1
      const chat = chatRecord({
        id: `chat_new_${this.created}`,
        folder: request.folder,
        agent: request.agent,
        role: 'orchestrator',
        model: request.model ?? null,
        allowSave: false,
        title: `Orchestrator · ${orchestration.epicTitle}`,
        runId: run.id,
        createdAt: this.tick(),
        updatedAt: this.tick()
      })
      this.chats.push(chat)
      this.changed(chat)
      return { ok: true, data: { run, chat, problem: null } }
    })
  }

  rename(request: { folder: string; chatId: string; title: string }): Promise<CommandResult<ChatRecord>> {
    return this.call('rename', [request], () => {
      const chat = this.find(request.chatId)
      if (chat === undefined) {
        return { ok: false, error: NOT_FOUND }
      }
      // A new record, so a chat a test seeded by reference is not changed behind its back.
      const renamed = { ...chat, title: request.title, updatedAt: this.tick() }
      this.chats = this.chats.map((candidate) => (candidate.id === chat.id ? renamed : candidate))
      this.changed(renamed)
      return { ok: true, data: { ...renamed } }
    })
  }

  delete(request: { folder: string; chatId: string }): Promise<CommandResult<null>> {
    return this.call('delete', [request], () => {
      const chat = this.find(request.chatId)
      if (chat === undefined) {
        return { ok: false, error: NOT_FOUND }
      }
      this.chats = this.chats.filter((candidate) => candidate.id !== chat.id)
      this.changed(chat)
      return { ok: true, data: null }
    })
  }

  models(kind: AgentKind): Promise<CommandResult<ModelOption[]>> {
    return this.call('models', [kind], () => {
      const failure = this.modelFailures[kind]
      return failure === undefined ? { ok: true, data: this.modelLists[kind] ?? [] } : { ok: false, error: failure }
    })
  }

  open(request: ChatRequestRef): Promise<CommandResult<ChatOpenView>> {
    return this.call('open', [request], () => this.view(request))
  }

  /** What `open` answers, as a separate call so a test can tell a view that follows a chat from one that opens it. */
  read(request: ChatRequestRef): Promise<CommandResult<ChatOpenView>> {
    return this.call('read', [request], () => this.view(request))
  }

  private view(request: ChatRequestRef): CommandResult<ChatOpenView> {
    const chat = this.find(request.chatId)
    if (chat === undefined) {
      return { ok: false, error: NOT_FOUND }
    }
    const items = [...(this.transcripts[chat.id] ?? [])]
    return { ok: true, data: { chat: { ...chat }, items, pending: this.pendingOf(chat.id), running: this.running.has(chat.id) } }
  }

  send(request: SendChatRequest): Promise<CommandResult<ChatItem>> {
    return this.call('send', [request], () => {
      if (this.find(request.chatId) === undefined) {
        return { ok: false, error: NOT_FOUND }
      }
      if (this.running.has(request.chatId)) {
        return { ok: false, error: { code: 'conflict', message: 'This chat is still answering. Stop it or wait for it to finish.' } }
      }
      const message = this.made(request.chatId, { kind: 'user_message', text: request.text })
      this.running.add(request.chatId)
      this.emitItem(request.chatId, message)
      this.emit({ type: 'turn', chatId: request.chatId, running: true })
      return { ok: true, data: message }
    })
  }

  threadBindings(request: ChatRequestRef): Promise<CommandResult<ThreadBinding[]>> {
    return this.call('threadBindings', [request], () => ({ ok: true, data: [...(this.bindings[request.chatId] ?? [])] }))
  }

  boundThreads(request: BoundThreadsRequest): Promise<CommandResult<BoundThread[]>> {
    return this.call('boundThreads', [request], () => {
      const found = 'attemptId' in request ? this.bound.attempts[request.attemptId] : this.bound.runs[request.runId]
      return { ok: true, data: [...(found ?? [])] }
    })
  }

  /** Records the call and leaves the turn running: the turn ends when a test calls `finishTurn`, as the agent settles it. */
  stop(request: ChatRequestRef): Promise<CommandResult<null>> {
    return this.call('stop', [request], () => ({ ok: true, data: null }))
  }

  /** Sends the cut-short message again: the record forgets it, the turn starts (and is pushed), and the stored message is answered. */
  retryTurn(request: ChatRequestRef): Promise<CommandResult<ChatItem>> {
    return this.call('retryTurn', [request], () => {
      const chat = this.find(request.chatId)
      const message = (this.transcripts[request.chatId] ?? []).find((item) => item.id === chat?.cutShortMessageId)
      if (chat === undefined || message === undefined) {
        return { ok: false, error: { code: 'not_found', message: 'There is no cut-short message to send again in this chat.' } }
      }
      this.chats = this.chats.map((candidate) => (candidate.id === chat.id ? { ...chat, cutShortMessageId: null } : candidate))
      this.running.add(chat.id)
      this.emit({ type: 'turn', chatId: chat.id, running: true })
      return { ok: true, data: message }
    })
  }

  setModel(request: SetChatModelRequest): Promise<CommandResult<ChatRecord>> {
    return this.call('setModel', [request], () => {
      const chat = this.find(request.chatId)
      if (chat === undefined) {
        return { ok: false, error: NOT_FOUND }
      }
      const changed = { ...chat, model: request.model, updatedAt: this.tick() }
      this.chats = this.chats.map((candidate) => (candidate.id === chat.id ? changed : candidate))
      this.emitItem(chat.id, this.made(chat.id, { kind: 'model_change', from: chat.model, to: request.model }))
      return { ok: true, data: { ...changed } }
    })
  }

  answerApproval(request: AnswerApprovalRequest): Promise<CommandResult<null>> {
    return this.call('answerApproval', [request], () => {
      if (!this.pendingOf(request.chatId).some((asked) => asked.requestId === request.requestId)) {
        return { ok: false, error: { code: 'not_found', message: 'That approval request is no longer waiting for an answer.' } }
      }
      this.emitItem(request.chatId, this.made(request.chatId, { kind: 'approval_decision', requestId: request.requestId, decision: request.decision }))
      return { ok: true, data: null }
    })
  }

  /** Stores an item in the chat's transcript and pushes it, as the main process does for each item it stores. */
  emitItem(chatId: string, item: ChatItem): void {
    const items = this.transcripts[chatId] ?? []
    const at = items.findIndex((stored) => stored.id === item.id)
    this.transcripts[chatId] = at === -1 ? [...items, item] : items.map((stored, index) => (index === at ? item : stored))
    this.emit({ type: 'item', chatId, item })
  }

  /** Ends the chat's running turn and says so, as the main process does once the agent has settled. */
  finishTurn(chatId: string): void {
    this.running.delete(chatId)
    this.emit({ type: 'turn', chatId, running: false })
  }

  /** Says the chat list of the chat's folder changed, as main does after a create, rename or delete. */
  private changed(chat: ChatRecord): void {
    this.emit({ type: 'chats_changed', folder: chat.folder, chatId: chat.id })
  }

  private made(chatId: string, item: { kind: ChatItem['kind'] } & Record<string, unknown>): ChatItem {
    this.stored += 1
    return { id: `item_fake_${chatId}_${this.stored}`, at: this.tick(), ...item } as ChatItem
  }

  onEvent(listener: (event: ChatPushEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private find(id: string): ChatRecord | undefined {
    return this.chats.find((chat) => chat.id === id)
  }

  /** The chat's stored approval requests that no stored decision answers. */
  private pendingOf(chatId: string): ApprovalRequestItem[] {
    const items = this.transcripts[chatId] ?? []
    const decided = new Set(items.flatMap((item) => (item.kind === 'approval_decision' ? [item.requestId] : [])))
    return items.flatMap((item) => (item.kind === 'approval_request' && !decided.has(item.requestId) ? [item] : []))
  }

  private inFolder(folder: string): ChatSummary[] {
    return this.chats
      .filter((chat) => chat.folder === folder)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((chat) => ({ ...chat, pending: this.pendingOf(chat.id).length }))
  }

  /** Strictly increasing ISO timestamps, later than anything a test seeds by hand. */
  private tick(): string {
    this.clock += 1
    return new Date(Date.UTC(2030, 0, 1, 0, 0, this.clock)).toISOString()
  }

  private async call<T>(method: Method, args: unknown[], produce: () => CommandResult<T> | Promise<CommandResult<T>>): Promise<CommandResult<T>> {
    this.calls.push({ method, args })
    await this.holds[method]?.shift()?.promise
    const failure = this.failures[method]
    return failure === undefined ? produce() : { ok: false, error: failure }
  }
}
