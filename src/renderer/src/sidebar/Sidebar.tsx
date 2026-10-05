import type { ReactNode } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { AgentAuthStatus, AgentKind, AgentView, TrackedFolderView } from '../../../shared/desktop/api'
import type { AgentStatuses } from '../agents/useAgents'
import { chatsFor } from '../agents/useChats'
import type { ChatListState } from '../agents/useChats'
import { AppVersionLabel } from '../autoUpdate/AppVersionLabel'
import { EMPTY_SELECTION } from '../app/selection'
import type { Selection } from '../app/selection'
import { listFor } from '../app/useEpicLists'
import type { EpicListState } from '../app/useEpicLists'
import brandIcon1x from '../assets/brand-icon-32.png'
import brandIcon2x from '../assets/brand-icon-64.png'
import { Button } from '../components/Button'
import { AgentsSection } from './AgentsSection'
import { FolderRow } from './FolderRow'
import type { Expansion } from './useExpansion'

/** The folders' chats and what can be done with them. */
interface SidebarChats {
  /** Each active folder's chats, by folder path. */
  lists: Record<string, ChatListState>
  /** Starts the new-chat flow for a folder. */
  onNew(path: string): void
  onOpen(path: string, chatId: string): void
  onRename(chat: ChatRecord, title: string): Promise<boolean>
  onDelete(chat: ChatRecord): Promise<boolean>
}

interface SidebarProps {
  version: string
  folders: readonly TrackedFolderView[]
  lists: Record<string, EpicListState>
  selection: Selection
  /** The connected agents and their sign-in states, listed above the folders. */
  agents: readonly AgentView[]
  agentStatuses: AgentStatuses
  expansion: Expansion
  chats: SidebarChats
  /** Rendered at the bottom of the sidebar (status and update controls). */
  footer: ReactNode
  onTrack(): void
  /** Opens the add-agent pane. */
  onAddAgent(): void
  onSelectAgent(kind: AgentKind): void
  /** A sign-in prompt in the Agents list asked an agent's state itself. */
  onAgentStatus(kind: AgentKind, status: AgentAuthStatus): void
  onSelectFolder(path: string): void
  onSelectEpic(path: string, epicId: string): void
  /** Asks the shell to confirm and stop tracking a folder. */
  onRequestUntrack(folder: TrackedFolderView): void
}

const BRAND_TAGLINE = 'All hail the machine spirit'

function Brand({ version }: { version: string }): JSX.Element {
  return (
    <div className="sidebar-brand">
      <img
        className="brand-mark"
        src={brandIcon1x}
        srcSet={`${brandIcon1x} 1x, ${brandIcon2x} 2x`}
        width={32}
        height={32}
        alt=""
      />
      <div className="brand-text">
        <span className="brand-name">DARK MECHANICUS</span>
        <span className="brand-tagline">{BRAND_TAGLINE}</span>
        <AppVersionLabel version={version} />
      </div>
    </div>
  )
}

/** The left panel: connected agents, tracked folders with their epic buckets and chats, then the status footer. */
export function Sidebar(props: SidebarProps): JSX.Element {
  const { agentPane } = props.selection
  // While an agents screen is open no folder or epic is the current one.
  const folderSelection = agentPane === undefined ? props.selection : EMPTY_SELECTION
  return (
    <aside className="sidebar" aria-label="Tracked folders">
      <Brand version={props.version} />
      <AgentsSection
        agents={props.agents}
        statuses={props.agentStatuses}
        selected={agentPane?.kind === 'agent' ? agentPane.agent : null}
        onAdd={props.onAddAgent}
        onSelect={props.onSelectAgent}
        onStatus={props.onAgentStatus}
      />
      <div className="sidebar-head">
        <span className="eyebrow">FOLDERS</span>
        <Button variant="ghost" icon="plus" aria-label="Track a folder" onClick={props.onTrack} />
      </div>
      <nav className="sidebar-tree" aria-label="Folders and epics">
        {props.folders.length === 0 ? (
          <p className="sidebar-note">No folders yet. Use + to track one.</p>
        ) : null}
        {props.folders.map((folder) => (
          <FolderRow
            key={folder.path}
            folder={folder}
            list={listFor(props.lists, folder.path)}
            selection={folderSelection}
            expansion={props.expansion}
            chats={chatsFor(props.chats.lists, folder.path)}
            statuses={props.agentStatuses}
            onSelectFolder={props.onSelectFolder}
            onSelectEpic={props.onSelectEpic}
            onStopTracking={props.onRequestUntrack}
            onNewChat={props.chats.onNew}
            onOpenChat={props.chats.onOpen}
            onRenameChat={props.chats.onRename}
            onDeleteChat={props.chats.onDelete}
          />
        ))}
      </nav>
      {props.footer}
    </aside>
  )
}
