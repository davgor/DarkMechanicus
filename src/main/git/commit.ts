/** Commits the files the person chose, and undoes the last unpushed commit. */
import type { CommitMessage } from '../../shared/git/api'
import type { FileChange, RepoStatus } from '../../shared/git/status'
import { pathArgs } from './args'
import { GitError, GitInputError } from './errors'
import type { GitRunner } from './runner'
import { readRepoState } from './status'

interface CommitInput {
  summary: string
  description: string
  files: ReadonlyArray<{ path: string; oldPath: string | null }>
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

function chosenPaths(status: RepoStatus, files: CommitInput['files']): string[] {
  const paths = new Set<string>()
  for (const file of files) {
    checkPaths(file.oldPath === null ? [file.path] : [file.path, file.oldPath])
    const entry = findInStatus(status, file.path)
    if (file.oldPath !== null && entry.oldPath !== file.oldPath) {
      throw new GitInputError(`${file.oldPath} is not the old path of ${file.path}.`)
    }
    paths.add(file.path)
    if (entry.oldPath !== null) {
      paths.add(entry.oldPath)
    }
  }
  return [...paths]
}

function buildMessage(summary: string, description: string): string {
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
  const paths = chosenPaths(status, input.files)
  const root = status.root
  // Start from HEAD so only the chosen files are committed, matching what the panel shows.
  if (status.branch.headOid === null) {
    await runner.run({ cwd: root, args: ['read-tree', '--empty'], kind: 'write' })
  } else {
    await runner.run({ cwd: root, args: ['reset', '-q', '--'], kind: 'write' })
  }
  await runner.run({ cwd: root, args: ['add', '-A', ...pathArgs(paths)], kind: 'write' })
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
