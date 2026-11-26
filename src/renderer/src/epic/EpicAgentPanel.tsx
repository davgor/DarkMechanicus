/**
 * The epic's Agent stage: the selected agent's chat in the centre and the epic's agent tree in a right rail. A root
 * is a chat bound to the epic; a subagent is a thread of a loaded transcript, shown read-only with a composer that
 * relays the person's message through the chat that owns the thread.
 */
import './epicAgentPanel.css'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ChatItem, ChatRecord } from '../../../shared/agents/chat'
import { AgentChangesCard } from '../agentChat/AgentChangesCard'
import { AgentChat } from '../agentChat/AgentChat'
import { withoutTodoCalls } from '../agentChat/todoPanelModel'
import { useAgentChat } from '../agentChat/useAgentChat'
import { useNeedsYou } from '../agentChat/useNeedsYou'
import { AgentTree, type NeedsYouControls } from '../agentTree/AgentTree'
import { buildAgentTree, type AgentTreeNodeInput } from '../agentTree/agentTreeModel'
import { ChatTranscript } from '../agents/ChatTranscript'
import { errorMessage } from '../api/dm'
import { RightRail, type RailTab } from '../components/RightRail'
import {
  activeOrchestratorId, defaultAgentChatId, epicAgentNodes, epicChats, owningChatId, relayMessage, threadTranscript,
  type EpicAgentNodesInput, type LoadedTranscript
} from './epicAgentsView'
import { agentRows, needsYouRows, type NeedsYouCount } from './needsYou'
import type { WorkspaceHandle } from './useWorkspace'

/** Subscribes to one chat's structured transcript and reports it; renders nothing. */
function TranscriptFeed({ folder, chatId, onLoaded }: {
  folder: string
  chatId: string
  onLoaded(chatId: string, transcript: LoadedTranscript): void
}): null {
  const { state } = useAgentChat({ folder, chatId })
  useEffect(() => {
    onLoaded(chatId, { items: state.items, busy: state.status === 'busy' })
  }, [chatId, onLoaded, state.items, state.status])
  return null
}

function useTranscripts(): [ReadonlyMap<string, LoadedTranscript>, (chatId: string, transcript: LoadedTranscript) => void] {
  const [transcripts, setTranscripts] = useState<ReadonlyMap<string, LoadedTranscript>>(() => new Map())
  const onLoaded = useCallback((chatId: string, transcript: LoadedTranscript) => {
    setTranscripts((previous) => new Map(previous).set(chatId, transcript))
  }, [])
  return [transcripts, onLoaded]
}

/** No chat is bound to the epic yet: start its planner. */
function NoAgents({ ws }: { ws: WorkspaceHandle }): JSX.Element {
  const [starting, setStarting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  async function startPlanner(): Promise<void> {
    setStarting(true)
    setProblem(null)
    try {
      const result = await window.dm.chats.startPlanner({ folder: ws.folder.path, epicId: ws.epicId })
      if (!result.ok) {
        // A `no_agent` refusal carries main's sign-in prompt text.
        setProblem(result.error.message)
        return
      }
      setProblem(result.data.problem)
      if (result.data.chat !== null) {
        ws.dispatch({ type: 'select_agent', chatId: result.data.chat.id })
        await ws.orchestration.onChatsChanged()
      }
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setStarting(false)
    }
  }
  return (
    <div className="eap-empty">
      <p className="ew-empty">No agents yet</p>
      <button className="btn btn-primary" type="button" disabled={starting} onClick={() => void startPlanner()}>Start planner</button>
      {problem !== null && <p role="alert" className="ew-notice-error">{problem}</p>}
    </div>
  )
}

/**
 * A terminal chat's actions: the epic has no terminal kit, so it links to the chat or switches it to the GUI. Main
 * owns the switch (it refuses while the terminal is live), so the epic never talks to the chat's GUI process directly.
 */
function SurfaceActions({ ws, chat }: { ws: WorkspaceHandle; chat: ChatRecord }): JSX.Element {
  const [switching, setSwitching] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  async function switchToGui(): Promise<void> {
    setSwitching(true)
    setProblem(null)
    try {
      const result = await window.dm.agentChat.setSurface({ folder: ws.folder.path, chatId: chat.id, surface: 'gui' })
      if (result.ok) await ws.orchestration.onChatsChanged()
      else setProblem(result.error.message)
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setSwitching(false)
    }
  }
  return (
    <>
      <div className="eap-actions">
        <button className="btn" type="button" onClick={() => ws.orchestration.onOpenChat(chat.id)}>Open terminal</button>
        <button className="btn btn-primary" type="button" disabled={switching} onClick={() => void switchToGui()}>Switch to GUI</button>
      </div>
      {problem !== null && <p role="alert" className="ew-notice-error">{problem}</p>}
    </>
  )
}

function TerminalChat({ ws, chat, name }: { ws: WorkspaceHandle; chat: ChatRecord; name: string }): JSX.Element {
  return (
    <section className="eap-terminal" aria-label={`${name} chat`}>
      <h2>{chat.title}</h2>
      <p className="ew-empty">This chat runs in a terminal.</p>
      <SurfaceActions ws={ws} chat={chat} />
    </section>
  )
}

/**
 * A subagent's thread, read-only. The relay composer is offered only while the owning chat runs in the GUI: sending
 * to a terminal chat's GUI bridge would start a hidden process behind its terminal, so a terminal owner offers its
 * terminal and the switch to the GUI instead.
 */
function ThreadView({ ws, owner, ownerName, threadId, name, items }: {
  ws: WorkspaceHandle
  owner: ChatRecord
  ownerName: string
  threadId: string
  name: string
  items: readonly ChatItem[]
}): JSX.Element {
  const entries = useMemo(() => withoutTodoCalls(threadTranscript(items, threadId)), [items, threadId])
  return (
    <section className="agent-chat" aria-label={`${name} thread`}>
      <header className="agent-chat-header"><h2>{name}</h2></header>
      <div className="agent-chat-scroll">
        {entries.length === 0 && <p className="agent-chat-empty">Nothing in this thread yet.</p>}
        <ChatTranscript folder={ws.folder.path} agentName={name} entries={entries} />
      </div>
      {owner.surface === 'gui'
        ? <RelayComposer folder={ws.folder.path} ownerId={owner.id} ownerName={ownerName} threadId={threadId} name={name} />
        : <div className="eap-terminal">
          <p className="ew-empty">{ownerName} runs in a terminal. Message this worker there, or switch {ownerName} to the GUI.</p>
          <SurfaceActions ws={ws} chat={owner} />
        </div>}
    </section>
  )
}

/** Sends the person's text to the owning chat inside the fixed relay marker; the thread's label is never part of it. */
function RelayComposer({ folder, ownerId, ownerName, threadId, name }: {
  folder: string
  ownerId: string
  ownerName: string
  threadId: string
  name: string
}): JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  async function send(): Promise<void> {
    if (sending || !text.trim()) return
    const sent = text
    setSending(true)
    setProblem(null)
    try {
      const result = await window.dm.agentChat.send({ folder, chatId: ownerId, text: relayMessage(threadId, sent) })
      if (result.ok) setText((current) => (current === sent ? '' : current))
      else setProblem(result.error.message)
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setSending(false)
    }
  }
  const inputId = `eap-relay-${threadId}`
  return (
    <form className="agent-chat-composer" onSubmit={(event) => { event.preventDefault(); void send() }}>
      {problem !== null && <p className="agent-chat-command-error" role="alert">{problem}</p>}
      <label className="agent-chat-label" htmlFor={inputId}>Message {name}</label>
      <textarea className="input" id={inputId} value={text} maxLength={18_000} rows={3} placeholder="Send a message…"
        onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void send()
          }
        }} />
      <div className="agent-chat-actions">
        <span className="agent-chat-hint">Your message goes through {ownerName}, which passes it to this worker.</span>
        <button className="btn btn-primary" type="submit" disabled={sending || !text.trim()}>Send</button>
      </div>
    </form>
  )
}

function railTabs(nodes: AgentTreeNodeInput[], { selectedId, onSelect, now, changes, needsYou }: {
  selectedId: string | null
  onSelect: (id: string) => void
  now: number
  changes: ReactNode
  needsYou: NeedsYouControls
}): RailTab[] {
  const tree = buildAgentTree(nodes)
  const { needsYou: waiting, working } = tree.counts
  const badge: RailTab['badge'] = waiting > 0
    ? { text: String(waiting), tone: 'attention' }
    : working > 0 ? { text: String(working), tone: 'running' } : undefined
  return [{
    id: 'agents',
    label: 'Agents',
    icon: 'agent',
    ...(badge === undefined ? {} : { badge }),
    content: <>
      <AgentTree tree={tree} selectedId={selectedId} onSelect={onSelect} now={now} label="Epic agents" needsYou={needsYou} />
      {changes}
    </>
  }]
}

/** The selected root's chat (GUI or terminal), or one of its threads. */
function CentrePane({ ws, chat, threadId, nodes, items }: {
  ws: WorkspaceHandle
  chat: ChatRecord
  threadId: string | null
  nodes: readonly AgentTreeNodeInput[]
  items: readonly ChatItem[]
}): JSX.Element {
  const named = (id: string): string | undefined => nodes.find((node) => node.id === id)?.name
  const name = named(chat.id) ?? chat.title
  if (threadId !== null) {
    return <ThreadView ws={ws} owner={chat} ownerName={name} threadId={threadId} name={named(threadId) ?? 'Subagent'} items={items} />
  }
  if (chat.surface === 'gui') return <AgentChat folder={ws.folder.path} chatId={chat.id} agentLabel={name} />
  return <TerminalChat ws={ws} chat={chat} name={name} />
}

/**
 * The epic's agent nodes with the folder's attention applied: a row with its own prompt waiting on the person takes
 * the needs-you status, so the tree's own header count and collapsed-ancestor bubbling show it.
 */
function useNeedsYouNodes(folder: string, input: Omit<EpicAgentNodesInput, 'needsYou'>): {
  nodes: AgentTreeNodeInput[]
  counts: ReadonlyMap<string, NeedsYouCount>
} {
  const attention = useNeedsYou(folder)
  const { chats, run, epicId, transcripts, savedTickets } = input
  const base = useMemo(() => epicAgentNodes({ chats, run, epicId, transcripts, savedTickets }),
    [chats, run, epicId, transcripts, savedTickets])
  const counts = useMemo(() => needsYouRows(agentRows(base), attention), [base, attention])
  const nodes = useMemo(() => {
    const waiting = new Set([...counts].filter(([, count]) => count.own > 0).map(([id]) => id))
    return waiting.size === 0 ? base : epicAgentNodes({ chats, run, epicId, transcripts, savedTickets, needsYou: waiting })
  }, [base, counts, chats, run, epicId, transcripts, savedTickets])
  return { nodes, counts }
}

export function EpicAgentPanel({ ws }: { ws: WorkspaceHandle }): JSX.Element {
  const run = ws.data.run
  const folder = ws.folder.path
  const chats = useMemo(() => epicChats(ws.orchestration.chats, run, ws.epicId), [ws.orchestration.chats, run, ws.epicId])
  const [transcripts, onLoaded] = useTranscripts()
  const fallbackId = defaultAgentChatId(chats, run)
  const chat = chats.find((item) => item.id === ws.state.agentChatId) ?? chats.find((item) => item.id === fallbackId)
  const lead = activeOrchestratorId(chats, run)
  // Only chats still subscribed feed the tree; a chat no longer watched would otherwise stay frozen as it was.
  const watched = useMemo(() => new Map([...transcripts].filter(([id]) => id === lead || id === chat?.id)), [transcripts, lead, chat?.id])
  const { nodes, counts } = useNeedsYouNodes(folder, {
    chats, run, epicId: ws.epicId, transcripts: watched, savedTickets: ws.data.savedTickets
  })
  if (chat === undefined) {
    return <section aria-label="Agent chat" className="eap"><NoAgents ws={ws} /></section>
  }
  const threadId = ws.state.agentChatId === chat.id ? ws.state.agentThreadId : null
  const onSelect = (id: string): void => {
    const owner = owningChatId(nodes, id)
    if (owner !== null) ws.dispatch({ type: 'select_agent', chatId: owner, threadId: owner === id ? null : id })
  }
  const needsYou: NeedsYouControls = {
    below: new Map([...counts].map(([id, count]) => [id, count.descendants])),
    deciding: new Set([...counts].filter(([, count]) => count.deciding > 0).map(([id]) => id)),
    // The card waits in the owning chat's own view, so the dot selects that chat rather than the thread.
    select: (id) => {
      const owner = owningChatId(nodes, id)
      if (owner !== null) ws.dispatch({ type: 'select_agent', chatId: owner })
    }
  }
  return (
    <section aria-label="Agent chat" className="eap">
      {lead !== null && <TranscriptFeed folder={folder} chatId={lead} onLoaded={onLoaded} />}
      {chat.id !== lead && <TranscriptFeed folder={folder} chatId={chat.id} onLoaded={onLoaded} />}
      <div className="eap-centre">
        <CentrePane ws={ws} chat={chat} threadId={threadId} nodes={nodes} items={watched.get(chat.id)?.items ?? []} />
      </div>
      <RightRail label="Epic agents" storageKey={`dm.epicRail.v1:${folder}\n${ws.epicId}`}
        tabs={railTabs(nodes, {
          selectedId: threadId ?? chat.id, onSelect, now: ws.now, needsYou,
          changes: <AgentChangesCard folder={folder} epicId={ws.epicId} chat={chat} threadId={threadId}
            onOpenSourceFile={ws.orchestration.onOpenSourceFile} />
        })} />
    </section>
  )
}
