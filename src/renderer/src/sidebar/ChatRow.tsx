import { useState } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { AgentView } from '../../../shared/desktop/api'
import { agentName } from '../agents/agentText'
import { chatMeta } from '../agents/chatList'
import { useLiveTerminal } from '../agents/liveTerminals'
import { classNames } from '../components/classNames'
import { Menu } from '../components/Menu'

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
}

/** The badge of a chat that waits on the person to sign in to its agent. */
function WaitingBadge({ chat, agents, signInWaiting }: Pick<ChatRowProps, 'chat' | 'agents' | 'signInWaiting'>): JSX.Element | null {
  return signInWaiting ? (
    <span className="waiting-badge" title={`This chat is waiting for you to sign in to ${agentName(chat.agent, agents)}`}>
      Needs sign-in
    </span>
  ) : null
}

/**
 * One chat in the sidebar: its title (with a dot while its terminal runs, and a badge while it waits for a
 * sign-in), then its agent and model; opens the chat, and has a menu to rename or delete it.
 */
export function ChatRow({ chat, agents, signInWaiting, selected, onOpen, onRename, onDelete }: ChatRowProps): JSX.Element {
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
          <WaitingBadge chat={chat} agents={agents} signInWaiting={signInWaiting} />
        </span>{' '}
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
