/**
 * The person's side of OMP chats' mailboxes, behind the `chatMail:*` channels, and the central metadata monitor that
 * keeps the app window's unread and wake badges current. A pure factory over injected dependencies (no Electron).
 *
 * **Who and which mailbox.** Every request names a tracked folder and a chat id, never an endpoint id: the folder is
 * resolved to its canonical tracked path (an untracked or swapped folder is refused, `chatFolder`), the chat must be
 * an existing OMP chat with a mailbox stored on its record, and that endpoint must belong to this chat on this machine
 * and not be deleted. Everything runs as the person through the folder's held desktop workspace (`mail.manage`,
 * human-only: no grant carries it) and the desktop service functions; never as, or on behalf of, an agent session.
 *
 * **Seen is not acknowledged.** Reading a page neither acknowledges for the agent nor marks it seen. The seen cursor
 * moves forward only, and only up to the highest sequence an inbox page actually served to the window, so a message
 * that arrived after the window rendered stays unseen.
 *
 * **Wake.** Allow one inbox wake arms at most one credit per mailbox, revisioned and nonce-checked by the service; a
 * repeated Allow while armed returns the armed state. Nothing here starts, resumes or pastes into a chat terminal: a
 * stopped chat stays stopped whatever mail or credits it has, and a consumed or lost wake needs a new Allow.
 *
 * **Monitor.** `snapshot(folder)` answers every mailbox of the folder (the catch-up after start or a missed push) and
 * keeps one poll per folder going: every 2 s, one sweep in flight, bounded pages read in one transaction each with the
 * event loop free between pages, a push only for a chat whose metadata changed. A sweep or snapshot whose folder was
 * stopped (untrack) or restarted meanwhile discards what it read. Pushes carry counts and wake state, never a body.
 * The monitor only reads human state: it never acknowledges, takes a wake credit or touches an agent's inbox.
 */
import { z } from 'zod'
import type { Ctx } from '../../core/context'
import { DomainError, fail } from '../../core/errors'
import { parseInput } from '../../core/schemas'
import { armAgentMailWake, getHumanAgentMailState, markHumanAgentMailSeen, readHumanAgentInbox } from '../../core/services/agentMail'
import { AGENT_MAIL_LIMITS, getEndpoint } from '../../core/services/agentMailStore'
import { chatIdSchema, type ChatRecord } from '../../shared/agents/chat'
import type { ChatMailPage, ChatMailPushEvent, ChatMailSnapshot, ChatMailState } from '../../shared/agents/chatApi'
import type { CommandResult } from '../../shared/desktop/api'
import type { FolderRegistry } from '../desktop/folderRegistry'
import { answer, chatFolder, folderSchema } from './chatHandlers'
import { hasMailbox } from './chatMailboxes'
import type { ChatStore } from './chatStore'

/** How often a monitored folder is swept. */
const MAIL_POLL_MS = 2_000
/** Mailboxes read per page (one transaction) of a sweep or snapshot. */
const MAIL_PAGE_SIZE = 25

const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const refShape = { folder: folderSchema, chatId: chatIdSchema }
const refSchema = z.strictObject(refShape)
const readSchema = z.strictObject({
  ...refShape,
  afterSeq: seq.optional(),
  throughSeq: seq.optional(),
  limit: z.number().int().min(1).max(AGENT_MAIL_LIMITS.pageSize).optional(),
  unacknowledgedOnly: z.boolean().optional()
})
const seenSchema = z.strictObject({ ...refShape, throughSeq: seq.min(1) })
const wakeSchema = z.strictObject({ ...refShape, expectedRevision: seq, requestNonce: z.string().min(1).max(128) })

export interface AgentMailDesktopDeps {
  registry: Pick<FolderRegistry, 'resolve'>
  /** The chat records; read only (listing through it would provision). */
  store: Pick<ChatStore, 'getChat' | 'listChats'>
  /** The person's context in the folder's held desktop workspace (never a fresh session). */
  contextFor: (folder: string) => Ctx
  /** Delivers metadata to the app window; without it nothing is pushed. */
  push?: (event: ChatMailPushEvent) => void
  /** Told about failures that are not DomainErrors (bugs, I/O), so main can log the stack. */
  onUnexpectedError?: (error: unknown) => void
  pollMs?: number
  pageSize?: number
  /** Lets the event loop run between pages (tests can hold a page's results back); defaults to `setImmediate`. */
  yieldPage?: () => Promise<void>
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface ChatMailHandlers {
  snapshot(folder: unknown): Promise<CommandResult<ChatMailSnapshot>>
  state(request: unknown): Promise<CommandResult<ChatMailState>>
  read(request: unknown): Promise<CommandResult<ChatMailPage>>
  markSeen(request: unknown): Promise<CommandResult<ChatMailState>>
  allowWake(request: unknown): Promise<CommandResult<ChatMailState>>
}

export interface AgentMailDesktop {
  handlers: ChatMailHandlers
  /** Stops the folder's monitor and forgets what it served; call before the folder is untracked or its workspace closes. */
  stopFolder(folder: string): void
  /** Stops every monitor for good (quit); later snapshots start none. */
  dispose(): void
}

/** One folder's poll: its pending timer and the metadata last published per chat. Replaced, never reused, after a stop. */
interface FolderWatch {
  timer: NodeJS.Timeout | null
  last: Map<string, string>
}

/** A chat's mailbox, resolved and checked in its folder's desktop context. */
interface ChatMailbox {
  folder: string
  chat: ChatRecord
  endpointId: string
  ctx: Ctx
}

const NO_MAILBOX = 'This chat has no mailbox.'

/** The folder's mailbox chats in id order; ids are unique within a folder (the store keys its index by id). */
function eligible(chats: readonly ChatRecord[]): ChatRecord[] {
  return chats.filter((chat) => hasMailbox(chat) && chat.endpointId !== undefined).sort((a, b) => (a.id < b.id ? -1 : 1))
}

/** The chat's own endpoint, open or suspended, on this machine; anything else is `not_found`. */
function checkedEndpoint(ctx: Ctx, chat: ChatRecord): string {
  const endpoint = chat.endpointId === undefined || !hasMailbox(chat) ? null : getEndpoint(ctx, chat.endpointId)
  if (endpoint === null || endpoint.chatId !== chat.id || endpoint.machineId !== ctx.machineId || endpoint.state === 'deleting' || endpoint.state === 'deleted') {
    fail('not_found', NO_MAILBOX, { chatId: chat.id })
  }
  return endpoint.id
}

/** Strips the version so two reads of the same metadata compare equal. */
function fingerprint(state: ChatMailState): string {
  const { version: _version, ...rest } = state
  return JSON.stringify(rest)
}

/** The service and its monitors: one watch per monitored folder, and per folder what inbox pages served. */
class ChatMailDesk {
  private readonly pollMs: number
  private readonly pageSize: number
  private readonly yieldPage: () => Promise<void>
  private readonly watches = new Map<string, FolderWatch>()
  /** Per folder and endpoint, the highest sequence an inbox page served to the window. */
  private readonly served = new Map<string, Map<string, number>>()
  private version = 0
  private disposed = false

  private readonly deps: AgentMailDesktopDeps

  constructor(deps: AgentMailDesktopDeps) {
    this.deps = deps
    this.pollMs = deps.pollMs ?? MAIL_POLL_MS
    this.pageSize = deps.pageSize ?? MAIL_PAGE_SIZE
    this.yieldPage = deps.yieldPage ?? (() => new Promise<void>((resolve) => setImmediate(resolve)))
  }

  mailbox(input: { folder: string; chatId: string }): ChatMailbox {
    const folder = chatFolder(this.deps, input.folder)
    const chat = this.deps.store.getChat({ folder, id: input.chatId })
    if (chat === null) {
      fail('not_found', NO_MAILBOX, { chatId: input.chatId })
    }
    const ctx = this.deps.contextFor(folder)
    return { folder, chat, endpointId: checkedEndpoint(ctx, chat), ctx }
  }

  stateOf(box: Pick<ChatMailbox, 'ctx' | 'folder' | 'endpointId'> & { chatId: string }): ChatMailState {
    const view = getHumanAgentMailState(box.ctx, { endpointId: box.endpointId })
    const { revision, armed, armedAt, lastAttempt } = view.wake
    return {
      folder: box.folder,
      chatId: box.chatId,
      humanSeenSeq: view.humanSeenSeq,
      unseenCount: view.unseenCount,
      pendingCount: view.pendingCount,
      retainedCount: view.retainedCount,
      retentionDays: view.retentionDays,
      wake: { revision, armed, armedAt, lastAttempt },
      version: ++this.version
    }
  }

  /** One page of states in one transaction; a chat whose mailbox is gone (deleted meanwhile) is left out. */
  private readPage(folder: string, chats: readonly ChatRecord[]): ChatMailState[] {
    const ctx = this.deps.contextFor(folder)
    return ctx.db.tx(() =>
      chats.flatMap((chat) => {
        try {
          return [this.stateOf({ ctx, folder, chatId: chat.id, endpointId: checkedEndpoint(ctx, chat) })]
        } catch (error) {
          if (error instanceof DomainError && error.code === 'not_found') return []
          throw error
        }
      })
    )
  }

  /** Pushes the state when its metadata differs from what the folder's watch last published. */
  publish(state: ChatMailState): void {
    const watch = this.watches.get(state.folder)
    if (watch === undefined) return
    const print = fingerprint(state)
    if (watch.last.get(state.chatId) === print) return
    watch.last.set(state.chatId, print)
    this.deps.push?.({ type: 'mail_state', state })
  }

  /**
   * Reads every mailbox of the folder in bounded pages, yielding between pages. Returns null when the folder's watch
   * was stopped or replaced meanwhile: what was read belongs to a folder generation that no longer exists.
   */
  private async sweep(folder: string, watch: FolderWatch | undefined): Promise<ChatMailState[] | null> {
    const chats = eligible(this.deps.store.listChats(folder))
    const states: ChatMailState[] = []
    for (let start = 0; start < chats.length; start += this.pageSize) {
      const page = this.readPage(folder, chats.slice(start, start + this.pageSize))
      await this.yieldPage()
      if (this.watches.get(folder) !== watch) return null
      states.push(...page)
    }
    return states
  }

  /** The next sweep, 2 s after the last one finished: never two in flight. */
  private schedule(folder: string, watch: FolderWatch): void {
    if (this.watches.get(folder) !== watch) return
    watch.timer = setTimeout(() => {
      watch.timer = null
      void this.poll(folder, watch)
    }, this.pollMs)
  }

  private async poll(folder: string, watch: FolderWatch): Promise<void> {
    try {
      if (this.deps.registry.resolve(folder) !== folder) {
        this.stopFolder(folder)
        return
      }
      const states = await this.sweep(folder, watch)
      if (states === null) return
      const present = new Set(states.map((state) => state.chatId))
      for (const state of states) this.publish(state)
      for (const chatId of watch.last.keys()) {
        if (!present.has(chatId)) {
          watch.last.delete(chatId)
          this.deps.push?.({ type: 'mail_removed', folder, chatId, version: ++this.version })
        }
      }
    } catch (error) {
      if (!(error instanceof DomainError)) this.deps.onUnexpectedError?.(error)
    } finally {
      this.schedule(folder, watch)
    }
  }

  stopFolder(folder: string): void {
    const watch = this.watches.get(folder)
    if (watch?.timer != null) clearTimeout(watch.timer)
    this.watches.delete(folder)
    this.served.delete(folder)
  }

  dispose(): void {
    this.disposed = true
    for (const folder of this.watches.keys()) this.stopFolder(folder)
  }

  async snapshot(input: unknown): Promise<ChatMailSnapshot> {
    const folder = chatFolder(this.deps, parseInput(folderSchema, input, 'folder'))
    let watch = this.watches.get(folder)
    if (watch === undefined && !this.disposed) {
      watch = { timer: null, last: new Map() }
      this.watches.set(folder, watch)
      this.schedule(folder, watch)
    }
    const chats = await this.sweep(folder, watch)
    if (chats === null) {
      fail('unauthorized', `The folder ${folder} is no longer tracked by Dark Mechanicus.`)
    }
    if (watch !== undefined) {
      watch.last = new Map(chats.map((state) => [state.chatId, fingerprint(state)]))
    }
    return { folder, chats }
  }

  read(input: unknown): ChatMailPage {
    const { folder, chatId, ...window } = parseInput(readSchema, input, 'chat mail read')
    const box = this.mailbox({ folder, chatId })
    const page = readHumanAgentInbox(box.ctx, { endpointId: box.endpointId, ...window })
    const highest = page.messages.reduce((max, message) => Math.max(max, message.seq), 0)
    const folderServed = this.served.get(box.folder) ?? new Map<string, number>()
    folderServed.set(box.endpointId, Math.max(folderServed.get(box.endpointId) ?? 0, highest))
    this.served.set(box.folder, folderServed)
    return page
  }

  markSeen(input: unknown): ChatMailState {
    const request = parseInput(seenSchema, input, 'chat mail seen')
    const box = this.mailbox(request)
    if (request.throughSeq > (this.served.get(box.folder)?.get(box.endpointId) ?? 0)) {
      fail('invalid_input', 'Mark seen only up to a message this window was shown.', { field: 'throughSeq' })
    }
    markHumanAgentMailSeen(box.ctx, { endpointId: box.endpointId, throughSeq: request.throughSeq })
    const state = this.stateOf({ ...box, chatId: box.chat.id })
    this.publish(state)
    return state
  }

  allowWake(input: unknown): ChatMailState {
    const request = parseInput(wakeSchema, input, 'chat mail wake')
    const box = this.mailbox(request)
    armAgentMailWake(box.ctx, { endpointId: box.endpointId, expectedRevision: request.expectedRevision, requestNonce: request.requestNonce })
    const state = this.stateOf({ ...box, chatId: box.chat.id })
    this.publish(state)
    return state
  }
}

export function createAgentMailDesktop(deps: AgentMailDesktopDeps): AgentMailDesktop {
  const desk = new ChatMailDesk(deps)
  return {
    handlers: {
      snapshot: (input) => answer(deps, () => desk.snapshot(input)),
      state: (input) =>
        answer(deps, () => {
          const box = desk.mailbox(parseInput(refSchema, input, 'chat mail request'))
          return desk.stateOf({ ...box, chatId: box.chat.id })
        }),
      read: (input) => answer(deps, () => desk.read(input)),
      markSeen: (input) => answer(deps, () => desk.markSeen(input)),
      allowWake: (input) => answer(deps, () => desk.allowWake(input))
    },
    stopFolder: (folder) => desk.stopFolder(folder),
    dispose: () => desk.dispose()
  }
}
