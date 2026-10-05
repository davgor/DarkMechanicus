import { useState } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { plural } from '../app/plural'
import { DeleteChatDialog, RenameChatDialog } from '../agents/ChatDialogs'
import { newestFirst, waitingCount, waitingOnSignIn, waitingReason } from '../agents/chatList'
import type { AgentStatuses } from '../agents/useAgents'
import type { ChatListState } from '../agents/useChats'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { ChatRow } from './ChatRow'

interface AgentsBlockProps {
  folder: TrackedFolderView
  list: ChatListState
  /** The connected agents' sign-in states: a chat whose agent is signed out and whose turn it cut short waits on a sign-in. */
  statuses: AgentStatuses
  expanded: boolean
  selectedChatId: string | null
  onToggle(): void
  onNewChat(): void
  onOpenChat(chatId: string): void
  /** Resolves true once the chat has its new title, false if it could not be renamed. */
  onRenameChat(chat: ChatRecord, title: string): Promise<boolean>
  /** Resolves true once the chat is deleted, false if it could not be. */
  onDeleteChat(chat: ChatRecord): Promise<boolean>
}

type Pending = { kind: 'rename' | 'delete'; chat: ChatRecord }

interface ChatListProps {
  list: ChatListState
  statuses: AgentStatuses
  selectedChatId: string | null
  onOpen(chatId: string): void
  onAsk(pending: Pending): void
}

/** The rows, or the note that stands in for them while there are none to show. */
function ChatList({ list, statuses, selectedChatId, onOpen, onAsk }: ChatListProps): JSX.Element {
  if (list.status === 'loading') {
    return <p className="sidebar-note chat-note">Loading chats…</p>
  }
  return (
    <>
      {list.status === 'error' ? <p className="sidebar-note chat-note is-error">Could not refresh chats</p> : null}
      {list.chats.length === 0 && list.status === 'ready' ? (
        <p className="sidebar-note chat-note">No chats yet. Use + to start one.</p>
      ) : null}
      <ul className="chat-list">
        {newestFirst(list.chats).map((chat) => (
          <li key={chat.id}>
            <ChatRow
              chat={chat}
              signInWaiting={waitingOnSignIn(chat, statuses)}
              selected={chat.id === selectedChatId}
              onOpen={onOpen}
              onRename={(target) => onAsk({ kind: 'rename', chat: target })}
              onDelete={(target) => onAsk({ kind: 'delete', chat: target })}
            />
          </li>
        ))}
      </ul>
    </>
  )
}

function ChatDialog({ pending, props, onClose }: { pending: Pending; props: AgentsBlockProps; onClose(): void }): JSX.Element {
  const { chat } = pending
  return pending.kind === 'rename' ? (
    <RenameChatDialog chat={chat} onSubmit={(title) => props.onRenameChat(chat, title)} onClose={onClose} />
  ) : (
    <DeleteChatDialog chat={chat} onConfirm={() => props.onDeleteChat(chat)} onClose={onClose} />
  )
}

/**
 * The Agents block under an initialized folder, below its epic buckets: a collapsible header with a
 * + that starts a chat, and the folder's chats newest first. A chat waiting on an approval or on its agent
 * being signed in has a badge; rename and delete open from a row's menu.
 */
export function AgentsBlock(props: AgentsBlockProps): JSX.Element {
  const { folder, list, statuses, expanded } = props
  const [pending, setPending] = useState<Pending | null>(null)
  const waiting = waitingCount(list.chats, statuses)
  return (
    <div className="agents-block">
      <div className="agents-block-head">
        <button
          type="button"
          className="agents-toggle"
          aria-expanded={expanded}
          aria-label={`Agents, ${plural(list.chats.length, 'chat')}${waiting > 0 ? `, ${waiting} waiting for ${waitingReason(list.chats, statuses)}` : ''}`}
          onClick={props.onToggle}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
          <span className="bucket-label">Agents</span>
          {waiting > 0 && !expanded ? <span className="waiting-badge">{waiting} waiting</span> : null}
          <span className="count-badge">{list.chats.length}</span>
        </button>
        <Button variant="ghost" size="sm" icon="plus" aria-label={`New chat in ${folder.name}`} onClick={props.onNewChat} />
      </div>
      {expanded ? (
        <ChatList list={list} statuses={statuses} selectedChatId={props.selectedChatId} onOpen={props.onOpenChat} onAsk={setPending} />
      ) : null}
      {pending === null ? null : <ChatDialog pending={pending} props={props} onClose={() => setPending(null)} />}
    </div>
  )
}
