import { execFile, execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fail } from '../errors'
import { gitOriginContext, queryLocalGitOrigin, type LocalGitOriginConfigCache } from './gitOriginConfig'
import { nodeFs } from './nodeFs'
import { ancestorsOf } from './discovery'
import { DM_DIR } from './layout'
import type { FsAdapter, GitAdapter, GitHead, GitPathChange, GitPathsFailure } from './types'

type RunGit = (args: string[]) => Promise<{ code: number; stdout: string }>
/** The same, synchronously: for the few reads a database transaction needs (e.g. binding an epic branch). */
type RunGitSync = (args: string[]) => { code: number; stdout: string }

const HEADS_PREFIX = 'refs/heads/'
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const BRANCH_REF_PATTERN = /^refs\/heads\/[^\s~^:?*[\\]+$/
const MAX_GIT_FILE_BYTES = 1024 * 1024
const MAX_PACKED_REFS_BYTES = 16 * 1024 * 1024
const GIT_TIMEOUT_MS = 10_000
const GIT_FAILED = 128
const GIT_MAX_BUFFER = 16 * 1024 * 1024
/** Variables that would point git at another repository than the one we pass with -C. */
const REDIRECTING_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE'
]

/** Reads a small metadata file; null when missing, empty/special (size 0), oversized, or unreadable. */
function readSmall(fs: FsAdapter, path: string, limit: number): string | null {
  const size = fs.fileSize(path)
  if (size <= 0 || size > limit) {
    return null
  }
  try {
    return fs.readFile(path)
  } catch {
    return null
  }
}

function resolveGitDir(fs: FsAdapter, root: string): string | null {
  const dotGit = join(root, '.git')
  if (fs.isDirectory(dotGit)) {
    return dotGit
  }
  const pointer = readSmall(fs, dotGit, MAX_GIT_FILE_BYTES)
  const target = pointer === null ? undefined : /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1]
  return target === undefined ? null : resolve(root, target)
}

function commonDirOf(fs: FsAdapter, gitDir: string): string | null {
  const text = readSmall(fs, join(gitDir, 'commondir'), MAX_GIT_FILE_BYTES)?.trim()
  return text ? resolve(gitDir, text) : null
}

function looseRef(fs: FsAdapter, dir: string, ref: string): string | null {
  const text = readSmall(fs, join(dir, ...ref.split('/')), MAX_GIT_FILE_BYTES)?.trim() ?? ''
  return SHA_PATTERN.test(text) ? text : null
}

function packedRef(fs: FsAdapter, dir: string, ref: string): string | null {
  const text = readSmall(fs, join(dir, 'packed-refs'), MAX_PACKED_REFS_BYTES) ?? ''
  for (const line of text.split(/\r?\n/)) {
    const [sha, name] = line.split(' ')
    if (name === ref && sha !== undefined && SHA_PATTERN.test(sha)) {
      return sha
    }
  }
  return null
}

function resolveRef(fs: FsAdapter, gitDir: string, ref: string): string | null {
  const dirs = [gitDir, commonDirOf(fs, gitDir)].filter((dir): dir is string => dir !== null)
  for (const dir of dirs) {
    const found = looseRef(fs, dir, ref) ?? packedRef(fs, dir, ref)
    if (found !== null) {
      return found
    }
  }
  return null
}

function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0)
  return code < 32 || code === 127
}

/** Local branch refs git itself would accept: no traversal, whitespace, or special characters. */
function isBranchRef(ref: string): boolean {
  return BRANCH_REF_PATTERN.test(ref) && !ref.includes('..') && !ref.includes('//') && ![...ref].some(isControlCharacter)
}

function parseHead(fs: FsAdapter, gitDir: string, head: string): GitHead {
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1] ?? ''
  if (isBranchRef(ref)) {
    return { branch: ref.slice(HEADS_PREFIX.length), commit: resolveRef(fs, gitDir, ref), detached: false }
  }
  return { branch: null, commit: SHA_PATTERN.test(head) ? head : null, detached: true }
}

function readGitHead(fs: FsAdapter, root: string): GitHead | null {
  const gitDir = resolveGitDir(fs, root)
  const head = gitDir === null ? null : readSmall(fs, join(gitDir, 'HEAD'), MAX_GIT_FILE_BYTES)
  if (gitDir === null || head === null) {
    return null
  }
  return parseHead(fs, gitDir, head.trim())
}

function readIndexStamp(fs: FsAdapter, root: string): string | null {
  const gitDir = resolveGitDir(fs, root)
  return gitDir === null ? null : fs.fileStamp(join(gitDir, 'index'))
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  for (const key of REDIRECTING_ENV) {
    delete env[key]
  }
  return env
}

/** Git's exit status, or 128 (its "fatal" status) when the process could not run or was stopped. */
function exitCodeOf(error: { code?: unknown }): number {
  return typeof error.code === 'number' ? error.code : GIT_FAILED
}

function defaultRunGit(root: string): RunGit {
  return (args) =>
    new Promise((settle) => {
      execFile(
        'git',
        ['-C', root, ...args],
        { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: gitEnv(), windowsHide: true },
        (error, stdout) => settle({ code: error ? exitCodeOf(error) : 0, stdout })
      )
    })
}

function defaultRunGitSync(root: string, env?: NodeJS.ProcessEnv, executable = 'git'): RunGitSync {
  return (args) => {
    try {
      const stdout = execFileSync(executable, ['-C', root, ...args], {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        env: env ?? gitEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return { code: 0, stdout }
    } catch (error: unknown) {
      // execFileSync throws with the exit status in `status` (null when git could not run or was killed).
      const status = error !== null && typeof error === 'object' && 'status' in error ? error.status : null
      return { code: typeof status === 'number' ? status : GIT_FAILED, stdout: '' }
    }
  }
}

function directoryStamp(path: string): string {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isDirectory()) throw new Error('The local Git checkout directory changed.')
  return `${path}:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

/** Cheap identity of a previously validated local Git checkout and its origin configuration. */
export function gitCheckoutStamp(root: string, protectIndex: boolean): string {
  const gitDir = resolveGitDir(nodeFs, root)
  if (gitDir === null) throw new Error('The local Git checkout metadata is missing.')
  const common = commonDirOf(nodeFs, gitDir) ?? gitDir
  return JSON.stringify([
    directoryStamp(root), directoryStamp(gitDir), directoryStamp(common),
    nodeFs.fileStamp(join(root, '.git')), nodeFs.fileStamp(join(gitDir, 'commondir')),
    nodeFs.fileStamp(join(common, 'config')), nodeFs.fileStamp(join(gitDir, 'config.worktree')),
    protectIndex ? [nodeFs.fileStamp(join(gitDir, 'index')), readGitHead(nodeFs, root)] : null
  ])
}

function readLocalGitOriginLive(root: string): string | null {
  if (nodeFs.isSymlink(join(root, '.git'))) return null
  const run = defaultRunGitSync(root)
  const top = run(['rev-parse', '--show-toplevel'])
  if (top.code !== 0 || nodeFs.realpath(top.stdout.trim()) !== root) return null
  return queryLocalGitOrigin(run)
}

export function gitOriginExecutionStamp(): string { return gitOriginContext(gitEnv()).key }

/** Reads an actual checkout's configured origin, without consulting URL rewrites or included configuration. */
export function readLocalGitOrigin(root: string, configCache?: LocalGitOriginConfigCache): string | null {
  if (configCache === undefined) return readLocalGitOriginLive(root)
  const env = gitEnv()
  const initial = gitOriginContext(env)
  return configCache.read(root, {
    initial, contextNow: () => gitOriginContext(gitEnv()),
    run: defaultRunGitSync(root, env, initial.executable ?? 'git'), fallback: () => readLocalGitOriginLive(root)
  })
}

/** A machine-private path must be absent from both the index and committed tree before it can be read. */
export function isUntrackedLocalGitPath(root: string, path: string): boolean {
  const run = defaultRunGitSync(root)
  const index = run(['ls-files', '-z', '--', ':(icase,literal)' + path])
  if (index.code !== 0 || index.stdout !== '') return false
  if (readGitHead(nodeFs, root)?.commit === null) return true
  // ls-tree only supports case-sensitive pathspecs. Check the names so case aliases cannot hide portable private state.
  const head = run(['ls-tree', '-r', '-z', '--name-only', 'HEAD'])
  const privatePath = path.toLowerCase()
  return head.code === 0 && !head.stdout.split('\0').some(name => {
    const lower = name.toLowerCase()
    return lower === privatePath || lower.startsWith(privatePath + '/')
  })
}

/** Refs and paths become git arguments: refuse anything git could read as an option. */
function safeArg(value: string): string {
  if (value.startsWith('-') || value.includes('\u0000')) {
    fail('unsafe_path', 'Refusing to pass an option-like or NUL-containing value to git.')
  }
  return value
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line !== '')
}

/** `<commit> <parent>...` as `rev-list --parents` prints one commit; null for anything else. */
function parseCommitLine(text: string): { commit: string; parents: string[] } | null {
  const rows = lines(text)
  const [commit, ...parents] = rows[0]?.split(' ') ?? []
  const valid = rows.length === 1 && commit !== undefined && [commit, ...parents].every((id) => SHA_PATTERN.test(id))
  return valid ? { commit, parents } : null
}

/** `git diff --name-status` letters `--no-renames` can print (copies and renames never appear). */
const DIFF_STATUS = /^[ADMTUX]$/
/** Field counts before the path in `git status --porcelain=v2` entries: untracked, ignored, ordinary, renamed or copied, unmerged. */
const STATUS_FIELDS: Record<string, number> = { '?': 1, '!': 1, '1': 8, '2': 9, u: 10 }
/** What `# branch.oid` and `# branch.head` say for an unborn HEAD and a detached one. */
const UNBORN_OID = '(initial)'
const DETACHED_HEAD = '(detached)'

/** `<status>\0<path>\0` pairs of `git diff --name-status -z`; null for output that is not that shape. */
function parseNameStatus(text: string): GitPathChange[] | null {
  const tokens = text.split('\u0000')
  if (tokens.pop() !== '' || tokens.length % 2 !== 0) {
    return text === '' ? [] : null
  }
  const paths: GitPathChange[] = []
  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index] ?? ''
    const path = tokens[index + 1] ?? ''
    if (!DIFF_STATUS.test(status) || path === '') {
      return null
    }
    paths.push({ status, path })
  }
  return paths
}

/** What `git status --porcelain=v2 --branch` has said so far; `undefined` until its header names HEAD and the branch. */
interface StatusScan {
  head: string | null | undefined
  branch: string | null | undefined
  paths: GitPathChange[]
}

/** The `--branch` headers read: each value checked, `undefined` for one git never prints. Other headers are skipped. */
const STATUS_HEADERS: Record<string, { key: 'head' | 'branch'; read: (value: string) => string | null | undefined }> = {
  'branch.oid': { key: 'head', read: (value) => (value === UNBORN_OID ? null : SHA_PATTERN.test(value) ? value : undefined) },
  'branch.head': { key: 'branch', read: (value) => (value === DETACHED_HEAD ? null : isBranchRef(`${HEADS_PREFIX}${value}`) ? value : undefined) }
}

/** One `# <name> <value>` header; false when a header it reads holds a value git never prints. */
function readStatusHeader(entry: string, scan: StatusScan): boolean {
  const [, name = '', value = ''] = /^# (\S+) (.*)$/.exec(entry) ?? []
  const header = Object.hasOwn(STATUS_HEADERS, name) ? STATUS_HEADERS[name] : undefined
  if (header === undefined) return true
  scan[header.key] = header.read(value)
  return scan[header.key] !== undefined
}

/** One changed-path entry, and for a rename or copy its source path from `rest`; false for an entry it cannot read. */
function readStatusEntry(entry: string, rest: Iterator<string, undefined>, paths: GitPathChange[]): boolean {
  const kind = entry.charAt(0)
  const fields = STATUS_FIELDS[kind]
  const parts = entry.split(' ')
  const path = parts.slice(fields).join(' ')
  if (fields === undefined || parts.length <= fields || path === '') return false
  // Untracked and ignored entries have no `XY` field: their kind is their status.
  const status = fields === 1 ? kind : (parts[1] ?? '')
  paths.push({ status, path })
  if (kind !== '2') return true
  // A rename or copy names its source in the next token: that path changed too.
  const source = rest.next().value ?? ''
  paths.push({ status, path: source })
  return source !== ''
}

/** `git status --porcelain=v2 -z --branch`: HEAD's commit and branch, and the paths, still relative to the repository root. */
function parseStatusV2(text: string): { head: string | null; branch: string | null; paths: GitPathChange[] } | null {
  const tokens = text.split('\u0000')
  if (tokens.pop() !== '') return null
  const scan: StatusScan = { head: undefined, branch: undefined, paths: [] }
  const queue = tokens.values()
  for (const entry of queue) {
    if (!(entry.startsWith('# ') ? readStatusHeader(entry, scan) : readStatusEntry(entry, queue, scan.paths))) return null
  }
  const { head, branch, paths } = scan
  return head === undefined || branch === undefined ? null : { head, branch, paths }
}

/** Repository-root paths made relative to the folder at `prefix` (`rev-parse --show-prefix`); null if one is outside. */
function belowPrefix(paths: GitPathChange[], prefix: string): GitPathChange[] | null {
  const relative: GitPathChange[] = []
  for (const change of paths) {
    const path = change.path.slice(prefix.length)
    if (!change.path.startsWith(prefix) || path === '') {
      return null
    }
    relative.push({ status: change.status, path })
  }
  return relative
}

/** `diffPaths` and `statusPaths`: git run in `.darkmechanicus/` below `root`, without git's optional index lock. */
function recordPathQueries(
  root: string,
  fs: FsAdapter,
  output: (args: string[]) => Promise<string | null>
): Pick<GitAdapter, 'diffPaths' | 'statusPaths'> {
  const inDmDir = (args: string[]): Promise<string | null> => output(['--no-optional-locks', '-C', DM_DIR, ...args])
  /** Why a git command run in `.darkmechanicus/` failed: no repository holds it, or git itself failed. */
  const failure = (): { ok: false; reason: GitPathsFailure } => {
    const inRepository = ancestorsOf(resolve(root, DM_DIR)).some((dir) => fs.exists(join(dir, '.git')))
    return { ok: false, reason: inRepository ? 'git_failed' : 'not_work_tree' }
  }
  return {
    diffPaths: async (from, to) => {
      const text = await inDmDir(['diff', '--name-status', '-z', '--no-renames', '--no-color', '--relative', safeArg(from), safeArg(to), '--', '.'])
      const paths = text === null ? null : parseNameStatus(text)
      return paths === null ? failure() : { ok: true, paths }
    },
    statusPaths: async () => {
      const [where, text] = await Promise.all([
        inDmDir(['rev-parse', '--is-inside-work-tree', '--show-prefix']),
        inDmDir(['status', '--porcelain=v2', '-z', '--branch', '--no-renames', '-uall', '--ignored=matching', '--', '.'])
      ])
      const [inside, prefix = ''] = (where ?? '').split(/\r?\n/)
      if (where !== null && inside !== 'true') {
        return { ok: false, reason: 'not_work_tree' }
      }
      const status = text === null ? null : parseStatusV2(text)
      const paths = status === null || where === null ? null : belowPrefix(status.paths, prefix)
      return status === null || paths === null ? failure() : { ok: true, head: status.head, branch: status.branch, paths }
    }
  }
}

/** The commit local branch `name` points at, as `GitAdapter.branchCommit` describes. */
function readBranchCommit(fs: FsAdapter, root: string, runSync: RunGitSync, name: string): string | null {
  const ref = `${HEADS_PREFIX}${safeArg(name)}`
  const result = runSync(['rev-parse', '--verify', '--quiet', `${safeArg(ref)}^{commit}`])
  if (result.code !== 0 && result.code !== 1) {
    // Git could not answer (exit 1 is a clean "no such branch"): read the ref the way `head()` does, so an
    // existing branch is never mistaken for a missing one.
    const gitDir = resolveGitDir(fs, root)
    return gitDir !== null && isBranchRef(ref) ? resolveRef(fs, gitDir, ref) : null
  }
  const resolved = result.code === 0 ? result.stdout.trim() : ''
  return SHA_PATTERN.test(resolved) ? resolved : null
}

/**
 * Git access for one repository root. `head()` reads `.git` files directly (worktrees included);
 * the other methods run the git CLI and degrade to null/empty results when git is unavailable.
 */
export function createGitAdapter(
  root: string,
  options: { fs?: FsAdapter; runGit?: RunGit; runGitSync?: RunGitSync } = {}
): GitAdapter {
  const fs = options.fs ?? nodeFs
  const run = options.runGit ?? defaultRunGit(root)
  const runSync = options.runGitSync ?? defaultRunGitSync(root)
  const output = async (args: string[]): Promise<string | null> => {
    const result = await run(args)
    return result.code === 0 ? result.stdout : null
  }
  return {
    head: () => readGitHead(fs, root),
    indexStamp: () => readIndexStamp(fs, root),
    countUncommitted: async (pathspec) => {
      const status = await output(['status', '--porcelain=v1', '-uall', '--', safeArg(pathspec)])
      return status === null ? null : lines(status).length
    },
    listLocalBranches: async () => lines((await output(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])) ?? ''),
    listWorktrees: async () =>
      lines((await output(['worktree', 'list', '--porcelain'])) ?? '')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length)),
    listFiles: async (ref, pathspec) =>
      lines((await output(['ls-tree', '-r', '--name-only', safeArg(ref), '--', safeArg(pathspec)])) ?? ''),
    showFile: async (ref, path) => output(['show', `${safeArg(ref)}:./${safeArg(path)}`]),
    isAncestor: async (ancestor, descendant) => {
      const result = await run(['merge-base', '--is-ancestor', safeArg(ancestor), safeArg(descendant)])
      // Exit status 1 is a clean "no"; any other failure means git could not look the commits up.
      return result.code === 0 ? true : result.code === 1 ? false : null
    },
    commitParents: async (ref) => {
      // `--verify` accepts exactly one revision, so a range or a name that expands to several is refused.
      const resolved = (await output(['rev-parse', '--verify', '--quiet', `${safeArg(ref)}^{commit}`]))?.trim() ?? ''
      const text = SHA_PATTERN.test(resolved) ? await output(['rev-list', '--parents', '-n', '1', resolved, '--']) : null
      return text === null ? null : parseCommitLine(text)
    },
    ...recordPathQueries(root, fs, output),
    branchCommit: (name) => readBranchCommit(fs, root, runSync, name)
  }
}
