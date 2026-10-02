import { useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type {
  BoardKeptPathView,
  BoardMentionView,
  BoardRemovalResultView,
  BoardRemovalView
} from '../../../shared/domain/views'
import { plural } from '../app/plural'
import { useToasts } from '../app/toasts'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { describeBoardRemoval, groupByFolder, mentionedLines } from './removalText'

interface BoardRemovalProps {
  folder: TrackedFolderView
  /** Told once the confirmed files were deleted. */
  onRemoved?(result: BoardRemovalResultView): void
}

type Step =
  | { kind: 'offer'; loading: boolean }
  | { kind: 'review'; plan: BoardRemovalView; confirming: boolean; removing: boolean }
  | { kind: 'done'; result: BoardRemovalResultView }

function FilesToDelete({ paths }: { paths: string[] }): JSX.Element {
  return (
    <section className="board-group" aria-label="Files to delete">
      <h4 className="board-group-title">
        Will be deleted <span className="board-count">{paths.length}</span>
      </h4>
      {paths.length === 0 ? (
        <p className="note">Nothing to delete: no file of the old workflow is left.</p>
      ) : (
        <ul className="removal-groups">
          {groupByFolder(paths).map((group) => (
            <li key={group.folder} className="removal-group">
              <span className="removal-folder mono">{group.folder}</span>
              <ul className="removal-files">
                {group.files.map((file) => (
                  <li key={file} className="removal-file mono">
                    {file}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function KeptPaths({ kept }: { kept: BoardKeptPathView[] }): JSX.Element | null {
  return kept.length === 0 ? null : (
    <section className="board-group" aria-label="Left in place">
      <h4 className="board-group-title">
        Left in place <span className="board-count">{kept.length}</span>
      </h4>
      <ul className="board-list">
        {kept.map((item) => (
          <li key={`${item.path} ${item.reason}`} className="board-skipped">
            <span className="mono">{item.path}</span> <span className="board-reason">{item.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function EditByHand({ mentions }: { mentions: BoardMentionView[] }): JSX.Element | null {
  return mentions.length === 0 ? null : (
    <section className="board-group" aria-label="Still mentions the board, edit by hand">
      <h4 className="board-group-title">
        Still mentions the board, edit by hand <span className="board-count">{mentions.length}</span>
      </h4>
      <p className="note">
        These are never deleted. Change them to point at Dark Mechanicus instead of <code>board/</code>.
      </p>
      <ul className="board-list">
        {mentions.map((mention) => (
          <li key={mention.path} className="board-skipped">
            <span className="mono">{mention.path}</span>{' '}
            <span className="board-reason">{mentionedLines(mention.lines)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

interface ConfirmProps {
  folder: TrackedFolderView
  count: number
  busy: boolean
  onConfirm(): void
  onCancel(): void
}

/** The last step before anything is deleted. */
function ConfirmRemoval({ folder, count, busy, onConfirm, onCancel }: ConfirmProps): JSX.Element {
  const files = plural(count, 'file')
  return (
    <Dialog
      title={`Delete ${files}?`}
      description="Deletes exactly the files listed, then the folders this leaves empty. Deleted files can be recovered from Git history only if they were committed. Nothing is committed for you."
      onClose={busy ? () => undefined : onCancel}
      actions={
        <>
          <Button disabled={busy} onClick={onCancel}>
            Keep them
          </Button>
          <Button variant="danger" busy={busy} onClick={onConfirm}>
            {`Delete ${files}`}
          </Button>
        </>
      }
    >
      <p className="mono dialog-path">{folder.displayPath}</p>
    </Dialog>
  )
}

function Removed({ result }: { result: BoardRemovalResultView }): JSX.Element {
  return (
    <>
      <p className="note">
        Removed {plural(result.removed.length, 'file')} and {plural(result.removedFolders.length, 'folder')}. Nothing
        was committed: review the deletions in Git and commit them when you are ready.
      </p>
      <KeptPaths kept={result.kept} />
      <EditByHand mentions={result.editByHand} />
    </>
  )
}

/** Loads the list on request, and deletes it once confirmed. */
function useBoardRemoval(folder: TrackedFolderView, onRemoved: BoardRemovalProps['onRemoved']) {
  const toasts = useToasts()
  const [step, setStep] = useState<Step>({ kind: 'offer', loading: false })

  const review = async (): Promise<void> => {
    setStep({ kind: 'offer', loading: true })
    try {
      const plan = await window.dm.previewBoardRemoval(folder.path)
      setStep({ kind: 'review', plan, confirming: false, removing: false })
    } catch (error) {
      toasts.reportError(error)
      setStep({ kind: 'offer', loading: false })
    }
  }

  const remove = async (plan: BoardRemovalView): Promise<void> => {
    setStep({ kind: 'review', plan, confirming: true, removing: true })
    try {
      const result = await window.dm.removeBoardFiles(folder.path, plan.remove)
      setStep({ kind: 'done', result })
      const notice = describeBoardRemoval(result)
      toasts.push(notice.tone, notice.message)
      onRemoved?.(result)
    } catch (error) {
      toasts.reportError(error)
      setStep({ kind: 'review', plan, confirming: false, removing: false })
    }
  }

  return { step, setStep, review, remove }
}

/**
 * Offers to remove the old board workflow once nothing on the board is left to import: lists every
 * file it would delete and the files to edit by hand, and deletes only after a confirmation.
 */
export function BoardRemoval({ folder, onRemoved }: BoardRemovalProps): JSX.Element {
  const { step, setStep, review, remove } = useBoardRemoval(folder, onRemoved)
  return (
    <section className="board-removal" aria-label="Remove the old board workflow">
      <h3 className="card-subtitle">Remove the old workflow files</h3>
      {step.kind === 'offer' ? (
        <>
          <p className="note">
            Nothing on the board is left to import, so <code>board/</code> and the board-only skills (
            <code>complete-ticket</code>, <code>collapse-epic</code>) are no longer needed. You see every file before
            anything is deleted, and nothing is committed.
          </p>
          <div className="button-row">
            <Button icon="file" busy={step.loading} onClick={() => void review()}>
              Review files to remove
            </Button>
          </div>
        </>
      ) : null}
      {step.kind === 'review' ? (
        <>
          <FilesToDelete paths={step.plan.remove} />
          <KeptPaths kept={step.plan.kept} />
          <EditByHand mentions={step.plan.editByHand} />
          <div className="button-row">
            {step.plan.remove.length > 0 ? (
              <Button variant="danger" onClick={() => setStep({ ...step, confirming: true })}>
                {`Delete ${plural(step.plan.remove.length, 'file')}…`}
              </Button>
            ) : null}
            <Button onClick={() => setStep({ kind: 'offer', loading: false })}>Not now</Button>
          </div>
          {step.confirming ? (
            <ConfirmRemoval
              folder={folder}
              count={step.plan.remove.length}
              busy={step.removing}
              onConfirm={() => void remove(step.plan)}
              onCancel={() => setStep({ ...step, confirming: false })}
            />
          ) : null}
        </>
      ) : null}
      {step.kind === 'done' ? <Removed result={step.result} /> : null}
    </section>
  )
}
