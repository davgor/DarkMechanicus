/** Commits the files the person chose, and undoes the last unpushed commit. */
import type { CommitMessage } from '../../shared/git/api'
import { changedLineIndices, type FileDiff } from '../../shared/git/diff'
import type { FileChange, RepoStatus } from '../../shared/git/status'
import { literalPathArgs, pathArgs } from './args'
import { readWorkingDiff } from './diff'
import { GitError, GitInputError } from './errors'
import { buildPartialPatch } from './partialPatch'
import type { GitRunner } from './runner'
import { readRepoState } from './status'

type TextDiff = Extract<FileDiff, { kind: 'text' }>

const SUBMODULE_MODE = '160000'

interface CommitEntry {
  path: string
  oldPath: string | null
  /** Commit only these changed lines (`changedLineIndices` numbering) of the diff whose hash is `diffHash`. */
  lines?: readonly number[]
  diffHash?: string
}

interface CommitInput {
  summary: string
  description: string
  files: readonly CommitEntry[]
}

/** The current status of the repository holding `folder`, or the error that says why it has none. */
export async function requireStatus(runner: GitRunner, folder: string): Promise<RepoStatus> {
  const state = await readRepoState(runner, folder)
  if (state.kind === 'git_missing') {
    throw new GitError('git_not_found', '')
  }
  if (state.kind === 'not_repository') {
    throw new GitError('not_repository', '', 'That folder is not a Git repository.')
  }
  return state.status
}

/** Refuses a path git must not receive, with the reason a person can read. */
export function checkPaths(paths: readonly string[]): void {
  try {
    pathArgs(paths)
  } catch {
    throw new GitInputError('Paths must be relative and stay inside the repository.')
  }
}

/** The status entry for `path`, which every path the renderer names has to match. */
export function findInStatus(status: RepoStatus, path: string): FileChange {
  const found = status.files.find((file) => file.path === path)
  if (found === undefined) {
    throw new GitInputError(`${path} is not a changed file.`)
  }
  return found
}

/** The status entry a chosen file names, after checking its paths; its old path too when it was renamed. */
function checkEntry(status: RepoStatus, file: CommitEntry): FileChange {
  checkPaths(file.oldPath === null ? [file.path] : [file.path, file.oldPath])
  const entry = findInStatus(status, file.path)
  if (file.oldPath !== null && entry.oldPath !== file.oldPath) {
    throw new GitInputError(`${file.oldPath} is not the old path of ${file.path}.`)
  }
  return entry
}

function chosenPaths(status: RepoStatus, files: readonly CommitEntry[]): string[] {
  const paths = new Set<string>()
  for (const file of files) {
    const entry = checkEntry(status, file)
    paths.add(file.path)
    if (entry.oldPath !== null) {
      paths.add(entry.oldPath)
    }
  }
  return [...paths]
}

/**
 * The patch committing the chosen lines of one file, or null when none is chosen. It is built from the file's
 * diff as it is now, so a diff whose hash differs from the one the lines were chosen in fails `stale_selection`.
 */
async function linePatch(runner: GitRunner, root: string, change: FileChange, file: CommitEntry): Promise<string | null> {
  if (file.diffHash === undefined) {
    throw new GitInputError(`Lines of ${file.path} need the hash of the diff they were chosen in.`)
  }
  if (change.kind === 'typechange') {
    throw new GitInputError(`Lines cannot be chosen in ${file.path}: its type changed.`)
  }
  const diff = await readWorkingDiff(runner, root, change, { force: true })
  if (diff.hash !== file.diffHash) {
    throw new GitError('stale_selection', '', `${file.path} changed after its lines were chosen. Choose them again.`)
  }
  const text = selectableDiff(diff, file.path)
  return buildPartialPatch(text, new Set(checkedLines(text, file)))
}

/** The text diff lines can be chosen in. */
function selectableDiff(diff: FileDiff, path: string): TextDiff {
  if (diff.kind !== 'text') {
    throw new GitInputError(`Lines can only be chosen in a text diff, and ${path} has none.`)
  }
  if (diff.oldMode === SUBMODULE_MODE || diff.newMode === SUBMODULE_MODE) {
    throw new GitInputError(`Lines cannot be chosen in ${path}: it is a submodule.`)
  }
  // The diff is read as UTF-8; a file in another encoding would not survive the round trip byte-exact.
  if (diff.hunks.some((hunk) => hunk.lines.some((line) => line.text.includes('\uFFFD')))) {
    throw new GitInputError(`Lines cannot be chosen in ${path}: it is not UTF-8 text.`)
  }
  return diff
}

function checkedLines(diff: TextDiff, file: CommitEntry): readonly number[] {
  const lines = file.lines ?? []
  const count = changedLineIndices(diff).flat().filter((index) => index !== null).length
  if (lines.some((index) => !Number.isInteger(index) || index < 0 || index >= count)) {
    throw new GitInputError(`${file.path} has no such changed line.`)
  }
  return lines
}

/** The patches for the files committed by line; a file must not also be chosen whole or twice. */
async function linePatches(runner: GitRunner, status: RepoStatus, files: readonly CommitEntry[], whole: readonly string[]): Promise<string[]> {
  const taken = new Set(whole)
  const patches: string[] = []
  for (const file of files) {
    const change = checkEntry(status, file)
    for (const path of change.oldPath === null ? [file.path] : [file.path, change.oldPath]) {
      if (taken.has(path)) {
        throw new GitInputError(`${path} is chosen more than once.`)
      }
      taken.add(path)
    }
    const patch = await linePatch(runner, status.root, change, file)
    patches.push(...(patch === null ? [] : [patch]))
  }
  return patches
}

/** Stages the whole files and applies the line patches to the index only, starting from HEAD. */
async function stageChosen(runner: GitRunner, status: RepoStatus, paths: readonly string[], patches: readonly string[]): Promise<void> {
  const root = status.root
  // Start from HEAD so only the chosen files are committed, matching what the panel shows.
  if (status.branch.headOid === null) {
    await runner.run({ cwd: root, args: ['read-tree', '--empty'], kind: 'write' })
  } else {
    await runner.run({ cwd: root, args: ['reset', '-q', '--'], kind: 'write' })
  }
  // Without paths `add -A` would stage every change.
  if (paths.length > 0) {
    await runner.run({ cwd: root, args: literalPathArgs(['add', '-A'], paths), kind: 'write' })
  }
  for (const patch of patches) {
    // The patch keeps HEAD's line numbers exactly; `--unidiff-zero` lets it apply when `diff.context` is 0.
    await runner.run({ cwd: root, args: ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-'], kind: 'write', stdin: patch })
  }
}

export function buildMessage(summary: string, description: string): string {
  return description === '' ? `${summary}\n` : `${summary}\n\n${description}\n`
}

export async function commitFiles(runner: GitRunner, folder: string, input: CommitInput): Promise<{ oid: string }> {
  const summary = input.summary.trim()
  const description = input.description.trim()
  if (summary === '') {
    throw new GitInputError('A commit needs a summary.')
  }
  if (input.files.length === 0) {
    throw new GitInputError('Choose at least one file to commit.')
  }
  const status = await requireStatus(runner, folder)
  if (status.inProgress !== null) {
    throw new GitError('operation_in_progress', '', `A ${status.inProgress} is in progress.`)
  }
  // Starting from HEAD below would drop the unmerged entries of a conflicted stash restore, markers and all.
  if (status.files.some((file) => file.kind === 'conflicted')) {
    throw new GitError('merge_conflicts', '', 'Resolve the conflicted files before committing.')
  }
  const paths = chosenPaths(status, input.files.filter((file) => file.lines === undefined))
  const patches = await linePatches(runner, status, input.files.filter((file) => file.lines !== undefined), paths)
  const root = status.root
  await stageChosen(runner, status, paths, patches)
  await runner.run({ cwd: root, args: ['commit', '-q', '-F', '-'], kind: 'write', stdin: buildMessage(summary, description) })
  const head = await runner.run({ cwd: root, args: ['rev-parse', 'HEAD'], kind: 'read' })
  return { oid: head.stdout.trim() }
}

export async function undoLastCommit(runner: GitRunner, folder: string): Promise<CommitMessage> {
  const status = await requireStatus(runner, folder)
  const root = status.root
  if (status.branch.headOid === null) {
    throw new GitInputError('Nothing to undo: no commits yet.')
  }
  const parents = await runner.run({ cwd: root, args: ['rev-list', '--parents', '-n', '1', 'HEAD'], kind: 'read' })
  const parentCount = parents.stdout.trim().split(/\s+/).length - 1
  if (parentCount > 1) {
    throw new GitInputError('Cannot undo a merge commit.')
  }
  const remote = await runner.run({ cwd: root, args: ['branch', '-r', '--contains', 'HEAD'], kind: 'read' })
  if (remote.stdout.trim() !== '') {
    throw new GitInputError('Cannot undo a commit that is already pushed.')
  }
  const log = await runner.run({ cwd: root, args: ['log', '-1', '--format=%B'], kind: 'read' })
  if (parentCount === 0) {
    await runner.run({ cwd: root, args: ['update-ref', '-d', 'HEAD'], kind: 'write' })
  } else {
    await runner.run({ cwd: root, args: ['reset', '--soft', 'HEAD~1'], kind: 'write' })
  }
  return splitMessage(log.stdout)
}

/** The first paragraph is the summary; the rest is the description. */
function splitMessage(raw: string): CommitMessage {
  const text = raw.replace(/\r\n/g, '\n').trim()
  const at = text.search(/\n\s*\n/)
  if (at === -1) {
    return { summary: text, description: '' }
  }
  return { summary: text.slice(0, at).trim(), description: text.slice(at).trim() }
}
