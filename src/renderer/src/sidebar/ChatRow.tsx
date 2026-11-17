import { useState } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { AgentView } from '../../../shared/desktop/api'
import type { EpicSummaryView } from '../../../shared/domain/views'
import { agentName } from '../agents/agentText'
import { chatMeta } from '../agents/chatList'
import { useLiveTerminal } from '../agents/liveTerminals'
import { useChatMail } from '../agents/useAgentMail'
import { plural } from '../app/plural'
import { classNames } from '../components/classNames'
import { Menu } from '../components/Menu'

export interface BoardConversation {
  kind: 'epic' | 'card'
  identity?: string
}
export function boardConversationOf(chat: ChatRecord, epics: readonly EpicSummaryView[]): BoardConversation | undefined {
  const conversation = chat.conversation
  if (conversation === undefined) return undefined
  if ('cardId' in conversation) return { kind: 'card' }
  return { kind: 'epic', identity: epics.find((epic) => epic.id === conversation.epicId)?.title }
}


interface ChatRowProps {
  chat: ChatRecord
  /** The connected agents: a custom agent's chat is called by its display name while it is connected. */
  agents: readonly AgentView[]
  /** A lost sign-in cut a turn short and its agent is still signed out. */
  signInWaiting: boolean
  selected: boolean
  onOpen(chatId: string): void
  onRename(chat: ChatRecord): void
  onDelete(chat: ChatRecord): void
  /** Where the chat belongs, for a list that mixes folders (an agent's chats): its folder's name, or "No project". */
  place?: string
  boardConversation?: BoardConversation
}

/** The badge of a chat that waits on the person to sign in to its agent. */
function WaitingBadge({ chat, agents, signInWaiting }: Pick<ChatRowProps, 'chat' | 'agents' | 'signInWaiting'>): JSX.Element | null {
  return signInWaiting ? (
    <span className="waiting-badge" title={`This chat is waiting for you to sign in to ${agentName(chat.agent, agents)}`}>
      Needs sign-in
    </span>
  ) : null
}

/** Messages the person has not seen, from the page's mail store: a stopped chat's mail counts too. */
function UnseenBadge({ chat }: { chat: ChatRecord }): JSX.Element | null {
  const unseen = useChatMail(chat.folder, chat.id).state?.unseenCount ?? 0
  if (unseen === 0) return null
  const label = `${plural(unseen, 'message')} unseen by you`
  return (
    <span className="unseen-badge" role="img" aria-label={label} title={label}>
      {unseen}
    </span>
  )
}

/**
 * One chat in the sidebar: its title (with a dot while its terminal runs, a count of the messages the person has not
 * seen, and a badge while it waits for a sign-in), then where it belongs when the list mixes folders, and its agent
 * and model; opens the chat, and has a menu to rename or delete it.
 */
export function ChatRow({ chat, agents, signInWaiting, selected, onOpen, onRename, onDelete, place, boardConversation }: ChatRowProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const live = useLiveTerminal(chat.id)
  return (
    <div
      className={classNames('chat-row', selected && 'is-selected')}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenuOpen(true)
      }}
    >
      <button
        type="button"
        className="chat-row-main"
        aria-current={selected ? 'true' : undefined}
        onClick={() => onOpen(chat.id)}
      >
        <span className="chat-row-head">
          <span className="chat-row-title" title={chat.title}>
            {chat.title}
          </span>
          {live ? <span className="chat-live-dot" role="img" aria-label="terminal running" title="Its terminal is running" /> : null}
          <UnseenBadge chat={chat} />
          <WaitingBadge chat={chat} agents={agents} signInWaiting={signInWaiting} />
        </span>{' '}
        {place === undefined ? null : <span className="chat-row-place">{place}</span>}
        {boardConversation === undefined ? null : (
          <span className="chat-row-place">
            {boardConversation.identity === undefined ? 'Board conversation' : `Board conversation · ${boardConversation.identity}`}
          </span>
        )}
        <span className="chat-row-meta">{chatMeta(chat, agents)}</span>
      </button>
      <Menu
        label={`Actions for ${chat.title}`}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        items={[
          { id: 'rename', label: 'Rename', onSelect: () => onRename(chat) },
          { id: 'delete', label: 'Delete', onSelect: () => onDelete(chat) }
        ]}
      />
    </div>
  )
}
