/**
 * `window.dm.chats` for renderer tests about chats: an in-memory store of chat records that
 * answers list, create, rename and delete the way the main process does (newest first, `not_found`
 * for a chat that is gone), and records every call. `read` returns the chat with the transcript it stored
 * before chats became terminals (`transcripts`; none by default), and nothing pushes items any more.
 * `boundThreads` answers what a test put in `bound` for the attempt or run (none by default), and
 * `boundTerminal` the chat a test put in `terminals` (none by default).
 * Play and Kick back need `kanban` (how the card moves): Play then stores a card chat and answers it, as main does,
 * unless `kanbanProblem` says the chat could not be started; Kick back answers the card's chat.
 * Starting an orchestrator needs `orchestration` (how to queue the run and what the epic is called):
 * it then queues the run, stores an orchestrator chat with Allow save off that records the run's id
 * and answers both, as main does, unless `orchestrationProblem` says the chat could not be started.
 * Starting a transfer chat needs `transfer` (the epic's title, where its transfer stands and its prompt): it
 * is refused unless the transfer is queued or in progress, as in main, and otherwise stores an orchestrator
 * chat with Allow save off that records the epic's id, unless `transferProblem` says it could not be started.
 * `findTransferChat` answers the newest such chat of the folder, `transferPrompt` the transfer's prompt.
 * Starting a Kanban card needs `kanban` (how Play and a kick-back move the card): it then marks the play, stores
 * an orchestrator chat with Allow save off that records the card's id and answers both, as main does, unless
 * `kanbanProblem` says the chat could not be started. A kick-back moves the card back, stores the comment as a
 * message of the card's newest chat and answers that chat's id (null when the card has none).
 * A create, a rename and a delete that succeed push `chats_changed` to every subscriber (the originating
 * window too), as main does, so a second subscriber stands for a second window.
 */
import type { ChatItem, ChatRecord } from '../../../shared/agents/chat'
import type {
  BoundThread,
  BoundThreadsRequest,
  ChatPushEvent,
  ChatReadView,
  ChatRequestRef,
  ChatsApi,
  CreateChatRequest,
  KickBackKanbanCardRequest,
  KickBackKanbanCardResult,
  StartKanbanCardRequest,
  StartKanbanCardResult,
  StartOrchestratorRequest,
  StartOrchestratorResult,
  StartTransferChatRequest,
  StartTransferChatResult,
  TransferChatRequest
} from '../../../shared/agents/chatApi'
import type { CommandResult } from '../../../shared/desktop/api'
import type { DomainErrorShape } from '../../../shared/domain/errors'
import type { KanbanCardView } from '../../../shared/domain/kanban'
import type { TransferStatus } from '../../../shared/domain/transfer'
import type { RunView } from '../../../shared/domain/views'
import { chatRecord } from './fixtures'
import { deferred } from './deferred'
import type { Deferred } from './deferred'

type Method =
  | 'list'
  | 'create'
  | 'startOrchestrator'
  | 'startTransferChat'
  | 'startKanbanCard'
  | 'kickBackKanbanCard'
  | 'findTransferChat'
  | 'transferPrompt'
  | 'rename'
  | 'delete'
  | 'read'
  | 'boundThreads'
  | 'boundTerminal'

/** What main does around an orchestrator chat that the fake cannot: queue the run, and name the epic. */
interface FakeOrchestration {
  epicTitle: string
  queueRun(folder: string, epicId: string): Promise<RunView>
}

/** What main reads for a transfer chat that the fake cannot: the epic's title, its transfer's status and the kickoff. */
interface FakeTransfer {
  epicTitle: string
  status: TransferStatus
  /** What `transferPrompt` answers. */
  prompt: string
}

/** What main does around a Kanban card that the fake cannot: record Play and the kick-back on the card. */
interface FakeKanban {
  play(folder: string, cardId: string): Promise<KanbanCardView>
  kickBack(folder: string, cardId: string, comment: string): Promise<KanbanCardView>
}

const NOT_FOUND: DomainErrorShape = { code: 'not_found', message: 'Chat not found.' }

export class FakeChats implements ChatsApi {
  /** Every stored chat, across folders. */
  chats: ChatRecord[] = []
  /** A method listed here answers with this error instead of doing its work. */
  failures: Partial<Record<Method, DomainErrorShape>> = {}
  /** How `startOrchestrator` queues the run; without it the call is refused as unavailable. */
  orchestration: FakeOrchestration | null = null
  /** When set, `startOrchestrator` queues the run but starts no chat and answers with this problem. */
  orchestrationProblem: string | null = null
  /** What `startTransferChat` and `transferPrompt` read of the epic's transfer; without it both are refused as unavailable. */
  transfer: FakeTransfer | null = null
  /** When set, `startTransferChat` starts no chat and answers with this problem. */
  transferProblem: string | null = null
  /** How `startKanbanCard` and `kickBackKanbanCard` move the card; without it both are refused as unavailable. */
  kanban: FakeKanban | null = null
  /** When set, `startKanbanCard` marks the play but starts no chat and answers with this problem. */
  kanbanProblem: string | null = null
  /** Each chat's stored transcript, as `read` returns it. */
  transcripts: Record<string, ChatItem[]> = {}
  /** The threads bound to each attempt and each run, as `boundThreads` answers them; one with no entry has none. */
  bound: { attempts: Record<string, BoundThread[]>; runs: Record<string, BoundThread[]> } = { attempts: {}, runs: {} }
  /** The chat each attempt and each run is bound to by grant, as `boundTerminal` answers it; one with no entry has none. */
  terminals: { attempts: Record<string, string>; runs: Record<string, string> } = { attempts: {}, runs: {} }
  /** Every call with exactly the arguments it was given, oldest first. */
  calls: { method: Method; args: unknown[] }[] = []
  private holds: Partial<Record<Method, Deferred[]>> = {}
  private listeners = new Set<(event: ChatPushEvent) => void>()
  private clock = 0
  private created = 0

  /** Makes the next call of `method` wait until the returned deferred is resolved. */
  hold(method: Method): Deferred {
    const hold = deferred()
    this.holds[method] = [...(this.holds[method] ?? []), hold]
    return hold
  }

  /** Pushes an event to every subscriber, as the main process does when a folder's chats change. */
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

  list(folder: string): Promise<CommandResult<ChatRecord[]>> {
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

  startTransferChat(request: StartTransferChatRequest): Promise<CommandResult<StartTransferChatResult>> {
    return this.call<StartTransferChatResult>('startTransferChat', [request], () => {
      const transfer = this.transfer
      if (transfer === null) {
        return { ok: false, error: { code: 'unsupported_capability', message: 'Transfers are not part of this test.' } }
      }
      if (transfer.status !== 'queued' && transfer.status !== 'in_progress') {
        return { ok: false, error: { code: 'unmet_prerequisite', message: 'The transfer is not authorized. Press Transfer to Linear before starting a transfer chat.' } }
      }
      if (this.transferProblem !== null) {
        return { ok: true, data: { chat: null, problem: this.transferProblem } }
      }
      this.created += 1
      const chat = chatRecord({
        id: `chat_new_${this.created}`,
        folder: request.folder,
        agent: request.agent,
        role: 'orchestrator',
        model: request.model ?? null,
        allowSave: false,
        title: `Linear transfer · ${transfer.epicTitle}`,
        transferEpicId: request.epicId,
        createdAt: this.tick(),
        updatedAt: this.tick()
      })
      this.chats.push(chat)
      this.changed(chat)
      return { ok: true, data: { chat, problem: null } }
    })
  }

  startKanbanCard(request: StartKanbanCardRequest): Promise<CommandResult<StartKanbanCardResult>> {
    return this.call<StartKanbanCardResult>('startKanbanCard', [request], async () => {
      const kanban = this.kanban
      if (kanban === null) {
        return { ok: false, error: { code: 'unsupported_capability', message: 'Kanban is not part of this test.' } }
      }
      const card = await kanban.play(request.folder, request.cardId)
      if (this.kanbanProblem !== null) {
        return { ok: true, data: { card, chat: null, problem: this.kanbanProblem } }
      }
      this.created += 1
      const chat = chatRecord({
        id: `chat_new_${this.created}`,
        folder: request.folder,
        agent: request.agent,
        role: 'orchestrator',
        model: request.model ?? null,
        allowSave: false,
        title: `Kanban · ${card.key} ${card.title}`,
        cardId: card.id,
        createdAt: this.tick(),
        updatedAt: this.tick()
      })
      this.chats.push(chat)
      this.changed(chat)
      return { ok: true, data: { card, chat, problem: null } }
    })
  }

  kickBackKanbanCard(request: KickBackKanbanCardRequest): Promise<CommandResult<KickBackKanbanCardResult>> {
    return this.call<KickBackKanbanCardResult>('kickBackKanbanCard', [request], async () => {
      const kanban = this.kanban
      if (kanban === null) {
        return { ok: false, error: { code: 'unsupported_capability', message: 'Kanban is not part of this test.' } }
      }
      const card = await kanban.kickBack(request.folder, request.cardId, request.comment)
      const chat = this.inFolder(request.folder).find((item) => item.cardId === request.cardId) ?? null
      return { ok: true, data: { card, chatId: chat?.id ?? null, problem: null } }
    })
  }

  findTransferChat(request: TransferChatRequest): Promise<CommandResult<ChatRecord | null>> {
    return this.call('findTransferChat', [request], () => ({
      ok: true,
      data: this.inFolder(request.folder).find((chat) => chat.transferEpicId === request.epicId) ?? null
    }))
  }

  transferPrompt(request: TransferChatRequest): Promise<CommandResult<string>> {
    return this.call('transferPrompt', [request], () =>
      this.transfer === null ? { ok: false, error: { code: 'unsupported_capability', message: 'Transfers are not part of this test.' } } : { ok: true, data: this.transfer.prompt }
    )
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

  read(request: ChatRequestRef): Promise<CommandResult<ChatReadView>> {
    return this.call('read', [request], () => {
      const chat = this.find(request.chatId)
      if (chat === undefined) {
        return { ok: false, error: NOT_FOUND }
      }
      return { ok: true, data: { chat: { ...chat }, items: [...(this.transcripts[chat.id] ?? [])] } }
    })
  }

  boundThreads(request: BoundThreadsRequest): Promise<CommandResult<BoundThread[]>> {
    return this.call('boundThreads', [request], () => {
      const found = 'attemptId' in request ? this.bound.attempts[request.attemptId] : this.bound.runs[request.runId]
      return { ok: true, data: [...(found ?? [])] }
    })
  }

  boundTerminal(request: BoundThreadsRequest): Promise<CommandResult<string | null>> {
    return this.call('boundTerminal', [request], () => {
      const found = 'attemptId' in request ? this.terminals.attempts[request.attemptId] : this.terminals.runs[request.runId]
      return { ok: true, data: found ?? null }
    })
  }

  /** Says the chat list of the chat's folder changed, as main does after a create, rename or delete. */
  private changed(chat: ChatRecord): void {
    this.emit({ type: 'chats_changed', folder: chat.folder, chatId: chat.id })
  }

  onEvent(listener: (event: ChatPushEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private find(id: string): ChatRecord | undefined {
    return this.chats.find((chat) => chat.id === id)
  }

  private inFolder(folder: string): ChatRecord[] {
    return this.chats
      .filter((chat) => chat.folder === folder)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((chat) => ({ ...chat }))
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
