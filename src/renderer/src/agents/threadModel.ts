/**
 * The transcript as a tree, free of React. The chat's entries are a flat list in the order they were
 * stored; the work of a subagent is a thread (`thread` item) whose entries carry its id as `threadId`.
 * Here each thread becomes a block under the call that spawned it (`parentItemId`), holding its own rows,
 * and a thread started by a subagent nests inside that subagent's block. Everything stays in the order
 * it was stored.
 *
 * Two cases the adapters should not produce are still shown rather than lost, because a request waiting
 * for the person may be inside: a thread whose spawning call is not in its own thread's rows is shown
 * where the thread item was stored, and entries that name a thread that has no thread item are shown as
 * a block of their own, labelled by the request's `threadLabel` when there is one.
 */
import type { ChatItem } from '../../../shared/agents/chat'
import type { PillState } from '../components/StatePill'
import { transcriptRows, type TranscriptRowModel } from './approvalModel'
import type { TranscriptEntry } from './chatViewModel'

type ThreadItem = Extract<ChatItem, { kind: 'thread' }>

/** A row of the transcript with the thread blocks that hang under it. */
export interface TreeRow extends TranscriptRowModel {
  threads: ThreadNode[]
}

export interface ThreadNode {
  item: ThreadItem
  /** The thread's own rows, oldest first. */
  rows: TreeRow[]
}

type Scopes = ReadonlyMap<string | undefined, readonly TranscriptRowModel[]>

/** What a row with no thread under it carries: one array for all of them, so the rows that did not change stay equal. */
const NO_THREADS: ThreadNode[] = []

/** The label a thread nobody named gets: the one its approval request carried, else a plain one. */
function lostLabel(entry: TranscriptEntry): string {
  return entry.kind === 'approval_request' && entry.threadLabel !== undefined ? entry.threadLabel : 'Subagent'
}

/** A thread item for entries whose own was never stored, placed before the first of them. */
function lostThread(threadId: string, first: TranscriptEntry): ThreadItem {
  return { id: threadId, at: 'at' in first ? first.at : '', kind: 'thread', parentItemId: '', label: lostLabel(first), state: 'running' }
}

function withLostThreads(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const known = new Set(entries.flatMap((entry) => (entry.kind === 'thread' ? [entry.id] : [])))
  const out: TranscriptEntry[] = []
  for (const entry of entries) {
    const threadId = entry.threadId
    if (threadId !== undefined && !known.has(threadId)) {
      known.add(threadId)
      out.push(lostThread(threadId, entry))
    }
    out.push(entry)
  }
  return out
}

function groupByThread(rows: readonly TranscriptRowModel[]): Scopes {
  const scopes = new Map<string | undefined, TranscriptRowModel[]>()
  for (const row of rows) {
    const key = row.entry.threadId
    scopes.set(key, [...(scopes.get(key) ?? []), row])
  }
  return scopes
}

function nodeOf(scopes: Scopes, item: ThreadItem): ThreadNode {
  return { item, rows: rowsOf(scopes, item.id) }
}

/** The thread items among `rows`, by the call each names as its spawner. */
function threadsByParent(rows: readonly TranscriptRowModel[]): Map<string, ThreadItem[]> {
  const byParent = new Map<string, ThreadItem[]>()
  for (const { entry } of rows) {
    if (entry.kind === 'thread') {
      byParent.set(entry.parentItemId, [...(byParent.get(entry.parentItemId) ?? []), entry])
    }
  }
  return byParent
}

/** The rows of one thread (`undefined`: the chat's own): its entries, with each thread under its spawning call. */
function rowsOf(scopes: Scopes, scope: string | undefined): TreeRow[] {
  const rows = scopes.get(scope) ?? []
  const spawners = new Set(rows.flatMap((row) => (row.entry.kind === 'thread' ? [] : [row.entry.id])))
  const byParent = threadsByParent(rows)
  return rows.flatMap((row): TreeRow[] => {
    const { entry } = row
    if (entry.kind !== 'thread') {
      const under = byParent.get(entry.id)
      return [{ ...row, threads: under === undefined ? NO_THREADS : under.map((item) => nodeOf(scopes, item)) }]
    }
    return spawners.has(entry.parentItemId) ? [] : [{ ...row, threads: [nodeOf(scopes, entry)] }]
  })
}

/** The entries as the rows of the chat's own thread, each carrying the thread blocks under it. */
export function transcriptTree(entries: readonly TranscriptEntry[]): TreeRow[] {
  return rowsOf(groupByThread(transcriptRows(withLostThreads(entries))), undefined)
}

/** A thread's state in words, with the state color it shares with the rest of the app. */
export function threadStateView(state: ThreadItem['state']): { label: string; pill: PillState } {
  switch (state) {
    case 'running':
      return { label: 'Running', pill: 'running' }
    case 'done':
      return { label: 'Done', pill: 'accepted' }
    case 'failed':
      return { label: 'Failed', pill: 'failed' }
  }
}
