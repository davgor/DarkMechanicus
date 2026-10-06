/** Reads the current branch's commits, the files each changed, and one file's diff in a commit. Read-only. */
import type { FileDiff } from '../../shared/git/diff'
import type { CommitDiffRequest, CommitFile, CommitSummary, HistoryPage, HistoryRequest } from '../../shared/git/history'
import type { FileChangeKind } from '../../shared/git/status'
import { pathArgs } from './args'
import { DIFF_LIMIT_BYTES, FORCED_DIFF_LIMIT_BYTES } from './diff'
import { parseUnifiedDiff } from './diffParser'
import { GitError, GitInputError } from './errors'
import type { GitRunner } from './runner'

/** The most commits one history page may ask for. */
export const MAX_HISTORY_LIMIT = 200

const OID_PATTERN = /^[0-9a-fA-F]{4,64}$/
const FIELD = '%x00'
const RECORD = '%x1e'
const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%aI', '%s', '%b'].join(FIELD) + RECORD
const SAFE_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color']

const KINDS: Readonly<Record<string, FileChangeKind>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'conflicted'
}

/** A commit id as 4 to 64 hex characters; anything else (a ref, an option) is refused. */
function oidArg(oid: string): string {
  if (!OID_PATTERN.test(oid)) {
    throw new GitInputError('A commit id is 4 to 64 hexadecimal characters.')
  }
  return oid
}

async function hasCommit(runner: GitRunner, root: string, rev: string): Promise<boolean> {
  const result = await runner.run({ cwd: root, args: ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], kind: 'read', acceptExitCodes: [0, 1] })
  return result.code === 0
}

function parseRecord(record: string): CommitSummary {
  const [oid = '', parents = '', authorName = '', authorEmail = '', authoredAt = '', summary = '', ...rest] = record.split('\u0000')
  return {
    oid,
    shortOid: oid.slice(0, 7),
    parents: parents === '' ? [] : parents.split(' '),
    authorName,
    authorEmail,
    authoredAt,
    summary,
    body: rest.join('\u0000').replace(/\s+$/, ''),
    unpushed: false
  }
}

async function unpushedSet(runner: GitRunner, root: string): Promise<Set<string>> {
  const result = await runner.run({ cwd: root, args: ['rev-list', 'HEAD', '--not', '--remotes'], kind: 'read' })
  return new Set(result.stdout.split('\n').filter((line) => line !== ''))
}

export async function getHistory(runner: GitRunner, root: string, request: HistoryRequest): Promise<HistoryPage> {
  const { skip, limit } = request
  if (!Number.isInteger(skip) || skip < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    throw new GitInputError(`Ask for 1 to ${MAX_HISTORY_LIMIT} commits, starting at 0 or later.`)
  }
  if (!(await hasCommit(runner, root, 'HEAD'))) {
    return { commits: [], hasMore: false }
  }
  const log = await runner.run({
    cwd: root,
    args: ['log', `--max-count=${limit + 1}`, `--skip=${skip}`, `--format=${LOG_FORMAT}`, 'HEAD'],
    kind: 'read'
  })
  const records = log.stdout.split('\u001e').map((record) => record.replace(/^\n/, '')).filter((record) => record !== '')
  const unpushed = await unpushedSet(runner, root)
  const commits = records.slice(0, limit).map((record) => {
    const commit = parseRecord(record)
    return { ...commit, unpushed: unpushed.has(commit.oid) }
  })
  return { commits, hasMore: records.length > limit }
}

/** Parses `diff-tree --name-status -z`: `X NUL path NUL`, or `Rnn NUL old NUL new NUL` for renames and copies. */
function parseNameStatus(output: string): CommitFile[] {
  const tokens = output.split('\u0000')
  const files: CommitFile[] = []
  let at = 0
  while (at < tokens.length) {
    const status = tokens[at] ?? ''
    if (status === '') {
      at += 1
      continue
    }
    const kind = KINDS[status.charAt(0)] ?? 'modified'
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push({ path: tokens[at + 2] ?? '', oldPath: tokens[at + 1] ?? null, kind })
      at += 3
    } else {
      files.push({ path: tokens[at + 1] ?? '', oldPath: null, kind })
      at += 2
    }
  }
  return files
}

async function requireCommit(runner: GitRunner, root: string, oid: string): Promise<void> {
  if (!(await hasCommit(runner, root, oid))) {
    throw new GitError('git_failed', '', 'That commit does not exist in this repository.')
  }
}

export async function getCommitFiles(runner: GitRunner, root: string, oid: string): Promise<CommitFile[]> {
  oidArg(oid)
  await requireCommit(runner, root, oid)
  // `diff-tree -m --first-parent` still prints every parent's changes on this git, so a commit with a parent is compared with `<oid>^1` directly.
  const compared = (await hasCommit(runner, root, `${oid}^1`)) ? [`${oid}^1`, oid] : ['--root', oid]
  const result = await runner.run({
    cwd: root,
    args: ['diff-tree', '-r', '-M', '-z', '--no-commit-id', '--name-status', ...compared],
    kind: 'read'
  })
  return parseNameStatus(result.stdout)
}

export async function getCommitDiff(runner: GitRunner, root: string, request: CommitDiffRequest): Promise<FileDiff> {
  const { oid, path, oldPath } = request
  oidArg(oid)
  const paths = pathArgs(oldPath === null ? [path] : [oldPath, path])
  await requireCommit(runner, root, oid)
  const limit = request.force === true ? FORCED_DIFF_LIMIT_BYTES : DIFF_LIMIT_BYTES
  const isRoot = !(await hasCommit(runner, root, `${oid}^1`))
  const args = isRoot
    ? ['show', '--format=', ...SAFE_FLAGS, oid, ...paths]
    : ['diff', ...SAFE_FLAGS, '-M', `${oid}^1`, oid, ...paths]
  try {
    const result = await runner.run({ cwd: root, args, kind: 'read', maxOutputBytes: limit })
    return { ...parseUnifiedDiff(result.stdout), path, oldPath }
  } catch (error) {
    if (error instanceof GitError && error.code === 'output_too_large') {
      return { kind: 'too_large', bytes: limit, path, oldPath, oldMode: null, newMode: null, hash: '' }
    }
    throw error
  }
}
