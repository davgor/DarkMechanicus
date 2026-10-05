import { useState } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { waitingCount, waitingReason } from '../agents/chatList'
import type { AgentStatuses } from '../agents/useAgents'
import type { ChatListState } from '../agents/useChats'
import { plural } from '../app/plural'
import type { Selection } from '../app/selection'
import type { EpicListState } from '../app/useEpicLists'
import { classNames } from '../components/classNames'
import { Icon } from '../components/Icon'
import { Menu } from '../components/Menu'
import { AgentsBlock } from './AgentsBlock'
import { BucketGroup } from './BucketGroup'
import { groupEpics } from './buckets'
import type { Expansion } from './useExpansion'

interface FolderRowProps {
  folder: TrackedFolderView
  list: EpicListState
  selection: Selection
  expansion: Expansion
  /** The folder's chats, listed in its Agents block. */
  chats: ChatListState
  /** The connected agents' sign-in states: a chat whose agent is signed out and whose turn it cut short waits on a sign-in. */
  statuses: AgentStatuses
  onSelectFolder(path: string): void
  onSelectEpic(path: string, epicId: string): void
  onStopTracking(folder: TrackedFolderView): void
  /** Starts the new-chat flow for the folder. */
  onNewChat(path: string): void
  onOpenChat(path: string, chatId: string): void
  onRenameChat(chat: ChatRecord, title: string): Promise<boolean>
  onDeleteChat(chat: ChatRecord): Promise<boolean>
}

/** A folder can hold epics only when it is reachable and initialized. */
const canHoldEpics = (folder: TrackedFolderView): boolean => folder.available && folder.initialized

interface HeaderProps {
  folder: TrackedFolderView
  expanded: boolean
  highlighted: boolean
  /** Chats of the folder waiting for an approval or a sign-in; shown while the folder is collapsed, so a waiting agent is seen from anywhere. */
  waiting: number
  /** What they wait for, in words. */
  waitingFor: string
  onToggle(): void
  onSelect(): void
  onStopTracking(): void
}

function FolderHeader(props: HeaderProps): JSX.Element {
  const { folder, expanded, highlighted, waiting, waitingFor } = props
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div
      className={classNames('folder-row', highlighted && 'is-selected')}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenuOpen(true)
      }}
    >
      <button
        type="button"
        className="folder-chevron"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${folder.name}`}
        onClick={props.onToggle}
      >
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
      </button>
      <button
        type="button"
        className="folder-main"
        aria-current={highlighted ? 'true' : undefined}
        onClick={props.onSelect}
      >
        <Icon name="folder" />
        <span className="folder-text">
          <span className="folder-name" title={folder.name}>
            {folder.name}
          </span>{' '}
          <span className="folder-path mono" title={folder.path}>
            {folder.displayPath}
          </span>
        </span>
        {waiting > 0 && !expanded ? (
          <span className="waiting-badge" title={`${plural(waiting, 'chat')} waiting for your ${waitingFor}`}>
            {waiting} waiting
          </span>
        ) : null}
      </button>
      <Menu
        label={`Actions for ${folder.name}`}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        items={[{ id: 'stop', label: 'Stop tracking folder', onSelect: props.onStopTracking }]}
      />
    </div>
  )
}

interface StatusRowProps {
  label: string
  selected: boolean
  onSelect(): void
}

/** The "Setup required" / "Folder unavailable" row shown instead of buckets. */
function StatusRow({ label, selected, onSelect }: StatusRowProps): JSX.Element {
  return (
    <button
      type="button"
      className={classNames('status-row', selected && 'is-selected')}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <Icon name="warning" size={14} />
      <span>{label}</span>
    </button>
  )
}

function Buckets(props: FolderRowProps): JSX.Element {
  const { folder, list, selection, expansion } = props
  if (list.status === 'loading') {
    return <p className="sidebar-note">Loading epics…</p>
  }
  const selectedEpicId = selection.folderPath === folder.path ? selection.epicId : null
  return (
    <div className="buckets">
      {list.status === 'error' ? <p className="sidebar-note is-error">Could not refresh epics</p> : null}
      {groupEpics(list.epics).map((bucket) => (
        <BucketGroup
          key={bucket.id}
          bucket={bucket}
          expanded={expansion.isBucketExpanded(folder.path, bucket.id)}
          selectedEpicId={selectedEpicId}
          onToggle={() => expansion.toggleBucket(folder.path, bucket.id)}
          onOpenEpic={(epicId) => props.onSelectEpic(folder.path, epicId)}
        />
      ))}
    </div>
  )
}

/** The Agents block, under the epic buckets of a folder that is initialized. */
function Agents(props: FolderRowProps): JSX.Element {
  const { folder, selection, expansion } = props
  return (
    <AgentsBlock
      folder={folder}
      list={props.chats}
      statuses={props.statuses}
      expanded={expansion.isAgentsExpanded(folder.path)}
      selectedChatId={selection.folderPath === folder.path ? (selection.chatId ?? null) : null}
      onToggle={() => expansion.toggleAgents(folder.path)}
      onNewChat={() => props.onNewChat(folder.path)}
      onOpenChat={(chatId) => props.onOpenChat(folder.path, chatId)}
      onRenameChat={props.onRenameChat}
      onDeleteChat={props.onDeleteChat}
    />
  )
}

function FolderBody(props: FolderRowProps & { folderSelected: boolean }): JSX.Element {
  const { folder, folderSelected } = props
  if (!folder.available) {
    return (
      <StatusRow
        label="Folder unavailable"
        selected={folderSelected}
        onSelect={() => props.onSelectFolder(folder.path)}
      />
    )
  }
  if (!folder.initialized) {
    return (
      <StatusRow
        label="Setup required"
        selected={folderSelected}
        onSelect={() => props.onSelectFolder(folder.path)}
      />
    )
  }
  return (
    <>
      <Buckets {...props} />
      <Agents {...props} />
    </>
  )
}

/** A tracked folder: header (chevron, select, actions) and, when expanded, its body. */
export function FolderRow(props: FolderRowProps): JSX.Element {
  const { folder, selection, expansion } = props
  const expanded = expansion.isFolderExpanded(folder.path)
  const folderSelected =
    selection.folderPath === folder.path && selection.epicId === null && selection.chatId === undefined
  return (
    <div className="folder">
      <FolderHeader
        folder={folder}
        expanded={expanded}
        highlighted={folderSelected && canHoldEpics(folder)}
        waiting={waitingCount(props.chats.chats, props.statuses)}
        waitingFor={waitingReason(props.chats.chats, props.statuses)}
        onToggle={() => expansion.toggleFolder(folder.path)}
        onSelect={() => props.onSelectFolder(folder.path)}
        onStopTracking={() => props.onStopTracking(folder)}
      />
      {expanded ? <FolderBody {...props} folderSelected={folderSelected} /> : null}
    </div>
  )
}
