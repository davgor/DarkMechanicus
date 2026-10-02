import { useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { BoardImportView } from '../../../shared/domain/views'
import { useToasts } from '../app/toasts'
import { useBoardPreview } from '../app/useBoardPreview'
import { BoardPreview } from '../board/BoardPreview'
import { boardFound, importButtonLabel, newEpicCount } from '../board/boardImport'
import { Button } from '../components/Button'

interface BoardImportCardProps {
  folder: TrackedFolderView
  /** Changes when the folder's epics change, so the preview is read again. */
  version: number | string
  /** Resolves with what the import did, or null once the failure has been reported. */
  onImport(): Promise<BoardImportView | null>
  onOpenEpic(epicId: string): void
}

/** What is left to do once nothing new would be imported. */
function NothingNew({ view }: { view: BoardImportView }): JSX.Element | null {
  return view.open.length === 0 ? null : (
    <p className="note">Nothing new to import: every open epic was imported before.</p>
  )
}

/**
 * The folder's old-style Markdown `board/`, while it still has one: what an import brings in and,
 * after one, what it created. Hidden for folders without a board.
 */
export function BoardImportCard({ folder, version, onImport, onOpenEpic }: BoardImportCardProps): JSX.Element | null {
  const toasts = useToasts()
  const preview = useBoardPreview(folder.path, version, toasts.reportError)
  const [result, setResult] = useState<BoardImportView | null>(null)
  const [busy, setBusy] = useState(false)
  const view = result ?? (preview.status === 'ready' ? preview.value : null)
  if (view === null || !boardFound(view)) {
    return null
  }
  const count = newEpicCount(view)

  const importNow = async (): Promise<void> => {
    setBusy(true)
    try {
      const imported = await onImport()
      if (imported !== null) {
        setResult(imported)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card board-card" aria-label="Old-style board">
      <h2 className="card-title">Old-style board</h2>
      <p className="note">
        This repository still has a Markdown <code>board/</code>. Importing brings its open epics in as Backlog epics
        whose plans stay drafts until you review them and press Save. Board files are only read; nothing is committed.
      </p>
      <BoardPreview view={view} onOpenEpic={onOpenEpic} />
      {count > 0 ? (
        <div className="button-row">
          <Button variant="primary" icon="download" busy={busy} onClick={() => void importNow()}>
            {importButtonLabel(count)}
          </Button>
        </div>
      ) : (
        <NothingNew view={view} />
      )}
    </section>
  )
}
