/**
 * The epic's top-level agents as browser-style tabs over the Agent stage: the run's Magos, then any live Lexmechanic,
 * transfer or board-conversation chat, and the selected chat. A tab selects its chat with the same `select_agent` the
 * rail tree uses, so the two stay in step; workers stay in the rail. "+" starts an agent or reopens a stopped one.
 */
import './agentTabStrip.css'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { RunView } from '../../../shared/domain/views'
import { useAgentChat } from '../agentChat/useAgentChat'
import { LexmechanicArt } from '../agentRoles/LexmechanicArt'
import { MagosArt } from '../agentRoles/MagosArt'
import { agentName } from '../agents/agentText'
import { useLiveTerminal } from '../agents/liveTerminals'
import { useChatMail } from '../agents/useAgentMail'
import { errorMessage } from '../api/dm'
import { classNames } from '../components/classNames'
import { Dialog } from '../components/Dialog'
import { Icon } from '../components/Icon'
import { AgentPickerDialog } from './AgentPickerDialog'
import { agentTabs, cycleTab, reopenableChats, tabAfterClose, type AgentTab, type AgentTabSignals } from './agentTabs'
import type { WorkspaceHandle } from './useWorkspace'

type Report = (chatId: string, signals: AgentTabSignals) => void

/** Reports a GUI chat's liveness, turn and unseen mail; reading only, so watching a chat never starts it. */
function GuiSignals({ folder, chatId, report }: { folder: string; chatId: string; report: Report }): null {
  const { state } = useAgentChat({ folder, chatId }, { autoStart: false })
  const unread = useChatMail(folder, chatId).state?.unseenCount ?? 0
  const live = state.status === 'starting' || state.status === 'idle' || state.status === 'busy'
  const busy = state.status === 'busy'
  useEffect(() => report(chatId, { live, busy, unread }), [report, chatId, live, busy, unread])
  return null
}

/** Reports a terminal chat's live PTY and unseen mail; its turn is not known outside the terminal. */
function TerminalSignals({ folder, chatId, report }: { folder: string; chatId: string; report: Report }): null {
  const live = useLiveTerminal(chatId)
  const unread = useChatMail(folder, chatId).state?.unseenCount ?? 0
  useEffect(() => report(chatId, { live, busy: false, unread }), [report, chatId, live, unread])
  return null
}

function useSignals(): [ReadonlyMap<string, AgentTabSignals>, Report] {
  const [signals, setSignals] = useState<ReadonlyMap<string, AgentTabSignals>>(() => new Map())
  const report = useCallback<Report>((chatId, next) => {
    setSignals((previous) => {
      const before = previous.get(chatId)
      if (before?.live === next.live && before.busy === next.busy && before.unread === next.unread) return previous
      return new Map(previous).set(chatId, next)
    })
  }, [])
  return [signals, report]
}

/** The role's art at tab size, or the generic agent glyph for a chat without a root callsign; decorative. */
function TabIcon({ callsign }: { callsign: AgentTab['callsign'] }): JSX.Element {
  return (
    <span className="ats-icon" aria-hidden="true">
      {callsign === 'Magos' ? <MagosArt size={16} /> : callsign === 'Lexmechanic' ? <LexmechanicArt size={16} /> : <Icon name="agent" />}
    </span>
  )
}

/** The tab's accessible name: its callsign, then what its indicators show. */
function tabLabel(tab: AgentTab): string {
  return [
    tab.name,
    tab.unread > 0 && `${tab.unread} unread ${tab.unread === 1 ? 'message' : 'messages'}`,
    tab.needsYou && 'needs you',
    tab.busy && 'working'
  ].filter(Boolean).join(', ')
}

/** The hover text: the agent, and for any agent but a Skitarii one, that it does not coordinate over Skitarii mail. */
function tabTooltip(tab: AgentTab, agent: string): string {
  const lines = [`${tab.name} · ${agent}`]
  if (!tab.coordinates) lines.push('No coordination: only Skitarii agents message each other')
  if (!tab.live) lines.push('Stopped')
  return lines.join('\n')
}

/** The Lexmechanic's (or another closable tab's) Stop confirmation; the chat stays in history. */
function StopDialog({ tab, onCancel, onStop }: { tab: AgentTab; onCancel(): void; onStop(): Promise<void> }): JSX.Element {
  const [stopping, setStopping] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  async function stop(): Promise<void> {
    setStopping(true)
    try {
      await onStop()
    } catch (error) {
      setProblem(errorMessage(error))
      setStopping(false)
    }
  }
  return (
    <Dialog title={`Stop the ${tab.name}?`} description="Its chat stays in history." onClose={onCancel}
      actions={<>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-danger" disabled={stopping} onClick={() => void stop()}>Stop</button>
      </>}>
      {problem !== null && <p role="alert" className="ew-notice-error">{problem}</p>}
    </Dialog>
  )
}

/** The epic's stopped top-level chats, each reopened in the GUI. */
function ReopenList({ chats, names, onReopen }: {
  chats: readonly ChatRecord[]
  names: ReadonlyMap<string, string>
  onReopen(chat: ChatRecord): Promise<void>
}): JSX.Element {
  const [opening, setOpening] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  async function reopen(chat: ChatRecord): Promise<void> {
    setOpening(chat.id)
    setProblem(null)
    try {
      await onReopen(chat)
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setOpening(null)
    }
  }
  return (
    <section className="ats-reopen" aria-label="Reopen">
      <h3>Reopen</h3>
      {chats.length === 0 ? <p className="ew-muted">No stopped agents</p> : (
        <ul>
          {chats.map((chat) => (
            <li key={chat.id}>
              <button type="button" className="ats-reopen-row" disabled={opening !== null} onClick={() => void reopen(chat)}>
                <span className="ats-reopen-name">{names.get(chat.id) ?? chat.title}</span>
                <span className="ats-reopen-meta">{chat.title} · {new Date(chat.createdAt).toLocaleDateString()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem !== null && <p role="alert" className="ew-notice-error">{problem}</p>}
    </section>
  )
}

/** Feeds every epic chat's signals to the strip; renders nothing. */
function SignalFeeds({ folder, chats, report }: { folder: string; chats: readonly ChatRecord[]; report: Report }): JSX.Element {
  return <>{chats.map((chat) => chat.surface === 'gui'
    ? <GuiSignals key={chat.id} folder={folder} chatId={chat.id} report={report} />
    : <TerminalSignals key={chat.id} folder={folder} chatId={chat.id} report={report} />)}</>
}

/**
 * Ctrl+Tab and Ctrl+Shift+Tab cycle the tabs anywhere on the Agent stage, as in a browser; not while a modal dialog
 * (the Stop confirmation, the picker, or any other) is open, so the chat behind it never changes.
 */
function useCtrlTab(tabs: readonly AgentTab[], selectedId: string | null, select: (chatId: string | null) => void): void {
  const current = useRef({ tabs, selectedId })
  current.current = { tabs, selectedId }
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key !== 'Tab' || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return
      event.preventDefault()
      select(cycleTab(current.current.tabs, current.current.selectedId, event.shiftKey ? -1 : 1))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [select])
}

/** The tab an arrow, Home or End key moves to within the tablist; null for any other key. */
function keyTarget(key: string, tabs: readonly AgentTab[], selectedId: string | null): string | null {
  switch (key) {
    case 'ArrowRight': return cycleTab(tabs, selectedId, 1)
    case 'ArrowLeft': return cycleTab(tabs, selectedId, -1)
    case 'Home': return tabs[0]?.chatId ?? null
    case 'End': return tabs.at(-1)?.chatId ?? null
    default: return null
  }
}

/** One tab: its select button (icon, callsign and indicators) and, when it can stop, its ✕. */
function TabItem({ tab, selected, agent, onSelect, onClose }: {
  tab: AgentTab
  selected: boolean
  agent: string
  onSelect(): void
  onClose(): void
}): JSX.Element {
  return (
    <div className={classNames('ats-tab', selected && 'is-active glass', !tab.live && 'is-stopped')}>
      <button type="button" role="tab" className="ats-select" data-chat-id={tab.chatId} aria-selected={selected}
        aria-label={tabLabel(tab)} tabIndex={selected ? 0 : -1} title={tabTooltip(tab, agent)} onClick={onSelect}>
        <TabIcon callsign={tab.callsign} />
        <span className="ats-name">{tab.name}</span>
        {tab.busy && <span className="ats-spinner" aria-hidden="true" />}
        {tab.needsYou && <span className="ats-needs-you" aria-hidden="true">!</span>}
        {tab.unread > 0 && <span className="ats-unread" aria-hidden="true" />}
      </button>
      {tab.closable && (
        <button type="button" className="ats-close" aria-label={`Stop ${tab.name}`} title={`Stop ${tab.name}`} onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  )
}

/** The tablist: arrow keys, Home and End move within it, selecting and focusing as they go. */
function TabList({ tabs, selectedId, agents, select, onClose }: {
  tabs: readonly AgentTab[]
  selectedId: string | null
  agents: WorkspaceHandle['orchestration']['agents']
  select(chatId: string | null): void
  onClose(tab: AgentTab): void
}): JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.ctrlKey || event.altKey || event.metaKey ? null : keyTarget(event.key, tabs, selectedId)
    if (target === null) return
    event.preventDefault()
    select(target)
    const buttons = list.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []
    Array.from(buttons).find((button) => button.dataset.chatId === target)?.focus()
  }
  return (
    <div ref={list} className="ats-list" role="tablist" aria-label="Agent tabs" onKeyDown={onKeyDown}>
      {tabs.map((tab) => <TabItem key={tab.chatId} tab={tab} selected={tab.chatId === selectedId} agent={agentName(tab.agentId, agents)}
        onSelect={() => select(tab.chatId)} onClose={() => onClose(tab)} />)}
    </div>
  )
}

interface AgentTabStripProps {
  ws: WorkspaceHandle
  /** The epic's chats (`epicChats`). */
  chats: readonly ChatRecord[]
  run: RunView | null
  /** The selected root chat (a selected worker selects its owner here). */
  selectedId: string | null
  names: ReadonlyMap<string, string>
  /** Roots with a prompt waiting on the person, their own or a worker's. */
  needsYou: ReadonlySet<string>
}

export function AgentTabStrip({ ws, chats, run, selectedId, names, needsYou }: AgentTabStripProps): JSX.Element {
  const folder = ws.folder.path
  const agents = ws.orchestration.agents
  const [signals, report] = useSignals()
  const [confirming, setConfirming] = useState<AgentTab | null>(null)
  const [picking, setPicking] = useState(false)
  const tabs = useMemo(() => agentTabs({
    chats, run, selectedId, names, signals, needsYou,
    coordinates: (chat) => (agents.find((agent) => agent.id === chat.agent)?.kind ?? chat.agent) === 'omp'
  }), [chats, run, selectedId, names, signals, needsYou, agents])
  const { dispatch } = ws
  const select = useCallback((chatId: string | null) => {
    if (chatId !== null) dispatch({ type: 'select_agent', chatId })
  }, [dispatch])
  useCtrlTab(tabs, selectedId, select)

  async function stop(tab: AgentTab): Promise<void> {
    const result = await window.dm.agentChat.stop({ folder, chatId: tab.chatId })
    if (!result.ok) throw new Error(result.error.message)
    // The selected chat would stay a tab (and its view could start it again), so the selection moves off it.
    if (tab.chatId === selectedId) select(tabAfterClose(tabs, tab.chatId))
    setConfirming(null)
  }

  async function reopen(chat: ChatRecord): Promise<void> {
    if (chat.surface !== 'gui') {
      const result = await window.dm.agentChat.setSurface({ folder, chatId: chat.id, surface: 'gui' })
      if (!result.ok) throw new Error(result.error.message)
      await ws.orchestration.onChatsChanged()
    }
    // The GUI chat's view starts a stopped chat once it is shown.
    select(chat.id)
    setPicking(false)
  }

  return (
    <div className="ats">
      <SignalFeeds folder={folder} chats={chats} report={report} />
      <TabList tabs={tabs} selectedId={selectedId} agents={agents} select={select} onClose={setConfirming} />
      <button type="button" className="ats-new" aria-label="Start or reopen an agent" title="Start or reopen an agent" onClick={() => setPicking(true)}>
        <Icon name="plus" size={14} />
      </button>
      {confirming !== null && <StopDialog tab={confirming} onCancel={() => setConfirming(null)} onStop={() => stop(confirming)} />}
      {picking && (
        <AgentPickerDialog ws={ws} onClose={() => setPicking(false)}>
          <ReopenList chats={reopenableChats(chats, tabs)} names={names} onReopen={reopen} />
        </AgentPickerDialog>
      )}
    </div>
  )
}
