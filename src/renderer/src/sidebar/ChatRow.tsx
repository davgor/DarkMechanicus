import { useState } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { ChatSummary } from '../../../shared/agents/chatApi'
import { agentName } from '../agents/agentText'
import { chatMeta } from '../agents/chatList'
import { classNames } from '../components/classNames'
import { Menu } from '../components/Menu'

interface ChatRowProps {
  chat: ChatSummary
  /** A lost sign-in cut a turn short and its agent is still signed out. */
  signInWaiting: boolean
  selected: boolean
  onOpen(chatId: string): void
  onRename(chat: ChatRecord): void
  onDelete(chat: ChatRecord): void
}

/** The badge of a chat that waits on the person: for an approval, or for its agent to be signed in. */
function WaitingBadge({ chat, signInWaiting }: Pick<ChatRowProps, 'chat' | 'signInWaiting'>): JSX.Element | null {
  if (chat.pending > 0) {
    return (
      <span className="waiting-badge" title="This chat is waiting for your approval">
        Needs approval
      </span>
    )
  }
  return signInWaiting ? (
    <span className="waiting-badge" title={`This chat is waiting for you to sign in to ${agentName(chat.agent)}`}>
      Needs sign-in
    </span>
  ) : null
}

/** One chat in the sidebar: its title (with a badge while it waits for an approval or a sign-in), then its agent and model; opens the chat, and has a menu to rename or delete it. */
export function ChatRow({ chat, signInWaiting, selected, onOpen, onRename, onDelete }: ChatRowProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
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
          <WaitingBadge chat={chat} signInWaiting={signInWaiting} />
        </span>{' '}
        <span className="chat-row-meta">{chatMeta(chat)}</span>
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
