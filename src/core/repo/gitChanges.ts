/**
 * Which tracked records changed since the last reconcile, from what git reports: the commits between the commit that
 * reconcile read and HEAD, the working tree's status, and the paths that were dirty when it read them. Pure: the caller
 * runs git (`GitAdapter.diffPaths`, `statusPaths`, `isAncestor`) and reads the marker (`readReconcileMarker`).
 * Anything this cannot account for exactly returns `full`, so a missed change never leaves a record stale.
 */
import { type IdKind, isStableId } from '../ids'
import type { ReconcileMarker } from '../meta'
import { isProfileName } from '../profileNames'
import type { GitDiffPaths, GitPathChange, GitStatusPaths } from './types'

/**
 * Bumped whenever import semantics change (what a record file means, which files are imported, how they are checked),
 * so a marker stored by an older importer forces one full reconcile.
 */
export const IMPORTER_VERSION = 1

/** Why every record has to be read. */
type FullReason =
  /** No marker is stored (or it is malformed or its dirty-path list was over the limit). */
  | 'no_marker'
  /** The marker was stored by another `IMPORTER_VERSION`. */
  | 'importer_version'
  /** The marker's commit is not an ancestor of HEAD: a force-push, rebase or history rewrite. */
  | 'not_ancestor'
  /** The checkout branch differs from the one the last reconcile recorded (or none was recorded). */
  | 'branch_changed'
  /** HEAD names no commit yet. */
  | 'unborn_head'
  /** `.darkmechanicus/` is not inside a git work tree. */
  | 'not_work_tree'
  /** Git is unavailable, a git command failed, or its answer is missing. */
  | 'git_failed'
  /** `project.json` changed. */
  | 'project_record'
  /** A path outside the record layout (or with an invalid id or name) changed. */
  | 'unknown_path'
  /** Git ignores a record path, so it cannot report the path's changes. */
  | 'ignored_path'

/** The records a targeted reconcile reads: ids of epics, runs and Kanban cards, profile names, and two whole folders. */
export interface TrackedRecords {
  epics: Set<string>
  runs: Set<string>
  kanbanCards: Set<string>
  profiles: Set<string>
  /** `observations/` (project-level metric observations). */
  projectObservations: boolean
  /** `recovered-attachments/`. */
  recoveredAttachments: boolean
}

export type TrackedChanges = { kind: 'full'; reason: FullReason } | ({ kind: 'targeted' } & TrackedRecords)

/** Records the caller wants re-read whatever git says (exported since the last reconcile, stored conflicts, ...). */
export interface RecheckRecords {
  epics?: Iterable<string>
  runs?: Iterable<string>
  kanbanCards?: Iterable<string>
  profiles?: Iterable<string>
  projectObservations?: boolean
  recoveredAttachments?: boolean
}

export interface TrackedChangesInput {
  marker: ReconcileMarker
  /** `statusPaths()`: the working tree against HEAD, with HEAD's commit (the end of the diff) and branch. */
  status: GitStatusPaths
  /** `META_KEYS.checkoutBranch` as stored: null when never recorded, `''` for "no branch". */
  recordedBranch: string | null
  /** Whether `marker.baseCommit` is an ancestor of `status.head` (`isAncestor`); null when git could not say. */
  isAncestor: boolean | null
  /** `diffPaths(marker.baseCommit, status.head)`; may be null when the two are the same commit. */
  diff: GitDiffPaths | null
  recheck?: RecheckRecords
}

/** Paths below `.darkmechanicus/` no reconcile reads. `knowledge/` is loaded on demand by `knowledge/load.ts`. */
const IGNORED_ROOTS: Record<string, true> = { local: true, knowledge: true }
const PROFILE_SUFFIX = '.json'

type PathVerdict = 'ignored' | 'mapped' | { reason: FullReason }

/** Files directly in `.darkmechanicus/` with a fixed meaning. */
const ROOT_FILES: Record<string, PathVerdict> = { '.gitignore': 'ignored', 'project.json': { reason: 'project_record' } }

/** Adds the record a path below one top-level folder belongs to; false when the path names no valid record. */
type FolderMapper = (name: string, rest: string[], records: TrackedRecords) => boolean

function idFolder(key: 'epics' | 'runs' | 'kanbanCards', kind: IdKind): FolderMapper {
  return (name, _rest, records) => {
    if (!isStableId(name, kind)) return false
    records[key].add(name)
    return true
  }
}

function wholeFolder(key: 'projectObservations' | 'recoveredAttachments'): FolderMapper {
  return (_name, _rest, records) => {
    records[key] = true
    return true
  }
}

/** The record folders, laid out as `ownedPaths` (`paths.ts`) writes them. */
const FOLDERS: Record<string, FolderMapper> = {
  epics: idFolder('epics', 'epic'),
  history: idFolder('runs', 'run'),
  kanban: idFolder('kanbanCards', 'kanbanCard'),
  profiles: (name, rest, records) => {
    const profile = name.slice(0, -PROFILE_SUFFIX.length)
    const valid = rest.length === 0 && name.endsWith(PROFILE_SUFFIX) && isProfileName(profile)
    if (valid) records.profiles.add(profile)
    return valid
  },
  observations: wholeFolder('projectObservations'),
  'recovered-attachments': wholeFolder('recoveredAttachments')
}

/** Records `path` (relative to `.darkmechanicus/`, forward slashes) belongs to, added to `records`. */
function mapPath(path: string, records: TrackedRecords): PathVerdict {
  const [top = '', name = '', ...rest] = path.split('/')
  if (IGNORED_ROOTS[top] === true) return 'ignored'
  if (Object.hasOwn(ROOT_FILES, path)) return ROOT_FILES[path] ?? 'ignored'
  const folder = Object.hasOwn(FOLDERS, top) ? FOLDERS[top] : undefined
  return folder?.(name, rest, records) === true ? 'mapped' : { reason: 'unknown_path' }
}

/** Whether the stored marker is current: present, written by this importer, on the branch checked out now. */
function markerFallback(marker: ReconcileMarker, recordedBranch: string | null, branch: string | null): FullReason | null {
  if (marker.baseCommit === null || marker.importerVersion === null || marker.dirtyPaths === null) return 'no_marker'
  if (marker.importerVersion !== IMPORTER_VERSION) return 'importer_version'
  const recorded = recordedBranch === '' ? null : recordedBranch
  return recordedBranch === null || recorded !== branch ? 'branch_changed' : null
}

/** Whether git's answer covers every commit between the marker and `head`. */
function historyFallback(input: TrackedChangesInput, head: string): FullReason | null {
  if (input.marker.baseCommit === head) return null
  if (input.isAncestor !== true) return input.isAncestor === false ? 'not_ancestor' : 'git_failed'
  if (input.diff === null) return 'git_failed'
  return input.diff.ok ? null : input.diff.reason
}

/** The first reason the marker cannot be trusted as a starting point, or null. */
function fallback(input: TrackedChangesInput): FullReason | null {
  const { status } = input
  if (!status.ok) return status.reason
  if (status.head === null) return 'unborn_head'
  return markerFallback(input.marker, input.recordedBranch, status.branch) ?? historyFallback(input, status.head)
}

/** The records the diff, the status and the paths dirty at the last reconcile name, or why they cannot be mapped. */
function changedRecords(input: TrackedChangesInput): TrackedRecords | FullReason {
  const records: TrackedRecords = {
    epics: new Set(), runs: new Set(), kanbanCards: new Set(), profiles: new Set(),
    projectObservations: false, recoveredAttachments: false
  }
  const changes: GitPathChange[] = [
    ...(input.diff?.ok === true ? input.diff.paths : []),
    ...(input.status.ok ? input.status.paths : []),
    ...(input.marker.dirtyPaths ?? []).map((path) => ({ status: '', path }))
  ]
  for (const change of changes) {
    const verdict = mapPath(change.path, records)
    if (typeof verdict === 'object') return verdict.reason
    if (verdict === 'mapped' && change.status === '!') return 'ignored_path'
  }
  return records
}

function addRecheck(records: TrackedRecords, recheck: RecheckRecords = {}): void {
  for (const key of ['epics', 'runs', 'kanbanCards', 'profiles'] as const) {
    for (const id of recheck[key] ?? []) records[key].add(id)
  }
  records.projectObservations ||= recheck.projectObservations === true
  records.recoveredAttachments ||= recheck.recoveredAttachments === true
}

/** The records changed since the last reconcile, or `full` with the reason a targeted read would not be exact. */
export function trackedChanges(input: TrackedChangesInput): TrackedChanges {
  const records = fallback(input) ?? changedRecords(input)
  if (typeof records === 'string') return { kind: 'full', reason: records }
  addRecheck(records, input.recheck)
  return { kind: 'targeted', ...records }
}
