/**
 * Which agent rows hold prompts waiting on the person: a row's own prompts, the sum of its subtree's, and the prompts
 * the Magos is still deciding (shown apart and never counted as waiting on the person). Only a chat's shown prompt,
 * the head of its queue, waits on anyone: the prompts queued behind it carry the translator's `off` until they lead.
 */
import type { AttentionItem } from '../../../shared/agents/agentChat'
import type { AgentTreeNodeInput } from '../agentTree/agentTreeModel'
import { owningChatId } from './epicAgentsView'

/** One agent row: a chat (`threadId` null, its main thread) or one of its threads. */
export interface NeedsYouRow {
  id: string
  chatId: string
  threadId: string | null
  parentId: string | null
}

export interface NeedsYouCount {
  own: number
  descendants: number
  deciding: number
}

/** The tree inputs as rows: a root is its own chat, a thread belongs to the root chat at the top of its chain. */
export function agentRows(nodes: readonly AgentTreeNodeInput[]): NeedsYouRow[] {
  return nodes.map((node) => ({
    id: node.id,
    chatId: owningChatId(nodes, node.id) ?? node.id,
    threadId: node.parentId === null ? null : node.id,
    parentId: node.parentId
  }))
}

/**
 * Per chat, the row each thread's prompt badges: its thread's row, falling back to the chat's own row (thread `null`)
 * when that thread has none, as for a subagent of a chat whose transcript is not loaded.
 */
function rowsByThread(rows: readonly NeedsYouRow[]): Map<string, Map<string | null, string>> {
  const byChat = new Map<string, Map<string | null, string>>()
  for (const row of rows) {
    const threads = byChat.get(row.chatId) ?? new Map<string | null, string>()
    threads.set(row.threadId, row.id)
    byChat.set(row.chatId, threads)
  }
  return byChat
}

/** Adds `own` to every ancestor of `id`, stopping at an unknown parent or a cycle. */
function bubble(id: string, own: number, counts: ReadonlyMap<string, NeedsYouCount>, parents: ReadonlyMap<string, string | null>): void {
  const visited = new Set([id])
  for (let parent = parents.get(id) ?? null; parent !== null && !visited.has(parent); parent = parents.get(parent) ?? null) {
    const count = counts.get(parent)
    if (count === undefined) return
    count.descendants += own
    visited.add(parent)
  }
}

/**
 * Per row id: `own` counts the chat's shown prompt when it waits on the person (`off` or `escalated`) on the row's
 * thread (a chat row: its main thread, and any thread without a row of its own), `descendants` sums `own` over the
 * row's subtree, and `deciding` counts the Magos's.
 */
export function needsYouRows(
  rows: readonly NeedsYouRow[],
  attention: ReadonlyMap<string, readonly AttentionItem[]>
): Map<string, NeedsYouCount> {
  const counts = new Map(rows.map((row): [string, NeedsYouCount] => [row.id, { own: 0, descendants: 0, deciding: 0 }]))
  const byChat = rowsByThread(rows)
  for (const [chatId, items] of attention) {
    const threads = byChat.get(chatId)
    if (threads !== undefined) for (const item of items) countShown(item, threads, counts)
  }
  const parents = new Map(rows.map((row) => [row.id, row.parentId]))
  for (const [id, { own }] of counts) if (own > 0) bubble(id, own, counts, parents)
  return counts
}

/** Adds a shown prompt to its row's count; a prompt queued behind the head waits on no one yet. */
function countShown(item: AttentionItem, threads: ReadonlyMap<string | null, string>, counts: ReadonlyMap<string, NeedsYouCount>): void {
  if (!item.shown) return
  const id = threads.get(item.threadId) ?? threads.get(null)
  const count = id === undefined ? undefined : counts.get(id)
  if (count === undefined) return
  if (item.arbitration === 'deciding') count.deciding++
  else count.own++
}
