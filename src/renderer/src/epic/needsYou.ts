/**
 * Which agent rows hold prompts waiting on the person: a row's own prompts, the sum of its subtree's, and the prompts
 * the Magos is still deciding (shown apart and never counted as waiting on the person).
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

function ownCount(row: NeedsYouRow, items: readonly AttentionItem[]): NeedsYouCount {
  const count: NeedsYouCount = { own: 0, descendants: 0, deciding: 0 }
  for (const item of items) {
    if (item.threadId !== row.threadId) continue
    if (item.arbitration === 'deciding') count.deciding++
    else if (item.arbitration === 'off' || item.arbitration === 'escalated') count.own++
  }
  return count
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
 * Per row id: `own` counts the chat's prompts on the row's thread (a chat row: its main thread) that wait on the person
 * (`off` or `escalated`), `descendants` sums `own` over the row's subtree, and `deciding` counts the Magos's.
 */
export function needsYouRows(
  rows: readonly NeedsYouRow[],
  attention: ReadonlyMap<string, readonly AttentionItem[]>
): Map<string, NeedsYouCount> {
  const counts = new Map(rows.map((row) => [row.id, ownCount(row, attention.get(row.chatId) ?? [])]))
  const parents = new Map(rows.map((row) => [row.id, row.parentId]))
  for (const [id, { own }] of counts) if (own > 0) bubble(id, own, counts, parents)
  return counts
}
