/**
 * What a chat thread shows in the places that follow Dark Mechanicus work (an attempt's Activity tab,
 * the orchestrator feed), free of React. A thread of an open chat (the chat's own, or a subagent's) becomes
 * rows: what was said, what was run, what waits for an answer, and the subagents it started. Rows
 * carry the words to show; nothing is rendered as markup here. Items are already masked when stored, and a
 * Dark Mechanicus call is named by what it did, never by its input.
 *
 * Which thread of which chat belongs to an attempt or a run is the main process's binding
 * (`chats:boundThreads`); `chooseBoundThread` picks the one to follow. `mergeByTime` puts the rows among
 * the records the places already list, in time order.
 */
import type { ApprovalRequestItem, ChatItem } from '../../../shared/agents/chat'
import type { BoundThread } from '../../../shared/agents/chatApi'
import type { Tone } from '../graph/ticketStates'
import { actionMarker, markerText } from './actionMarkers'
import { transcriptRows } from './approvalModel'
import { callStatus, callSummary, type TranscriptEntry } from './chatViewModel'
import { threadStateView } from './threadModel'

type ToolCallItem = Extract<ChatItem, { kind: 'tool_call' }>
type ThreadItem = Extract<ChatItem, { kind: 'thread' }>
type DecisionItem = Extract<ChatItem, { kind: 'approval_decision' }>

interface RowBase {
  id: string
  /** When it was stored (ISO 8601); null for a text that is still being written. */
  at: string | null
  /** The state color of the row's dot. */
  tone: Tone
}

export type StreamRow =
  | (RowBase & { kind: 'message'; who: 'You' | 'Assistant'; text: string; streaming: boolean })
  | (RowBase & { kind: 'tool'; title: string; summary: string; status: ReturnType<typeof callStatus> })
  | (RowBase & { kind: 'approval'; request: ApprovalRequestItem; answer: DecisionItem | null })
  | (RowBase & { kind: 'thread'; label: string; state: ReturnType<typeof threadStateView> })
  | (RowBase & { kind: 'error'; message: string })

type Body = { [K in StreamRow['kind']]: Omit<Extract<StreamRow, { kind: K }>, keyof RowBase> & { tone: Tone } }[StreamRow['kind']]

const TOOL_TONES: Readonly<Record<ToolCallItem['status'], Tone>> = { running: 'running', completed: 'neutral', failed: 'failed', denied: 'blocked' }
const THREAD_TONES: Readonly<Record<ThreadItem['state'], Tone>> = { running: 'running', done: 'accepted', failed: 'failed' }

/** A Dark Mechanicus call reads as "claimed DM-12" (its words, not its input); any other as its tool and the input that says what it does. */
function toolBody(call: ToolCallItem): Body {
  const marker = actionMarker(call)
  const tone = TOOL_TONES[call.status]
  const status = callStatus(call.status)
  if (marker !== null) {
    return { kind: 'tool', tone, title: markerText(marker, marker.target.ticketKey), summary: '', status }
  }
  return { kind: 'tool', tone, title: call.name, summary: callSummary(call.input), status }
}

function approvalBody(request: ApprovalRequestItem, answer: DecisionItem | null): Body {
  return { kind: 'approval', tone: answer === null ? 'attention' : 'neutral', request, answer }
}

/** The body a stored or streaming entry has as a row; null for what is not part of the conversation. */
function bodyOf(entry: TranscriptEntry, answer: DecisionItem | null): Body | null {
  switch (entry.kind) {
    case 'user_message':
      return { kind: 'message', tone: 'neutral', who: 'You', text: entry.text, streaming: false }
    case 'assistant_text':
      return { kind: 'message', tone: 'neutral', who: 'Assistant', text: entry.text, streaming: false }
    case 'streaming_text':
      return { kind: 'message', tone: 'neutral', who: 'Assistant', text: entry.text, streaming: true }
    case 'tool_call':
      return toolBody(entry)
    case 'approval_request':
      return approvalBody(entry, answer)
    case 'thread':
      return { kind: 'thread', tone: THREAD_TONES[entry.state], label: entry.label, state: threadStateView(entry.state) }
    case 'error':
      return { kind: 'error', tone: 'failed', message: entry.message }
    default:
      return null
  }
}

/** Each thread's parent: the thread the `thread` item that started it was stored in (undefined: the chat's own). */
function parentsOf(entries: readonly TranscriptEntry[]): ReadonlyMap<string, string | undefined> {
  return new Map(entries.flatMap((entry): [string, string | undefined][] => (entry.kind === 'thread' ? [[entry.id, entry.threadId]] : [])))
}

/** Whether `threadId` is `scope` itself or any thread below it, by following the threads that started it upward. */
function inside(parents: ReadonlyMap<string, string | undefined>, scope: string | undefined, threadId: string | undefined): boolean {
  const seen = new Set<string>()
  let current = threadId
  while (!seen.has(current ?? '')) {
    if (current === scope) {
      return true
    }
    if (current === undefined) {
      return false
    }
    seen.add(current)
    current = parents.get(current)
  }
  return false
}

function rowOf(entry: TranscriptEntry, answer: DecisionItem | null): StreamRow | null {
  const body = bodyOf(entry, answer)
  return body === null ? null : ({ id: entry.id, at: 'at' in entry ? entry.at : null, ...body } as StreamRow)
}

/**
 * The rows of one thread of a chat (`threadId` null: the chat's own), in the order stored: its own messages,
 * calls, approvals, errors and the subagent threads it started (one row each, with the label and state).
 * What happens inside those subagents is not shown, except a request that still waits for an answer anywhere
 * below: it is the one thing a person must not miss. A thread the transcript does not have yields no rows.
 */
export function streamRows(entries: readonly TranscriptEntry[], threadId: string | null): StreamRow[] {
  const scope = threadId ?? undefined
  const parents = parentsOf(entries)
  return transcriptRows(entries).flatMap(({ entry, answer }): StreamRow[] => {
    const own = entry.threadId === scope
    const waitingBelow = entry.kind === 'approval_request' && answer === null && inside(parents, scope, entry.threadId)
    const row = own || waitingBelow ? rowOf(entry, answer) : null
    return row === null ? [] : [row]
  })
}

/** The time a row sorts by; a text still being written (or a time that cannot be read) is the newest. */
function timeOf(at: string | null): number {
  const time = at === null ? Number.NaN : Date.parse(at)
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time
}

type Merged<R, S> = { source: 'record'; item: R } | { source: 'chat'; row: S }

/** Whether the record goes before the chat row: it is older (oldest first) or newer (newest first), and a tie goes to the record. */
function recordFirst(record: number, row: number, order: 'oldest_first' | 'newest_first'): boolean {
  return order === 'oldest_first' ? record <= row : record >= row
}

/**
 * The chat rows among the records, in time order. Both lists must already be in the requested order; each
 * keeps its own order, and the records come first when both happened at the same time. Rows still being
 * written, which have no time yet, count as the newest.
 */
export function mergeByTime<R, S extends { at: string | null }>(
  records: readonly R[],
  recordAt: (item: R) => string,
  rows: readonly S[],
  order: 'oldest_first' | 'newest_first'
): Merged<R, S>[] {
  const merged: Merged<R, S>[] = []
  let next = 0
  for (const row of rows) {
    const rowTime = timeOf(row.at)
    for (let record = records[next]; record !== undefined && recordFirst(timeOf(recordAt(record)), rowTime, order); record = records[next]) {
      merged.push({ source: 'record', item: record })
      next += 1
    }
    merged.push({ source: 'chat', row })
  }
  return [...merged, ...records.slice(next).map((item): Merged<R, S> => ({ source: 'record', item }))]
}

/**
 * The thread to follow among an attempt's or a run's bound threads, or null when none has the role: the
 * `worker` thread of an attempt (the latest bound, since an attempt that was handed to another thread moved
 * on), or the main thread of the chat that is the run's `orchestrator` (the latest, after a takeover).
 */
export function chooseBoundThread(threads: readonly BoundThread[], role: BoundThread['role']): BoundThread | null {
  const fits = threads.filter((thread) => thread.role === role && (role === 'worker' || thread.threadId === null))
  return fits[fits.length - 1] ?? null
}
