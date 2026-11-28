import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { chatImageUrl } from '../../../shared/agents/chatImageUrl'
import type { AgentChatAnswer, AgentChatApi } from '../../../shared/agents/agentChat'
import type { BrowserApi } from '../../../shared/browser/browserApi'
import type { CommandResult } from '../../../shared/desktop/api'
import { OriginPromptCard } from '../browser/OriginPromptCard'
import { ChatTranscript } from '../agents/ChatTranscript'
import { RevealThreadContext } from '../agents/revealThread'
import type { Scheduler } from '../app/scheduler'
import { StreamingBubble } from './StreamingBubble'
import { PendingPromptCard } from './PendingPromptCard'
import { TodoCard } from './TodoCard'
import { ChatComposer } from './ChatComposer'
import { ModelPicker } from './ModelPicker'
import { ChatImageAttachButton, ChatImageChips } from './ChatImageChips'
import { ChatEvidenceProvider, useChatEvidence, type ChatEpic, type ChatImageSrc } from './ChatImages'
import { TurnActivityLine } from './TurnActivityLine'
import { ChatAgentsRail, useChatRail, useThreadReveal, type RailChat } from './ChatAgentsRail'
import type { AgentChatState as ChatState } from './agentChatModel'
import { useAgentChat, useMailTranscript, type TranscriptLine } from './useAgentChat'
import { ChatImagesContext, useChatImages, type ChatImages, type ChatImagesHandle, type StageImage } from './useChatImages'
import '../agents/chatView.css'
import './agentChat.css'
import '../agents/chatThreads.css'

interface Props {
  folder: string | null
  /** The folder's attachment key (`TrackedFolderView.attachmentKey`), the host of the chat's image addresses; null without a folder. */
  folderKey?: string | null
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
  /** The epic the chat works in, whose images it may attach as evidence; none outside an epic. */
  epic?: ChatEpic
  /** A Skitarii (OMP) chat: the composer offers its model and effort chip. Claude and every other chat has none. */
  skitarii?: boolean
  /** The in-app browser (`window.dm.browser`): its pending site prompt docks above the composer. None shows no site card. */
  browser?: BrowserApi
  /**
   * Hands the composer's images to a panel outside the chat (the epic's Browser rail, whose camera adds captures as
   * chips); called with null once the chat closes. The chat's own rail gets them from context without it.
   */
  shareImages?(images: ChatImagesHandle | null): void
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

/** The composer's images, handed to `shareImages` (see `Props.shareImages`) while the chat is open, and null after. */
function useComposerImages(stage: StageImage, shareImages: Props['shareImages']): ChatImages {
  const images = useChatImages(stage)
  const { addStaged } = images
  useEffect(() => {
    if (shareImages === undefined) return undefined
    shareImages({ addStaged })
    return () => shareImages(null)
  }, [shareImages, addStaged])
  return images
}

function ChatView({
  folder, folderKey = null, chatId, agentLabel, agentChip, context, api, scheduler, rail = 'none', chat = ORDINARY_CHAT, revealThreadId, onRevealed,
  epic, skitarii, browser, shareImages
}: Props): JSX.Element {
  const { state, send, stageImage, interrupt, setSurface, answer, models, setModel } = useAgentChat({ folder, chatId, api, scheduler })
  const transcript = useMailTranscript(folder, chatId, state.items)
  const images = useComposerImages(stageImage, shareImages)
  const evidence = useChatEvidence({ folder, chatId, api, items: state.items, epic })
  const command = useChatCommand()
  const agents = useChatRail(chatId)
  const agentsOpen = !agents.state.collapsed
  const { reveal, show } = useThreadReveal(state, revealThreadId, onRevealed)
  const railId = useId()
  const busy = state.status === 'busy'
  const imageSrc = useCallback<ChatImageSrc>((ref) => chatImageUrl(folderKey, chatId, ref.id), [folderKey, chatId])
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
      <ChatImagesContext.Provider value={images}><div className="agent-chat-body">
        <div className="agent-chat-main">
          {state.statusDetail && <p className="agent-chat-detail">{state.statusDetail}</p>}
          <RevealThreadContext.Provider value={reveal}><ChatEvidenceProvider value={evidence}>
            <Messages state={state} transcript={transcript} folder={folder} agentLabel={agentLabel} imageSrc={imageSrc} />
          </ChatEvidenceProvider></RevealThreadContext.Provider>
          <TurnActivityLine state={state} stop={stop} acting={command.acting} />
          <PromptSlot folder={folder} chatId={chatId} pending={state.pending} answer={answer} browser={browser} />
          <TodoCard chatId={chatId} state={state} />
          <Composer chatId={chatId} folderKey={folderKey} agentLabel={agentLabel} agentChip={agentChip} context={context} state={state}
            command={command} images={images} send={send} stop={stop}
            model={skitarii ? <ModelPicker state={state} load={models} choose={setModel} /> : null} />
        </div>
        {showRail && <div id={railId} className="agent-chat-rail">
          <ChatAgentsRail folder={folder} folderKey={folderKey} chatId={chatId} chat={chat} agentLabel={agentLabel} state={state} rail={agents}
            selected={reveal.target} select={show} />
        </div>}
      </div></ChatImagesContext.Provider>
    </section>
  )
}

/** The prompt slot above the composer: the agent's approval or question, then the chat's browser site prompt below it. */
function PromptSlot({ folder, chatId, pending, answer, browser }: {
  folder: string | null
  chatId: string
  pending: ChatState['pending']
  answer(request: AgentChatAnswer): Promise<CommandResult<null>>
  browser: BrowserApi | undefined
}): JSX.Element {
  return (
    <>
      <PendingPromptCard prompt={pending} answer={answer} />
      {browser && <OriginPromptCard folder={folder} chatId={chatId} api={browser} />}
    </>
  )
}

/**
 * The chat's shared composer: Message the agent while the transcript is empty, Reply to it once there is one. Staged
 * images go with the text by id and leave the composer only once the send was taken.
 */
function Composer({ chatId, folderKey, agentLabel, agentChip, context, state, command, images, send, stop, model }: {
  chatId: string
  folderKey: string | null
  agentLabel: string
  agentChip: string | undefined
  context: string | null | undefined
  state: ChatState
  command: ChatCommand
  images: ChatImages
  send(message: { text: string; imageIds: readonly string[] }): Promise<CommandResult<null>>
  stop(): void
  /** The model chip, just left of Send; none for a chat that cannot switch models. */
  model: JSX.Element | null
}): JSX.Element {
  const busy = state.status === 'busy'
  const disabled = !(state.status === 'idle' || busy)
  const empty = state.items.length === 0 && state.streaming.size === 0
  async function sendWithImages(text: string): Promise<boolean> {
    const imageIds = images.images.map((image) => image.id)
    const sent = await command.run(() => send({ text, imageIds }))
    if (sent) images.clear(imageIds)
    return sent
  }
  return (
    <ChatComposer id={`agent-message-${chatId}`} label={`Message ${agentLabel}`}
      placeholder={empty ? `Message ${agentLabel}…` : `Reply to ${agentLabel}…`} agent={agentChip ?? agentLabel} context={context ?? null}
      queued={state.queued} maxLength={20_000} disabled={disabled} acting={command.acting} busy={busy}
      error={command.error} send={sendWithImages} stop={stop} trailing={model}
      leading={<ChatImageAttachButton pickerProps={images.pickerProps} disabled={disabled} />}
      attachments={{
        chips: <ChatImageChips folderKey={folderKey} chatId={chatId} images={images.images} staging={images.staging} error={images.error}
          remove={images.remove} />,
        count: images.images.length, staging: images.staging, intake: images.targetProps
      }} />
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
    <header className="agent-chat-header glass">
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

function Messages({ state, transcript, folder, agentLabel, imageSrc }: {
  state: ChatState; transcript: readonly TranscriptLine[]; folder: string | null; agentLabel: string; imageSrc: ChatImageSrc
}): JSX.Element {
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
  }, [transcript, state.streaming])
  return (
    <div className="agent-chat-scroll glass-strong" ref={viewport} tabIndex={0} aria-label="Chat messages" onScroll={(event) => {
      const node = event.currentTarget
      pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 32
    }}>
      <div ref={content}>
        {state.items.length === 0 && transcript.length === 0 && state.streaming.size === 0 && <p className="agent-chat-empty">Send a message to {agentLabel} to begin.</p>}
        <ChatTranscript folder={folder ?? ''} agentName={agentLabel} entries={transcript} imageSrc={imageSrc} status={state.status} />
        {Array.from(state.streaming, ([id, stream]) => <StreamingBubble key={id} {...stream} />)}
      </div>
    </div>
  )
}

