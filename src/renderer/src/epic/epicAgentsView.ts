/**
 * The epic's agents for the Agent stage: the chats bound to the epic as roots, and the subagent threads of each
 * loaded transcript nested under them. Pure, so the panel only renders what this derives.
 */
import { rootCallsignOf } from '../../../shared/agents/callsign'
import type { ChatItem, ChatRecord } from '../../../shared/agents/chat'
import { isActiveRunState } from '../../../shared/domain/status'
import type { RunView } from '../../../shared/domain/views'
import { chatAgentNodes } from '../agentTree/chatAgentNodes'
import type { AgentTreeNodeInput } from '../agentTree/agentTreeModel'

/** A root chat's loaded transcript and whether its agent is mid-turn. */
export interface LoadedTranscript {
  items: readonly ChatItem[]
  busy: boolean
}

/** The active run's orchestrator chat, which the panel always subscribes to; null without an active run or chat. */
export function activeOrchestratorId(chats: readonly ChatRecord[], run: RunView | null): string | null {
  if (run === null || !isActiveRunState(run.state)) return null
  return chats.find((chat) => chat.runId === run.id && chat.role === 'orchestrator')?.id ?? null
}

/**
 * The epic's chats once each, bound by `epicId` or by the bindings chats stored before it (the run's id, the
 * transfer or the conversation): the active run's orchestrator first, then the newest first.
 */
export function epicChats(chats: readonly ChatRecord[], run: RunView | null, epicId: string): ChatRecord[] {
  const seen = new Set<string>()
  const bound = chats.filter((chat) => {
    const isBound = chat.epicId === epicId
      || (run !== null && chat.runId !== undefined && chat.runId === run.id)
      || chat.transferEpicId === epicId
      || (chat.conversation !== undefined && 'epicId' in chat.conversation && chat.conversation.epicId === epicId)
    if (seen.has(chat.id) || !isBound) return false
    seen.add(chat.id)
    return true
  }).sort((a, b) => (b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : 0))
  const lead = activeOrchestratorId(bound, run)
  return lead === null ? bound : [...bound.filter((chat) => chat.id === lead), ...bound.filter((chat) => chat.id !== lead)]
}

/** The selection's default: the active run's orchestrator, then the newest chat. */
export function defaultAgentChatId(chats: readonly ChatRecord[], run: RunView | null): string | null {
  return activeOrchestratorId(chats, run) ?? chats[0]?.id ?? null
}

/** What the chat is to the epic, shown under its name. */
function chatKindLabel(chat: ChatRecord, run: RunView | null): string {
  if (chat.transferEpicId !== undefined) return 'Transfer'
  if (chat.conversation !== undefined) return 'Conversation'
  if (chat.role === 'planner') return 'Planner'
  if (chat.role === 'orchestrator' && chat.runId !== undefined) {
    return run !== null && chat.runId === run.id ? `Orchestrator (run ${run.number})` : 'Orchestrator (earlier run)'
  }
  return chat.role.charAt(0).toUpperCase() + chat.role.slice(1)
}

/**
 * Each root chat's number among chats granted the same root callsign: the oldest keeps the bare callsign and each
 * later one, by creation then id, is numbered from 2, so two planners read `Lexmechanic` and `Lexmechanic-2`.
 */
function rootOrdinals(chats: readonly ChatRecord[]): Map<string, number> {
  const ordinals = new Map<string, number>()
  const held = new Map<string, number>()
  const oldestFirst = [...chats].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  for (const chat of oldestFirst) {
    const role = rootCallsignOf(chat)?.role
    if (role === undefined) continue
    const count = (held.get(role) ?? 0) + 1
    held.set(role, count)
    if (count > 1) ordinals.set(chat.id, count)
  }
  return ordinals
}

/**
 * Roots named from their chat records (Magos only for a run's orchestrator, Lexmechanic for a planner, numbered when
 * several chats share one, otherwise the chat's title) and, under each root whose transcript is loaded, the subagents
 * named from main's stamped callsigns. A root's node id is its chat id; an id seen before is never listed again. A node
 * id in `needsYou` (a chat with a main-thread prompt, or a running thread with its own) gets the `needs_you` status.
 */
export interface EpicAgentNodesInput {
  chats: readonly ChatRecord[]
  run: RunView | null
  epicId: string
  transcripts: ReadonlyMap<string, LoadedTranscript>
  savedTickets: readonly { key: string; title: string }[]
  needsYou?: ReadonlySet<string>
}

export function epicAgentNodes({ chats, run, epicId, transcripts, savedTickets, needsYou }: EpicAgentNodesInput): AgentTreeNodeInput[] {
  const seen = new Set<string>()
  const nodes: AgentTreeNodeInput[] = []
  const bound = epicChats(chats, run, epicId)
  const ordinals = rootOrdinals(bound)
  for (const chat of bound) {
    const transcript = transcripts.get(chat.id)
    const ordinal = ordinals.get(chat.id)
    const derived = chatAgentNodes({
      root: {
        id: chat.id,
        chat,
        fallbackName: chat.title,
        ...(ordinal === undefined ? {} : { ordinal }),
        secondary: chatKindLabel(chat, run),
        status: needsYou?.has(chat.id) ? 'needs_you' : transcript?.busy ? 'running' : 'idle',
        startedAt: Date.parse(chat.createdAt),
        endedAt: null
      },
      items: transcript?.items ?? [],
      savedTickets,
      needsYou
    })
    for (const node of derived) {
      if (seen.has(node.id)) continue
      seen.add(node.id)
      nodes.push(node)
    }
  }
  return nodes
}

/** The root chat a node belongs to: roots are their own owners; null for an unknown id. */
export function owningChatId(nodes: readonly AgentTreeNodeInput[], id: string): string | null {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const visited = new Set<string>()
  let node = byId.get(id)
  while (node !== undefined && node.parentId !== null && !visited.has(node.id)) {
    visited.add(node.id)
    node = byId.get(node.parentId)
  }
  return node !== undefined && node.parentId === null ? node.id : null
}

/**
 * One thread's own items and everything nested in it, in transcript order, as a transcript of their own: the
 * thread's direct items lose their `threadId`, so they render as top-level rows.
 */
export function threadTranscript(items: readonly ChatItem[], threadId: string): ChatItem[] {
  const inside = new Set([threadId])
  const out: ChatItem[] = []
  for (const item of items) {
    if (item.threadId === undefined || !inside.has(item.threadId)) continue
    if (item.kind === 'thread') inside.add(item.id)
    out.push(item.threadId === threadId ? { ...item, threadId: undefined } : item)
  }
  return out
}

/** The message the owning chat receives for one of its worker threads; only the thread's id names the worker. */
export function relayMessage(threadId: string, text: string): string {
  return `[Message from the person for your worker subagent, thread ${threadId}]\n${text}\nPass this to that worker now and post its answer.`
}
