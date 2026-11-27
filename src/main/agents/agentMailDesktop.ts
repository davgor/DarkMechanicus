/**
 * The person's side of OMP chats' mailboxes, behind the `chatMail:*` channels, and the central metadata monitor that
 * keeps unread and automatic-delivery badges current. A pure factory over injected dependencies (no Electron).
 *
 * **Who and which mailbox.** Every request names a tracked folder and a chat id, never an endpoint id: the folder is
 * resolved to its canonical tracked path (an untracked or swapped folder is refused, `chatFolder`), the chat must be
 * an existing OMP chat with its ordinary mailbox or a trusted world-to-member mailbox route, and that endpoint must belong to this chat on this machine
 * and not be deleted. Everything runs as the person through the folder's held desktop workspace (`mail.manage`,
 * human-only: no grant carries it) and the desktop service functions; never as, or on behalf of, an agent session.
 *
 * **Seen is not acknowledged.** Reading a page neither acknowledges for the agent nor marks it seen. The seen cursor
 * moves forward only, and only up to the highest sequence an inbox page actually served to the window, so a message
 * that arrived after the window rendered stays unseen.
 *
 * **Automatic delivery.** Every eligible tracked folder is monitored without opening Inbox. Exact host-body receipts,
 * not acknowledgment or seen state, determine which messages still need the existing recipient chat resumed. The
 * shared board monitor retains person bodies through unavailable hosts and restart; no replacement chat is created.
 *
 * **Monitor.** `snapshot(folder)` catches up after start or a missed push. Each tracked folder has one poll every
 * 2 s, one sweep in flight, bounded pages read in separate transactions with the event loop free between pages,
 * and a push only for changed metadata. Resuming happens after those transactions finish. A sweep whose folder was
 * stopped or restarted meanwhile discards its result. Pushes never carry bodies; polling never acknowledges or marks seen.
 */
import { z } from 'zod'
import type { ProjectWorkspace } from '../desktop/workspaceClient'
import { DomainError, fail } from '../../core/errors'
import { parseInput } from '../../core/schemas'
import { AGENT_MAIL_LIMITS } from '../../core/services/agentMailStore'
import { chatIdSchema, type ChatRecord } from '../../shared/agents/chat'
import type { ChatMailPage, ChatMailPushEvent, ChatMailSnapshot, ChatMailState } from '../../shared/agents/chatApi'
import type { CommandResult } from '../../shared/desktop/api'
import type { AgentMailMessageView } from '../../shared/domain/agentMail'
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

export interface AgentMailDesktopDeps {
  registry: Pick<FolderRegistry, 'resolve'>
  /** The chat records; read only (listing through it would provision). */
  store: Pick<ChatStore, 'getChat' | 'listChats'>
  /** World-owned chats projected into this member's mailbox, retaining their root folder for wake/resume. */
  routedChats?: (folder: string, background?: boolean) => readonly ChatRecord[] | Promise<readonly ChatRecord[]>
  /** All eligible tracked folders, independent of which inbox the person opened. */
  folders?: () => readonly string[]
  /** The person's context in the folder's held desktop workspace (never a fresh session). */
  workspaceFor: (folder: string, background?: boolean) => ProjectWorkspace
  delivery?: {
    hasMessage(chat: ChatRecord, message: AgentMailMessageView & { project?: string }): boolean
    resume(chat: ChatRecord): Promise<string | null>
  }
  /** The standing cult wake (`src/main/cults/cultWake.ts`): told which undelivered messages each chat holds. */
  cultWake?: { offer(folder: string, recipient: ChatRecord, messages: readonly AgentMailMessageView[]): Promise<void> }
  /** Person-board work shares this unconditional tracked-folder monitor, including non-peer hosts. */
  board?: { poll(folder: string): Promise<void> }
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
  workspace: ProjectWorkspace
}

const NO_MAILBOX = 'This chat has no mailbox.'

/** The folder's ordinary and world-owned mailbox projections, in chat id order. */
function eligible(chats: readonly ChatRecord[]): ChatRecord[] {
  return chats.filter((chat) => !chat.archived && hasMailbox(chat) && chat.endpointId !== undefined).sort((a, b) => (a.id < b.id ? -1 : 1))
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
  private discoveryTimer: NodeJS.Timeout | null = null
  private readonly deliveryProblems = new Map<string, string>()
  private readonly unobservable = new Set<string>()

  private readonly deps: AgentMailDesktopDeps

  constructor(deps: AgentMailDesktopDeps) {
    this.deps = deps
    this.pollMs = deps.pollMs ?? MAIL_POLL_MS
    this.pageSize = deps.pageSize ?? MAIL_PAGE_SIZE
    this.yieldPage = deps.yieldPage ?? (() => new Promise<void>((resolve) => setImmediate(resolve)))
    if (deps.folders !== undefined) {
      this.discoveryTimer = setInterval(() => this.discoverFolders(), this.pollMs)
    }
  }

  private discoverFolders(): void {
    if (this.disposed) return
    for (const folder of this.deps.folders?.() ?? []) {
      if (this.watches.has(folder)) continue
      const watch: FolderWatch = { timer: null, last: new Map() }
      this.watches.set(folder, watch)
      void this.poll(folder, watch)
    }
  }

  private async chatAt(folder: string, id: string, background = false): Promise<ChatRecord | null> {
    return this.deps.store.getChat({ folder, id }) ?? (await this.deps.routedChats?.(folder, background))?.find(chat => chat.id === id) ?? null
  }

  async mailbox(input: { folder: string; chatId: string }): Promise<ChatMailbox> {
    const folder = chatFolder(this.deps, input.folder)
    const chat = await this.chatAt(folder, input.chatId)
    if (chat === null || !hasMailbox(chat) || chat.endpointId === undefined) {
      fail('not_found', NO_MAILBOX, { chatId: input.chatId })
    }
    return { folder, chat, endpointId: chat.endpointId, workspace: this.deps.workspaceFor(folder) }
  }

  async stateOf(box: ChatMailbox): Promise<ChatMailState> {
    const view = await box.workspace.call('mailState', box.chat)
    const delivery = await this.deliveryState(box)
    return {
      folder: box.folder,
      chatId: box.chat.id,
      humanSeenSeq: view.humanSeenSeq,
      unseenCount: view.unseenCount,
      pendingCount: view.pendingCount,
      retainedCount: view.retainedCount,
      retentionDays: view.retentionDays,
      delivery,
      version: ++this.version
    }
  }

  private inspectPage(folder: string, chat: ChatRecord, messages: readonly AgentMailMessageView[], delivery: ChatMailState['delivery']): AgentMailMessageView[] {
    const pending: AgentMailMessageView[] = []
    for (const message of messages) {
      try {
        const scoped = chat.folder === folder ? message : { ...message, project: folder }
        if (delivery.problem !== null || !this.deps.delivery?.hasMessage(chat, scoped)) {
          delivery.pendingCount += 1
          pending.push(message)
        } else delivery.deliveredCount += 1
      } catch (error) {
        delivery.pendingCount += 1
        delivery.problem = error instanceof Error ? error.message : String(error)
      }
    }
    return pending
  }

  private async deliveryState(box: ChatMailbox): Promise<ChatMailState['delivery']> {
    const delivery = { pendingCount: 0, deliveredCount: 0, problem: null as string | null }
    let afterSeq = 0
    let throughSeq: number | undefined
    for (;;) {
      const page = await box.workspace.call('mailRead', box.chat, { afterSeq, throughSeq, limit: AGENT_MAIL_LIMITS.pageSize })
      const pending = this.inspectPage(box.folder, box.chat, page.messages, delivery)
      // Only main's records decide whether a sender may wake this member (`cultWake.ts`); the body is never read there.
      if (pending.length > 0) await this.deps.cultWake?.offer(box.folder, box.chat, pending)
      if (!page.hasMore) break
      afterSeq = page.nextCursor
      throughSeq = page.snapshotHighWater
    }
    const key = `${box.folder}\0${box.chat.id}`
    if (delivery.problem === null) this.unobservable.delete(key)
    else this.unobservable.add(key)
    delivery.problem ??= delivery.pendingCount === 0 ? null : this.deliveryProblems.get(key) ??
      (this.deps.delivery === undefined ? 'The recipient host context transport is unavailable.' : null)
    return delivery
  }

  /** Bounded pages preserve cancellation points and omit mailboxes removed since discovery. */
  private async readPage(folder: string, chats: readonly ChatRecord[], background: boolean): Promise<ChatMailState[]> {
    const workspace = this.deps.workspaceFor(folder, background)
    const states: ChatMailState[] = []
    for (const chat of chats) {
      if (chat.endpointId === undefined) continue
      try { states.push(await this.stateOf({ workspace, folder, chat, endpointId: chat.endpointId })) }
      catch (error) { if (!(error instanceof DomainError && error.code === 'not_found')) throw error }
    }
    return states
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
  private async sweep(folder: string, watch: FolderWatch | undefined, background = false): Promise<ChatMailState[] | null> {
    const chats = eligible([...this.deps.store.listChats(folder), ...(await this.deps.routedChats?.(folder, background) ?? [])])
    const states: ChatMailState[] = []
    for (let start = 0; start < chats.length; start += this.pageSize) {
      const page = await this.readPage(folder, chats.slice(start, start + this.pageSize), background)
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
      await this.deps.board?.poll(folder)
      if (this.watches.get(folder) !== watch) return
      const states = await this.sweep(folder, watch, true)
      if (states === null) return
      for (const state of states) if (!(await this.resumeUndelivered(folder, state, watch))) return
      this.publishSweep(folder, states, watch)
    } catch (error) {
      if (!(error instanceof DomainError)) this.deps.onUnexpectedError?.(error)
    } finally {
      this.schedule(folder, watch)
    }
  }

  private async resumeUndelivered(folder: string, state: ChatMailState, watch: FolderWatch): Promise<boolean> {
    const delivery = this.deps.delivery
    if (state.delivery.pendingCount === 0 || delivery === undefined || this.unobservable.has(`${folder}\0${state.chatId}`)) return true
    const chat = await this.chatAt(folder, state.chatId, true)
    if (chat === null) return true
    if (this.watches.get(folder) !== watch) return false
    const problem = await delivery.resume(chat)
    if (this.watches.get(folder) !== watch) return false
    const key = `${folder}\0${chat.id}`
    if (problem === null) this.deliveryProblems.delete(key)
    else this.deliveryProblems.set(key, problem)
    state.delivery.problem = problem
    return true
  }

  private publishSweep(folder: string, states: ChatMailState[], watch: FolderWatch): void {
    const present = new Set(states.map((state) => state.chatId))
    for (const state of states) this.publish(state)
    for (const chatId of watch.last.keys()) {
      if (present.has(chatId)) continue
      watch.last.delete(chatId)
      this.deps.push?.({ type: 'mail_removed', folder, chatId, version: ++this.version })
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
    if (this.discoveryTimer !== null) clearInterval(this.discoveryTimer)
    this.discoveryTimer = null
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

  async read(input: unknown): Promise<ChatMailPage> {
    const { folder, chatId, ...window } = parseInput(readSchema, input, 'chat mail read')
    const box = await this.mailbox({ folder, chatId })
    const page = await box.workspace.call('mailRead', box.chat, window)
    if (this.deps.registry.resolve(box.folder) !== box.folder || !box.workspace.current) fail('unauthorized', 'This mailbox folder was closed.')
    const highest = page.messages.reduce((max, message) => Math.max(max, message.seq), 0)
    const folderServed = this.served.get(box.folder) ?? new Map<string, number>()
    folderServed.set(box.endpointId, Math.max(folderServed.get(box.endpointId) ?? 0, highest))
    this.served.set(box.folder, folderServed)
    return page
  }

  async markSeen(input: unknown): Promise<ChatMailState> {
    const request = parseInput(seenSchema, input, 'chat mail seen')
    const box = await this.mailbox(request)
    if (request.throughSeq > (this.served.get(box.folder)?.get(box.endpointId) ?? 0)) {
      fail('invalid_input', 'Mark seen only up to a message this window was shown.', { field: 'throughSeq' })
    }
    await box.workspace.call('mailSeen', box.chat, request.throughSeq)
    const state = await this.stateOf(box)
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
        answer(deps, async () => desk.stateOf(await desk.mailbox(parseInput(refSchema, input, 'chat mail request')))),
      read: (input) => answer(deps, () => desk.read(input)),
      markSeen: (input) => answer(deps, () => desk.markSeen(input))
    },
    stopFolder: (folder) => desk.stopFolder(folder),
    dispose: () => desk.dispose()
  }
}
