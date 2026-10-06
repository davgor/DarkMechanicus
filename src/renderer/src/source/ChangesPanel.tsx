import { useEffect, useRef, useState } from 'react'
import type { FileChange, RepoStatus } from '../../../shared/git/status'
import { callGit } from '../api/git'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { Menu } from '../components/Menu'
import { badgeOf, splitPath } from './changeBadge'
import { CommitBox } from './CommitBox'
import type { CommittedInfo } from './CommitBox'
import { useInclusion } from './useInclusion'
import type { InclusionModel } from './useInclusion'

export const fileKey = (file: FileChange): string => `${file.kind}\u0000${file.path}`

const errorText = (error: unknown): string => (error instanceof Error ? error.message : 'Git did not answer.')

function trashName(): string {
  return /mac/i.test(navigator.platform) ? 'Trash' : 'Recycle Bin'
}

interface FileRowProps {
  file: FileChange
  selected: boolean
  inclusion: InclusionModel
  onSelect(): void
  onDiscard(): void
}

function FileRow({ file, selected, inclusion, onSelect, onDiscard }: FileRowProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const { dir, name } = splitPath(file.path)
  const badge = badgeOf(file.kind)
  return (
    <li
      className="source-row"
      onContextMenu={(event) => {
        event.preventDefault()
        setMenuOpen(true)
      }}
    >
      <input
        type="checkbox"
        className="source-check"
        aria-label={`Include ${file.path}`}
        checked={inclusion.of(file.path) !== 'none'}
        onChange={() => inclusion.toggle(file.path)}
      />
      <button type="button" className="source-file" aria-pressed={selected} onClick={onSelect}>
        <span className="source-file-text">
          <span className="source-file-path">
            <span className="source-dir">{dir}</span>
            <span className="source-name">{name}</span>
          </span>
          {file.oldPath === null ? null : <span className="source-old muted">{file.oldPath}</span>}
        </span>
        <span className={`source-badge source-badge-${file.kind}`} title={badge.label} aria-label={badge.label}>
          {badge.letter}
        </span>
      </button>
      <Menu
        label="File actions"
        open={menuOpen}
        onOpenChange={setMenuOpen}
        items={[
          { id: 'discard', label: 'Discard changes…', onSelect: onDiscard },
          { id: 'copy', label: 'Copy file path', onSelect: () => void window.dm.copyText(file.path) }
        ]}
      />
    </li>
  )
}

function HeaderCheckbox({ count, inclusion }: { count: number; inclusion: InclusionModel }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const label = `${count} changed ${count === 1 ? 'file' : 'files'}`
  useEffect(() => {
    if (ref.current !== null) {
      ref.current.indeterminate = inclusion.header === 'some'
    }
  }, [inclusion.header])
  return (
    <label className="source-heading-check">
      <input ref={ref} type="checkbox" checked={inclusion.header === 'all'} onChange={inclusion.toggleAll} disabled={count === 0} />
      <span>{label}</span>
    </label>
  )
}

interface DiscardDialogProps {
  files: readonly FileChange[]
  folderPath: string
  onClose(): void
  onDone(): void
}

function DiscardDialog({ files, folderPath, onClose, onDone }: DiscardDialogProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const discard = (): void => {
    setBusy(true)
    setFailure(null)
    callGit(window.git.discardChanges(folderPath, { files: [...files] })).then(
      () => {
        setBusy(false)
        onDone()
      },
      (error: unknown) => {
        setBusy(false)
        setFailure(errorText(error))
      }
    )
  }
  return (
    <Dialog
      title="Discard changes?"
      description={`These changes will be moved to the ${trashName()}.`}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" busy={busy} onClick={discard}>
            Discard changes
          </Button>
        </>
      }
    >
      <ul className="source-discard-files">
        {files.map((file) => (
          <li key={fileKey(file)} className="mono">
            {file.path}
          </li>
        ))}
      </ul>
      {failure === null ? null : <p role="alert">{failure}</p>}
    </Dialog>
  )
}

/** The commit just made stays undoable while HEAD is still it (or not yet read) and it is not pushed. */
function undoable(committed: CommittedInfo | null, status: RepoStatus): committed is CommittedInfo {
  if (committed === null) {
    return false
  }
  const { headOid, upstream, ahead } = status.branch
  if (headOid !== committed.oid && headOid !== committed.headBefore) {
    return false
  }
  return !(headOid === committed.oid && upstream !== null && ahead === 0)
}

interface UndoStripProps {
  committed: CommittedInfo
  folderPath: string
  onUndone(message: { summary: string; description: string }): void
}

function UndoStrip({ committed, folderPath, onUndone }: UndoStripProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const undo = (): void => {
    setBusy(true)
    setFailure(null)
    callGit(window.git.undoLastCommit(folderPath)).then(
      (message) => {
        setBusy(false)
        onUndone(message)
      },
      (error: unknown) => {
        setBusy(false)
        setFailure(errorText(error))
      }
    )
  }
  return (
    <div className="source-undo">
      <span className="source-undo-text">Committed just now: {committed.summary}</span>
      <Button size="sm" busy={busy} onClick={undo}>
        Undo
      </Button>
      {failure === null ? null : <p role="alert">{failure}</p>}
    </div>
  )
}

interface ChangesListProps {
  files: readonly FileChange[]
  inclusion: InclusionModel
  selected: string | null
  onSelect(key: string): void
  onDiscard(files: readonly FileChange[]): void
}

function ChangesList({ files, inclusion, selected, onSelect, onDiscard }: ChangesListProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div className="source-changes-top">
      <div className="source-changes-header">
        <HeaderCheckbox count={files.length} inclusion={inclusion} />
        {files.length === 0 ? null : (
          <Menu
            label="Changes actions"
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={[{ id: 'discard-all', label: 'Discard all changes…', onSelect: () => onDiscard(files) }]}
          />
        )}
      </div>
      {files.length === 0 ? (
        <p className="muted source-clean">No local changes</p>
      ) : (
        <ul className="source-files">
          {files.map((file) => (
            <FileRow
              key={fileKey(file)}
              file={file}
              selected={selected === fileKey(file)}
              inclusion={inclusion}
              onSelect={() => onSelect(fileKey(file))}
              onDiscard={() => onDiscard([file])}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

interface ChangesPanelProps {
  folderPath: string
  status: RepoStatus
  selected: string | null
  onSelect(key: string): void
  /** Reads the repository state again. */
  onRefresh(): void
}

/** The left column's Changes: files with checkboxes, discard, the undo strip and the commit box. */
export function ChangesPanel({ folderPath, status, selected, onSelect, onRefresh }: ChangesPanelProps): JSX.Element {
  const inclusion = useInclusion(folderPath, status.files)
  const [discarding, setDiscarding] = useState<readonly FileChange[] | null>(null)
  const [draft, setDraft] = useState({ summary: '', description: '' })
  const [committed, setCommitted] = useState<CommittedInfo | null>(null)
  const undone = (message: { summary: string; description: string }): void => {
    setCommitted(null)
    setDraft(message)
    onRefresh()
  }
  return (
    <section className="source-changes" aria-label="Changes">
      <ChangesList files={status.files} inclusion={inclusion} selected={selected} onSelect={onSelect} onDiscard={setDiscarding} />
      <div className="source-changes-bottom">
        {undoable(committed, status) ? <UndoStrip committed={committed} folderPath={folderPath} onUndone={undone} /> : null}
        <CommitBox
          folderPath={folderPath}
          branchName={status.branch.name}
          headOid={status.branch.headOid}
          included={inclusion.included}
          summary={draft.summary}
          description={draft.description}
          onChange={setDraft}
          onCommitted={(info) => {
            setCommitted(info)
            onRefresh()
          }}
        />
      </div>
      {discarding === null ? null : (
        <DiscardDialog
          files={discarding}
          folderPath={folderPath}
          onClose={() => setDiscarding(null)}
          onDone={() => {
            setDiscarding(null)
            onRefresh()
          }}
        />
      )}
    </section>
  )
}
