/**
 * Runs agent chats in the main process: one adapter (one agent process) per active chat.
 *
 * Lifecycle. A chat's process starts on its first message, or when the chat is opened if its
 * vendor needs it running (`startOnOpen`). It runs in the chat's folder with the chat's Dark
 * Mechanicus MCP server. Stop interrupts the running turn and keeps the process. A process with no
 * running turn and no waiting approval for `idleMs` is disposed; the next message starts a new one
 * that resumes the vendor session. `disposeAll` (app quit) disposes every process and refuses new
 * ones; each adapter's `dispose` kills its process tree.
 *
 * Approvals. A request is stored (and pushed) as a transcript item, then waits in main, not in
 * the renderer, until the person answers: closing the window or reopening the chat loses nothing.
 * The adapter is held until then. Allow for this chat remembers the request's category and tool
 * (every `command` through `Bash`, every `file_edit` through `Edit`, ...) for that chat until the
 * app quits, and answers matching requests itself, recording them as automatic. Stop, quitting
 * and failed storage cancel waiting requests: the decision is stored as `cancelled` and the
 * adapter is told `deny`. A request left without a decision by a crash is recorded as `cancelled`
 * the next time its chat is opened, since no process is left to answer.
 *
 * Signed-out agents. When an adapter reports `auth_required` (its CLI's login expired or was revoked
 * while the app ran), the item is stored, the agent kind is flagged signed out (see `signInFlags`), the
 * message of the turn that was cut short is remembered on the chat (`cutShortMessageId`), and, when the
 * chat orchestrates a run that is running, that run is paused with the reason `signed_out` through the
 * desktop's own session (`runs`). Until the person signs in again, a new turn in any chat with that agent
 * stores the message and an `auth_required` item and starts nothing. `retryTurn` sends the cut-short
 * message again, once, when the agent is not signed out; nothing is ever sent again on its own, and the
 * run is never resumed here: the person does that from the run bar.
 *
 * Streaming. Items are stored first and the stored (masked) item is pushed, in the order the
 * adapter emitted them. Assistant deltas are not stored; each text stream goes through a stream
 * masker so a claim token split across deltas never reaches the renderer, and whatever it holds
 * back is released when the turn ends (or dropped once the whole text arrives as an item).
 *
 * Activity. With `activity`, every chat's threads are bound to the runs and attempts they act on (see
 * `activityBindings`): a chat Start run launched as soon as it is created, each item once it is stored,
 * and the whole transcript again when the chat is opened (which binds chats stored before bindings
 * existed, and adds nothing twice). A binding that fails is reported, never thrown, so it cannot cost an
 * item. Deleting a chat forgets its bindings before the chat itself is removed.
 */
import { randomUUID } from 'node:crypto'
import { DomainError } from '../../core/errors'
import type {
  ApprovalDecision,
  ApprovalRequestItem,
  ChatAdapter,
  ChatAdapterEvent,
  ChatAdapterStartOptions,
  ChatItem,
  ChatRecord,
  McpServerSpec,
  ModelOption
} from '../../shared/agents/chat'
import { canSavePlans } from '../../shared/agents/chat'
import type { ChatOpenView, ChatPushEvent, ChatSummary, CreateChatRequest } from '../../shared/agents/chatApi'
import { AGENT_DEFINITIONS } from '../../shared/desktop/agentKinds'
import type { AgentAuthStatus, AgentKind, McpConfigView } from '../../shared/desktop/api'
import { SIGNED_OUT_PAUSE_REASON } from '../../shared/domain/status'
import type { RunView } from '../../shared/domain/views'
import { darkMechanicusServer } from '../desktop/mcpJson'
import type { ActivityBindings } from './activityBindings'
import type { ChatAdapterDefinition, ChatAdapterDefinitions } from './adapterRegistry'
import type { ChatRef, ChatStore } from './chatStore'
import { createStreamMasker, type StreamMasker } from './claimTokenMask'
import { createSignInFlags, type SignInFlags } from './signInFlags'

/** How long a process with nothing to do is kept. */
const DEFAULT_IDLE_MS = 10 * 60_000

interface SessionTimers {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** The desktop's run commands, for pausing the run of an orchestrator chat whose agent was signed out. */
export interface SignedOutRuns {
  /** The run as the desktop sees it, or null when there is none; only its state is read. */
  getRun(folder: string, runId: string): Promise<Pick<RunView, 'state'> | null>
  /** Pauses the run through the desktop's own session: only it may give the reason `signed_out`. */
  pauseRun(folder: string, input: { runId: string; reason: string }): Promise<unknown>
}

export interface SessionManagerDeps {
  store: ChatStore
  adapters: ChatAdapterDefinitions
  /** The connected executable for a kind (agent registry); null when the agent is not connected. */
  executablePath: (kind: AgentKind) => string | null
  /** The app's Dark Mechanicus launch command for a folder (`buildMcpConfig`). */
  mcpConfig: (folder: string) => Pick<McpConfigView, 'command' | 'args' | 'env'>
  /** Delivers an event to the renderer. */
  push: (event: ChatPushEvent) => void
  /** Lets a signed-out orchestrator chat pause its run; without it no run is touched. */
  runs?: SignedOutRuns
  /** Where chat threads are bound to the runs and attempts they act on; without it nothing is bound. */
  activity?: ActivityBindings
  /** Ids for the items the manager writes itself. */
  newId?: () => string
  now?: () => string
  idleMs?: number
  timers?: SessionTimers
  /** Told about failures nobody awaits (a refused adapter item, a failed dispose), so main can log them. */
  onError?: (error: unknown) => void
}

/** A request to create a chat, with the run it orchestrates when there is one. */
type NewChatRequest = CreateChatRequest & Pick<ChatRecord, 'runId'>

interface ApprovalAnswer {
  requestId: string
  decision: ApprovalDecision
}

export interface SessionManager {
  /** A folder's chats, each with the number of approval requests it is waiting on. */
  listChats(folder: string): ChatSummary[]
  /** `runId` links the chat to the run it orchestrates; only main sets it (the `chats:create` request cannot). */
  createChat(request: NewChatRequest): ChatRecord
  /** Changes the chat's title; a running agent keeps going, and its next session is named after the new title. */
  renameChat(ref: ChatRef, title: string): ChatRecord
  /** Ends the chat's agent, then removes its activity bindings, the chat and its transcript; throws `not_found` for an unknown chat. */
  deleteChat(ref: ChatRef): Promise<void>
  /** The transcript, waiting approvals and turn state; starts the process for start-on-open vendors. */
  openChat(ref: ChatRef): Promise<ChatOpenView>
  /** Stores the message and starts a turn; resolves with the stored message once the turn has begun. */
  send(ref: ChatRef, text: string): Promise<ChatItem>
  stop(ref: ChatRef): Promise<void>
  /**
   * Sends the message a sign-in cut short, once, and returns it. Refused (`conflict`) while the agent is
   * signed out or the chat is answering, and `not_found` when no turn is waiting to be retried.
   */
  retryTurn(ref: ChatRef): Promise<ChatItem>
  /**
   * The status the app shows for an agent, given what its CLI's own status command said: `signed_out`
   * while a chat has found the sign-in gone, until the person started a sign-in and the CLI says signed in
   * (which also tells the opened chats). Anything else is the CLI's answer as it was.
   */
  reconcileAuthStatus(kind: AgentKind, status: AgentAuthStatus): AgentAuthStatus
  /** The person started the CLI's sign-in for the agent (the Sign in button). */
  signInStarted(kind: AgentKind): void
  setModel(ref: ChatRef, model: string): Promise<ChatRecord>
  answerApproval(ref: ChatRef, answer: ApprovalAnswer): void
  listModels(kind: AgentKind): Promise<ModelOption[]>
  /** Chats with a live agent process (starting or started). */
  liveCount(): number
  /** Disposes every process and refuses to start more (app quit). */
  disposeAll(): Promise<void>
}

interface WaitingApproval {
  request: ApprovalRequestItem
  respond: (decision: ApprovalDecision) => void
}

interface TextStream {
  itemId: string
  masker: StreamMasker
  threadId: string | undefined
}

interface Session {
  chat: ChatRecord
  adapter: ChatAdapter
  ready: Promise<void>
  /** The running turn; null between turns. */
  turn: Promise<void> | null
  waiting: Map<string, WaitingApproval>
  streams: Map<string, TextStream>
  idle: unknown
  disposed: boolean
  /** The user message of the running turn: what a sign-in that cuts the turn short leaves for retry. */
  userMessageId: string | null
  /** The turn already reported its sign-in as gone; later reports in the same turn are dropped. */
  authReported: boolean
  /** Pausing the run of a signed-out orchestrator chat; the turn ends once it has finished. Never rejects. */
  pausing: Promise<void> | null
}

type AuthRequiredItem = Extract<ChatItem, { kind: 'auth_required' }>

interface Manager extends Required<Omit<SessionManagerDeps, 'runs' | 'activity'>> {
  runs: SignedOutRuns | undefined
  activity: ActivityBindings | undefined
  /** Which agents a chat found signed out. */
  flags: SignInFlags
  /** Chats opened or written to since the app started, with their agent: the ones to tell when a sign-in changes. */
  seen: Map<string, AgentKind>
  /** Live sessions by chat id. */
  sessions: Map<string, Session>
  /** Chat id -> approval scopes the person allowed for that chat. */
  allowances: Map<string, Set<string>>
  closing: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requireChat(manager: Manager, ref: ChatRef): ChatRecord {
  const chat = manager.store.getChat(ref)
  if (chat === null) {
    throw new DomainError('not_found', `Chat not found: ${ref.id}`)
  }
  return chat
}

/** Stores an item and pushes what was stored (masked). */
function record(manager: Manager, chat: ChatRef, item: ChatItem): ChatItem {
  const stored = manager.store.appendItem(chat, item)
  manager.push({ type: 'item', chatId: chat.id, item: stored })
  return stored
}

/** Binds a chat's threads to what they act on; a failure is reported, never thrown, so it cannot cost an item. */
function bindActivity(manager: Manager, bind: (activity: ActivityBindings) => unknown): void {
  const { activity } = manager
  if (activity === undefined) {
    return
  }
  try {
    bind(activity)
  } catch (error) {
    manager.onError(error)
  }
}

function stamp(manager: Manager): { id: string; at: string } {
  return { id: manager.newId(), at: manager.now() }
}

interface Decision {
  requestId: string
  decision: ApprovalDecision | 'cancelled'
  /** Answered by an earlier Allow for this chat. */
  automatic?: boolean
}

function recordDecision(manager: Manager, chat: ChatRef, { requestId, decision, automatic = false }: Decision): void {
  record(manager, chat, { ...stamp(manager), kind: 'approval_decision', requestId, decision, ...(automatic ? { automatic } : {}) })
}

// ---- Adapters and the Dark Mechanicus server ----

function adapterFor(manager: Manager, kind: AgentKind): { definition: ChatAdapterDefinition; executablePath: string } {
  const name = AGENT_DEFINITIONS[kind].displayName
  const definition = manager.adapters[kind]
  if (definition === undefined) {
    throw new DomainError('unsupported_capability', `${name} chats are not available in this version.`)
  }
  const executablePath = manager.executablePath(kind)
  if (executablePath === null) {
    throw new DomainError('not_found', `${name} is not connected. Connect it under Agents first.`)
  }
  return { definition, executablePath }
}

function savesPlans(chat: ChatRecord): boolean {
  return chat.allowSave && canSavePlans(chat.role)
}

/** The chat's server: its role, `--allow-save` when it may save, and the label "<Agent> · <title>". */
function chatServer(manager: Manager, chat: ChatRecord): McpServerSpec {
  return darkMechanicusServer(manager.mcpConfig(chat.folder), {
    role: chat.role,
    allowSave: savesPlans(chat),
    label: `${AGENT_DEFINITIONS[chat.agent].displayName} · ${chat.title}`
  })
}

function startOptions(manager: Manager, chat: ChatRecord): ChatAdapterStartOptions {
  return {
    chatId: chat.id,
    folder: chat.folder,
    model: chat.model,
    role: chat.role,
    allowSave: savesPlans(chat),
    sessionId: chat.sessionId,
    darkMechanicus: chatServer(manager, chat)
  }
}

// ---- Session lifecycle ----

function clearIdle(manager: Manager, session: Session): void {
  if (session.idle !== null) {
    manager.timers.clear(session.idle)
    session.idle = null
  }
}

/** Arms the idle timer when the session has nothing to do. */
function idleWhenQuiet(manager: Manager, session: Session): void {
  if (session.disposed || session.turn !== null || session.waiting.size > 0) {
    return
  }
  clearIdle(manager, session)
  session.idle = manager.timers.set(() => {
    void disposeSession(manager, session)
  }, manager.idleMs)
}

/** Records every waiting approval as cancelled and tells the adapter `deny`, so it is not left holding. */
function cancelWaiting(manager: Manager, session: Session): void {
  const waiting = [...session.waiting.entries()]
  session.waiting.clear()
  for (const [requestId, { respond }] of waiting) {
    try {
      recordDecision(manager, session.chat, { requestId, decision: 'cancelled' })
    } catch (error) {
      manager.onError(error)
    }
    respond('deny')
  }
}

async function disposeSession(manager: Manager, session: Session): Promise<void> {
  if (session.disposed) {
    return
  }
  session.disposed = true
  if (manager.sessions.get(session.chat.id) === session) {
    manager.sessions.delete(session.chat.id)
  }
  clearIdle(manager, session)
  cancelWaiting(manager, session)
  session.streams.clear()
  try {
    await session.adapter.dispose()
  } catch (error) {
    manager.onError(error)
  }
}

function createSession(manager: Manager, chat: ChatRecord): Session {
  if (manager.closing) {
    throw new DomainError('conflict', 'Dark Mechanicus is quitting, so no agent can start.')
  }
  const { definition, executablePath } = adapterFor(manager, chat.agent)
  // Everything that can throw happens before the session is registered, so a failure leaves no trace.
  const options = startOptions(manager, chat)
  const session: Session = {
    chat,
    adapter: definition.create(executablePath),
    ready: Promise.resolve(),
    turn: null,
    waiting: new Map(),
    streams: new Map(),
    idle: null,
    disposed: false,
    userMessageId: null,
    authReported: false,
    pausing: null
  }
  manager.sessions.set(chat.id, session)
  session.ready = Promise.resolve().then(() => session.adapter.start(options, (event) => onAdapterEvent(manager, session, event)))
  return session
}

/** The chat's live session, starting it (once, however many callers race) when there is none. */
async function ensureSession(manager: Manager, chat: ChatRecord): Promise<Session> {
  const existing = manager.sessions.get(chat.id)
  const session = existing ?? createSession(manager, chat)
  try {
    await session.ready
  } catch (error) {
    await disposeSession(manager, session)
    throw error
  }
  if (session.disposed) {
    throw new DomainError('conflict', 'The agent for this chat was shut down while it started.')
  }
  return session
}

// ---- Adapter events ----

function onItem(manager: Manager, session: Session, item: ChatItem): void {
  if (item.kind === 'assistant_text') {
    // The whole text is here; whatever the masker held back is superseded by the stored item.
    session.streams.delete(item.id)
  }
  if (item.kind === 'auth_required') {
    onAuthRequired(manager, session, item)
    return
  }
  record(manager, session.chat, item)
  // The item as the adapter gave it: a spawn prompt's claim token still names its attempt; only ids are kept.
  bindActivity(manager, (activity) => activity.observe(session.chat, item))
}

// ---- Signed-out agents ----

/** What a refused turn says when the CLI's own words were not kept. */
function signedOutWords(kind: AgentKind): string {
  return `${AGENT_DEFINITIONS[kind].displayName} is signed out. Sign in, then retry.`
}

/** Remembers which message the sign-in cut short, so `retryTurn` can send it again. */
function markCutShort(manager: Manager, chat: ChatRef, messageId: string | null): ChatRecord {
  return manager.store.updateChat(chat, { cutShortMessageId: messageId })
}

/** Tells every chat of the agent that was opened since the app started. */
function tellChats(manager: Manager, agent: AgentKind, state: 'signed_out' | 'signed_in'): void {
  for (const [chatId, kind] of manager.seen) {
    if (kind === agent) {
      manager.push({ type: 'agent_auth', chatId, agent, state })
    }
  }
}

/** Pauses the run of an orchestrator chat when it is running; any other run state (or no run) is left alone. */
async function pauseRunOf(manager: Manager, chat: ChatRecord): Promise<void> {
  const { runs } = manager
  if (runs === undefined || chat.runId === undefined) {
    return
  }
  try {
    const run = await runs.getRun(chat.folder, chat.runId)
    if (run?.state === 'running') {
      await runs.pauseRun(chat.folder, { runId: chat.runId, reason: SIGNED_OUT_PAUSE_REASON })
    }
  } catch (error) {
    manager.onError(error)
  }
}

/** The adapter's CLI said the sign-in is gone: store it once per turn, flag the agent, keep the message for retry, pause the run. */
function onAuthRequired(manager: Manager, session: Session, item: AuthRequiredItem): void {
  if (session.authReported) {
    return
  }
  session.authReported = true
  const stored = record(manager, session.chat, { ...item, agent: session.chat.agent }) as AuthRequiredItem
  manager.flags.markSignedOut(session.chat.agent, stored.message)
  if (session.userMessageId !== null) {
    session.chat = markCutShort(manager, session.chat, session.userMessageId)
  }
  tellChats(manager, session.chat.agent, 'signed_out')
  session.pausing = pauseRunOf(manager, session.chat)
}

/** A turn in a chat whose agent is signed out: the message is stored, and answered with the CLI's words, without starting the CLI. */
async function refuseTurn(manager: Manager, chat: ChatRecord, text: string): Promise<ChatItem> {
  const message = record(manager, chat, { ...stamp(manager), kind: 'user_message', text })
  const words = manager.flags.message(chat.agent) ?? signedOutWords(chat.agent)
  record(manager, chat, { ...stamp(manager), kind: 'auth_required', agent: chat.agent, message: words })
  markCutShort(manager, chat, message.id)
  await pauseRunOf(manager, chat)
  return message
}

function pushDelta(manager: Manager, session: Session, stream: TextStream, delta: string): void {
  if (delta === '') {
    return
  }
  const thread = stream.threadId === undefined ? {} : { threadId: stream.threadId }
  manager.push({ type: 'assistant_delta', chatId: session.chat.id, itemId: stream.itemId, delta, ...thread })
}

function onDelta(manager: Manager, session: Session, event: Extract<ChatAdapterEvent, { type: 'assistant_delta' }>): void {
  let stream = session.streams.get(event.itemId)
  if (stream === undefined) {
    stream = { itemId: event.itemId, masker: createStreamMasker(), threadId: event.threadId }
    session.streams.set(event.itemId, stream)
  }
  pushDelta(manager, session, stream, stream.masker.push(event.delta))
}

function flushStreams(manager: Manager, session: Session): void {
  for (const stream of session.streams.values()) {
    pushDelta(manager, session, stream, stream.masker.flush())
  }
  session.streams.clear()
}

/** What Allow for this chat covers: the request's category and tool. */
function scopeOf(request: ApprovalRequestItem): string {
  return `${request.category}\u0000${request.tool}`
}

function isAllowedForChat(manager: Manager, session: Session, request: ApprovalRequestItem): boolean {
  return manager.allowances.get(session.chat.id)?.has(scopeOf(request)) ?? false
}

function onApproval(manager: Manager, session: Session, request: ApprovalRequestItem, respond: WaitingApproval['respond']): void {
  let stored: ChatItem
  try {
    stored = record(manager, session.chat, request)
  } catch (error) {
    respond('deny')
    throw error
  }
  const asked = stored as ApprovalRequestItem
  if (isAllowedForChat(manager, session, asked)) {
    recordDecision(manager, session.chat, { requestId: asked.requestId, decision: 'allow_chat', automatic: true })
    respond('allow_chat')
    return
  }
  session.waiting.set(asked.requestId, { request: asked, respond })
  clearIdle(manager, session)
}

function handleEvent(manager: Manager, session: Session, event: ChatAdapterEvent): void {
  switch (event.type) {
    case 'item':
      onItem(manager, session, event.item)
      return
    case 'assistant_delta':
      onDelta(manager, session, event)
      return
    case 'approval_request':
      onApproval(manager, session, event.request, event.respond)
      return
    case 'session':
      session.chat = manager.store.updateChat(session.chat, { sessionId: event.sessionId })
  }
}

function onAdapterEvent(manager: Manager, session: Session, event: ChatAdapterEvent): void {
  if (session.disposed) {
    return
  }
  try {
    handleEvent(manager, session, event)
  } catch (error) {
    manager.onError(error)
  }
}

// ---- Turns ----

function endTurn(manager: Manager, session: Session, failure: unknown): void {
  session.turn = null
  session.userMessageId = null
  if (session.disposed) {
    return
  }
  flushStreams(manager, session)
  if (failure !== null) {
    record(manager, session.chat, { ...stamp(manager), kind: 'error', message: errorMessage(failure) })
  }
  manager.push({ type: 'turn', chatId: session.chat.id, running: false })
  idleWhenQuiet(manager, session)
}

async function playTurn(manager: Manager, session: Session, text: string): Promise<void> {
  let failure: unknown = null
  try {
    await session.adapter.send(text)
  } catch (error) {
    failure = error ?? new Error('The turn failed.')
  }
  await session.pausing
  session.pausing = null
  try {
    endTurn(manager, session, failure)
  } catch (error) {
    manager.onError(error)
  }
}

const STILL_ANSWERING = 'This chat is still answering. Stop it or wait for it to finish.'

function see(manager: Manager, chat: ChatRecord): void {
  manager.seen.set(chat.id, chat.agent)
}

/** Starts the turn for a message that is already in the transcript; the chat has no cut-short message to retry from here on. */
function startTurn(manager: Manager, session: Session, message: { id: string }, text: string): void {
  if (manager.store.getChat(session.chat)?.cutShortMessageId != null) {
    session.chat = markCutShort(manager, session.chat, null)
  }
  session.userMessageId = message.id
  session.authReported = false
  clearIdle(manager, session)
  manager.push({ type: 'turn', chatId: session.chat.id, running: true })
  session.turn = playTurn(manager, session, text)
}

async function send(manager: Manager, ref: ChatRef, text: string): Promise<ChatItem> {
  const chat = requireChat(manager, ref)
  see(manager, chat)
  if (manager.flags.message(chat.agent) !== null) {
    if (manager.sessions.get(chat.id)?.turn != null) {
      throw new DomainError('conflict', STILL_ANSWERING)
    }
    return refuseTurn(manager, chat, text)
  }
  const session = await ensureSession(manager, chat)
  if (session.turn !== null) {
    throw new DomainError('conflict', STILL_ANSWERING)
  }
  const message = record(manager, session.chat, { ...stamp(manager), kind: 'user_message', text })
  startTurn(manager, session, message, text)
  return message
}

/** The user message the chat's last sign-in cut short, from its transcript. */
function cutShortMessage(manager: Manager, chat: ChatRecord): Extract<ChatItem, { kind: 'user_message' }> {
  const id = chat.cutShortMessageId
  const items = id == null ? [] : (manager.store.readTranscript(chat)?.items ?? [])
  const found = items.find((item) => item.id === id)
  if (found?.kind !== 'user_message') {
    throw new DomainError('not_found', 'There is no cut-short message to send again in this chat.')
  }
  return found
}

async function retryTurn(manager: Manager, ref: ChatRef): Promise<ChatItem> {
  const chat = requireChat(manager, ref)
  if (manager.flags.message(chat.agent) !== null) {
    throw new DomainError('conflict', `${AGENT_DEFINITIONS[chat.agent].displayName} is still signed out. Sign in first.`)
  }
  const message = cutShortMessage(manager, chat)
  see(manager, chat)
  const session = await ensureSession(manager, chat)
  if (session.turn !== null) {
    throw new DomainError('conflict', STILL_ANSWERING)
  }
  // The message goes out once: a retry that raced this one while the process started has used it already.
  if (manager.store.getChat(chat)?.cutShortMessageId !== message.id) {
    throw new DomainError('conflict', 'That message was already sent again.')
  }
  startTurn(manager, session, message, message.text)
  return message
}

function reconcileAuthStatus(manager: Manager, kind: AgentKind, status: AgentAuthStatus): AgentAuthStatus {
  const reconciled = manager.flags.reconcile(kind, status)
  if (reconciled.cleared) {
    tellChats(manager, kind, 'signed_in')
  }
  return reconciled.status
}

/** Calls an adapter method so that a synchronous throw becomes a rejection. */
function invoke(action: () => Promise<void>): Promise<void> {
  try {
    return action()
  } catch (error) {
    return Promise.reject(error)
  }
}

async function stop(manager: Manager, ref: ChatRef): Promise<void> {
  const chat = requireChat(manager, ref)
  const session = manager.sessions.get(chat.id)
  if (session === undefined || session.turn === null) {
    return
  }
  // Interrupt first, so a request denied below cannot let the turn carry on.
  const stopping = invoke(() => session.adapter.stop())
  cancelWaiting(manager, session)
  await stopping
}

// ---- Approvals answered by the person ----

function allowancesOf(manager: Manager, chatId: string): Set<string> {
  let scopes = manager.allowances.get(chatId)
  if (scopes === undefined) {
    scopes = new Set()
    manager.allowances.set(chatId, scopes)
  }
  return scopes
}

function settleApproval(manager: Manager, session: Session, answer: Decision & { decision: ApprovalDecision }): void {
  const { requestId } = answer
  const waiting = session.waiting.get(requestId)
  if (waiting === undefined) {
    return
  }
  session.waiting.delete(requestId)
  recordDecision(manager, session.chat, answer)
  waiting.respond(answer.decision)
}

function answerApproval(manager: Manager, ref: ChatRef, answer: ApprovalAnswer): void {
  const chat = requireChat(manager, ref)
  const session = manager.sessions.get(chat.id)
  const waiting = session?.waiting.get(answer.requestId)
  if (session === undefined || waiting === undefined) {
    throw new DomainError('not_found', 'That approval request is no longer waiting for an answer.')
  }
  settleApproval(manager, session, { requestId: answer.requestId, decision: answer.decision })
  if (answer.decision === 'allow_chat') {
    const scope = scopeOf(waiting.request)
    allowancesOf(manager, chat.id).add(scope)
    for (const other of [...session.waiting.values()].filter((item) => scopeOf(item.request) === scope)) {
      settleApproval(manager, session, { requestId: other.request.requestId, decision: 'allow_chat', automatic: true })
    }
  }
  idleWhenQuiet(manager, session)
}

// ---- Opening chats ----

/** Stored requests that never got a decision and that no live process is waiting on any more. */
function cancelOrphans(manager: Manager, chat: ChatRecord, session: Session | undefined): void {
  const items = manager.store.readTranscript(chat)?.items ?? []
  const decided = new Set(items.flatMap((item) => (item.kind === 'approval_decision' ? [item.requestId] : [])))
  for (const item of items) {
    if (item.kind === 'approval_request' && !decided.has(item.requestId) && session?.waiting.has(item.requestId) !== true) {
      recordDecision(manager, chat, { requestId: item.requestId, decision: 'cancelled' })
      decided.add(item.requestId)
    }
  }
}

async function startOnOpen(manager: Manager, chat: ChatRecord): Promise<void> {
  if (manager.adapters[chat.agent]?.startOnOpen !== true || manager.flags.message(chat.agent) !== null) {
    return
  }
  try {
    idleWhenQuiet(manager, await ensureSession(manager, chat))
  } catch (error) {
    // A chat whose agent cannot start still opens; its first message reports why.
    if (!(error instanceof DomainError)) {
      manager.onError(error)
    }
  }
}

async function openChat(manager: Manager, ref: ChatRef): Promise<ChatOpenView> {
  const chat = requireChat(manager, ref)
  see(manager, chat)
  const live = manager.sessions.get(chat.id)
  cancelOrphans(manager, chat, live)
  if (live === undefined) {
    await startOnOpen(manager, chat)
  }
  const session = manager.sessions.get(chat.id)
  const transcript = manager.store.readTranscript(chat)
  bindActivity(manager, (activity) => activity.observeChat(transcript?.chat ?? chat, transcript?.items ?? []))
  return {
    chat: transcript?.chat ?? chat,
    items: transcript?.items ?? [],
    pending: session === undefined ? [] : [...session.waiting.values()].map((waiting) => waiting.request),
    running: session?.turn != null
  }
}

// ---- The rest of the surface ----

async function setModel(manager: Manager, ref: ChatRef, model: string): Promise<ChatRecord> {
  const chat = requireChat(manager, ref)
  if (chat.model === model) {
    return chat
  }
  const session = manager.sessions.get(chat.id)
  if (session !== undefined) {
    await session.ready
    await session.adapter.setModel(model)
  }
  const updated = manager.store.updateChat(chat, { model })
  record(manager, chat, { ...stamp(manager), kind: 'model_change', from: chat.model, to: model })
  return updated
}

function listChats(manager: Manager, folder: string): ChatSummary[] {
  return manager.store.listChats(folder).map((chat) => ({ ...chat, pending: manager.sessions.get(chat.id)?.waiting.size ?? 0 }))
}

function createChat(manager: Manager, request: NewChatRequest): ChatRecord {
  const chat = manager.store.createChat({
    folder: request.folder,
    agent: request.agent,
    role: request.role,
    model: request.model ?? null,
    allowSave: request.allowSave ?? true,
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.runId === undefined ? {} : { runId: request.runId })
  })
  bindActivity(manager, (activity) => activity.observeChat(chat, []))
  return chat
}

function renameChat(manager: Manager, ref: ChatRef, title: string): ChatRecord {
  return manager.store.updateChat(requireChat(manager, ref), { title })
}

/**
 * Disposes the agent before the store forgets the chat, so what it wrote while stopping still has a chat to go to.
 * Its activity bindings go first: a chat whose removal failed is bound again when it is opened.
 */
async function deleteChat(manager: Manager, ref: ChatRef): Promise<void> {
  const chat = requireChat(manager, ref)
  const session = manager.sessions.get(chat.id)
  if (session !== undefined) {
    await disposeSession(manager, session)
  }
  manager.allowances.delete(chat.id)
  manager.seen.delete(chat.id)
  manager.activity?.forgetChat(chat)
  manager.store.deleteChat(chat)
}

async function disposeAll(manager: Manager): Promise<void> {
  manager.closing = true
  await Promise.all([...manager.sessions.values()].map((session) => disposeSession(manager, session)))
}

const nodeTimers: SessionTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const manager: Manager = {
    newId: () => `item_${randomUUID()}`,
    now: () => new Date().toISOString(),
    idleMs: DEFAULT_IDLE_MS,
    timers: nodeTimers,
    onError: () => {},
    ...deps,
    runs: deps.runs,
    activity: deps.activity,
    flags: createSignInFlags(),
    seen: new Map(),
    sessions: new Map(),
    allowances: new Map(),
    closing: false
  }
  return {
    listChats: (folder) => listChats(manager, folder),
    createChat: (request) => createChat(manager, request),
    renameChat: (ref, title) => renameChat(manager, ref, title),
    deleteChat: (ref) => deleteChat(manager, ref),
    openChat: (ref) => openChat(manager, ref),
    send: (ref, text) => send(manager, ref, text),
    stop: (ref) => stop(manager, ref),
    retryTurn: (ref) => retryTurn(manager, ref),
    reconcileAuthStatus: (kind, status) => reconcileAuthStatus(manager, kind, status),
    signInStarted: (kind) => {
      manager.flags.signInStarted(kind)
    },
    setModel: (ref, model) => setModel(manager, ref, model),
    answerApproval: (ref, answer) => {
      answerApproval(manager, ref, answer)
    },
    listModels: async (kind) => {
      const { definition, executablePath } = adapterFor(manager, kind)
      return definition.listModels(executablePath)
    },
    liveCount: () => manager.sessions.size,
    disposeAll: () => disposeAll(manager)
  }
}
