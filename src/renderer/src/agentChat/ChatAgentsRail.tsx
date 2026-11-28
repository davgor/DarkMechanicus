import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatItem, ChatRecord } from '../../../shared/agents/chat'
import { AgentTree } from '../agentTree/AgentTree'
import { buildAgentTree, type AgentStatus, type AgentTreeNodeInput } from '../agentTree/agentTreeModel'
import { chatAgentNodes } from '../agentTree/chatAgentNodes'
import type { RevealThread } from '../agents/revealThread'
import { browserRailTab } from '../browser/BrowserPanel'
import { RightRail } from '../components/RightRail'
import { useRailState, type RailStateHandle } from '../components/useRailState'
import { useNow } from '../epic/clock'
import type { AgentChatState } from './agentChatModel'

export type RailChat = Pick<ChatRecord, 'role' | 'runId'>

/**
 * This chat's Agents rail state, remembered under `dm.chatRail.v1:<chatId>`. The chat's Agents toggle and the
 * rail's own chevron both read and write it: the rail is shown while it is not collapsed. A chat with nothing
 * stored starts collapsed, never at the narrow-window default of the shared rail.
 */
export function useChatRail(chatId: string): RailStateHandle {
  return useRailState(`dm.chatRail.v1:${chatId}`, true)
}

const ROOT_STATUS: Record<NonNullable<AgentChatState['status']>, AgentStatus> = {
  busy: 'running', idle: 'idle', starting: 'idle', signed_out: 'idle', exited: 'done', failed: 'failed'
}

function rootId(chatId: string): string {
  return `chat:${chatId}`
}

function treeInputs(chatId: string, chat: RailChat, agentLabel: string, state: AgentChatState): AgentTreeNodeInput[] {
  return chatAgentNodes({
    root: {
      id: rootId(chatId), chat, fallbackName: agentLabel, secondary: '',
      status: ROOT_STATUS[state.status ?? 'starting'], startedAt: null, endedAt: null
    },
    items: state.items,
    // An ordinary chat has no epic, so no saved tickets title its subagents.
    savedTickets: []
  })
}

/** The thread ids from `target` out through every thread that encloses it. */
function pathTo(target: string, items: readonly ChatItem[]): Set<string> {
  const parents = new Map(items.flatMap((item) => (item.kind === 'thread' ? [[item.id, item.threadId] as const] : [])))
  const path = new Set<string>()
  for (let id: string | undefined = target; id !== undefined && !path.has(id); id = parents.get(id)) path.add(id)
  return path
}

/**
 * The reveal request the transcript follows, set by a tree selection or a shell thread landing. A landing is
 * revealed once the chat has loaded, then acknowledged once through `onRevealed`.
 */
export function useThreadReveal(state: AgentChatState, landing: string | null | undefined, onRevealed?: () => void): {
  reveal: RevealThread
  show(threadId: string): void
} {
  const [reveal, setReveal] = useState<RevealThread>(() => ({ path: new Set(), target: null, nonce: 0, handled: new Map() }))
  const items = useRef(state.items)
  items.current = state.items
  const show = (threadId: string): void => {
    setReveal((previous) => ({ ...previous, path: pathTo(threadId, items.current), target: threadId, nonce: previous.nonce + 1 }))
  }
  const taken = useRef<string | null>(null)
  const loaded = state.status !== null
  useEffect(() => {
    if (!landing) taken.current = null
    if (!landing || !loaded || taken.current === landing) return
    taken.current = landing
    setReveal((previous) => ({ ...previous, path: pathTo(landing, items.current), target: landing, nonce: previous.nonce + 1 }))
    onRevealed?.()
  }, [landing, loaded, onRevealed])
  return { reveal, show }
}

/** The rail beside an ordinary chat: its Agents tab lists the chat and the subagents it started; its Browser tab shows the chat's browser. */
export function ChatAgentsRail({ folder, chatId, chat, agentLabel, state, rail, selected, select }: {
  folder: string | null
  chatId: string
  chat: RailChat
  agentLabel: string
  state: AgentChatState
  /** The chat's rail state from `useChatRail`, shared with its Agents toggle. */
  rail: RailStateHandle
  selected: string | null
  select(threadId: string): void
}): JSX.Element {
  const now = useNow()
  const tree = useMemo(() => buildAgentTree(treeInputs(chatId, chat, agentLabel, state)), [chatId, chat, agentLabel, state])
  const content = (
    <AgentTree tree={tree} selectedId={selected} now={now} label="Chat agent tree"
      onSelect={(id) => { if (id !== rootId(chatId)) select(id) }} />
  )
  return <RightRail label="Chat agents" rail={rail}
    tabs={[{ id: 'agents', label: 'Agents', icon: 'agent', content }, browserRailTab(folder, chatId)]} />
}
