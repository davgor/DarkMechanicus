/**
 * Removes an old-style `/board` workflow from a repository after the person confirmed the exact list
 * of files: `board/` and the board-only skill folders, as decided by `../../core/board/removal.ts`. It
 * deletes files and then the folders that leaves empty; it never commits, and it never deletes
 * anything else. Instruction files that still mention the board are only reported.
 *
 * Repository contents are untrusted, so, as for skill installation and `.mcp.json`, every entry is
 * looked at with `lstat`: a symbolic link (or junction) is never followed, descended into or deleted
 * through, and a folder that resolves outside the repository is refused. The renderer's list is never
 * trusted either: removal walks the repository again and deletes only files that are both confirmed
 * and still candidates, re-checking every folder above each file right before deleting it.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  confirmedRemoval,
  INSTRUCTION_FILES,
  LINK_REASON,
  planBoardRemoval,
  REMOVAL_ROOTS,
  type RemovalEntry,
  type RemovalEntryKind,
  type RemovalScan,
  RULE_FOLDERS,
  SKILL_FILE,
  SKILL_FOLDERS
} from '../../core/board/removal'
import { DomainError } from '../../core/errors'
import type { BoardKeptPathView, BoardRemovalResultView, BoardRemovalView } from '../../shared/domain/views'

type EntryKind = 'missing' | 'file' | 'directory' | 'symlink' | 'other'

/** The filesystem surface the removal uses; tests inject fakes through it. */
export interface BoardRemovalFs {
  /** What is at `path`, without following symbolic links. */
  entryKind(path: string): EntryKind
  readdir(path: string): string[]
  readFile(path: string): string
  /** Size in bytes of the entry itself (a link is not followed). */
  fileSize(path: string): number
  /** Canonical real path with every symbolic link resolved. */
  realpath(path: string): string
  /** Removes one directory entry; on a link it removes the link, never its target. */
  unlink(path: string): void
  /** Removes an empty folder. */
  rmdir(path: string): void
}

/** Entries one removal root may hold; a larger root is refused whole, to be removed by hand. */
export const MAX_REMOVAL_ENTRIES = 3_000
const MAX_DEPTH = 16
/** Entries listed in a skill or rule folder when looking for files that mention the board. */
const MAX_LISTED = 500
const MAX_TEXT_BYTES = 256 * 1024
const RULE_FILE = /\.mdc?$/i

const nodeRemovalFs: BoardRemovalFs = {
  entryKind(path) {
    const stats = lstatSync(path, { throwIfNoEntry: false })
    if (stats === undefined) {
      return 'missing'
    }
    if (stats.isSymbolicLink()) {
      return 'symlink'
    }
    if (stats.isDirectory()) {
      return 'directory'
    }
    return stats.isFile() ? 'file' : 'other'
  },
  readdir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
  fileSize: (path) => lstatSync(path).size,
  realpath: (path) => realpathSync.native(path),
  unlink: (path) => {
    unlinkSync(path)
  },
  rmdir: (path) => {
    rmdirSync(path)
  }
}

interface Repo {
  fs: BoardRemovalFs
  root: string
  /** Real path of the repository, which every folder used must resolve inside. */
  rootReal: string
}

function resolveRoot(fs: BoardRemovalFs, repoRoot: string): Repo {
  try {
    return { fs, root: repoRoot, rootReal: fs.realpath(repoRoot) }
  } catch {
    throw new DomainError('not_found', `Repository folder not found: ${repoRoot}`)
  }
}

function absolute(repo: Repo, path: string): string {
  return join(repo.root, ...path.split('/'))
}

/** Whether `real` is the repository itself or lies below it. */
function inRepository(repo: Repo, real: string): boolean {
  const rel = relative(repo.rootReal, real)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function kindOf(kind: Exclude<EntryKind, 'missing'>): RemovalEntryKind {
  return kind === 'symlink' ? 'link' : kind
}

/** Whether a repository-relative path is plain: no empty, `.` or `..` segment. */
function isPlainPath(path: string): boolean {
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

/**
 * The first folder above `path` that is not a real folder of the repository, and what it is instead
 * (`missing` when the path cannot exist), or null when every folder above it is one.
 */
function folderProblem(repo: Repo, path: string): { path: string; kind: EntryKind | 'outside' } | null {
  const parts = path.split('/')
  for (let index = 1; index < parts.length; index += 1) {
    const folder = parts.slice(0, index).join('/')
    const kind = repo.fs.entryKind(absolute(repo, folder))
    if (kind !== 'directory') {
      return { path: folder, kind }
    }
  }
  const parent = parts.slice(0, -1).join('/')
  const real = repo.fs.realpath(parent === '' ? repo.root : absolute(repo, parent))
  return inRepository(repo, real) ? null : { path: parent, kind: 'outside' }
}

/** Whether `folder` is a real folder of the repository: no link at or above it, resolving inside it. */
function isRealFolder(repo: Repo, folder: string): boolean {
  const dir = absolute(repo, folder)
  return (
    isPlainPath(folder) &&
    folderProblem(repo, folder) === null &&
    repo.fs.entryKind(dir) === 'directory' &&
    inRepository(repo, repo.fs.realpath(dir))
  )
}

interface Walk {
  repo: Repo
  found: RemovalEntry[]
  problems: BoardKeptPathView[]
}

/** The entry names of `dir` in order, or null after recording why it is not looked into. */
function listWalked(walk: Walk, dir: string): string[] | null {
  try {
    const real = walk.repo.fs.realpath(absolute(walk.repo, dir))
    if (!inRepository(walk.repo, real) || real === walk.repo.rootReal) {
      walk.problems.push({ path: dir, reason: 'resolves outside the repository' })
      return null
    }
    return walk.repo.fs.readdir(absolute(walk.repo, dir)).sort()
  } catch {
    walk.problems.push({ path: dir, reason: 'could not be listed' })
    return null
  }
}

/** Adds the entries below `dir` to the walk, never following a link; false once the root is too large. */
function walkFolder(walk: Walk, dir: string, names: readonly string[], level: number): boolean {
  for (const name of names) {
    const path = `${dir}/${name}`
    const kind = walk.repo.fs.entryKind(absolute(walk.repo, path))
    if (kind === 'missing') {
      continue
    }
    walk.found.push({ path, kind: kindOf(kind) })
    if (walk.found.length > MAX_REMOVAL_ENTRIES) {
      return false
    }
    if (kind !== 'directory') {
      continue
    }
    if (level >= MAX_DEPTH) {
      walk.problems.push({ path, reason: 'is nested too deeply to look into' })
      continue
    }
    const children = listWalked(walk, path)
    if (children !== null && !walkFolder(walk, path, children, level + 1)) {
      return false
    }
  }
  return true
}

/** Adds `root` and everything below it to the scan; a root that is too large is refused whole. */
function scanRoot(repo: Repo, scan: RemovalScan, root: string): void {
  const above = folderProblem(repo, root)
  if (above !== null) {
    if (above.kind === 'symlink') {
      scan.problems.push({ path: above.path, reason: LINK_REASON })
    } else if (above.kind === 'outside') {
      scan.problems.push({ path: above.path, reason: 'resolves outside the repository' })
    }
    return
  }
  const kind = repo.fs.entryKind(absolute(repo, root))
  if (kind === 'missing') {
    return
  }
  if (kind !== 'directory') {
    scan.entries.push({ path: root, kind: kindOf(kind) })
    return
  }
  const walk: Walk = { repo, found: [], problems: [] }
  const names = listWalked(walk, root)
  if (names === null) {
    scan.problems.push(...walk.problems)
  } else if (walkFolder(walk, root, names, 1)) {
    scan.entries.push({ path: root, kind: 'directory' }, ...walk.found)
    scan.problems.push(...walk.problems)
  } else {
    scan.problems.push({ path: root, reason: `holds more than ${MAX_REMOVAL_ENTRIES} entries; remove it by hand` })
  }
}

/** Reads a regular file below real folders of the repository, within the size limit; otherwise skips it. */
function readText(repo: Repo, scan: RemovalScan, path: string): void {
  try {
    const file = absolute(repo, path)
    const readable =
      folderProblem(repo, path) === null &&
      repo.fs.entryKind(file) === 'file' &&
      repo.fs.fileSize(file) <= MAX_TEXT_BYTES
    if (readable) {
      scan.texts.push({ path, text: repo.fs.readFile(file) })
    }
  } catch {
    // An unreadable file is simply not looked at.
  }
}

/** The entries of a real folder of the repository, or none. */
function listFolder(repo: Repo, folder: string): string[] {
  try {
    return isRealFolder(repo, folder) ? repo.fs.readdir(absolute(repo, folder)).sort().slice(0, MAX_LISTED) : []
  } catch {
    return []
  }
}

/** Reads the board skills' `SKILL.md` and every instruction, skill or rule file that may mention the board. */
function readTexts(repo: Repo, scan: RemovalScan): void {
  const paths = new Set<string>([
    ...REMOVAL_ROOTS.filter((root) => root.includes('/')).map((root) => `${root}/${SKILL_FILE}`),
    ...INSTRUCTION_FILES,
    ...SKILL_FOLDERS.flatMap((folder) => listFolder(repo, folder).map((name) => `${folder}/${name}/${SKILL_FILE}`)),
    ...RULE_FOLDERS.flatMap((folder) =>
      listFolder(repo, folder)
        .filter((name) => RULE_FILE.test(name))
        .map((name) => `${folder}/${name}`)
    )
  ])
  for (const path of paths) {
    readText(repo, scan, path)
  }
}

function scanRepository(repo: Repo): RemovalScan {
  const scan: RemovalScan = { entries: [], texts: [], problems: [] }
  for (const root of REMOVAL_ROOTS) {
    scanRoot(repo, scan, root)
  }
  readTexts(repo, scan)
  const seen = new Set<string>()
  scan.problems = scan.problems.filter(({ path }) => {
    const first = !seen.has(path)
    seen.add(path)
    return first
  })
  return scan
}

/** What removing the board workflow would delete; nothing is changed. */
export function previewBoardRemoval(repoRoot: string, fs: BoardRemovalFs = nodeRemovalFs): BoardRemovalView {
  const { remove, kept, editByHand } = planBoardRemoval(scanRepository(resolveRoot(fs, repoRoot)))
  return { remove, kept, editByHand }
}

/** Deletes one planned file after checking it again; returns why it was left in place, or null. */
function deleteFile(repo: Repo, path: string): string | null {
  try {
    if (!isPlainPath(path) || folderProblem(repo, path) !== null) {
      return 'is no longer inside a real folder of the repository'
    }
    const file = absolute(repo, path)
    const kind = repo.fs.entryKind(file)
    if (kind !== 'file') {
      return kind === 'symlink' ? LINK_REASON : 'is no longer a regular file'
    }
    repo.fs.unlink(file)
    return null
  } catch {
    return 'could not be deleted'
  }
}

/** Removes a planned folder when the deletion left it empty and it is still a real folder here. */
function pruneFolder(repo: Repo, folder: string): boolean {
  try {
    const dir = absolute(repo, folder)
    const empty = isRealFolder(repo, folder) && repo.fs.readdir(dir).length === 0
    if (empty) {
      repo.fs.rmdir(dir)
    }
    return empty
  } catch {
    return false
  }
}

function byPath(a: BoardKeptPathView, b: BoardKeptPathView): number {
  if (a.path === b.path) {
    return 0
  }
  return a.path < b.path ? -1 : 1
}

/**
 * Deletes the confirmed files that are still files to remove, then the folders that leaves empty.
 * Everything else, including files that appeared since the list was shown, stays and is reported.
 * Nothing is committed. Refusals (`not_found`) happen before anything is deleted.
 */
export function removeBoardFiles(
  repoRoot: string,
  confirmed: readonly string[],
  fs: BoardRemovalFs = nodeRemovalFs
): BoardRemovalResultView {
  const repo = resolveRoot(fs, repoRoot)
  const plan = planBoardRemoval(scanRepository(repo))
  const chosen = confirmedRemoval(plan, confirmed)
  const removed: string[] = []
  const kept = [...plan.kept, ...chosen.kept]
  for (const path of chosen.remove) {
    const problem = deleteFile(repo, path)
    if (problem === null) {
      removed.push(path)
    } else {
      kept.push({ path, reason: problem })
    }
  }
  const removedFolders = plan.folders.filter((folder) => pruneFolder(repo, folder))
  return { removed, removedFolders, kept: kept.sort(byPath), editByHand: plan.editByHand }
}
