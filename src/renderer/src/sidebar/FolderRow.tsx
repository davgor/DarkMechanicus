import { useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { Selection } from '../app/selection'
import type { EpicListState } from '../app/useEpicLists'
import { classNames } from '../components/classNames'
import { Icon } from '../components/Icon'
import { Menu } from '../components/Menu'
import { BucketGroup } from './BucketGroup'
import { groupEpics } from './buckets'
import type { Expansion } from './useExpansion'

interface FolderRowProps {
  folder: TrackedFolderView
  list: EpicListState
  selection: Selection
  expansion: Expansion
  onSelectFolder(path: string): void
  onSelectEpic(path: string, epicId: string): void
  onStopTracking(folder: TrackedFolderView): void
}

/** A folder can hold epics only when it is reachable and initialized. */
const canHoldEpics = (folder: TrackedFolderView): boolean => folder.available && folder.initialized

interface HeaderProps {
  folder: TrackedFolderView
  expanded: boolean
  highlighted: boolean
  onToggle(): void
  onSelect(): void
  onStopTracking(): void
}

function FolderHeader(props: HeaderProps): JSX.Element {
  const { folder, expanded, highlighted } = props
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
          <span className="folder-name">{folder.name}</span>{' '}
          <span className="folder-path mono">{folder.displayPath}</span>
        </span>
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
  return <Buckets {...props} />
}

/** A tracked folder: header (chevron, select, actions) and, when expanded, its body. */
export function FolderRow(props: FolderRowProps): JSX.Element {
  const { folder, selection, expansion } = props
  const expanded = expansion.isFolderExpanded(folder.path)
  const folderSelected = selection.folderPath === folder.path && selection.epicId === null
  return (
    <div className="folder">
      <FolderHeader
        folder={folder}
        expanded={expanded}
        highlighted={folderSelected && canHoldEpics(folder)}
        onToggle={() => expansion.toggleFolder(folder.path)}
        onSelect={() => props.onSelectFolder(folder.path)}
        onStopTracking={() => props.onStopTracking(folder)}
      />
      {expanded ? <FolderBody {...props} folderSelected={folderSelected} /> : null}
    </div>
  )
}
