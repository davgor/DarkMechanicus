import { useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { AgentAuthStatus, AgentId, AgentView, TrackedFolderView } from '../../../shared/desktop/api'
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
import { Menu } from '../components/Menu'
import { AgentsSection } from './AgentsSection'
import { FolderRow } from './FolderRow'
import type { Expansion } from './useExpansion'
import type { KanbanCards, KanbanCounts } from '../kanban/useKanbanCounts'

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

export interface SidebarProps {
  version: string
  folders: readonly TrackedFolderView[]
  lists: Record<string, EpicListState>
  selection: Selection
  /** The connected agents and their sign-in states, listed above the folders. */
  agents: readonly AgentView[]
  agentStatuses: AgentStatuses
  expansion: Expansion
  chats: SidebarChats
  /** Every chat, listed under its agent in the AGENTS section, and summoning an agent with no project. */
  agentChats: Omit<ComponentProps<typeof AgentsSection>['chats'], 'folders' | 'epics' | 'selectedChatId'>
  /** Rendered at the bottom of the sidebar (status and update controls). */
  footer: ReactNode
  /** Tracks an existing folder through the native picker. */
  onTrack(): void
  /** Opens the clone dialog. */
  onClone(): void
  /** Opens the add-agent pane. */
  onAddAgent(): void
  onSelectAgent(id: AgentId): void
  /** A sign-in prompt in the Agents list asked an agent's state itself. */
  onAgentStatus(id: AgentId, status: AgentAuthStatus): void
  onSelectFolder(path: string): void
  onSelectEpic(path: string, epicId: string): void
  /** Open Kanban cards per folder path; a folder is absent until its board has loaded. */
  kanbanCounts: KanbanCounts
  kanbanCards?: KanbanCards
  onSelectKanban(path: string, cardId?: string): void
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

/** The FOLDERS + button: track an existing folder, or clone a repository. */
function AddFolderMenu({ onTrack, onClone }: Pick<SidebarProps, 'onTrack' | 'onClone'>): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      label="Add a folder"
      icon="plus"
      open={open}
      onOpenChange={setOpen}
      items={[
        { id: 'track', label: 'Add existing folder…', onSelect: onTrack },
        { id: 'clone', label: 'Clone repository…', onSelect: onClone }
      ]}
    />
  )
}

/** The AGENTS section, with the chat open in the main area (a folder's, or a project-less one) marked in its agent's list. */
function SidebarAgents(props: SidebarProps): JSX.Element {
  const { agentPane, chatId } = props.selection
  const openChatId = agentPane === undefined ? (chatId ?? null) : agentPane.kind === 'chat' ? agentPane.chatId : null
  return (
    <AgentsSection
      agents={props.agents}
      statuses={props.agentStatuses}
      selected={agentPane?.kind === 'agent' ? agentPane.agent : null}
      chats={{ ...props.agentChats, folders: props.folders, epics: props.lists, selectedChatId: openChatId }}
      onAdd={props.onAddAgent}
      onSelect={props.onSelectAgent}
      onStatus={props.onAgentStatus}
    />
  )
}

function FolderSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }): JSX.Element {
  const [expanded, setExpanded] = useState(true)
  return (
    <section aria-label={title}>
      <div className="sidebar-head">
        <Button
          variant="ghost"
          size="sm"
          icon={expanded ? 'chevron-down' : 'chevron-right'}
          aria-label={title}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="eyebrow">{title.toUpperCase()}</span>
        </Button>
        {action}
      </div>
      <div hidden={!expanded}>{children}</div>
    </section>
  )
}

/** Worlds and projects share the same row, disclosure and folder-scoped agent controls. */
function SidebarFolder({ folder, props, selection }: { folder: TrackedFolderView; props: SidebarProps; selection: Selection }): JSX.Element {
  return (
    <FolderRow
      folder={folder}
      list={listFor(props.lists, folder.path)}
      selection={selection}
      expansion={props.expansion}
      chats={chatsFor(props.chats.lists, folder.path)}
      statuses={props.agentStatuses}
      agents={props.agents}
      onSelectFolder={props.onSelectFolder}
      onSelectEpic={props.onSelectEpic}
      kanbanOpen={props.kanbanCounts[folder.path] ?? null}
      kanbanCards={props.kanbanCards?.[folder.path]}
      onSelectKanban={props.onSelectKanban}
      onStopTracking={props.onRequestUntrack}
      onNewChat={props.chats.onNew}
      onOpenChat={props.chats.onOpen}
      onRenameChat={props.chats.onRename}
      onDeleteChat={props.chats.onDelete}
    >
      {folder.forgeWorld ? <div className="forge-projects">
        {props.folders.filter(child => child.forgeParent === folder.path).map(child => <SidebarFolder key={child.path} folder={child} props={props} selection={selection} />)}
      </div> : null}
    </FolderRow>
  )
}

/** The left panel: connected agents, tracked folders with their epic buckets and chats, then the status footer. */
export function Sidebar(props: SidebarProps): JSX.Element {
  const { agentPane } = props.selection
  const roots = props.folders.filter(folder => !folder.forgeParent)
  const folders = roots.filter(folder => !folder.forgeWorld)
  const worlds = roots.filter(folder => folder.forgeWorld)
  // While an agents screen is open no folder or epic is the current one.
  const folderSelection = agentPane === undefined ? props.selection : EMPTY_SELECTION
  return (
    <aside className="sidebar" aria-label="Tracked folders">
      <Brand version={props.version} />
      <SidebarAgents {...props} />
      <nav className="sidebar-tree" aria-label="Folders and epics">
        {worlds.length > 0 && (
          <FolderSection title="Forge Worlds">
            {worlds.map(folder => <SidebarFolder key={folder.path} folder={folder} props={props} selection={folderSelection} />)}
          </FolderSection>
        )}
        <FolderSection title="Folders" action={<AddFolderMenu onTrack={props.onTrack} onClone={props.onClone} />}>
          {folders.length === 0 && <p className="sidebar-note">No folders yet. Use + to track one.</p>}
          {folders.map(folder => <SidebarFolder key={folder.path} folder={folder} props={props} selection={folderSelection} />)}
        </FolderSection>
      </nav>
      {props.footer}
    </aside>
  )
}
