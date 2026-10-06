import { useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { CreateEpicInput } from '../../../shared/domain/api'
import type { BoardImportView, EpicDetailView, StorageStatusView } from '../../../shared/domain/views'
import type { EpicListState } from '../app/useEpicLists'
import { Button } from '../components/Button'
import { BoardImportCard } from './BoardImportCard'
import { BranchEpics } from './BranchEpics'
import { EpicBuckets } from './EpicBuckets'
import { HistorySearch } from './HistorySearch'
import { McpCard } from './McpCard'
import { NewEpicDialog } from './NewEpicDialog'
import { StorageCard } from './StorageCard'

interface FolderHomeProps {
  folder: TrackedFolderView
  list: EpicListState
  status: StorageStatusView | null
  busy: { flush: boolean; reconcile: boolean }
  onOpenEpic(epicId: string): void
  /** Resolves with the created epic, or null once the failure has been reported. */
  onCreateEpic(input: CreateEpicInput): Promise<EpicDetailView | null>
  onFlush(): void
  onReconcile(): void
  /** Imports the folder's old-style board; resolves with the result, or null once a failure was reported. */
  onImportBoard(): Promise<BoardImportView | null>
}

/**
 * An initialized folder with no epic open: its epics, history search, storage and MCP status, and
 * the import of an old-style board while the folder still has one.
 */
export function FolderHome(props: FolderHomeProps): JSX.Element {
  const { folder } = props
  const [creating, setCreating] = useState(false)
  const titles = Object.fromEntries(props.list.epics.map((epic) => [epic.id, epic.title]))
  return (
    <div className="home">
      <div className="home-actions">
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          New epic
        </Button>
      </div>
      <div className="home-grid">
        <div className="home-primary">
          <section className="home-section" aria-label="Epics">
            <EpicBuckets list={props.list} onOpenEpic={props.onOpenEpic} />
          </section>
          <HistorySearch folder={folder} onOpenEpic={props.onOpenEpic} />
        </div>
        <div className="home-secondary">
          <BoardImportCard
            folder={folder}
            version={props.list.epics.length}
            onImport={props.onImportBoard}
            onOpenEpic={props.onOpenEpic}
          />
          <StorageCard
            status={props.status}
            titles={titles}
            busy={props.busy}
            onFlush={props.onFlush}
            onReconcile={props.onReconcile}
          />
          <McpCard folder={folder} status={props.status} />
          <BranchEpics folder={folder} />
        </div>
      </div>
      {creating ? (
        <NewEpicDialog
          onClose={() => setCreating(false)}
          onSubmit={async (input) => (await props.onCreateEpic(input)) !== null}
        />
      ) : null}
    </div>
  )
}
