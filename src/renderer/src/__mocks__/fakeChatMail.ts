/**
 * `window.dm.chats.mail` for renderer tests about Skitarii inboxes: an in-memory store of each chat's mailbox state
 * and messages, keyed by folder and chat, that answers the way main does. Every answer and push carries a new version
 * from one counter; `read` pages by sequence; `markSeen` moves only the person's cursor.
 * Every call is recorded; a method held with `hold` waits until `release`; `failures` answers a method with an error.
 */
import type {
  ChatMailApi,
  ChatMailPage,
  ChatMailPushEvent,
  ChatMailRef,
  ChatMailSnapshot,
  ChatMailState,
  MarkChatMailSeenRequest,
  ReadChatMailRequest
} from '../../../shared/agents/chatApi'
import type { CommandResult } from '../../../shared/desktop/api'
import type { DomainErrorShape } from '../../../shared/domain/errors'
import type { AgentMailMessageView } from '../../../shared/domain/agentMail'
import { deferred, type Deferred } from './deferred'

type Method = 'snapshot' | 'state' | 'read' | 'markSeen'

const keyOf = (folder: string, chatId: string): string => `${folder}\0${chatId}`

/** A chat's mailbox with nothing in it, unless the patch says otherwise. */
export function mailState(patch: Partial<ChatMailState> & ChatMailRef): ChatMailState {
  return {
    humanSeenSeq: 0,
    unseenCount: 0,
    pendingCount: 0,
    retainedCount: 0,
    retentionDays: 7,
    delivery: { pendingCount: patch.pendingCount ?? 0, deliveredCount: 0, problem: null },
    version: 0,
    ...patch
  }
}

/** A received message from a peer, unacknowledged, unless the patch says otherwise. */
export function mailMessage(patch: Partial<AgentMailMessageView> & { seq: number }): AgentMailMessageView {
  return {
    id: `msg_${patch.seq}`,
    from: { endpointId: 'ep_peer', name: 'Peer chat', deleted: false },
    inReplyTo: null,
    bodyBytes: 5,
    acceptedAt: '2026-11-15T10:00:00.000Z',
    acknowledgedAt: null,
    expiresAt: null,
    body: 'hello',
    ...patch
  }
}

export class FakeChatMail implements ChatMailApi {
  readonly calls: { method: Method; args: unknown[] }[] = []
  failures: Partial<Record<Method, DomainErrorShape>> = {}
  private readonly states = new Map<string, ChatMailState>()
  private readonly inboxes = new Map<string, AgentMailMessageView[]>()
  private readonly served = new Map<string, number>()
  private readonly holds: Partial<Record<Method, Deferred[]>> = {}
  private readonly listeners = new Set<(event: ChatMailPushEvent) => void>()
  private version = 0

  /** Stores the chat's state with a new version and returns it; pushes it too when `push` is set. */
  put(patch: Partial<ChatMailState> & ChatMailRef, push = false): ChatMailState {
    const before = this.states.get(keyOf(patch.folder, patch.chatId))
    const state = { ...(before ?? mailState(patch)), ...patch, version: ++this.version }
    this.states.set(keyOf(patch.folder, patch.chatId), state)
    if (push) this.emit({ type: 'mail_state', state })
    return state
  }

  /** The chat's retained messages, ascending, as `read` serves them. */
  setMessages(folder: string, chatId: string, messages: AgentMailMessageView[]): void {
    this.inboxes.set(keyOf(folder, chatId), messages)
  }

  /** Removes the chat's mailbox and pushes `mail_removed`. */
  remove(folder: string, chatId: string): void {
    this.states.delete(keyOf(folder, chatId))
    this.emit({ type: 'mail_removed', folder, chatId, version: ++this.version })
  }

  emit(event: ChatMailPushEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  listenerCount(): number {
    return this.listeners.size
  }

  /** From now on each call of the method waits until a `release` lets it answer. */
  hold(method: Method): void {
    this.holds[method] = this.holds[method] ?? []
  }

  /** Lets the oldest held call of the method answer (all of them with `all`), and stops holding when none are left. */
  release(method: Method, all = false): void {
    const gates = this.holds[method] ?? []
    for (const gate of all ? gates.splice(0) : gates.splice(0, 1)) gate.resolve()
    if (all) delete this.holds[method]
  }

  async snapshot(folder: string): Promise<CommandResult<ChatMailSnapshot>> {
    const failed = await this.enter('snapshot', [folder])
    if (failed) return failed
    return { ok: true, data: { folder, chats: [...this.states.values()].filter((state) => state.folder === folder) } }
  }

  async state(request: ChatMailRef): Promise<CommandResult<ChatMailState>> {
    const failed = await this.enter('state', [request])
    if (failed) return failed
    return this.answer(request)
  }

  async read(request: ReadChatMailRequest): Promise<CommandResult<ChatMailPage>> {
    const failed = await this.enter('read', [request])
    if (failed) return failed
    const all = this.inboxes.get(keyOf(request.folder, request.chatId)) ?? []
    const horizon = request.throughSeq ?? all.reduce((highest, message) => Math.max(highest, message.seq), 0)
    const window = all.filter((message) => message.seq > (request.afterSeq ?? 0) && message.seq <= horizon)
    const messages = window.slice(0, request.limit ?? 50)
    const last = messages.at(-1)?.seq ?? request.afterSeq ?? 0
    const key = keyOf(request.folder, request.chatId)
    this.served.set(key, Math.max(this.served.get(key) ?? 0, last))
    return { ok: true, data: { messages, snapshotHighWater: horizon, nextCursor: last, hasMore: window.length > messages.length } }
  }

  async markSeen(request: MarkChatMailSeenRequest): Promise<CommandResult<ChatMailState>> {
    const failed = await this.enter('markSeen', [request])
    if (failed) return failed
    const key = keyOf(request.folder, request.chatId)
    if (request.throughSeq > (this.served.get(key) ?? 0)) return { ok: false, error: { code: 'invalid_input', message: 'Not shown.' } }
    const known = this.states.get(key)
    if (known === undefined) return { ok: false, error: { code: 'not_found', message: 'No mailbox.' } }
    const humanSeenSeq = Math.max(known.humanSeenSeq, request.throughSeq)
    const unseenCount = (this.inboxes.get(key) ?? []).filter((message) => message.seq > humanSeenSeq).length
    return { ok: true, data: this.put({ folder: request.folder, chatId: request.chatId, humanSeenSeq, unseenCount }) }
  }


  onEvent(listener: (event: ChatMailPushEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private answer(request: ChatMailRef): CommandResult<ChatMailState> {
    const known = this.states.get(keyOf(request.folder, request.chatId))
    return known === undefined ? { ok: false, error: { code: 'not_found', message: 'No mailbox.' } } : { ok: true, data: known }
  }

  private async enter(method: Method, args: unknown[]): Promise<CommandResult<never> | null> {
    this.calls.push({ method, args })
    const gates = this.holds[method]
    if (gates !== undefined) {
      const gate = deferred()
      gates.push(gate)
      await gate.promise
    }
    const failure = this.failures[method]
    return failure === undefined ? null : { ok: false, error: failure }
  }
}
