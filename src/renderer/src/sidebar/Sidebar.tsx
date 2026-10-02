import type { ReactNode } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { AppVersionLabel } from '../autoUpdate/AppVersionLabel'
import type { Selection } from '../app/selection'
import { listFor } from '../app/useEpicLists'
import type { EpicListState } from '../app/useEpicLists'
import brandIcon1x from '../assets/brand-icon-32.png'
import brandIcon2x from '../assets/brand-icon-64.png'
import { Button } from '../components/Button'
import { FolderRow } from './FolderRow'
import type { Expansion } from './useExpansion'

interface SidebarProps {
  version: string
  folders: readonly TrackedFolderView[]
  lists: Record<string, EpicListState>
  selection: Selection
  expansion: Expansion
  /** Rendered at the bottom of the sidebar (status and update controls). */
  footer: ReactNode
  onTrack(): void
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

/** The left panel: tracked folders with their epic buckets, then the status footer. */
export function Sidebar(props: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar" aria-label="Tracked folders">
      <Brand version={props.version} />
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
            selection={props.selection}
            expansion={props.expansion}
            onSelectFolder={props.onSelectFolder}
            onSelectEpic={props.onSelectEpic}
            onStopTracking={props.onRequestUntrack}
          />
        ))}
      </nav>
      {props.footer}
    </aside>
  )
}
