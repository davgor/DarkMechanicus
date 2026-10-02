import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fail } from '../errors'
import { type IdKind, isStableId } from '../ids'
import { isProfileName } from '../profileNames'
import type { FsAdapter, RepoLayout } from './types'

function checkedId(value: string, kind: IdKind): string {
  if (!isStableId(value, kind)) {
    fail('unsafe_path', `Refusing to build a repository path from an invalid ${kind} id.`, { kind })
  }
  return value
}

function checkedProfileName(name: string): string {
  if (!isProfileName(name)) {
    fail('unsafe_path', 'Refusing to build a repository path from an invalid profile name.')
  }
  return name
}

/**
 * App-generated paths of repository-owned records. Every segment comes from a validated stable id
 * (or profile name), so no caller-supplied text can introduce separators or traversal.
 */
export function ownedPaths(layout: RepoLayout) {
  const epicDir = (epicId: string): string => join(layout.epicsDir, checkedId(epicId, 'epic'))
  const snapshotsDir = (epicId: string): string => join(epicDir(epicId), 'snapshots')
  const runDir = (runId: string): string => join(layout.historyDir, checkedId(runId, 'run'))
  const commentsDir = (epicId: string): string => join(epicDir(epicId), 'comments')
  return {
    epicDir,
    snapshotsDir,
    snapshotFile: (epicId: string, revisionId: string): string =>
      join(snapshotsDir(epicId), `${checkedId(revisionId, 'revision')}.json`),
    epicPointerFile: (epicId: string): string => join(epicDir(epicId), 'current.json'),
    epicStateFile: (epicId: string): string => join(epicDir(epicId), 'state.json'),
    runDir,
    runHistoryFile: (runId: string): string => join(runDir(runId), 'run.json'),
    profileFile: (name: string): string => join(layout.profilesDir, `${checkedProfileName(name)}.json`),
    commentsDir,
    commentFile: (epicId: string, commentId: string): string =>
      join(commentsDir(epicId), `${checkedId(commentId, 'comment')}.json`)
  }
}

/** Repository-relative path with forward slashes, for messages and results (never absolute). */
export function displayPath(layout: RepoLayout, path: string): string {
  return relative(layout.root, resolve(path)).split(sep).join('/')
}

/** Whether `target` lies below `base` (not `base` itself), compared lexically. */
export function isStrictlyInside(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** `base/a`, `base/a/b`, … down to `target` (which must be strictly inside `base`). */
function componentsBelow(base: string, target: string): string[] {
  const parts = relative(base, target).split(sep)
  return parts.map((_, index) => join(base, ...parts.slice(0, index + 1)))
}

interface ContainmentCheck {
  layout: RepoLayout
  fs: FsAdapter
  realBase: string
}

function unsafe(layout: RepoLayout, path: string, reason: string): never {
  const shown = displayPath(layout, path)
  return fail('unsafe_path', `Unsafe repository path ${shown}: ${reason}.`, { path: shown })
}

function checkComponent(check: ContainmentCheck, component: string): void {
  if (check.fs.isSymlink(component)) {
    unsafe(check.layout, component, 'symbolic links and junctions are not allowed inside .darkmechanicus')
  }
  if (check.fs.exists(component) && !isStrictlyInside(check.realBase, check.fs.realpath(component))) {
    unsafe(check.layout, component, 'it resolves outside .darkmechanicus')
  }
}

/**
 * Fails closed with `unsafe_path` unless `target` is lexically inside `.darkmechanicus/`, no
 * component from `.darkmechanicus/` down to it is a link (symlink or junction), and every existing
 * component's real path stays inside the real `.darkmechanicus/`. Call before each owned read or
 * write so a path replaced since the last check is caught at use.
 */
export function assertContained(layout: RepoLayout, fs: FsAdapter, target: string): void {
  const base = resolve(layout.dmDir)
  const resolved = resolve(target)
  if (!isStrictlyInside(base, resolved)) {
    unsafe(layout, resolved, 'it is outside .darkmechanicus')
  }
  if (fs.isSymlink(base) || !fs.isDirectory(base)) {
    unsafe(layout, base, '.darkmechanicus must be a real directory, not a link')
  }
  const check: ContainmentCheck = { layout, fs, realBase: fs.realpath(base) }
  for (const component of componentsBelow(base, resolved)) {
    checkComponent(check, component)
  }
}
