import { useEffect, useMemo, useState } from 'react'
import type { GitResult } from '../../../shared/git/api'
import type { ConflictFile, ConflictKind, ConflictState } from '../../../shared/git/conflicts'
import type { FileChange, RepoStatus } from '../../../shared/git/status'
import { callGit } from '../api/git'
import { useResource } from '../app/useResource'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { splitPath } from './changeBadge'
import './conflicts.css'

const errorText = (error: unknown): string => (error instanceof Error ? error.message : 'Git did not answer.')

/** One empty map, so a folder switch does not hand the memos a new one on every render. */
const NOTHING_REMEMBERED: ReadonlyMap<string, ConflictFile> = new Map()

const KIND_LABELS: Record<ConflictKind, string | null> = {
  both_modified: null,
  both_added: 'Added on both sides',
  deleted_by_us: 'Deleted by us',
  deleted_by_them: 'Deleted by them',
  both_deleted: 'Deleted on both sides',
  added_by_us: 'Added by us',
  added_by_them: 'Added by them'
}

interface ConflictRowModel extends ConflictFile {
  /** It was conflicted during this operation and is no longer unmerged. */
  resolved: boolean
}

export interface ConflictsModel {
  /** An operation is in progress or files are unmerged, so the Conflicts panel shows. */
  active: boolean
  /** The last answer of `getConflicts`; null until the first arrives. */
  conflicts: ConflictState | null
  /** The conflicted files, resolved ones included, by path. */
  rows: ConflictRowModel[]
  /** The changed files the Conflicts panel does not list, for the Changes list. */
  otherFiles: FileChange[]
  /** Why the conflicts could not be read. */
  error: string | null
}

interface Remembered {
  folder: string
  files: ReadonlyMap<string, ConflictFile>
}

/** Every file seen conflicted while the operation lasts, so a resolved one stays listed as Resolved. */
function useRemembered(folder: string, active: boolean, current: ConflictState | null): ReadonlyMap<string, ConflictFile> {
  const [remembered, setRemembered] = useState<Remembered>({ folder, files: new Map() })
  useEffect(() => {
    setRemembered((previous) => {
      const base = previous.folder === folder && active ? previous.files : new Map<string, ConflictFile>()
      const added = (current?.files ?? []).filter((file) => !base.has(file.path))
      if (added.length === 0 && base === previous.files) {
        return previous
      }
      return { folder, files: new Map([...base, ...added.map((file) => [file.path, file] as const)]) }
    })
  }, [folder, active, current])
  return remembered.folder === folder ? remembered.files : NOTHING_REMEMBERED
}

function rowsOf(current: ConflictState | null, remembered: ReadonlyMap<string, ConflictFile>): ConflictRowModel[] {
  const open = new Map((current?.files ?? []).map((file) => [file.path, file] as const))
  const rows = [...open.values()].map((file) => ({ ...file, resolved: false }))
  for (const [path, file] of remembered) {
    if (!open.has(path)) {
      rows.push({ ...file, markers: 0, resolved: true })
    }
  }
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Counts the times `active` turned true, so each operation reads its conflicts afresh instead of seeing the last one's. */
function useActivation(active: boolean): number {
  const [activation, setActivation] = useState({ active, count: 0 })
  if (activation.active !== active) {
    setActivation({ active, count: activation.count + (active ? 1 : 0) })
  }
  return activation.count
}

/** The folder's conflicts, read again with every repository refresh while an operation or a conflict lasts. */
export function useConflicts(folder: string, status: RepoStatus, version: number): ConflictsModel {
  const active = status.inProgress !== null || status.files.some((file) => file.kind === 'conflicted')
  const activation = useActivation(active)
  const [error, setError] = useState<string | null>(null)
  const loaded = useResource<ConflictState>({
    key: active ? `${folder}\u0000${activation}` : null,
    version,
    load: () =>
      callGit(window.git.getConflicts(folder)).then((value) => {
        setError(null)
        return value
      }),
    onError: (failure) => setError(errorText(failure))
  })
  const conflicts = active && loaded.status === 'ready' ? loaded.value : null
  const remembered = useRemembered(folder, active, conflicts)
  const rows = useMemo(() => (active ? rowsOf(conflicts, remembered) : []), [active, conflicts, remembered])
  const otherFiles = useMemo(() => {
    const listed = new Set(rows.map((row) => row.path))
    return status.files.filter((file) => file.kind !== 'conflicted' && !listed.has(file.path))
  }, [rows, status.files])
  return { active, conflicts, rows, otherFiles, error: active ? error : null }
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** How the banner names an operation other than a merge, whose Abort runs `git <operation> --abort`. */
const OPERATION_NAMES: Record<Exclude<RepoStatus['inProgress'], null | 'merge'>, string> = {
  rebase: 'A rebase',
  am: 'Applying patches (git am)',
  'cherry-pick': 'A cherry-pick',
  revert: 'A revert'
}

type Run = (what: string, call: () => Promise<GitResult<unknown>>) => void

interface Side {
  label: string
  /** What git calls it: while a rebase replays a commit, the commit (the person's) is `theirs`. */
  side: 'ours' | 'theirs'
}

interface Sides {
  mine: Side
  theirs: Side
}

interface ConflictRowProps {
  row: ConflictRowModel
  sides: Sides
  /** The status entry of the file, whose diff selecting it shows; null when git no longer lists it. */
  change: FileChange | null
  selected: boolean
  busy: boolean
  folderPath: string
  onSelect(file: FileChange): void
  run: Run
}

function ConflictActions({ row, sides, busy, folderPath, run }: Omit<ConflictRowProps, 'change' | 'selected' | 'onSelect'>): JSX.Element {
  const { path } = row
  return (
    <div className="source-conflict-actions">
      <Button size="sm" disabled={busy} onClick={() => run(path, () => window.git.openInEditor(folderPath, path))}>
        Open in editor
      </Button>
      {[sides.mine, sides.theirs].map(({ label, side }) => (
        <Button key={label} size="sm" disabled={busy} onClick={() => run(path, () => window.git.resolveWith(folderPath, { path, side }))}>
          {label}
        </Button>
      ))}
      <Button size="sm" disabled={busy || row.markers > 0} onClick={() => run(path, () => window.git.markResolved(folderPath, { path }))}>
        Mark resolved
      </Button>
    </div>
  )
}

function ConflictRow(props: ConflictRowProps): JSX.Element {
  const { row, change, selected, onSelect } = props
  const { dir, name } = splitPath(row.path)
  const kindLabel = KIND_LABELS[row.kind]
  return (
    <li className={`source-conflict${row.resolved ? ' source-conflict-resolved' : ''}`}>
      <button type="button" className="source-file" aria-pressed={selected} disabled={change === null} onClick={() => change !== null && onSelect(change)}>
        <span className="source-file-text">
          <span className="source-file-path">
            <span className="source-dir">{dir}</span>
            <span className="source-name">{name}</span>
          </span>
        </span>
        {row.resolved ? null : (
          <span className="source-badge source-badge-conflicted" title="Conflicted" aria-label="Conflicted">
            !
          </span>
        )}
      </button>
      <div className="source-conflict-state">
        <span className="source-conflict-count">{row.resolved ? 'Resolved' : plural(row.markers, 'conflict', 'conflicts')}</span>
        {kindLabel === null || row.resolved ? null : <span className="muted">{kindLabel}</span>}
      </div>
      {row.resolved ? null : <ConflictActions {...props} />}
    </li>
  )
}

function AbortMergeDialog({ folderPath, onClose, onDone }: { folderPath: string; onClose(): void; onDone(): void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const abort = (): void => {
    setBusy(true)
    setFailure(null)
    callGit(window.git.abortMerge(folderPath)).then(onDone, (error: unknown) => {
      setBusy(false)
      setFailure(errorText(error))
    })
  }
  return (
    <Dialog
      title="Abort the merge?"
      description="Your branch goes back to where it was before the merge, and the conflicts resolved so far are lost."
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" busy={busy} onClick={abort}>
            Abort merge
          </Button>
        </>
      }
    >
      {failure === null ? null : <p role="alert">{failure}</p>}
    </Dialog>
  )
}

interface BannerProps {
  status: RepoStatus
  model: ConflictsModel
  busy: string | null
  folderPath: string
  run: Run
  onAbortMerge(): void
}

function ConflictBanner({ status, model, busy, folderPath, run, onAbortMerge }: BannerProps): JSX.Element {
  const unresolved = model.rows.filter((row) => !row.resolved).length
  const operation = status.inProgress
  if (operation === null) {
    return <p className="source-conflict-banner-text source-conflict-heading">{plural(unresolved, 'conflicted file', 'conflicted files')}</p>
  }
  if (operation !== 'merge') {
    return (
      <div className="source-conflict-banner" role="region" aria-label="Operation in progress">
        <p className="source-conflict-banner-text">{OPERATION_NAMES[operation]} is in progress. Finish it in a terminal, or abort it here.</p>
        <div className="source-conflict-actions">
          <Button size="sm" variant="danger" busy={busy === 'abort'} onClick={() => run('abort', () => window.git.abortOperation(folderPath))}>
            Abort
          </Button>
        </div>
      </div>
    )
  }
  const their = model.conflicts?.theirLabel ?? 'another branch'
  const ours = model.conflicts?.ourBranch ?? 'the current commit'
  return (
    <div className="source-conflict-banner" role="region" aria-label="Merge in progress">
      <p className="source-conflict-banner-text">{`Merging ${their} into ${ours}: ${plural(unresolved, 'conflicted file', 'conflicted files')}`}</p>
      <div className="source-conflict-actions">
        <Button size="sm" variant="danger" disabled={busy !== null} onClick={onAbortMerge}>
          Abort merge
        </Button>
        <Button
          size="sm"
          variant="primary"
          busy={busy === 'commit'}
          disabled={busy !== null || model.conflicts === null || unresolved > 0}
          onClick={() => run('commit', () => window.git.commitMerge(folderPath, {}))}
        >
          Commit merge
        </Button>
      </div>
    </div>
  )
}

interface ConflictsPanelProps {
  folderPath: string
  status: RepoStatus
  model: ConflictsModel
  /** The path of the file whose diff shows. */
  selectedPath: string | null
  onSelect(file: FileChange): void
  /** Reads the repository state again. */
  onRefresh(): void
}

/**
 * Mine is git's side `mineSide` names (main decides it: `theirs` while a rebase replays a commit, else `ours`) and
 * theirs the other. `ourBranch` names git's `ours` and `theirLabel` (MERGE_MSG) git's `theirs`. Buttons only show on
 * unresolved rows, which exist only once the conflicts are read.
 */
function sidesOf(conflicts: ConflictState | null): Sides {
  const ours = conflicts?.ourBranch ?? null
  const theirs = conflicts?.theirLabel ?? null
  const named = (word: string, name: string | null): string => (name === null ? word : `${word} (${name})`)
  if (conflicts?.mineSide === 'theirs') {
    return { mine: { label: named('Use mine', theirs), side: 'theirs' }, theirs: { label: named('Use theirs', ours), side: 'ours' } }
  }
  return { mine: { label: named('Use mine', ours), side: 'ours' }, theirs: { label: named('Use theirs', theirs), side: 'theirs' } }
}

/**
 * Above the Changes list while a merge, rebase, git am, cherry-pick or revert is in progress or files are unmerged (a
 * stash restore): the banner for the operation, then each conflicted file with its marker count and the ways to resolve
 * it.
 */
export function ConflictsPanel({ folderPath, status, model, selectedPath, onSelect, onRefresh }: ConflictsPanelProps): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [aborting, setAborting] = useState(false)
  const run: Run = (what, call) => {
    setBusy(what)
    setFailure(null)
    callGit(call()).then(
      () => setBusy(null),
      (error: unknown) => {
        setBusy(null)
        setFailure(errorText(error))
      }
    ).finally(onRefresh)
  }
  const sides = sidesOf(model.conflicts)
  const message = failure ?? model.error
  return (
    <div className="source-conflicts">
      <ConflictBanner status={status} model={model} busy={busy} folderPath={folderPath} run={run} onAbortMerge={() => setAborting(true)} />
      {message === null ? null : <p role="alert" className="source-conflict-error">{message}</p>}
      <ul className="source-files" aria-label="Conflicted files">
        {model.rows.map((row) => {
          const change = status.files.find((file) => file.path === row.path) ?? null
          return (
            <ConflictRow key={row.path} row={row} sides={sides} change={change} selected={selectedPath === row.path} busy={busy !== null} folderPath={folderPath} onSelect={onSelect} run={run} />
          )
        })}
      </ul>
      {aborting ? (
        <AbortMergeDialog
          folderPath={folderPath}
          onClose={() => setAborting(false)}
          onDone={() => {
            setAborting(false)
            onRefresh()
          }}
        />
      ) : null}
    </div>
  )
}
