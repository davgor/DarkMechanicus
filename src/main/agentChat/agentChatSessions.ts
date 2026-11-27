import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { DomainError } from '../../core/errors'
import { inspectImageBytes } from '../../core/attachments/intake'
import { GUI_PROTOCOL_KINDS, type AgentChatAnswer, type AgentChatEvent, type AgentChatSnapshot, type AttentionItem, type PendingPrompt } from '../../shared/agents/agentChat'
import { callsignSchema, nextServitorOrdinal, resolveCallsign, rootCallsignOf, servitorOrdinals, type Callsign } from '../../shared/agents/callsign'
import type { ApprovalRequestItem, ChatImageRef, ChatItem, ChatRecord, DarkMechanicusCli } from '../../shared/agents/chat'
import type { AgentId, AgentView } from '../../shared/desktop/api'
import { SIGNED_OUT_PAUSE_REASON } from '../../shared/domain/status'
import type { ActivityBinding, ActivityBindings } from '../agents/activityBindings'
import { reachTargets, type ReachTarget } from '../agents/chatReach'
import { mailboxChat } from '../agents/chatMailboxOperations'
import type { ChatRef, ChatStore } from '../agents/chatStore'
import { resolveLaunchFolder } from '../agents/launchFolder'
import { ensureScratchFolder } from '../agents/scratchFolder'
import { claudeSessionExists } from '../terminals/claudeSession'
import { writeClaudeSettings } from '../terminals/claudeSettingsFile'
import { ompSessionId, writeOmpFiles } from '../terminals/ompSession'
import { writeTerminalFiles, type TerminalFiles } from '../terminals/terminalFiles'
import type { TerminalSessionsDeps } from '../terminals/terminalSessions'
import { agentChatLaunch, type AgentChatLaunchSpec } from './agentChatLaunch'
import { startAgentProcess, type AgentProcess, type AgentProcessExit } from './agentProcess'
import { claudeInitLines, claudeInputClipped, createClaudeProtocolState, encodeClaudeCommand, translateClaudeLine, type ClaudeProtocolState } from './claudeProtocol'
import { createOmpState, encodeOmpCommand, initLines, translateOmpLine, type OmpEvent, type OmpState } from './ompProtocol'
import { PendingPrompts, type ArbitrationGate, type AttentionEvent } from './pendingPrompts'
import { maskAgentChatSecretsDeep as mask } from './secretMask'
import type { CommandResultEvent, ThreadClaimEvent } from './translatorEvents'
import type { ChatImages, ChatImagesRef } from './chatImages'
import type { ToolResultBlob, TurnImage } from './toolResultImages'

export interface AgentChatSessionsDeps extends Pick<TerminalSessionsDeps,
  'agentFor' | 'folders' | 'checkAuth' | 'cliFor' | 'runs' | 'issueChatCli' | 'issueReachCli' |
  'reachFolders' | 'revokeChatGrant' | 'renewChatGrant' | 'keepAwake' | 'userData' |
  'ompExtension' | 'platform' | 'env' | 'newSessionId' | 'bindChatGrant' | 'onChatChanged'> {
  store: Pick<ChatStore, 'getChat' | 'updateChat' | 'appendItems' | 'readTranscript'>
  terminalLive(ref: ChatRef): boolean
  /** The live terminal owner's generation; null when no PTY runs. */
  terminalOwner(ref: ChatRef): string | null
  /** Stops only that owner generation and waits for process close, tree cleanup and grant revocation. */
  stopTerminal(ref: ChatRef, generation: string): Promise<void>
  push(event: AgentChatEvent): void
  timers?: { repeat(callback: () => void, ms: number): () => void }
  now?: () => string
  startProcess?: typeof startAgentProcess
  /**
   * The Magos arbiter gate (`createPromptArbitration`) for each newly exposed prompt; omitted, the person decides every
   * prompt. `inputClipped`: the translator cut the prompt's tool input for display, so it shows less than the CLI runs.
   */
  arbitrate?: (input: { ref: ChatRef; chat: ChatRecord; agent: AgentView; prompt: PendingPrompt; inputClipped: boolean }) => ArbitrationGate
  /** Verified worker attempts of a chat's threads, kept next to the chats; never a claim token. */
  bindings: Pick<ActivityBindings, 'bind' | 'threadsOf'>
  /**
   * A read-only check of a claim token (`<attemptId>.<secret>`) in the folder's project: the attempt and run it is the
   * live, latest claim of, or null. Omitted, nothing binds. The token is never stored, logged or pushed.
   */
  verifyAttemptClaim?: (folder: string, token: string) => Promise<{ attemptId: string; runId: string; ticketId: string } | null>
  /** The ticket key of a bound attempt; omitted or failing, the thread keeps its unverified label key. */
  ticketKeyOfAttempt?: (folder: string, attemptId: string) => Promise<string | null>
  /**
   * A run's Magos chat (`role` orchestrator with a `runId`) busy with no stdout line and no prompt pending for
   * `STALL_NOTIFY_MS`: told once per silent span, with no chat content. Omitted, nothing is told.
   */
  onAttention?(event: Extract<AttentionEvent, { kind: 'run_stalled' }>): void
  /** The chats' images (`chatImages`): images the person staged, read back by id for a turn, and tool-result images kept. */
  chatImages: Pick<ChatImages, 'put' | 'putToolImage' | 'read'>
}

type ConfirmTerminalStop = (chat: ChatRecord) => Promise<boolean>
/** What `start` answers: the chat's snapshot, or that its terminal owns it. */
export type StartResult = AgentChatSnapshot | { code: 'busy_elsewhere' }
export interface AgentChatSessions {
  start(ref: ChatRef, options?: { firstMessage?: string }): Promise<StartResult>
  /**
   * A user turn, with the ids of images staged for this chat (`stageImage`). An id this chat does not hold refuses
   * `invalid_input` before anything is written or stored; the turn's item names the images, never their bytes.
   */
  send(ref: ChatRef, input: { text: string; imageIds?: readonly string[] }): Promise<void>
  /** Keeps an image the person staged for the chat (PNG or JPEG); an unknown chat is `not_found`. */
  stageImage(ref: ChatRef, bytes: Uint8Array): Promise<ChatImageRef>
  interrupt(ref: ChatRef): Promise<void>
  answer(ref: ChatRef, input: AgentChatAnswer): Promise<void>
  snapshot(ref: ChatRef): AgentChatSnapshot
  /** Every queued prompt of the folder's live GUI chats (null: project-less chats), head first per chat; never tool input. */
  attention(folder: string | null): AttentionItem[]
  /**
   * A live terminal switches to the GUI only after `confirmTerminalStop` (Main-only, per call) resolves true for the
   * same owner generation; omitted, it refuses `busy`. Nothing renderer-supplied can stand in for it.
   */
  setSurface(ref: ChatRef, surface: 'gui' | 'terminal', confirmTerminalStop?: ConfirmTerminalStop): Promise<AgentChatSnapshot>
  stop(ref: ChatRef): Promise<void>
  /**
   * Asks the chat's live OMP process `type` over its RPC stdin and resolves with the reply's `data` (rejecting on a
   * failed reply, exit, stop or `OMP_REQUEST_TIMEOUT_MS`). Null when the chat has no live, initialized OMP process.
   */
  ompRequest(ref: ChatRef, type: 'get_available_models'): Promise<unknown> | null
  /** Stops the GUI process (refusing new starts meanwhile), then runs `remove`, which deletes the record. */
  deleteChat(ref: ChatRef, remove: () => Promise<void>): Promise<void>
  /**
   * Untrack: refuses every GUI start of the folders' chats, stops their processes and starts, waits until each process
   * has closed and its grants are revoked, then runs `forget` (the untrack itself) before starts are let through again.
   */
  releaseFolder(folder: string, forget: () => unknown, relatedFolders?: readonly string[]): Promise<void>
  /** Stops the GUI processes and starts of every chat of a removed agent, with their grants revoked. */
  endAgent(id: AgentId): Promise<void>
  isLive(ref: ChatRef): boolean
  busy(): boolean
  dispose(): Promise<void>
}
interface Entry {
  chat: ChatRecord
  status: AgentChatSnapshot['status']
  prompts?: PendingPrompts
  /** The attention list last pushed for this entry, serialized: an unchanged list is not pushed again. */
  attention: string
  todos: Map<string | null, AgentChatSnapshot['todos'][number]['phases']>
  queued: number
  turnActive: boolean
  interruptTimer?: NodeJS.Timeout
  interruptFailure?: string
  /** The silent span's notification; armed only while a run's Magos chat is busy with no prompt pending. */
  stallTimer?: NodeJS.Timeout
  /** The current silent span was already reported: nothing more until a line, a non-busy status or a prompt ends it. */
  stallReported?: boolean
  process?: AgentProcess
  protocol: 'claude' | 'omp'
  claude: ClaudeProtocolState
  omp: OmpState
  /** Main's own OMP requests awaiting their reply, by command id (`ompRequest`). */
  requests: Map<string, { resolve(data: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>
  grantIds: string[]
  release?: () => void
  cancelled: boolean
  cancel(): void
  cancellation: Promise<never>
  ready: Promise<void>
  admit(): void
  rejectReady(error: unknown): void
  closed: Promise<void>
  completeClose(): void
  rejectClose(error: unknown): void
  revoking?: Promise<void>
  transportStopped?: Promise<void>
  cleanup?: Promise<void>
  cleanupComplete?: boolean
  stopResult?: Promise<void>
  starting?: Promise<StartResult>
  ending?: Promise<void>
  /** The latest copy of each tool_call item, so a tool image stored later upserts the item as last shown. */
  toolCalls: Map<string, ToolCallItem>
  /** Tool images kept per tool_call item, and whether one was dropped; applied to every later copy of the item. */
  toolImages: Map<string, HeldToolImages>
  /** Tool images being stored, in arrival order. */
  imageWork?: Promise<void>
}
type ToolCallItem = Extract<ChatItem, { kind: 'tool_call' }>
interface HeldToolImages { images: NonNullable<ToolCallItem['images']>; invalid: boolean }
/** Transcript items hold at most 8 images (`chat.ts`). */
const IMAGES_PER_ITEM = 8
const INVALID_IMAGE_NOTE = 'image not shown (invalid)'
const imagesRef = (chat: ChatRecord): ChatImagesRef => ({ folder: chat.folder, chatId: chat.id })
/** The item with the tool images kept for it, and the invalid-image note once (`withToolImages` is idempotent). */
function withToolImages(item: ToolCallItem, held: HeldToolImages | undefined): ToolCallItem {
  if (!held) return item
  const summary = held.invalid && !(item.resultSummary ?? '').includes(INVALID_IMAGE_NOTE)
    ? [item.resultSummary, INVALID_IMAGE_NOTE].filter(Boolean).join('\n') : item.resultSummary
  return { ...item, ...(held.images.length ? { images: [...held.images] } : {}), resultSummary: summary }
}
/** A turn's user_message naming the images it carried; never their bytes. */
function withSentImages(event: OmpEvent, refs: ChatImageRef[]): OmpEvent {
  if (!refs.length || event.type !== 'item' || event.item.kind !== 'user_message') return event
  return { ...event, item: { ...event.item, images: refs } }
}
type ThreadItem = Extract<ChatItem, { kind: 'thread' }>
/** A chat's thread identities: seeded once from its stored thread items and attempt bindings, so a restart keeps them. */
interface Callsigns {
  /** The latest stamped item of each thread. */
  threads: Map<string, ThreadItem>
  /** Servitor ordinals, assigned once per thread id in first-seen order. */
  ordinals: Map<string, number>
  next: number
  /** Verified worker attempts by thread id; never a claim token. */
  attempts: Map<string, string>
  /** Unstamped approval requests raised inside threads, restamped when their thread's identity resolves. */
  requests: Map<string, ApprovalRequestItem>
}
const ticketKeySchema = callsignSchema.shape.ticketKey

function startsMainTurn(event: OmpEvent): boolean {
  if (event.type !== 'item' || event.item.threadId) return false
  return event.item.kind === 'assistant_text' || event.item.kind === 'tool_call' && event.item.status === 'running'
}
/**
 * Busy silence that reports a run's Magos chat stalled: well past the activity line's 30 s warning, because a long tool
 * such as the full gate (about 3.5 minutes) prints nothing.
 */
const STALL_NOTIFY_MS = 300_000

const repeat = (callback: () => void, ms: number): (() => void) => {
  const timer = setInterval(callback, ms)
  timer.unref()
  return () => clearInterval(timer)
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** How long main waits for a live OMP process to answer one of its own requests (`ompRequest`). */
const OMP_REQUEST_TIMEOUT_MS = 15_000

function newEntry(chat: ChatRecord, previous?: Entry): Entry {
  // The repository's ES library predates Promise.withResolvers.
  let cancel!: () => void, admit!: () => void, rejectReady!: (error: unknown) => void
  let completeClose!: () => void, rejectClose!: (error: unknown) => void
  const cancellation = new Promise<never>((_, reject) => { cancel = () => reject(new Error('The chat start was cancelled.')) })
  const ready = new Promise<void>((resolve, reject) => { admit = resolve; rejectReady = reject })
  const closed = new Promise<void>((resolve, reject) => { completeClose = resolve; rejectClose = reject })
  for (const pending of [cancellation, ready, closed]) void pending.catch(() => undefined)
  return { chat, status: 'starting', queued: 0, turnActive: false, todos: previous?.todos ?? new Map(), protocol: 'claude', attention: '[]',
    claude: createClaudeProtocolState(), omp: createOmpState(`${randomUUID()}:`), requests: new Map(), grantIds: [], cancelled: false,
    cancellation, cancel, ready, admit, rejectReady, closed, completeClose, rejectClose, toolCalls: new Map(), toolImages: new Map(),
    // A restarted chat still waits for (and chains after) the old process's tool images, so deleteChat sees them land.
    imageWork: previous?.imageWork }
}

/** A missing close is a failure, not proof that the process or its authority was cleaned up. */
async function boundedShutdown(work: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Agent shutdown did not complete within 5 seconds.')), 5000)
  })
  try { await Promise.race([work, deadline]) } finally { clearTimeout(timer) }
}

class SessionManager {
  private readonly entries = new Map<string, Entry>()
  private readonly callsignStates = new Map<string, Callsigns>()
  /** Ticket-key lookups per folder and attempt, and their settled values. */
  private readonly ticketKeys = new Map<string, Promise<string | null>>()
  private readonly resolvedKeys = new Map<string, string | null>()
  private readonly startingEntries = new Map<string, Entry>()
  private readonly cleanup = new Set<Promise<unknown>>()
  private readonly deleting = new Set<string>()
  private readonly switching = new Set<string>()
  /** Surface requests awaiting confirmation: refuses duplicates without reserving either owner. */
  private readonly confirming = new Set<string>()
  /** Folders being untracked (`releaseFolder`): no GUI chat of theirs may start until the untrack has finished. */
  private readonly releasing = new Set<string>()
  private closing = false
  private disposing?: Promise<void>

  constructor(private readonly deps: AgentChatSessionsDeps) {}

  private now(): string { return this.deps.now?.() ?? new Date().toISOString() }
  private step<T>(entry: Entry, work: Promise<T>): Promise<T> { return Promise.race([work, entry.cancellation]) }

  private chatFor(ref: ChatRef): ChatRecord {
    const chat = this.deps.store.getChat(ref)
    if (!chat) throw new DomainError('not_found', 'The chat no longer exists.')
    return chat
  }
  private update(entry: Entry, patch: Parameters<ChatStore['updateChat']>[1]): void {
    entry.chat = this.deps.store.updateChat(entry.chat, mask(patch))
    this.deps.onChatChanged?.(entry.chat)
  }
  /** A tool_call item as last shown, with the tool images kept for it; any other event unchanged. */
  private withHeldImages(entry: Entry, event: OmpEvent): OmpEvent {
    if (event.type !== 'item' || event.item.kind !== 'tool_call') return event
    entry.toolCalls.set(event.item.id, event.item)
    return { ...event, item: withToolImages(event.item, entry.toolImages.get(event.item.id)) }
  }
  private emit(entry: Entry, event: OmpEvent): void {
    if (event.type === 'pending') return // The registry publishes only the FIFO head.
    const safe = mask(this.stamped(entry, this.withHeldImages(entry, event)))
    if (safe.type === 'item') this.deps.store.appendItems(entry.chat, [safe.item])
    if (safe.type === 'status') {
      entry.status = safe.status
      if (safe.status === 'busy' && entry.protocol === 'omp') entry.turnActive = true
      if (safe.status === 'idle') {
        entry.turnActive = false
        this.clearInterrupt(entry)
      }
      this.watchStall(entry)
    }
    if (safe.type === 'queued') entry.queued = safe.count
    if (safe.type === 'todos') {
      if (safe.phases.length) entry.todos.set(safe.threadId, safe.phases)
      else entry.todos.delete(safe.threadId)
    }
    this.deps.push(mask({ ...safe, folder: entry.chat.folder, chatId: entry.chat.id }))
  }
  snapshot(ref: ChatRef): AgentChatSnapshot {
    const chat = this.chatFor(ref), entry = this.entries.get(chat.id)
    return mask({ items: this.deps.store.readTranscript(chat)?.items ?? [], status: entry?.status ?? 'exited',
      pending: entry?.prompts ? entry.prompts.snapshot() : null, queued: entry ? entry.queued : 0, surface: chat.surface ?? 'terminal',
      todos: entry ? [...entry.todos].map(([threadId, phases]) => ({ threadId, phases })) : [] })
  }
  attention(folder: string | null): AttentionItem[] {
    return [...this.entries.values()].filter(entry => entry.chat.folder === folder).flatMap(entry => this.attentionOf(entry))
  }
  /** The entry's queue, head `shown`: masked, bounded titles and never tool input, prompt detail or options. */
  private attentionOf(entry: Entry): AttentionItem[] {
    return mask((entry.prompts?.queue() ?? []).map((prompt, index) => ({
      chatId: entry.chat.id, promptId: prompt.id, kind: prompt.kind, threadId: prompt.threadId, callsign: prompt.callsign,
      arbitration: prompt.arbitration.state, title: mask(prompt.title).slice(0, 200), shown: index === 0
    })))
  }
  /** Pushes the entry's attention list whenever it differs from the one last pushed; `[]` once it empties. */
  private pushAttention(entry: Entry): void {
    const items = this.attentionOf(entry), serialized = JSON.stringify(items)
    if (serialized === entry.attention) return
    entry.attention = serialized
    this.deps.push({ type: 'attention', folder: entry.chat.folder, chatId: entry.chat.id, items })
  }
  private heldPrompts(entry: Entry): PendingPrompt[] {
    return entry.protocol === 'claude' ? [...entry.claude.pending.values()].map(held => held.prompt) : entry.omp.pending.map(held => held.prompt)
  }
  private stampedPrompts(entry: Entry): PendingPrompt[] {
    return this.heldPrompts(entry).map(prompt => ({ ...prompt, callsign: this.promptCallsign(entry, prompt.threadId, prompt.attributed) }))
  }
  private callsigns(entry: Entry): Callsigns {
    const { chat } = entry
    const known = this.callsignStates.get(chat.id)
    if (known) return known
    const state = this.storedCallsigns(chat)
    this.callsignStates.set(chat.id, state)
    if (chat.folder === null) return state
    for (const binding of this.deps.bindings.threadsOf(chat)) {
      if (binding.kind !== 'attempt' || binding.threadId === null) continue
      state.attempts.set(binding.threadId, binding.attemptId)
      this.lookup(entry, chat.folder, binding.attemptId)
    }
    return state
  }
  /** The stored thread items and the Servitor ordinals they hold, legacy threads' included, so a later stamp keeps the name shown. */
  private storedCallsigns(chat: ChatRecord): Callsigns {
    const threads = (this.deps.store.readTranscript(chat)?.items ?? []).filter((item): item is ThreadItem => item.kind === 'thread')
    const ordinals = servitorOrdinals(threads)
    return { threads: new Map(threads.map(thread => [thread.id, thread])), ordinals,
      next: nextServitorOrdinal(ordinals), attempts: new Map(), requests: new Map() }
  }
  /** Records decide identity: the chat's role and run, the verified attempt's ticket key, then the masked label. */
  private threadCallsign(entry: Entry, threadId: string, label: string): Callsign | null {
    const state = this.callsigns(entry), attemptId = state.attempts.get(threadId), ordinal = state.ordinals.get(threadId)
    const boundTicketKey = attemptId === undefined || entry.chat.folder === null ? null
      : this.resolvedKeys.get(JSON.stringify([entry.chat.folder, attemptId])) ?? null
    const callsign = resolveCallsign({ chat: entry.chat, threadId, label, boundTicketKey, servitorOrdinal: ordinal ?? state.next })
    if (callsign !== null && callsign.ordinal !== null && ordinal === undefined) {
      state.ordinals.set(threadId, callsign.ordinal)
      state.next++
    }
    return callsign
  }
  /** A request no thread or quiet main turn accounts for names nobody: never the chat's own, most trusted identity. */
  private promptCallsign(entry: Entry, threadId: string | null, attributed: boolean): Callsign | null {
    if (threadId !== null) return this.threadCallsign(entry, threadId, this.callsigns(entry).threads.get(threadId)?.label ?? '')
    return attributed ? rootCallsignOf(entry.chat) : null
  }
  private stamped(entry: Entry, event: OmpEvent): OmpEvent {
    if (event.type !== 'item') return event
    const { item } = event
    if (item.kind === 'thread') {
      const callsign = this.threadCallsign(entry, item.id, item.label)
      const thread = callsign ? { ...item, callsign } : item
      this.callsigns(entry).threads.set(item.id, thread)
      return { ...event, item: thread }
    }
    if (item.kind !== 'approval_request') return event
    if (item.threadId !== undefined) this.callsigns(entry).requests.set(item.id, item)
    const held = this.heldPrompts(entry).find(prompt => prompt.id === item.requestId)
    const callsign = this.promptCallsign(entry, item.threadId ?? null, held?.attributed ?? false)
    return callsign ? { ...event, item: { ...item, callsign } } : event
  }
  /**
   * Binds a thread to the attempt its spawn prompt claimed, only once the project confirms the token is that attempt's
   * live, latest claim in this Start-run chat's own run. The token goes nowhere else and is dropped here.
   */
  private claim(entry: Entry, event: ThreadClaimEvent): void {
    const { chat } = entry, verify = this.deps.verifyAttemptClaim
    if (verify === undefined || chat.folder === null || chat.runId === undefined) return
    const folder = chat.folder, runId = chat.runId, { threadId, attemptId } = event
    void verify(folder, event.token).then(found => {
      if (found?.attemptId !== attemptId || found.runId !== runId) return
      if (this.deleting.has(chat.id) || this.deps.store.getChat(chat) === null) return
      const state = this.callsigns(entry)
      if (state.attempts.has(threadId)) return
      const binding: ActivityBinding = { chatId: chat.id, folder, threadId, kind: 'attempt', attemptId, role: 'worker' }
      this.deps.bindings.bind(binding)
      state.attempts.set(threadId, attemptId)
      this.lookup(entry, folder, attemptId)
    }).catch(() => undefined)
  }
  /** One ticket-key lookup per attempt; a rejection or malformed key is null, and a found key restamps the attempt's threads. */
  private lookup(entry: Entry, folder: string, attemptId: string): void {
    const key = JSON.stringify([folder, attemptId])
    let lookup = this.ticketKeys.get(key)
    if (lookup === undefined) {
      lookup = Promise.resolve()
        .then(() => this.deps.ticketKeyOfAttempt?.(folder, attemptId) ?? null)
        .then(value => ticketKeySchema.safeParse(value).success ? value : null, () => null)
      this.ticketKeys.set(key, lookup)
      void lookup.then(value => { this.resolvedKeys.set(key, value) })
    }
    void lookup.then(value => { if (value !== null) this.restamp(entry, attemptId) }).catch(() => undefined)
  }
  /** Re-upserts the attempt's threads and their requests with their new identity, and re-pushes an affected prompt. */
  private restamp(entry: Entry, attemptId: string): void {
    const { chat } = entry, state = this.callsignStates.get(chat.id)
    if (!state || this.deleting.has(chat.id) || this.deps.store.getChat(chat) === null) return
    const current = this.entries.get(chat.id) ?? entry
    for (const [threadId, bound] of state.attempts) if (bound === attemptId) this.restampThread(current, state, threadId)
    current.prompts?.update(this.stampedPrompts(current))
  }
  private restampThread(entry: Entry, state: Callsigns, threadId: string): void {
    const thread = state.threads.get(threadId)
    if (!thread) return
    const callsign = this.threadCallsign(entry, threadId, thread.label)
    if (JSON.stringify(callsign) === JSON.stringify(thread.callsign ?? null)) return
    this.emit(entry, { type: 'item', item: thread })
    for (const request of state.requests.values()) if (request.threadId === threadId) this.emit(entry, { type: 'item', item: request })
  }
  private clearPrompts(entry: Entry): void {
    entry.claude.pending.clear()
    entry.omp.pending = []
    entry.prompts?.clear()
  }
  /** Fails every request still awaiting its reply: the process that would answer is exiting or stopped. */
  private failRequests(entry: Entry): void {
    for (const request of entry.requests.values()) {
      clearTimeout(request.timer)
      request.reject(new DomainError('cancelled', 'The agent stopped before it answered.'))
    }
    entry.requests.clear()
  }
  private settleRequest(entry: Entry, result: CommandResultEvent): void {
    const request = entry.requests.get(result.id)
    if (!request) return
    entry.requests.delete(result.id)
    clearTimeout(request.timer)
    if (result.ok) request.resolve(result.data)
    else request.reject(new DomainError('operation_unavailable', 'The agent refused the request.'))
  }
  ompRequest(ref: ChatRef, type: 'get_available_models'): Promise<unknown> | null {
    const entry = this.entries.get(this.chatFor(ref).id)
    if (!entry?.process || entry.protocol !== 'omp' || !entry.omp.initialized || entry.cancelled || entry.ending) return null
    const id = randomUUID()
    const encoded = encodeOmpCommand({ type, id }, entry.omp, this.now())
    this.write(entry, encoded.lines)
    entry.omp = encoded.state
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.requests.delete(id)
        reject(new DomainError('timeout', `The agent did not answer within ${OMP_REQUEST_TIMEOUT_MS / 1000} seconds.`))
      }, OMP_REQUEST_TIMEOUT_MS)
      timer.unref()
      entry.requests.set(id, { resolve, reject, timer })
    })
  }
  private tracked<T>(work: Promise<T>): Promise<T> {
    this.cleanup.add(work)
    void work.then(() => this.cleanup.delete(work), () => this.cleanup.delete(work))
    return work
  }
  private revoke(ids: readonly string[]): Promise<void> {
    return this.tracked(Promise.all(ids.map(id => this.deps.revokeChatGrant(id))).then(() => undefined))
  }
  private folder(chat: ChatRecord): string {
    return chat.folder === null ? ensureScratchFolder(this.deps.userData, chat.id) : resolveLaunchFolder({ folder: chat.folder }, this.deps.folders)
  }
  private assertOpen(chat: ChatRecord): void {
    if (this.closing || this.deleting.has(chat.id)) throw new Error('The chat is stopping.')
    if (chat.folder !== null && this.releasing.has(chat.folder)) throw new Error("The chat's folder is being untracked.")
    if (this.switching.has(chat.id)) throw new DomainError('busy', 'The chat is switching surfaces.')
  }
  private assertCurrent(entry: Entry): void {
    this.assertOpen(entry.chat)
    if (entry.cancelled) throw new Error('The chat start was cancelled.')
    this.folder(entry.chat)
    if (this.deps.terminalLive(entry.chat)) throw new Error('The chat is running in a terminal.')
  }
  private async pauseRun(folder: string, runId: string): Promise<void> {
    const run = await this.deps.runs.getRun(folder, runId)
    if (run?.state === 'running' || run?.state === 'paused') {
      await this.deps.runs.pauseRun(folder, { runId, reason: SIGNED_OUT_PAUSE_REASON })
    }
  }
  private async pauseIfSignedOut(entry: Entry): Promise<void> {
    const chat = entry.chat
    if (this.closing || entry.cancelled || chat.runId === undefined || chat.folder === null) return
    const agent = this.deps.agentFor(chat.agent)
    if (!agent || agent.kind === 'custom') return
    const auth = await this.deps.checkAuth(agent.kind, agent.executablePath)
    if (!this.closing && auth.state === 'signed_out') await this.pauseRun(chat.folder, chat.runId)
  }
  private revokeEntry(entry: Entry): Promise<void> {
    entry.revoking ??= this.revoke(entry.grantIds.splice(0))
    return entry.revoking
  }
  private cleanupEntry(entry: Entry): Promise<void> {
    if (entry.cleanup) return entry.cleanup
    const child = entry.process
    const revoke = this.revokeEntry(entry)
    // Defer invocation so even a synchronous close callback sees the installed composite barrier.
    entry.transportStopped = Promise.resolve().then(() => child?.stop())
    if (!child) void revoke.then(entry.completeClose, entry.rejectClose)
    entry.cleanup = Promise.all([entry.transportStopped, entry.closed, revoke]).then(() => {
      entry.cleanupComplete = true
      entry.process = undefined
    })
    return entry.cleanup
  }
  private awaitCleanup(entry: Entry): Promise<void> {
    if (entry.cleanupComplete) return entry.cleanup!
    entry.stopResult ??= boundedShutdown(this.cleanupEntry(entry)).catch(error => {
      this.clearPrompts(entry)
      this.emit(entry, { type: 'status', status: 'failed', detail: message(error) })
      throw error
    })
    return entry.stopResult
  }
  private ended(entry: Entry, exit: AgentProcessExit): Promise<void> {
    if (entry.ending) return entry.ending
    this.clearInterrupt(entry)
    this.clearPrompts(entry)
    this.failRequests(entry)
    this.resetStall(entry)
    entry.release?.()
    entry.release = undefined
    entry.admit()
    entry.ending = (async () => {
      await this.revokeEntry(entry)
      const detail = Buffer.from(mask(exit.stderr)).subarray(-2048).toString('utf8')
      if (entry.queued) this.emit(entry, { type: 'queued', count: 0 })
      this.emit(entry, { type: 'status', status: entry.interruptFailure ? 'failed' : exit.code === 0 || entry.cancelled ? 'exited' : 'failed',
        ...(entry.interruptFailure ? { detail: entry.interruptFailure } : detail ? { detail } : {}) })
    })()
    void entry.ending.then(entry.completeClose, entry.rejectClose)
    // Natural close can precede the transport's retained process-tree cleanup.
    void this.awaitCleanup(entry).catch(() => undefined)
    // Auth may require user/network time; it must never hold process shutdown open.
    void entry.ending.then(() => this.pauseIfSignedOut(entry)).catch(() => undefined)
    return entry.ending
  }
  private stopEntry(entry: Entry): Promise<void> {
    this.clearInterrupt(entry)
    this.resetStall(entry)
    entry.cancelled = true
    entry.cancel()
    this.clearPrompts(entry)
    this.failRequests(entry)
    entry.release?.()
    entry.release = undefined
    return this.awaitCleanup(entry)
  }
  private write(entry: Entry, lines: readonly string[]): void {
    for (const line of lines) if (!entry.process?.write(line)) throw new Error('The agent exited before accepting input.')
  }
  private ompLine(entry: Entry, raw: string): void {
    const result = translateOmpLine(raw, entry.omp, this.now())
    entry.omp = result.state
    for (const event of result.events) this.emit(entry, event)
    entry.prompts?.update(this.stampedPrompts(entry))
    for (const event of result.internalEvents) {
      if (event.type === 'thread_claim') this.claim(entry, event)
      else this.settleRequest(entry, event)
    }
    this.storeToolImages(entry, result.blobs)
    let frame: unknown
    try { frame = JSON.parse(raw) } catch { return }
    const init = initLines(frame, entry.omp, randomUUID)
    entry.omp = init.state
    this.write(entry, init.lines)
    if (entry.omp.initialized) entry.admit()
  }
  private consumeClaudeQueue(entry: Entry, events: OmpEvent[], mainStarted: boolean): void {
    if (entry.turnActive || entry.queued === 0) return
    // A valid terminal result can be the only evidence of an output-free queued turn.
    const ended = events.some(event => event.type === 'status' && event.status === 'idle')
    if (!mainStarted && !ended) return
    entry.turnActive = true
    // The CLI's explicit result count already describes the queue after this turn.
    if (!events.some(event => event.type === 'queued')) this.emit(entry, { type: 'queued', count: entry.queued - 1 })
    if (!ended) this.emit(entry, { type: 'status', status: 'busy' })
  }
  private claudeLine(entry: Entry, raw: string): void {
    const result = translateClaudeLine(raw, entry.claude, this.now())
    const mainStarted = result.state.activeMessages.get(null) !== entry.claude.activeMessages.get(null)
      || result.events.some(startsMainTurn)
    entry.claude = result.state
    this.consumeClaudeQueue(entry, result.events, mainStarted)
    for (const event of result.events) this.emit(entry, event)
    entry.prompts?.update(this.stampedPrompts(entry))
    for (const claim of result.internalEvents) this.claim(entry, claim)
    this.storeToolImages(entry, result.blobs)
    if (entry.claude.initialized) entry.admit()
    else if (result.events.some(event => event.type === 'status' && event.status === 'failed')) {
      entry.rejectReady(new Error('The agent rejected protocol initialization.'))
    }
  }
  /**
   * Keeps each tool-result image in the chat's image store, in arrival order, then upserts its tool_call item (as last
   * shown) with the image. A blob the store refuses is dropped, and the item notes it.
   */
  private storeToolImages(entry: Entry, blobs: readonly ToolResultBlob[]): void {
    if (!blobs.length) return
    const ref = imagesRef(entry.chat)
    entry.imageWork = this.tracked((entry.imageWork ?? Promise.resolve()).then(async () => {
      const touched = new Set<string>()
      for (const blob of blobs) {
        const held = entry.toolImages.get(blob.itemId) ?? { images: [], invalid: false }
        entry.toolImages.set(blob.itemId, held)
        touched.add(blob.itemId)
        if (held.images.length >= IMAGES_PER_ITEM) continue
        try { held.images.push(await this.deps.chatImages.putToolImage(ref, Buffer.from(blob.base64, 'base64'))) }
        catch { held.invalid = true }
      }
      if (this.deleting.has(entry.chat.id) || this.deps.store.getChat(entry.chat) === null) return
      for (const id of touched) {
        const item = entry.toolCalls.get(id)
        if (item) this.emit(entry, { type: 'item', item })
      }
    }).catch(() => undefined))
  }
  private line(entry: Entry, raw: string): void {
    if (entry.cancelled || entry.ending) return
    // Any stdout line ends the silent span; one is started again below while the chat stays due.
    this.resetStall(entry)
    try {
      if (entry.protocol === 'omp') this.ompLine(entry, raw)
      else this.claudeLine(entry, raw)
      const state = entry.protocol === 'omp' ? entry.omp : entry.claude
      if (state.sessionId && state.sessionId !== entry.chat.sessionId) this.update(entry, { sessionId: state.sessionId, sessionStarted: true })
      // Internal translator events contain authority. They never enter emit/store/IPC.
    } catch (error) {
      this.emit(entry, { type: 'status', status: 'failed', detail: message(error) })
      void this.stopEntry(entry).catch(() => undefined) // stopEntry publishes a failed shutdown.
    }
    this.watchStall(entry)
  }
  /** Ends the silent span: a stdout line, a non-busy status, a pending prompt, exit or stop. */
  private resetStall(entry: Entry): void {
    clearTimeout(entry.stallTimer)
    entry.stallTimer = undefined
    entry.stallReported = false
  }
  /** A run's Magos chat (orchestrator with a run), running, busy and with no prompt waiting on the person. */
  private stallDue(entry: Entry): boolean {
    const { chat } = entry
    return chat.role === 'orchestrator' && chat.runId !== undefined && entry.status === 'busy'
      && !entry.prompts?.snapshot() && !entry.cancelled && !entry.ending
  }
  /**
   * Starts a silent span when the chat is due and no span is running or reported; ends it otherwise. The timer never
   * holds the process open.
   */
  private watchStall(entry: Entry): void {
    const { chat } = entry, onAttention = this.deps.onAttention
    if (onAttention === undefined || !this.stallDue(entry)) { this.resetStall(entry); return }
    if (entry.stallTimer || entry.stallReported) return
    const since = Date.now()
    entry.stallTimer = setTimeout(() => {
      entry.stallTimer = undefined
      entry.stallReported = true
      try { onAttention({ kind: 'run_stalled', ref: { folder: chat.folder, id: chat.id }, silentMs: Date.now() - since }) }
      catch { /* A notifier failure never reaches the session. */ }
    }, STALL_NOTIFY_MS)
    entry.stallTimer.unref()
  }
  private watch(entry: Entry): void {
    const every = this.deps.timers?.repeat ?? repeat
    const release = this.deps.keepAwake?.() ?? (() => undefined)
    const stopFolder = every(() => {
      try { this.folder(entry.chat) } catch (error) {
        this.emit(entry, { type: 'status', status: 'failed', detail: message(error) })
        void this.stopEntry(entry).catch(() => undefined) // stopEntry publishes a failed shutdown.
      }
    }, 60_000)
    const stopRenew = every(() => {
      void this.tracked(Promise.all(entry.grantIds.map(id => this.deps.renewChatGrant(id))))
    }, 3_600_000)
    entry.release = () => { stopFolder(); stopRenew(); release() }
  }
  private async startFiles(entry: Entry, cwd: string, reach: ReachTarget[] | undefined): Promise<TerminalFiles> {
    const { chat } = entry, { deps } = this
    const cli = deps.cliFor(chat.folder)
    const paths = await this.step(entry, writeTerminalFiles({ userData: deps.userData, chatId: chat.id, platform: deps.platform,
      folder: cwd, cli, role: chat.role, allowSave: chat.allowSave, orchestratesRun: chat.runId !== undefined,
      nameFirstPrompt: chat.titleStatus === 'pending', skitariiMail: false,
      transferEpicId: chat.transferEpicId, cardId: chat.cardId, conversation: chat.conversation, reach }))
    if (entry.protocol === 'claude') return { ...paths, claudeSettings: await this.step(entry, writeClaudeSettings({
      userData: deps.userData, chatId: chat.id, platform: deps.platform, folder: cwd, cli, home: homedir(), tmp: tmpdir(),
      ...(reach === undefined ? {} : { projectless: true as const }) })) }
    return { ...paths, omp: { ...await this.step(entry, writeOmpFiles(deps.userData, chat.id, { fresh: false, role: chat.role })), extension: deps.ompExtension } }
  }
  private async issue(entry: Entry, agent: AgentView, cwd: string, reach: ReachTarget[] | undefined) {
    const { chat } = entry, { deps } = this
    const grant = { role: chat.role, allowSave: chat.allowSave, label: `${agent.displayName} · ${chat.title}`.slice(0, 120) }
    const identity = { ...mailboxChat(chat), kind: agent.kind }
    const issuing = reach === undefined
      ? deps.issueChatCli(cwd, grant, identity).then(value => ({ cli: value.cli, grantIds: [value.grantId] }))
      : reach.length ? deps.issueReachCli(reach, grant) : Promise.resolve({ cli: deps.cliFor(null), grantIds: [] })
    return this.step(entry, issuing.then(async value => {
      if (entry.cancelled || this.closing) { await this.revoke(value.grantIds); throw new Error('The chat start was cancelled.') }
      entry.grantIds = value.grantIds
      return value
    }))
  }
  private launch(entry: Entry, input: {
    agent: AgentView; cwd: string; reach: ReachTarget[] | undefined
    paths: TerminalFiles; grant: DarkMechanicusCli; firstMessage?: string
  }): AgentChatLaunchSpec {
    const { agent, cwd, reach, paths, grant, firstMessage } = input
    const { chat } = entry, { deps } = this
    const found = paths.omp ? ompSessionId(paths.omp.sessionDir) : null
    const sessionStarted = agent.kind === 'omp' ? found !== null : chat.sessionId !== null && claudeSessionExists({ env: deps.env, platform: deps.platform, folder: cwd, sessionId: chat.sessionId })
    return agentChatLaunch({ chat: { ...chat, sessionId: found ?? chat.sessionId, sessionStarted, kickoffSent: chat.kickoffSent === true },
      agent, folder: cwd, grant, paths, platform: deps.platform, env: deps.env,
      newSessionId: deps.newSessionId ?? randomUUID, kickoff: firstMessage ?? null, reach })
  }
  private spawn(entry: Entry, spec: AgentChatLaunchSpec): void {
    entry.todos.clear()
    const child = (this.deps.startProcess ?? startAgentProcess)(spec)
    entry.process = child
    child.onLine(raw => this.line(entry, raw))
    child.onExit(exit => { void this.ended(entry, exit) })
    this.watch(entry)
    if (entry.protocol === 'claude') {
      const init = claudeInitLines(entry.claude, randomUUID())
      entry.claude = init.state
      this.write(entry, init.lines)
    }
  }
  private firstTurn(entry: Entry, firstMessage?: string): void {
    const { chat } = entry
    if (chat.kickoffSent || chat.firstPromptDelivery === 'uncertain' || chat.firstPromptDelivery === 'submitted') return
    const text = firstMessage ?? chat.firstPrompt
    if (text === undefined) return
    if (chat.firstPrompt !== undefined) this.update(entry, { firstPromptDelivery: 'uncertain' })
    this.writeTurn(entry, text)
    this.update(entry, { kickoffSent: true, ...(chat.firstPrompt === undefined ? {} : { firstPromptDelivery: 'submitted' }) })
  }
  private encodeTurn(entry: Entry, text: string, turn: readonly TurnImage[]) {
    const sent = turn.length ? { images: [...turn] } : {}
    return entry.protocol === 'claude'
      ? encodeClaudeCommand({ type: 'send', text, uuid: randomUUID(), ...sent }, entry.claude, this.now())
      : encodeOmpCommand({ type: 'send', text, id: randomUUID(), ...sent }, entry.omp, this.now())
  }
  private writeTurn(entry: Entry, text: string, images: { refs: ChatImageRef[]; turn: TurnImage[] } = { refs: [], turn: [] }): void {
    const queued = entry.turnActive || entry.queued > 0
    const encoded = this.encodeTurn(entry, text, images.turn)
    if (!encoded.lines.length) throw new Error('The agent did not initialize its input protocol.')
    this.write(entry, encoded.lines)
    if (entry.protocol === 'claude') entry.claude = encoded.state as ClaudeProtocolState
    else entry.omp = encoded.state as OmpState
    if (!queued) entry.turnActive = true
    for (const event of encoded.events) this.emit(entry, withSentImages(event, images.refs))
    if (entry.protocol === 'claude' && queued) this.emit(entry, { type: 'queued', count: entry.queued + 1 })
    if (entry.status !== 'busy') this.emit(entry, { type: 'status', status: 'busy' })
  }
  private async bind(entry: Entry): Promise<void> {
    const { chat } = entry, generation = randomUUID()
    for (const id of entry.grantIds) await this.step(entry, Promise.resolve(this.deps.bindChatGrant?.(id, {
      folder: chat.folder, chatId: chat.id, generation, runId: chat.runId, cardId: chat.cardId
    })))
  }
  private async runStart(entry: Entry, firstMessage?: string): Promise<StartResult> {
    const { chat } = entry, { deps } = this
    const agent = deps.agentFor(chat.agent)
    if (!agent || (agent.kind !== 'claude' && agent.kind !== 'omp')) throw new Error('This chat has no GUI-capable agent.')
    entry.protocol = agent.kind
    entry.prompts = new PendingPrompts({
      publish: prompt => deps.push(mask({ type: 'pending', folder: chat.folder, chatId: chat.id, prompt })),
      ...(deps.arbitrate ? { arbitrate: prompt => deps.arbitrate!({ ref: { folder: chat.folder, id: chat.id }, chat: entry.chat, agent, prompt,
        // OMP prompts carry no translator-clipped input record: count them as clipped (OMP is never arbitrated today).
        inputClipped: entry.protocol === 'claude' ? claudeInputClipped(entry.claude, prompt.id) : true }) } : {}),
      answer: (prompt, verdict) => this.answerEntry(entry, { promptId: prompt.id, optionId: verdict.decision }, { decidedBy: 'magos', reason: verdict.reason }),
      changed: () => { this.pushAttention(entry); this.watchStall(entry) }
    })
    const auth = await this.step(entry, deps.checkAuth(agent.kind, agent.executablePath))
    if (auth.state === 'signed_out') {
      this.emit(entry, { type: 'status', status: 'signed_out', detail: auth.reason })
      return this.snapshot(chat)
    }
    this.assertCurrent(entry)
    const cwd = this.folder(chat)
    const reach = chat.folder === null ? reachTargets(cwd, deps.reachFolders()) : undefined
    const paths = await this.startFiles(entry, cwd, reach)
    this.assertCurrent(entry)
    const issued = await this.issue(entry, agent, cwd, reach)
    this.assertCurrent(entry)
    const spec = this.launch(entry, { agent, cwd, reach, paths, grant: issued.cli, firstMessage })
    this.update(entry, { grantIds: issued.grantIds, sessionId: spec.sessionId })
    this.assertCurrent(entry)
    this.spawn(entry, spec)
    await this.bind(entry)
    await this.step(entry, entry.ready)
    this.assertCurrent(entry)
    if (entry.ending) await entry.ending
    else this.firstTurn(entry, firstMessage)
    return this.snapshot(chat)
  }
  async start(ref: ChatRef, options: { firstMessage?: string } = {}): Promise<StartResult> {
    const chat = this.chatFor(ref)
    this.assertGuiCapable(chat)
    if (this.deps.terminalLive(chat)) return { code: 'busy_elsewhere' }
    this.assertOpen(chat)
    const reserved = this.startingEntries.get(chat.id)
    if (reserved?.starting) return reserved.starting
    const previous = this.entries.get(chat.id)
    if (previous?.process && !previous.ending && !previous.cancelled) return this.snapshot(chat)
    const entry = newEntry(chat, previous)
    this.startingEntries.set(chat.id, entry)
    // Reserve before yielding or publishing, but retain the old owner until its cleanup completes.
    entry.starting = this.beginStart(entry, previous, options.firstMessage).finally(() => {
      this.startingEntries.delete(chat.id)
      entry.starting = undefined
    })
    this.emit(entry, { type: 'status', status: 'starting' })
    return entry.starting
  }
  private async beginStart(entry: Entry, previous: Entry | undefined, firstMessage?: string): Promise<StartResult> {
    // Ensure start() installs the shared promise before auth, callbacks or notifications can re-enter.
    await Promise.resolve()
    try {
      if (previous?.cleanup) await this.step(entry, this.awaitCleanup(previous))
      this.assertCurrent(entry)
      entry.chat = this.chatFor(entry.chat)
      this.entries.set(entry.chat.id, entry)
      // Seed stored identities and bound attempts' ticket lookups before the process can report threads.
      this.callsigns(entry)
      return await this.runStart(entry, firstMessage)
    } catch (error) {
      await this.stopEntry(entry)
      this.emit(entry, { type: 'status', status: 'failed', detail: message(error) })
      return { ...this.snapshot(entry.chat), status: 'failed' }
    }
  }
  /** The staged images of this chat that `imageIds` name, measured and base64-encoded; any other id is `invalid_input`. */
  private async turnImages(chat: ChatRecord, imageIds: readonly string[]): Promise<{ refs: ChatImageRef[]; turn: TurnImage[] }> {
    const refs: ChatImageRef[] = [], turn: TurnImage[] = []
    for (const id of imageIds) {
      const stored = await this.deps.chatImages.read(imagesRef(chat), id)
      if (stored === null || stored.mime === 'image/webp') throw new DomainError('invalid_input', 'An image is not staged for this chat.')
      const measured = inspectImageBytes(stored.bytes)
      refs.push({ id, mime: measured.mime, width: measured.width, height: measured.height, bytes: stored.bytes.byteLength })
      turn.push({ mime: measured.mime, base64: Buffer.from(stored.bytes.buffer, stored.bytes.byteOffset, stored.bytes.byteLength).toString('base64') })
    }
    return { refs, turn }
  }
  async send(ref: ChatRef, input: { text: string; imageIds?: readonly string[] }): Promise<void> {
    // Checked before the chat starts: a refused id writes nothing to the agent and stores nothing.
    const images = await this.turnImages(this.chatFor(ref), input.imageIds ?? [])
    const result = await this.start(ref)
    if ('code' in result) throw new Error('The chat is running in a terminal.')
    const entry = this.entries.get(this.chatFor(ref).id)
    if (!entry?.process || entry.ending || entry.cancelled) throw new Error('The agent is not running.')
    this.assertCurrent(entry)
    this.writeTurn(entry, input.text, images)
  }
  async stageImage(ref: ChatRef, bytes: Uint8Array): Promise<ChatImageRef> {
    return this.deps.chatImages.put(imagesRef(this.chatFor(ref)), bytes)
  }
  async answer(ref: ChatRef, input: AgentChatAnswer): Promise<void> {
    const entry = this.entries.get(this.chatFor(ref).id)
    if (!entry) throw new DomainError('stale_prompt', 'This prompt is no longer pending.')
    // Renderer callers cannot supply decision provenance.
    this.answerEntry(entry, input, { decidedBy: 'person' })
  }
  private answerEntry(entry: Entry, input: AgentChatAnswer,
    provenance: { decidedBy: 'person' } | { decidedBy: 'magos'; reason: string }): void {
    if (!entry.process || entry.cancelled || entry.ending || !entry.prompts || this.entries.get(entry.chat.id) !== entry)
      throw new DomainError('stale_prompt', 'This prompt is no longer pending.')
    this.assertCurrent(entry)
    entry.prompts.answer(input.promptId, () => {
      const encoded = entry.protocol === 'claude'
        ? encodeClaudeCommand({ type: 'answer', ...input }, entry.claude, this.now())
        : encodeOmpCommand({ type: 'answer', id: randomUUID(), ...input }, entry.omp, this.now())
      if (!encoded.events.some(event => event.type === 'item' && event.item.kind === 'approval_decision'))
        throw new DomainError('invalid_input', 'Choose an offered option and provide a valid answer.')
      this.write(entry, encoded.lines)
      if (entry.protocol === 'claude') entry.claude = encoded.state as ClaudeProtocolState
      else entry.omp = encoded.state as OmpState
      for (const event of encoded.events) {
        if (event.type === 'item' && event.item.kind === 'approval_decision') {
          this.emit(entry, { ...event, item: { ...event.item, ...provenance } })
        } else this.emit(entry, event)
      }
      return this.stampedPrompts(entry)
    })
  }
  private clearInterrupt(entry: Entry): void {
    clearTimeout(entry.interruptTimer)
    entry.interruptTimer = undefined
  }
  async interrupt(ref: ChatRef): Promise<void> {
    const chat = this.chatFor(ref)
    this.assertOpen(chat)
    const entry = this.entries.get(chat.id)
    if (!entry?.process || entry.cancelled || entry.ending || !entry.turnActive || entry.interruptTimer) return
    this.assertCurrent(entry)
    const encoded = entry.protocol === 'claude'
      ? encodeClaudeCommand({ type: 'interrupt', requestId: randomUUID() }, entry.claude, this.now())
      : encodeOmpCommand({ type: 'interrupt', id: randomUUID() }, entry.omp, this.now())
    this.write(entry, encoded.lines)
    if (entry.protocol === 'claude') entry.claude = encoded.state as ClaudeProtocolState
    else entry.omp = encoded.state as OmpState
    entry.interruptTimer = setTimeout(() => {
      entry.interruptFailure = 'The agent did not end its turn within 5 seconds of interrupt.'
      this.emit(entry, { type: 'status', status: 'failed', detail: entry.interruptFailure })
      // Escalate this retained owner, then join the unchanged close/revocation/transport barrier.
      void entry.process?.stop({ force: true }).catch(() => undefined)
      void this.stopEntry(entry).catch(() => undefined)
    }, 5000)
    entry.interruptTimer.unref()
  }
  private guiBusy(chat: ChatRecord): boolean {
    if (this.startingEntries.has(chat.id)) return true
    const entry = this.entries.get(chat.id)
    if (!entry || entry.cleanupComplete) return false
    return entry.turnActive || entry.queued > 0 || Boolean(entry.prompts?.snapshot())
  }
  /**
   * Forge setup keeps the terminal's setup-action gate, no-new-session rule and checkout verification; tooling repair
   * keeps the terminal's live-caller handoff and repair-checkout verification; a Forge World merge resolver keeps the
   * terminal's member reach grants and resolver context, which this launch does not give.
   */
  private assertGuiCapable(chat: ChatRecord): void {
    if (chat.forgeSetup !== undefined) throw new DomainError('unsupported', 'Forge setup conversations run only in the terminal.')
    if (chat.repairIncidentId !== undefined) throw new DomainError('unsupported', 'Tooling repair conversations run only in the terminal.')
    if (chat.forgeResolver !== undefined) throw new DomainError('unsupported', 'Forge World merge resolvers run only in the terminal.')
  }
  private assertSurfaceAllowed(chat: ChatRecord, surface: 'gui' | 'terminal'): void {
    this.assertOpen(chat)
    if (this.confirming.has(chat.id)) throw new DomainError('busy', 'A surface switch is already awaiting confirmation.')
    const agent = this.deps.agentFor(chat.agent)
    if (surface === 'gui') this.assertGuiCapable(chat)
    if (surface === 'gui' && !GUI_PROTOCOL_KINDS.some(kind => kind === agent?.kind)) {
      throw new DomainError('unsupported', 'This agent has no GUI protocol.')
    }
    if (this.guiBusy(chat)) throw new DomainError('busy', 'Wait for the current turn and pending prompts before switching surfaces.')
  }
  /** The terminal generation a switch to the GUI must retire; null when no terminal runs or the terminal is the target. Never inferred idle. */
  private terminalGeneration(chat: ChatRecord, surface: 'gui' | 'terminal'): string | null {
    if (surface === 'terminal') return null
    const generation = this.deps.terminalOwner(chat)
    // A starting or still-retiring terminal has no confirmable owner.
    if (generation === null && this.deps.terminalLive(chat)) throw new DomainError('busy', 'The terminal is starting or still stopping.')
    return generation
  }
  /** Holds only a duplicate-request lock while asking; a missing callback, refusal or failure changes nothing. */
  private async confirmStop(chat: ChatRecord, confirm?: ConfirmTerminalStop): Promise<void> {
    if (!confirm) throw new DomainError('busy', 'The terminal is running; stopping it needs explicit confirmation.')
    this.confirming.add(chat.id)
    let confirmed: boolean
    try { confirmed = await confirm(chat) } finally { this.confirming.delete(chat.id) }
    if (confirmed !== true) throw new DomainError('cancelled', 'The terminal was left running.')
  }
  /** An approval names one owner: a replaced, exited or stopping terminal invalidates it. */
  private assertConfirmedOwner(ref: ChatRef, generation: string): void {
    const current = this.chatFor(ref)
    this.assertSurfaceAllowed(current, 'gui')
    if (this.deps.terminalOwner(current) !== generation) {
      throw new DomainError('busy', 'The terminal changed while the switch awaited confirmation; nothing was stopped.')
    }
  }
  /** Retires only the owner being replaced: the GUI process for the terminal, or the confirmed terminal generation. */
  private retireOwner(chat: ChatRecord, surface: 'gui' | 'terminal', generation: string | null): Promise<void> {
    if (surface === 'terminal') return this.stop(chat)
    return generation === null ? Promise.resolve() : this.deps.stopTerminal(chat, generation)
  }
  async setSurface(ref: ChatRef, surface: 'gui' | 'terminal', confirm?: ConfirmTerminalStop): Promise<AgentChatSnapshot> {
    const chat = this.chatFor(ref)
    this.assertSurfaceAllowed(chat, surface)
    if ((chat.surface ?? 'terminal') === surface) return this.snapshot(chat)
    const generation = this.terminalGeneration(chat, surface)
    if (generation !== null) {
      await this.confirmStop(chat, confirm)
      this.assertConfirmedOwner(ref, generation)
    }
    // Reserved synchronously after the final ownership check, through cleanup and persistence.
    this.switching.add(chat.id)
    try {
      await this.retireOwner(chat, surface, generation)
      if (this.closing || this.deleting.has(chat.id)) throw new Error('The chat is stopping.')
      // An earlier owner still fenced by a failed cleanup keeps the terminal live: the GUI must not take over yet.
      if (surface === 'gui' && this.deps.terminalLive(chat)) throw new DomainError('busy', 'An earlier terminal for this chat is still stopping.')
      this.deps.store.updateChat(this.chatFor(ref), { surface })
      this.deps.onChatChanged?.(ref)
      return this.snapshot(ref)
    } finally {
      this.switching.delete(chat.id)
    }
  }
  async stop(ref: ChatRef): Promise<void> {
    const id = this.chatFor(ref).id
    const entries = new Set([this.entries.get(id), this.startingEntries.get(id)])
    const stopping = [...entries].filter((entry): entry is Entry => entry !== undefined)
    await Promise.all(stopping.map(entry => this.stopEntry(entry)))
    await Promise.all(stopping.map(entry => entry.starting))
  }
  async deleteChat(ref: ChatRef, remove: () => Promise<void>): Promise<void> {
    const chat = this.deps.store.getChat(ref)
    if (chat === null) return remove()
    this.deleting.add(chat.id)
    try {
      await this.stop(chat)
      // A tool image still being kept lands before the chat's images are removed with it.
      await this.entries.get(chat.id)?.imageWork
      await remove(); this.entries.delete(chat.id); this.callsignStates.delete(chat.id)
    }
    finally { this.deleting.delete(chat.id) }
  }
  /** Stops the processes and starts of the chats `selects` picks, and waits for their close and revocation. */
  private async stopWhere(selects: (chat: ChatRecord) => boolean): Promise<void> {
    const stopping = [...new Set([...this.entries.values(), ...this.startingEntries.values()])].filter(entry => selects(entry.chat))
    await Promise.all(stopping.map(entry => this.stopEntry(entry)))
    await Promise.all(stopping.map(entry => entry.starting))
  }
  async releaseFolder(folder: string, forget: () => unknown, relatedFolders: readonly string[] = []): Promise<void> {
    const affected = new Set([folder, ...relatedFolders])
    for (const path of affected) this.releasing.add(path)
    try {
      await this.stopWhere(chat => chat.folder !== null && affected.has(chat.folder))
      await forget()
    } finally {
      for (const path of affected) this.releasing.delete(path)
    }
  }
  endAgent(id: AgentId): Promise<void> {
    return this.stopWhere(chat => chat.agent === id)
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.closing = true
    const entries = [...new Set([...this.entries.values(), ...this.startingEntries.values()])]
    this.disposing = boundedShutdown((async () => {
      await Promise.all(entries.map(entry => this.stopEntry(entry)))
      await Promise.all(entries.map(entry => entry.starting))
      await Promise.all(this.cleanup)
    })()).catch(error => {
      // A later explicit dispose may observe late cleanup; the failed caller remains rejected.
      this.disposing = undefined
      throw error
    })
    return this.disposing
  }
  isLive(ref: ChatRef): boolean {
    const id = this.chatFor(ref).id
    return this.switching.has(id) || this.startingEntries.has(id) || this.entries.get(id)?.process !== undefined
  }
  busy(): boolean { return this.startingEntries.size > 0 || [...this.entries.values()].some(entry => entry.status === 'busy') }
}

/** Main owns the process and its authority; attaching/detaching has no lifetime effect. */
export function createAgentChatSessions(deps: AgentChatSessionsDeps): AgentChatSessions {
  const manager = new SessionManager(deps)
  return { start: (ref, options) => manager.start(ref, options), snapshot: ref => manager.snapshot(ref),
    send: (ref, input) => manager.send(ref, input), stageImage: (ref, bytes) => manager.stageImage(ref, bytes),
    interrupt: ref => manager.interrupt(ref), answer: (ref, input) => manager.answer(ref, input),
    stop: ref => manager.stop(ref), deleteChat: (ref, remove) => manager.deleteChat(ref, remove), isLive: ref => manager.isLive(ref),
    releaseFolder: (folder, forget, related) => manager.releaseFolder(folder, forget, related), endAgent: id => manager.endAgent(id),
    setSurface: (ref, surface, confirm) => manager.setSurface(ref, surface, confirm),
    busy: () => manager.busy(), dispose: () => manager.dispose(), attention: folder => manager.attention(folder),
    ompRequest: (ref, type) => manager.ompRequest(ref, type) }
}
