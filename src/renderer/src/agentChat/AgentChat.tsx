import { useLayoutEffect, useRef, useState } from 'react'
import type { AgentChatApi } from '../../../shared/agents/agentChat'
import type { CommandResult } from '../../../shared/desktop/api'
import { ChatTranscript } from '../agents/ChatTranscript'
import type { Scheduler } from '../app/scheduler'
import { StreamingBubble } from './StreamingBubble'
import { PendingPromptCard } from './PendingPromptCard'
import { TodoCard } from './TodoCard'
import type { AgentChatState as ChatState } from './agentChatModel'
import { useAgentChat } from './useAgentChat'
import '../agents/chatView.css'
import './agentChat.css'
import '../agents/chatThreads.css'

interface Props {
  folder: string | null
  chatId: string
  agentLabel: string
  api?: AgentChatApi
  scheduler?: Scheduler
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

function ChatView({ folder, chatId, agentLabel, api, scheduler }: Props): JSX.Element {
  const { state, send, interrupt, setSurface, answer } = useAgentChat({ folder, chatId, api, scheduler })
  const command = useChatCommand()
  const busy = state.status === 'busy'
  function stop(): void {
    if (busy) void command.run(interrupt)
  }
  return (
    <section className="agent-chat" aria-label={`${agentLabel} chat`} onKeyDown={(event) => {
      if (event.key === 'Escape' && busy) {
        event.preventDefault()
        stop()
      }
    }}>
      <ChatHeader state={state} agentLabel={agentLabel} acting={command.acting}
        terminal={() => { void command.run(() => setSurface('terminal')) }} />
      {state.statusDetail && <p className="agent-chat-detail">{state.statusDetail}</p>}
      <Messages state={state} folder={folder} agentLabel={agentLabel} />
      <PendingPromptCard prompt={state.pending} answer={answer} />
      <TodoCard chatId={chatId} state={state} />
      <Composer chatId={chatId} agentLabel={agentLabel} busy={busy} ready={state.status === 'idle' || busy}
        queued={state.queued} command={command} send={send} stop={stop} />
    </section>
  )
}

function ChatHeader({ state, agentLabel, acting, terminal }: {
  state: ChatState; agentLabel: string; acting: boolean; terminal: () => void
}): JSX.Element {
  const disabled = state.status !== 'idle' || state.pending !== null || acting
  const status = state.status === 'busy' ? 'working' : state.status === 'signed_out' ? 'signed out' : state.status ?? 'starting'
  return (
    <header className="agent-chat-header">
      <h2>{agentLabel}</h2>
      <span className="agent-chat-status" role="status">{status}</span>
      <span title={disabled ? 'Terminal is available when the agent is idle with no pending prompt or command.' : 'Continue this session in Terminal'}>
        <button className="btn btn-sm" type="button" disabled={disabled} onClick={terminal}>Terminal</button>
      </span>
    </header>
  )
}

function Messages({ state, folder, agentLabel }: { state: ChatState; folder: string | null; agentLabel: string }): JSX.Element {
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
    <div className="agent-chat-scroll" ref={viewport} tabIndex={0} aria-label="Chat messages" onScroll={(event) => {
      const node = event.currentTarget
      pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 32
    }}>
      <div ref={content}>
        {state.items.length === 0 && state.streaming.size === 0 && <p className="agent-chat-empty">Send a message to {agentLabel} to begin.</p>}
        <ChatTranscript folder={folder ?? ''} agentName={agentLabel} entries={state.items} />
        {Array.from(state.streaming, ([id, stream]) => <StreamingBubble key={id} {...stream} />)}
      </div>
    </div>
  )
}

interface ComposerProps {
  chatId: string
  agentLabel: string
  ready: boolean
  busy: boolean
  queued: number
  command: ChatCommand
  send: (text: string) => Promise<CommandResult<null>>
  stop: () => void
}

function Composer({ chatId, agentLabel, ready, busy, queued, command, send, stop }: ComposerProps): JSX.Element {
  const [text, setText] = useState('')
  async function submit(): Promise<void> {
    if (!ready || !text.trim() || text.length > 20_000) return
    const sent = text
    if (await command.run(() => send(sent))) setText((current) => current === sent ? '' : current)
  }
  return (
    <form className="agent-chat-composer" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      {command.error && <p className="agent-chat-command-error" role="alert">{command.error}</p>}
      <label className="agent-chat-label" htmlFor={`agent-message-${chatId}`}>Message {agentLabel}</label>
      <textarea className="input" id={`agent-message-${chatId}`} value={text} maxLength={20_000} rows={3} disabled={!ready}
        placeholder="Send a message…" onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void submit()
          }
        }} />
      <div className="agent-chat-actions">
        <span className="agent-chat-hint">Enter to send · Shift+Enter for a new line</span>
        {queued > 0 && <span className="chat-chip" aria-label="Queued messages">{queued} queued</span>}
        {busy
          ? <button className="btn" type="button" disabled={command.acting} onClick={stop}>Stop</button>
          : <button className="btn btn-primary" type="submit" disabled={!ready || !text.trim() || command.acting}>Send</button>}
      </div>
    </form>
  )
}
