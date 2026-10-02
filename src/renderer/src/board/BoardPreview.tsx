import type { BoardImportView, BoardOpenEpicView } from '../../../shared/domain/views'
import { plural } from '../app/plural'
import { Button } from '../components/Button'

interface BoardPreviewProps {
  view: BoardImportView
  /** Show the done epics unfolded (onboarding); the folder home keeps them folded. */
  doneExpanded?: boolean
  /** Offered for open epics an import created, now or earlier. */
  onOpenEpic?(epicId: string): void
}

const STATE_PILL: Record<BoardOpenEpicView['state'], { label: string; tone: string }> = {
  new: { label: 'To import', tone: 'pill-ready' },
  created: { label: 'Imported now', tone: 'pill-accepted' },
  imported: { label: 'Already imported', tone: 'pill-waiting' }
}

function ticketSummary(epic: BoardOpenEpicView): string {
  const done = epic.doneTickets.length > 0 ? ` · ${epic.doneTickets.length} done on the board` : ''
  return `${plural(epic.ticketCount, 'open ticket')}${done}`
}

function sourceOf(epic: BoardOpenEpicView): string {
  return epic.sourcePath ?? `${plural(epic.sourcePaths.length, 'ticket file')}, no epic file`
}

function OpenEpicRow({ epic, onOpenEpic }: { epic: BoardOpenEpicView; onOpenEpic?(epicId: string): void }): JSX.Element {
  const pill = STATE_PILL[epic.state]
  const { epicId } = epic
  return (
    <li className="board-epic">
      <span className="board-id mono">{epic.boardId}</span>
      <span className="board-epic-head">
        <span className="board-epic-title">{epic.title}</span>
        <span className={`pill ${pill.tone}`}>{pill.label}</span>
      </span>
      <span className="board-epic-meta">{ticketSummary(epic)}</span>
      <span className="board-path mono">{sourceOf(epic)}</span>
      {onOpenEpic === undefined || epicId === null ? null : (
        <Button variant="ghost" size="sm" className="board-open" onClick={() => onOpenEpic(epicId)}>
          Open epic
        </Button>
      )}
    </li>
  )
}

function OpenEpics({ epics, onOpenEpic }: { epics: BoardOpenEpicView[]; onOpenEpic?(epicId: string): void }): JSX.Element {
  return (
    <section className="board-group" aria-label="Open epics">
      <h3 className="board-group-title">
        Open epics <span className="board-count">{epics.length}</span>
      </h3>
      {epics.length === 0 ? (
        <p className="note">None: every epic on the board is done.</p>
      ) : (
        <ul className="board-list">
          {epics.map((epic) => (
            <OpenEpicRow key={epic.boardId} epic={epic} onOpenEpic={onOpenEpic} />
          ))}
        </ul>
      )}
    </section>
  )
}

function DoneEpics({ epics, expanded }: { epics: BoardImportView['done']; expanded: boolean }): JSX.Element {
  return (
    <details className="board-group" aria-label="Done epics" open={expanded}>
      <summary className="board-group-title">
        Done epics <span className="board-count">{epics.length}</span>
        <span className="board-group-note">left in Git history, not imported</span>
      </summary>
      <ul className="board-list board-done">
        {epics.map((epic) => (
          <li key={epic.boardId} className="board-done-epic">
            <span className="board-id mono">{epic.boardId}</span>
            <span>{epic.title}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

function SkippedFiles({ files }: { files: BoardImportView['skipped'] }): JSX.Element {
  return (
    <section className="board-group" aria-label="Skipped files">
      <h3 className="board-group-title">
        Skipped files <span className="board-count">{files.length}</span>
      </h3>
      {files.length === 0 ? (
        <p className="note">None: every file in board/ was read.</p>
      ) : (
        <ul className="board-list">
          {files.map((file) => (
            <li key={file.path} className="board-skipped">
              <span className="mono">{file.path}</span> <span className="board-reason">{file.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** What importing an old-style board does: its open epics, the done ones it leaves alone, and skipped files. */
export function BoardPreview({ view, doneExpanded = false, onOpenEpic }: BoardPreviewProps): JSX.Element {
  return (
    <div className="board-preview">
      <OpenEpics epics={view.open} onOpenEpic={onOpenEpic} />
      <DoneEpics epics={view.done} expanded={doneExpanded} />
      <SkippedFiles files={view.skipped} />
    </div>
  )
}
