import { useState } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { AgentAuthStatus, AgentId, AgentView, TrackedFolderView } from '../../../shared/desktop/api'
import { agentVersionLabel, signInLabel } from '../agents/agentText'
import { DeleteChatDialog, RenameChatDialog } from '../agents/ChatDialogs'
import { newestFirst, waitingOnSignIn } from '../agents/chatList'
import { SignInOffer } from '../agents/SignInPrompt'
import type { AgentStatuses } from '../agents/useAgents'
import type { ChatListState } from '../agents/useChats'
import type { EpicListState } from '../app/useEpicLists'
import { Button } from '../components/Button'
import { classNames } from '../components/classNames'
import { Icon } from '../components/Icon'
import { boardConversationOf, ChatRow } from './ChatRow'

/** Every chat that is not deleted, and what can be done with them from an agent's row. */
interface AgentChats {
  /** Every tracked folder's chats and the project-less ones. */
  list: ChatListState
  /** The tracked folders, so a chat is labelled with its folder's name. */
  folders: readonly TrackedFolderView[]
  /** Sidebar epic summaries by folder, used to name board conversations. */
  epics: Record<string, EpicListState>
  /** The chat open in the main area, if any. */
  selectedChatId: string | null
  onOpen(chat: ChatRecord): void
  /** Resolves true once the chat has its new title, false if it could not be renamed. */
  onRename(chat: ChatRecord, title: string): Promise<boolean>
  /** Resolves true once the chat is deleted, false if it could not be. */
  onDelete(chat: ChatRecord): Promise<boolean>
  /** Starts a chat with the agent that is tied to no project, by asking for its first prompt. */
  onSummon(id: AgentId): void
}

interface AgentsSectionProps {
  agents: readonly AgentView[]
  statuses: AgentStatuses
  /** The id of the agent whose page is open in the main area. */
  selected: AgentId | null
  chats: AgentChats
  onAdd(): void
  onSelect(id: AgentId): void
  /** A sign-in prompt asked an agent's state itself: the shell shows what it found. */
  onStatus(id: AgentId, status: AgentAuthStatus): void
}

type Pending = { kind: 'rename' | 'delete'; chat: ChatRecord }

interface AgentRowProps {
  agent: AgentView
  statuses: AgentStatuses
  selected: boolean
  chats: AgentChats
  onSelect(id: AgentId): void
  onStatus(id: AgentId, status: AgentAuthStatus): void
  onAsk(pending: Pending): void
}

/** Where a chat belongs: its tracked folder's name (the folder's own name when it is not listed), or no project. */
function placeOf(chat: ChatRecord, folders: readonly TrackedFolderView[]): string {
  if (chat.folder === null) {
    return 'No project'
  }
  return folders.find((folder) => folder.path === chat.folder)?.name ?? chat.folder.split(/[\\/]/).filter(Boolean).pop() ?? chat.folder
}

/** The agent's chats, newest first, or the note that stands in for them. */
function AgentChatList({ agent, statuses, chats, onAsk }: Pick<AgentRowProps, 'agent' | 'statuses' | 'chats' | 'onAsk'>): JSX.Element {
  const { list } = chats
  if (list.status === 'loading') {
    return <p className="sidebar-note chat-note">Loading chats…</p>
  }
  const own = newestFirst(list.chats.filter((chat) => chat.agent === agent.id))
  return (
    <>
      {list.status === 'error' ? <p className="sidebar-note chat-note is-error">Could not refresh chats</p> : null}
      {own.length === 0 && list.status === 'ready' ? <p className="sidebar-note chat-note">No chats yet.</p> : null}
      <ul className="chat-list agent-chat-list" aria-label={`Chats of ${agent.displayName}`}>
        {own.map((chat) => (
          <li key={chat.id}>
            <ChatRow
              chat={chat}
              agents={[agent]}
              place={placeOf(chat, chats.folders)}
              boardConversation={boardConversationOf(chat, chat.folder === null ? [] : (chats.epics[chat.folder]?.epics ?? []))}
              signInWaiting={waitingOnSignIn(chat, statuses)}
              selected={chat.id === chats.selectedChatId}
              onOpen={() => chats.onOpen(chat)}
              onRename={(target) => onAsk({ kind: 'rename', chat: target })}
              onDelete={(target) => onAsk({ kind: 'delete', chat: target })}
            />
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * An agent that needs attention says so right on its row: Sign in when it is signed out, its reason and Check again
 * when its state is unknown. Its chevron lists its chats (every folder's and the project-less ones), and its summon
 * button starts one tied to no project.
 */
function AgentRow({ agent, statuses, selected, chats, onSelect, onStatus, onAsk }: AgentRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const state = signInLabel(statuses[agent.id])
  return (
    <li>
      <div className="agent-row-line">
        <button
          type="button"
          className="agent-chats-toggle"
          aria-expanded={expanded}
          aria-label={`Chats of ${agent.displayName}`}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
        </button>
        <button
          type="button"
          className={classNames('agent-row', selected && 'is-selected')}
          aria-current={selected ? 'true' : undefined}
          onClick={() => onSelect(agent.id)}
        >
          <Icon name="plug" />
          <span className="agent-text">
            <span className="agent-name">{agent.displayName}</span>
            <span className="agent-meta">
              <span className="mono">{agentVersionLabel(agent)}</span>
              <span className={`agent-state tone-${state.tone}`}>
                <span className="agent-state-dot" aria-hidden="true" />
                {state.text}
              </span>
            </span>
          </span>
        </button>
        <Button variant="ghost" size="sm" icon="plus" aria-label={`Summon ${agent.displayName} without a project`} onClick={() => chats.onSummon(agent.id)} />
      </div>
      <div className="agent-row-offer">
        <SignInOffer agent={agent.id} name={agent.displayName} status={statuses[agent.id]} onStatus={(status) => onStatus(agent.id, status)} />
      </div>
      {expanded ? <AgentChatList agent={agent} statuses={statuses} chats={chats} onAsk={onAsk} /> : null}
    </li>
  )
}

function ChatDialog({ pending, chats, onClose }: { pending: Pending; chats: AgentChats; onClose(): void }): JSX.Element {
  const { chat } = pending
  return pending.kind === 'rename' ? (
    <RenameChatDialog chat={chat} onSubmit={(title) => chats.onRename(chat, title)} onClose={onClose} />
  ) : (
    <DeleteChatDialog
      chat={chat}
      boardConversation={boardConversationOf(chat, chat.folder === null ? [] : (chats.epics[chat.folder]?.epics ?? []))?.kind}
      onConfirm={() => chats.onDelete(chat)}
      onClose={onClose}
    />
  )
}

/** The connected agents above the folders, each with its chats and a summon button, and the + that opens the add-agent pane. */
export function AgentsSection({ agents, statuses, selected, chats, onAdd, onSelect, onStatus }: AgentsSectionProps): JSX.Element {
  const [pending, setPending] = useState<Pending | null>(null)
  return (
    <section className="sidebar-agents" aria-label="Agents">
      <div className="sidebar-head">
        <span className="eyebrow">AGENTS</span>
        <Button variant="ghost" icon="plus" aria-label="Add an agent" onClick={onAdd} />
      </div>
      {agents.length === 0 ? (
        <p className="sidebar-note">No agents yet. Use + to add one.</p>
      ) : (
        <ul className="agent-list">
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              statuses={statuses}
              selected={selected === agent.id}
              chats={chats}
              onSelect={onSelect}
              onStatus={onStatus}
              onAsk={setPending}
            />
          ))}
        </ul>
      )}
      {pending === null ? null : <ChatDialog pending={pending} chats={chats} onClose={() => setPending(null)} />}
    </section>
  )
}
