/**
 * The chat's items grouped by turn, free of React. A turn starts at a `user_message` of the chat's own thread and
 * ends at the next one, or at the end of the transcript once the chat is idle. Once a turn has ended, its work (tool
 * calls, threads, approval records, intermediate agent text) folds into one `collapsed-work` entry; the turn's final
 * agent reply stays visible after it. Never folded: a prompt still waiting for an answer, an `error` and a
 * `turn_stopped`. A turn that ended any other way stays open, and so does the live one.
 */
import type { AgentChatSnapshot } from '../../../shared/agents/agentChat'
import type { ChatItem } from '../../../shared/agents/chat'

type UserMessage = Extract<ChatItem, { kind: 'user_message' }>

export type TurnEntry =
  | { kind: 'message'; item: UserMessage }
  | {
    kind: 'collapsed-work'
    /** The turn's `user_message` id: what its expanded state is kept by. */
    id: string
    startAt: string
    endAt: string
    /** The person stopped the turn (`turn_stopped`). */
    stopped: boolean
    /** The folded items, in transcript order. */
    items: ChatItem[]
  }
  | { kind: 'item'; item: ChatItem }

type WorkEntry = Extract<TurnEntry, { kind: 'collapsed-work' }>

const isTurnStart = (item: ChatItem): item is UserMessage => item.kind === 'user_message' && item.threadId === undefined

/** The approval requests no decision was stored for: prompts still waiting, which a fold must never hide. */
function waitingRequests(items: readonly ChatItem[]): Set<string> {
  const answered = new Set(items.flatMap((item) => (item.kind === 'approval_decision' ? [item.requestId] : [])))
  return new Set(items.flatMap((item) => (item.kind === 'approval_request' && !answered.has(item.requestId) ? [item.id] : [])))
}

function turnEntries(start: UserMessage, body: readonly ChatItem[], ended: boolean, waiting: ReadonlySet<string>): TurnEntry[] {
  const open: TurnEntry[] = [{ kind: 'message', item: start }, ...body.map((item): TurnEntry => ({ kind: 'item', item }))]
  // A waiting prompt inside a thread would be hidden with the call that spawned the thread: such a turn stays open.
  if (!ended || body.some((item) => item.threadId !== undefined && waiting.has(item.id))) return open
  const final = [...body].reverse().find((item) => item.kind === 'assistant_text' && item.threadId === undefined)
  const shown = (item: ChatItem): boolean =>
    item === final || (item.threadId === undefined && (item.kind === 'error' || item.kind === 'turn_stopped' || waiting.has(item.id)))
  const items = body.filter((item) => !shown(item))
  if (items.length === 0) return open
  const work: WorkEntry = {
    kind: 'collapsed-work', id: start.id, startAt: start.at, endAt: body[body.length - 1].at,
    stopped: body.some((item) => item.kind === 'turn_stopped' && item.threadId === undefined), items
  }
  return [open[0], work, ...body.filter(shown).map((item): TurnEntry => ({ kind: 'item', item }))]
}

/** The items as transcript entries, in order. Only `idle` ends the last turn; any other status leaves it open. */
export function turnGroups(items: readonly ChatItem[], status: AgentChatSnapshot['status'] | null): TurnEntry[] {
  const waiting = waitingRequests(items)
  const starts = items.flatMap((item, index) => (isTurnStart(item) ? [index] : []))
  const before = items.slice(0, starts[0] ?? items.length).map((item): TurnEntry => ({ kind: 'item', item }))
  return [
    ...before,
    ...starts.flatMap((start, turn) => {
      const last = turn === starts.length - 1
      const body = items.slice(start + 1, last ? items.length : starts[turn + 1])
      return turnEntries(items[start] as UserMessage, body, !last || status === 'idle', waiting)
    })
  ]
}

/** How long a turn's work took: `51s`, `28m 51s` or `1h 05m`; the second unit is zero-padded, as on a clock. */
export function formatWorkDuration(ms: number): string {
  const seconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1_000)) : 0
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** The disclosure's words: `Worked for 28m 51s`, or `Stopped after 3m 02s` for a turn the person stopped. */
export function workLabel(work: WorkEntry): string {
  const duration = formatWorkDuration(Date.parse(work.endAt) - Date.parse(work.startAt))
  return `${work.stopped ? 'Stopped after' : 'Worked for'} ${duration}`
}
