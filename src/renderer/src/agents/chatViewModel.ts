/**
 * The chat view's model, free of React: what the transcript holds as it opens and streams, and the
 * words the transcript rows use. The transcript is a list of stored items plus the assistant texts
 * that are still being written; both are updated without touching the entries around them, so a
 * row of the list renders again only when its own entry changed.
 *
 * Only the chat's own thread is shown. Items and deltas of a nested thread (`threadId` set) belong
 * to a subagent view that does not exist yet, and no adapter produces them today.
 */
import type { ChatItem, ModelOption } from '../../../shared/agents/chat'
import type { ChatOpenView, ChatPushEvent } from '../../../shared/agents/chatApi'
import type { AgentAuthState } from '../../../shared/desktop/api'
import type { PillState } from '../components/StatePill'

type ToolCallItem = Extract<ChatItem, { kind: 'tool_call' }>
type ToolInput = ToolCallItem['input']
type ResetItem = Extract<ChatItem, { kind: 'context_reset' }>
type DecisionItem = Extract<ChatItem, { kind: 'approval_decision' }>

/** An assistant text that is still being written: the deltas so far. The stored item replaces it, by the same id. */
interface StreamingText {
  kind: 'streaming_text'
  id: string
  text: string
}

export type TranscriptEntry = ChatItem | StreamingText

/** The last place `id` is in, or -1: what is being updated is nearly always at the end. */
function lastIndexOfId(entries: readonly TranscriptEntry[], id: string): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.id === id) {
      return index
    }
  }
  return -1
}

function replaceAt(entries: readonly TranscriptEntry[], index: number, entry: TranscriptEntry): TranscriptEntry[] {
  const next = entries.slice()
  next[index] = entry
  return next
}

/** A stored item: appended, or replacing the entry of the same id in its place (a call finishing, a text becoming whole). */
export function applyItem(entries: readonly TranscriptEntry[], item: ChatItem): TranscriptEntry[] {
  const index = lastIndexOfId(entries, item.id)
  return index === -1 ? [...entries, item] : replaceAt(entries, index, item)
}

/** More of an assistant text: starts its streaming entry where it begins, then grows it. */
export function applyDelta(entries: readonly TranscriptEntry[], itemId: string, delta: string): TranscriptEntry[] {
  const index = lastIndexOfId(entries, itemId)
  if (index === -1) {
    return [...entries, { kind: 'streaming_text', id: itemId, text: delta }]
  }
  const existing = entries[index]
  if (existing?.kind !== 'streaming_text') {
    // The whole text is already stored: a delta that arrives late adds nothing.
    return entries as TranscriptEntry[]
  }
  return replaceAt(entries, index, { ...existing, text: existing.text + delta })
}

/**
 * What the chat knows about its agent's sign-in. `checking`: the stored transcript says the sign-in
 * was lost once, and the app is asking whether it still is; `signed_in` also stands for "nothing says it
 * is gone".
 */
export interface ChatAuth {
  agent: 'checking' | 'signed_out' | 'signed_in'
  /** A turn was cut short by the sign-in and has not been sent again, or replaced by a newer message. */
  cutShort: boolean
  /** The cut-short turn was sent again from the sign-in card. */
  retried: boolean
}

const NO_AUTH_NEWS: ChatAuth = { agent: 'signed_in', cutShort: false, retried: false }

/** How far an opened chat is: loading its transcript, showing it, or unable to. */
export interface SessionState {
  chatId: string
  phase: 'loading' | 'ready' | 'failed'
  entries: TranscriptEntry[]
  /** A turn is running in the main process. */
  running: boolean
  auth: ChatAuth
  /** What was pushed while the transcript was still being fetched; replayed on top of it. */
  queued: ChatPushEvent[]
  error: string | null
}

export type SessionAction =
  | { type: 'opened'; view: ChatOpenView }
  | { type: 'failed'; message: string }
  /** Starts over: the transcript is fetched again after a failed opening. */
  | { type: 'reopen' }
  | { type: 'push'; event: ChatPushEvent }
  /** The message the main process stored for a send, so it shows even before its push arrives. */
  | { type: 'sent'; item: ChatItem }
  /** What the agent's own status said when the chat asked whether its sign-in is still gone. */
  | { type: 'agent_checked'; state: AgentAuthState }
  /** The message a sign-in cut short was sent again. */
  | { type: 'retried' }

export function openSession(chatId: string): SessionState {
  return { chatId, phase: 'loading', entries: [], running: false, auth: NO_AUTH_NEWS, queued: [], error: null }
}

/** A stored item of the chat's own thread: shown, and an `auth_required` one also means the agent is signed out with a turn to retry. */
function applyOwnItem(state: SessionState, item: ChatItem): SessionState {
  const auth: ChatAuth = item.kind === 'auth_required' ? { agent: 'signed_out', cutShort: true, retried: false } : state.auth
  return { ...state, entries: applyItem(state.entries, item), auth }
}

/** A turn starting leaves nothing to retry: the main process forgets the cut-short message when one starts. */
function applyTurn(state: SessionState, running: boolean): SessionState {
  return { ...state, running, auth: running ? { ...state.auth, cutShort: false } : state.auth }
}

function applyEvent(state: SessionState, event: ChatPushEvent): SessionState {
  switch (event.type) {
    case 'item':
      return event.item.threadId === undefined ? applyOwnItem(state, event.item) : state
    case 'assistant_delta':
      return event.threadId === undefined ? { ...state, entries: applyDelta(state.entries, event.itemId, event.delta) } : state
    case 'turn':
      return applyTurn(state, event.running)
    case 'agent_auth':
      return { ...state, auth: { ...state.auth, agent: event.state, retried: event.state === 'signed_out' ? false : state.auth.retried } }
  }
}

/** A chat whose transcript says its sign-in was lost has to ask whether it still is; the record says whether a turn was cut short. */
function authOf(view: ChatOpenView): ChatAuth {
  const lost = view.items.some((item) => item.kind === 'auth_required' && item.threadId === undefined)
  return { agent: lost ? 'checking' : 'signed_in', cutShort: view.chat.cutShortMessageId != null, retried: false }
}

function opened(state: SessionState, view: ChatOpenView): SessionState {
  const base: SessionState = { ...state, phase: 'ready', entries: view.items.filter((item) => item.threadId === undefined), running: view.running, auth: authOf(view), queued: [], error: null }
  return state.queued.reduce(applyEvent, base)
}

/** The answer of the check, taken only while the chat is still asking: whatever was pushed meanwhile is newer. */
function checked(state: SessionState, answer: AgentAuthState): SessionState {
  if (state.auth.agent !== 'checking') {
    return state
  }
  return { ...state, auth: { ...state.auth, agent: answer === 'signed_out' ? 'signed_out' : 'signed_in' } }
}

export function reduceSession(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'opened':
      return opened(state, action.view)
    case 'failed':
      return { ...state, phase: 'failed', queued: [], error: action.message }
    case 'reopen':
      return openSession(state.chatId)
    case 'sent':
      return { ...state, entries: applyItem(state.entries, action.item) }
    case 'agent_checked':
      return checked(state, action.state)
    case 'retried':
      return { ...state, auth: { ...state.auth, cutShort: false, retried: true } }
    case 'push':
      return action.event.chatId === state.chatId ? pushed(state, action.event) : state
  }
}

/** A push for this chat: replayed after the opening while it is fetched, applied once it is shown, dropped when it failed. */
function pushed(state: SessionState, event: ChatPushEvent): SessionState {
  switch (state.phase) {
    case 'loading':
      return { ...state, queued: [...state.queued, event] }
    case 'ready':
      return applyEvent(state, event)
    case 'failed':
      return state
  }
}

// ---- Sign-in cards ----

/**
 * What the latest `auth_required` card of a chat offers: Sign in while the agent is signed out, a wait while
 * it is being checked, Retry once it is signed in and a turn was cut short, a note that it was retried; `past`
 * is a card that is only a record (the earlier ones, and one whose turn was replaced by a newer message).
 */
export type SignInCardState = 'signed_out' | 'checking' | 'retry' | 'retried' | 'past'

export function signInCardState(auth: ChatAuth): SignInCardState {
  if (auth.agent !== 'signed_in') {
    return auth.agent
  }
  if (auth.retried) {
    return 'retried'
  }
  return auth.cutShort ? 'retry' : 'past'
}

// ---- Tool calls ----

/** The inputs that say what a call does, most telling first. */
const SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'files'] as const

const MAX_SUMMARY = 160

function clip(text: string): string {
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** A scalar or a list of scalars as one text; '' for anything else. */
function plain(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value) && value.every((part) => typeof part === 'string' || typeof part === 'number')) {
    return value.join(', ')
  }
  return ''
}

/** One line for a collapsed call: the input that says what it does, else the first text, else the input as JSON. */
export function callSummary(input: ToolInput): string {
  const named = SUMMARY_KEYS.map((key) => oneLine(plain(input[key]))).find((text) => text !== '')
  if (named !== undefined) {
    return clip(named)
  }
  const first = Object.values(input).find((value) => typeof value === 'string' && oneLine(value) !== '')
  if (typeof first === 'string') {
    return clip(oneLine(first))
  }
  return Object.keys(input).length === 0 ? '' : clip(JSON.stringify(input))
}

/** The input of a call, field by field, for the expanded row: strings as they are, anything else as JSON. */
export function inputFields(input: ToolInput): { key: string; text: string }[] {
  return Object.entries(input).map(([key, value]) => ({ key, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }))
}

/** A call's status in words, with the state color it shares with the rest of the app. */
export function callStatus(status: ToolCallItem['status']): { state: PillState; label: string } {
  switch (status) {
    case 'running':
      return { state: 'running', label: 'Running' }
    case 'completed':
      return { state: 'accepted', label: 'Done' }
    case 'failed':
      return { state: 'failed', label: 'Failed' }
    case 'denied':
      return { state: 'blocked', label: 'Denied' }
  }
}

/** What a call returned, or why there is nothing to show. */
export function resultText(call: Pick<ToolCallItem, 'status' | 'resultSummary'>): string {
  if (call.resultSummary !== null && call.resultSummary !== '') {
    return call.resultSummary
  }
  return call.status === 'running' ? 'Waiting for the result…' : 'No result was reported.'
}

// ---- Notices ----

export function modelLabels(models: readonly ModelOption[]): ReadonlyMap<string, string> {
  return new Map(models.map((model) => [model.id, model.label]))
}

/** A model switch, with the models' labels where they are known; a switch always applies from the next turn. */
export function modelChangeText(from: string | null, to: string, labels: ReadonlyMap<string, string>): string {
  const name = (id: string): string => labels.get(id) ?? id
  const head = from === null ? `Model set to ${name(to)}.` : `Model changed from ${name(from)} to ${name(to)}.`
  return `${head} It takes effect from the next turn.`
}

const RESET_TEXTS: Readonly<Record<ResetItem['reason'], string>> = {
  compact: 'The earlier conversation was compacted.',
  clear: 'The context was cleared.',
  model_change: 'The context was reset for the new model.',
  session_lost: 'The earlier session could not be resumed, so the chat continues in a new one.'
}

/** A context reset: the agent's own message when it gave one, else the reason in words. */
export function resetText(reason: ResetItem['reason'], message: string | undefined): string {
  return message !== undefined && message !== '' ? message : RESET_TEXTS[reason]
}

const DECISION_WORDS: Readonly<Record<Exclude<DecisionItem['decision'], 'cancelled'>, string>> = {
  allow_once: 'allowed once',
  allow_chat: 'allowed for this chat',
  deny: 'denied'
}

/** A neutral line for a stored approval decision whose request is not in the transcript (the card shows every other one). */
export function decisionText(item: DecisionItem): string {
  if (item.decision === 'cancelled') {
    return 'Approval cancelled: no answer reached the agent.'
  }
  const how = item.automatic === true ? 'Approval answered automatically' : 'Approval answered'
  return `${how}: ${DECISION_WORDS[item.decision]}.`
}
