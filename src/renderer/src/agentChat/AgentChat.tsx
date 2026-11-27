import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentChatApi } from '../../../shared/agents/agentChat'
import type { CommandResult } from '../../../shared/desktop/api'
import { ChatTranscript } from '../agents/ChatTranscript'
import { RevealThreadContext } from '../agents/revealThread'
import type { Scheduler } from '../app/scheduler'
import { StreamingBubble } from './StreamingBubble'
import { PendingPromptCard } from './PendingPromptCard'
import { TodoCard } from './TodoCard'
import { ChatComposer } from './ChatComposer'
import { TurnActivityLine } from './TurnActivityLine'
import { ChatAgentsRail, useChatRail, useThreadReveal, type RailChat } from './ChatAgentsRail'
import type { AgentChatState as ChatState } from './agentChatModel'
import { useAgentChat } from './useAgentChat'
import { withoutTodoCalls } from './todoPanelModel'
import '../agents/chatView.css'
import './agentChat.css'
import '../agents/chatThreads.css'

interface Props {
  folder: string | null
  chatId: string
  agentLabel: string
  /** The composer's agent chip: the label with its role or CLI, such as `Magos · Skitarii`; the label alone by default. */
  agentChip?: string
  /** The composer's context chip: the epic or folder the chat works in; none by default. */
  context?: string | null
  api?: AgentChatApi
  scheduler?: Scheduler
  /** `toggle` offers an Agents rail listing this chat's subagents; the epic panel keeps the default `none`. */
  rail?: 'none' | 'toggle'
  /** The chat record's role and run, which alone can name the tree's root. */
  chat?: RailChat
  /** A thread (a `thread` item's id) to open and scroll to once the chat has loaded. */
  revealThreadId?: string | null
  /** Called once the requested thread was revealed. */
  onRevealed?(): void
}

/** Key local drafts and in-flight UI state to the chat, just like the model subscription. */
export function AgentChat(props: Props): JSX.Element {
  return <ChatView key={JSON.stringify([props.folder, props.chatId])} {...props} />
}

type Command = () => Promise<CommandResult<unknown>>
interface ChatCommand {
  error: string | null
  acting: boolean
  run(command: Command): Promise<boolean>
}

function useChatCommand(): ChatCommand {
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState(false)
  const locked = useRef(false)
  async function run(command: Command): Promise<boolean> {
    if (locked.current) return false
    locked.current = true
    setActing(true)
    setError(null)
    try {
      const result = await command()
      if (!result.ok) setError(result.error.message)
      return result.ok
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The chat command failed.')
      return false
    } finally {
      locked.current = false
      setActing(false)
    }
  }
  return { error, acting, run }
}

const ORDINARY_CHAT: RailChat = { role: 'worker' }

function ChatView({
  folder, chatId, agentLabel, agentChip, context, api, scheduler, rail = 'none', chat = ORDINARY_CHAT, revealThreadId, onRevealed
}: Props): JSX.Element {
  const { state, send, interrupt, setSurface, answer } = useAgentChat({ folder, chatId, api, scheduler })
  const command = useChatCommand()
  const agents = useChatRail(chatId)
  const agentsOpen = !agents.state.collapsed
  const { reveal, show } = useThreadReveal(state, revealThreadId, onRevealed)
  const railId = useId()
  const busy = state.status === 'busy'
  function stop(): void {
    if (busy) void command.run(interrupt)
  }
  const showRail = rail === 'toggle' && agentsOpen
  return (
    <section className="agent-chat" aria-label={`${agentLabel} chat`} onKeyDown={(event) => {
      if (event.key === 'Escape' && busy) {
        event.preventDefault()
        stop()
      }
    }}>
      <ChatHeader state={state} agentLabel={agentLabel} acting={command.acting}
        terminal={() => { void command.run(() => setSurface('terminal')) }}
        agents={rail === 'toggle' ? { open: agentsOpen, toggle: () => agents.setCollapsed(agentsOpen), controls: railId } : null} />
      <div className="agent-chat-body">
        <div className="agent-chat-main">
          {state.statusDetail && <p className="agent-chat-detail">{state.statusDetail}</p>}
          <RevealThreadContext.Provider value={reveal}>
            <Messages state={state} folder={folder} agentLabel={agentLabel} />
          </RevealThreadContext.Provider>
          <TurnActivityLine state={state} stop={stop} acting={command.acting} />
          <PendingPromptCard prompt={state.pending} answer={answer} />
          <TodoCard chatId={chatId} state={state} />
          <Composer chatId={chatId} agentLabel={agentLabel} agentChip={agentChip} context={context} state={state} command={command}
            send={send} stop={stop} />
        </div>
        {showRail && <div id={railId} className="agent-chat-rail">
          <ChatAgentsRail chatId={chatId} chat={chat} agentLabel={agentLabel} state={state} rail={agents} selected={reveal.target} select={show} />
        </div>}
      </div>
    </section>
  )
}

/** The chat's shared composer: Message the agent while the transcript is empty, Reply to it once there is one. */
function Composer({ chatId, agentLabel, agentChip, context, state, command, send, stop }: {
  chatId: string
  agentLabel: string
  agentChip: string | undefined
  context: string | null | undefined
  state: ChatState
  command: ChatCommand
  send(text: string): Promise<CommandResult<null>>
  stop(): void
}): JSX.Element {
  const busy = state.status === 'busy'
  const empty = state.items.length === 0 && state.streaming.size === 0
  return (
    <ChatComposer id={`agent-message-${chatId}`} label={`Message ${agentLabel}`}
      placeholder={empty ? `Message ${agentLabel}…` : `Reply to ${agentLabel}…`} agent={agentChip ?? agentLabel} context={context ?? null}
      queued={state.queued} maxLength={20_000} disabled={!(state.status === 'idle' || busy)} acting={command.acting} busy={busy}
      error={command.error} send={(text) => command.run(() => send(text))} stop={stop} />
  )
}

function ChatHeader({ state, agentLabel, acting, terminal, agents }: {
  state: ChatState; agentLabel: string; acting: boolean; terminal: () => void
  agents: { open: boolean; toggle(): void; controls: string } | null
}): JSX.Element {
  const disabled = state.status !== 'idle' || state.pending !== null || acting
  const status = state.status === 'busy' ? 'working' : state.status === 'signed_out' ? 'signed out' : state.status ?? 'starting'
  const threads = state.items.filter((item) => item.kind === 'thread').length
  return (
    <header className="agent-chat-header">
      <h2>{agentLabel}</h2>
      <span className="agent-chat-status" role="status">{status}</span>
      {agents && <button className="btn btn-sm agent-chat-agents" type="button" aria-pressed={agents.open}
        aria-controls={agents.controls} onClick={agents.toggle}>
        Agents <span className="chat-chip" aria-label={`${threads} threads`}>{threads}</span>
      </button>}
      <span title={disabled ? 'Terminal is available when the agent is idle with no pending prompt or command.' : 'Continue this session in Terminal'}>
        <button className="btn btn-sm" type="button" disabled={disabled} onClick={terminal}>Terminal</button>
      </span>
    </header>
  )
}

function Messages({ state, folder, agentLabel }: { state: ChatState; folder: string | null; agentLabel: string }): JSX.Element {
  const items = useMemo(() => withoutTodoCalls(state.items), [state.items])
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const scroll = () => {
      if (pinned.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
    }
    scroll()
    // Content growth and composer/window resizing can move the bottom without a model event.
    if (typeof ResizeObserver === 'undefined' || !content.current || !viewport.current) return
    const observer = new ResizeObserver(scroll)
    observer.observe(content.current)
    observer.observe(viewport.current)
    return () => observer.disconnect()
  }, [state.items, state.streaming])
  return (
    <div className="agent-chat-scroll glass-strong" ref={viewport} tabIndex={0} aria-label="Chat messages" onScroll={(event) => {
      const node = event.currentTarget
      pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 32
    }}>
      <div ref={content}>
        {state.items.length === 0 && state.streaming.size === 0 && <p className="agent-chat-empty">Send a message to {agentLabel} to begin.</p>}
        <ChatTranscript folder={folder ?? ''} agentName={agentLabel} entries={items} />
        {Array.from(state.streaming, ([id, stream]) => <StreamingBubble key={id} {...stream} />)}
      </div>
    </div>
  )
}

