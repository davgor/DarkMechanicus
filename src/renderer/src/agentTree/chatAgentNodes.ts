import type { ChatItem, ChatRecord } from '../../../shared/agents/chat'
import { formatCallsign, rootCallsignOf, type Callsign } from '../../../shared/agents/callsign'
import type { AgentStatus, AgentTreeNodeInput } from './agentTreeModel'

type ThreadItem = Extract<ChatItem, { kind: 'thread' }>

export interface ChatRootInput {
  id: string
  /** The chat record; only it can name the root (Magos for a Start-run orchestrator, Lexmechanic for a planner). */
  chat: Pick<ChatRecord, 'role' | 'runId'>
  /** Shown when the record grants no callsign, for example the agent's label. */
  fallbackName: string
  /** Numbers a root that shares its callsign with an earlier root in the same view (`Lexmechanic-2`); else unnumbered. */
  ordinal?: number
  secondary: string
  status: AgentStatus
  startedAt: number | null
  endedAt: number | null
}

/** Root roles belong to chat records; a thread item stamped with one is treated as unnamed. */
const ROOT_ROLES: ReadonlySet<Callsign['role']> = new Set(['Magos', 'Lexmechanic'])

/**
 * One chat's agent-tree inputs: the record-named root, then one node per `thread` item in item order.
 * Subagent names come only from the callsign main stamped on the item, never from its model-written label.
 */
export function chatAgentNodes({ root, items, savedTickets, needsYou = new Set() }: {
  root: ChatRootInput
  items: readonly ChatItem[]
  savedTickets: readonly { key: string; title: string }[]
  needsYou?: ReadonlySet<string>
}): AgentTreeNodeInput[] {
  const titles = new Map(savedTickets.map(({ key, title }) => [key, title]))
  const nodes: AgentTreeNodeInput[] = [rootNode(root)]
  let legacy = 0
  for (const item of items) {
    if (item.kind !== 'thread') continue
    const callsign = item.callsign !== undefined && !ROOT_ROLES.has(item.callsign.role) ? item.callsign : null
    if (callsign === null) legacy++
    nodes.push({
      id: item.id,
      parentId: item.threadId ?? root.id,
      ...naming(callsign, legacy, titles),
      status: item.state === 'running' && needsYou.has(item.id) ? 'needs_you' : item.state,
      ...threadActivity(item, items)
    })
  }
  return nodes
}

function rootNode(root: ChatRootInput): AgentTreeNodeInput {
  const granted = rootCallsignOf(root.chat)
  const callsign = granted === null ? null : { ...granted, ordinal: root.ordinal ?? null }
  return {
    id: root.id,
    parentId: null,
    name: callsign === null ? root.fallbackName : formatCallsign(callsign),
    secondary: root.secondary,
    chip: callsign?.role ?? null,
    ticket: null,
    status: root.status,
    startedAt: root.startedAt,
    endedAt: root.endedAt,
    lastTool: null
  }
}

function naming(
  callsign: Callsign | null,
  legacyOrdinal: number,
  titles: ReadonlyMap<string, string>
): Pick<AgentTreeNodeInput, 'name' | 'secondary' | 'chip' | 'ticket'> {
  if (callsign === null) {
    return { name: `Servitor-${legacyOrdinal}`, secondary: '', chip: 'Servitor', ticket: null }
  }
  const key = callsign.ticketKey
  return {
    name: formatCallsign(callsign),
    secondary: (key === null ? undefined : titles.get(key)) ?? callsign.purpose ?? '',
    chip: callsign.role,
    ticket: key === null ? null : { key, verified: callsign.ticketVerified, mismatch: false }
  }
}

/** Times and the last tool come from the thread item and the items directly inside it. */
function threadActivity(
  thread: ThreadItem,
  items: readonly ChatItem[]
): Pick<AgentTreeNodeInput, 'startedAt' | 'endedAt' | 'lastTool'> {
  const startedAt = Date.parse(thread.at)
  let latest = startedAt
  let lastTool: string | null = null
  for (const item of items) {
    if (item.threadId !== thread.id) continue
    latest = Math.max(latest, Date.parse(item.at))
    if (item.kind === 'tool_call') lastTool = item.name
  }
  return { startedAt, endedAt: thread.state === 'running' ? null : latest, lastTool }
}
