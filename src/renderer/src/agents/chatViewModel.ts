/**
 * The model of a transcript a chat stored before chats became terminals, free of React: its entries, and the
 * words the transcript rows use. The list holds every thread's items, in the order they were stored: the chat's
 * own, and the items of nested threads (`threadId` set). `threadModel` arranges them into blocks under the calls
 * that spawned them. A later item with the same id replaces the earlier one in its place, like a tool call that
 * finished or a thread whose state changed.
 */
import type { ChatItem, ErrorProblem } from '../../../shared/agents/chat'
import type { PillState } from '../components/StatePill'

type ToolCallItem = Extract<ChatItem, { kind: 'tool_call' }>
type ToolInput = ToolCallItem['input']
type ResetItem = Extract<ChatItem, { kind: 'context_reset' }>
type DecisionItem = Extract<ChatItem, { kind: 'approval_decision' }>

export type TranscriptEntry = ChatItem

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

/** A stored item: appended, or replacing the entry of the same id in its place (a call finishing, a thread ending). */
export function applyItem(entries: readonly TranscriptEntry[], item: ChatItem): TranscriptEntry[] {
  const index = lastIndexOfId(entries, item.id)
  return index === -1 ? [...entries, item] : replaceAt(entries, index, item)
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
    case 'cancelled':
      return { state: 'canceled', label: 'Cancelled' }
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

/** The notice a stopped turn leaves after the message it was answering. */
export const STOPPED_TEXT = 'You stopped this turn before the agent finished.'

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

interface ProblemNotice {
  title: string
  /** What the person can do about it; always says that signing in again will not. */
  advice: string
}

const PROBLEM_NOTICES: Readonly<Record<ErrorProblem, ProblemNotice>> = {
  organization_not_allowed: {
    title: 'Organization not allowed',
    advice: 'The organization behind this account does not allow this agent. Ask its administrator, or use another account. Signing in again will not change this.'
  },
  account_on_hold: {
    title: 'Account on hold',
    advice: 'The account is on hold. Sort it out with the agent’s provider. Signing in again will not change this.'
  },
  verification_required: {
    title: 'Verification required',
    advice: 'The account has to be verified with the agent’s provider before it can be used. Signing in again will not change this.'
  }
}

/** What a problem with the account is called, and what to do about it: the notice that stands in for a plain error. */
export function problemNotice(problem: ErrorProblem): ProblemNotice {
  return PROBLEM_NOTICES[problem]
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
