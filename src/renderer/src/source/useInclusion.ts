import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CommitRequest } from '../../../shared/git/api'
import { changedLineIndices } from '../../../shared/git/diff'
import type { FileDiff } from '../../../shared/git/diff'
import type { FileChange } from '../../../shared/git/status'
import { callGit } from '../api/git'
import { useLatest } from '../app/useLatest'
import { useToasts } from '../app/toasts'
import type { LineSelection } from './DiffView'

/** Chosen changed lines (`changedLineIndices` numbering) of the diff with this hash; never all and never none. */
interface PartialInclusion {
  hash: string
  lines: ReadonlySet<number>
}

/** How much of a file a commit takes. */
type Inclusion = 'all' | 'none' | PartialInclusion

/** What a file's checkbox shows: checked, unchecked, or indeterminate for chosen lines. */
type FileInclusion = 'all' | 'none' | 'partial'

/** What the header checkbox shows: every file whole, nothing, or anything in between. */
type HeaderInclusion = 'all' | 'some' | 'none'

type Overrides = ReadonlyMap<string, Inclusion>

export interface InclusionModel {
  /** Whether (and how much of) a file is included. Files not seen before are `all`. */
  of(path: string): FileInclusion
  /** Includes a file that is left out or partly included; leaves out a file that is included whole. */
  toggle(path: string): void
  /** Includes every file whole when not all are, otherwise none. */
  toggleAll(): void
  header: HeaderInclusion
  /** The files a commit would take: everything not `none`. */
  included: FileChange[]
  /** The commit request's files: whole files, and partly included ones with their `lines` and `diffHash`. */
  commitFiles: CommitRequest['files']
  /** The line selection in a listed file's text diff; undefined for other diffs. */
  selectionOf(path: string, diff: FileDiff): LineSelection | undefined
  /** Resets a partly included file to `all`, with a toast, when its diff is no longer the one its lines were chosen in. */
  observe(path: string, diff: FileDiff): void
  /** Reads every partly included file's diff again and resets those that changed; resolves to how many did. */
  recheck(): Promise<number>
  /** Forgets every line selection without a toast, as after a commit took the chosen lines. */
  clearLines(): void
}

interface Stored {
  folder: string
  /** Only the files that deviate from the default (`all`). */
  overrides: Overrides
}

const NO_OVERRIDES: Overrides = new Map()

const isPartial = (inclusion: Inclusion | undefined): inclusion is PartialInclusion => typeof inclusion === 'object'

function changedCount(diff: Extract<FileDiff, { kind: 'text' }>): number {
  return changedLineIndices(diff).reduce((sum, hunk) => sum + hunk.filter((index) => index !== null).length, 0)
}

/** One file's text diff as a line selection sees it: its hash and how many changed lines it has. */
interface DiffShape {
  hash: string
  count: number
}

/** The lines shown as chosen: a selection made in an older diff counts as all, since it is about to be reset. */
function selectedIn(inclusion: Inclusion | undefined, { hash, count }: DiffShape): ReadonlySet<number> {
  if (inclusion === 'none') return new Set()
  if (isPartial(inclusion) && inclusion.hash === hash) return inclusion.lines
  return new Set(Array.from({ length: count }, (_, index) => index))
}

/** The inclusion after toggling `indices`: whole or nothing when every line or none is left chosen. */
function toggledLines(base: ReadonlySet<number>, indices: readonly number[], include: boolean, { hash, count }: DiffShape): Inclusion {
  const lines = new Set(base)
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= count) continue
    if (include) lines.add(index)
    else lines.delete(index)
  }
  if (lines.size === count) return 'all'
  return lines.size === 0 ? 'none' : { hash, lines }
}

function withInclusion(overrides: Overrides, path: string, inclusion: Inclusion): Map<string, Inclusion> {
  const next = new Map(overrides)
  if (inclusion === 'all') next.delete(path)
  else next.set(path, inclusion)
  return next
}

function commitEntry(file: FileChange, inclusion: Inclusion | undefined): CommitRequest['files'][number] {
  if (!isPartial(inclusion)) return { path: file.path, oldPath: file.oldPath }
  return { path: file.path, oldPath: file.oldPath, lines: [...inclusion.lines].sort((a, b) => a - b), diffHash: inclusion.hash }
}

function headerOf(files: readonly FileChange[], overrides: Overrides): HeaderInclusion {
  if (files.every((file) => overrides.get(file.path) === 'none')) return 'none'
  return files.every((file) => !overrides.has(file.path)) ? 'all' : 'some'
}

/**
 * The overrides of one folder, mirrored in a ref so that checks resolving outside a render (diff reads)
 * see the newest state and never reset or toast a file twice.
 */
interface StoredModel {
  overrides: Overrides
  current(): Overrides
  update(change: (previous: Overrides) => Overrides): void
}

function useStored(folder: string, files: readonly FileChange[]): StoredModel {
  const [stored, setStored] = useState<Stored>({ folder, overrides: NO_OVERRIDES })
  const latest = useRef(stored)
  const current = useCallback((): Overrides => (latest.current.folder === folder ? latest.current.overrides : NO_OVERRIDES), [folder])
  const update = useCallback(
    (change: (previous: Overrides) => Overrides) => {
      latest.current = { folder, overrides: change(current()) }
      setStored(latest.current)
    },
    [folder, current]
  )
  useEffect(() => {
    const present = new Set(files.map((file) => file.path))
    const previous = current()
    if (latest.current.folder === folder && [...previous.keys()].every((path) => present.has(path))) return
    update(() => new Map([...previous].filter(([path]) => present.has(path))))
  }, [folder, files, current, update])
  return { overrides: stored.folder === folder ? stored.overrides : NO_OVERRIDES, current, update }
}

type Observe = (path: string, diff: FileDiff) => boolean

/** Resets a partial file whose diff hash changed, with a toast; a too-large diff (no hash) says nothing. */
function useObserve({ current, update }: Pick<StoredModel, 'current' | 'update'>): Observe {
  const toasts = useToasts()
  return useCallback(
    (path: string, diff: FileDiff): boolean => {
      const inclusion = current().get(path)
      if (!isPartial(inclusion) || diff.kind === 'too_large' || inclusion.hash === diff.hash) return false
      update((previous) => withInclusion(previous, path, 'all'))
      toasts.push('info', `${path} changed, so its line selection was reset`)
      return true
    },
    [current, update, toasts]
  )
}

/** Reads the diff of every partly included file (as a commit would: forced) and passes it to `observe`. */
async function checkPartials(folder: string, partial: readonly FileChange[], observe: Observe, live: () => boolean): Promise<number> {
  const outcomes = await Promise.all(
    partial.map((file) =>
      callGit(window.git.getWorkingDiff(folder, { path: file.path, oldPath: file.oldPath, kind: file.kind, force: true })).then(
        (diff) => live() && observe(file.path, diff),
        () => false
      )
    )
  )
  return outcomes.filter(Boolean).length
}

/** Checks the partly included files again whenever the repository state was read again. */
function useRecheck(folder: string, files: readonly FileChange[], version: number, check: { current(): Overrides; observe: Observe }): () => Promise<number> {
  const { current, observe } = check
  const recheck = useCallback(
    (live: () => boolean = () => true) => {
      const overrides = current()
      return checkPartials(folder, files.filter((file) => isPartial(overrides.get(file.path))), observe, live)
    },
    [folder, files, current, observe]
  )
  const latest = useLatest(recheck)
  useEffect(() => {
    let live = true
    void latest.current(() => live)
    return () => {
      live = false
    }
  }, [version, latest])
  return recheck
}

/**
 * Inclusion of the changed files of one folder, by path: whole, none, or chosen lines of one diff. It survives status
 * refreshes, drops files that disappear, and resets chosen lines (with a toast) once the file's diff changes.
 */
export function useInclusion(folder: string, files: readonly FileChange[], version: number): InclusionModel {
  const stored = useStored(folder, files)
  const { overrides, current, update } = stored
  const observe = useObserve(stored)
  const recheck = useRecheck(folder, files, version, { current, observe })

  const toggle = useCallback(
    (path: string) => update((previous) => withInclusion(previous, path, (previous.get(path) ?? 'all') === 'all' ? 'none' : 'all')),
    [update]
  )

  const selectionOf = useCallback(
    (path: string, diff: FileDiff): LineSelection | undefined => {
      if (diff.kind !== 'text' || !files.some((file) => file.path === path)) return undefined
      const shape = { hash: diff.hash, count: changedCount(diff) }
      return {
        selected: selectedIn(overrides.get(path), shape),
        onToggle: (indices, include) =>
          update((previous) => withInclusion(previous, path, toggledLines(selectedIn(previous.get(path), shape), indices, include, shape)))
      }
    },
    [files, overrides, update]
  )

  return useMemo(() => {
    const included = files.filter((file) => overrides.get(file.path) !== 'none')
    const header = headerOf(files, overrides)
    return {
      of: (path) => {
        const inclusion = overrides.get(path) ?? 'all'
        return isPartial(inclusion) ? 'partial' : inclusion
      },
      toggle,
      toggleAll: () => update(() => (header === 'all' ? new Map(files.map((file) => [file.path, 'none' as const])) : new Map())),
      header,
      included,
      commitFiles: included.map((file) => commitEntry(file, overrides.get(file.path))),
      selectionOf,
      observe,
      recheck: () => recheck(),
      clearLines: () => update((previous) => new Map([...previous].filter(([, inclusion]) => !isPartial(inclusion))))
    }
  }, [files, overrides, toggle, update, selectionOf, observe, recheck])
}
