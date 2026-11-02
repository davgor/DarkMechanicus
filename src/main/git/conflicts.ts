/**
 * Merge conflicts: the unmerged files with their kind and marker count, resolving a file with one side or by hand,
 * committing or aborting the merge, and aborting a rebase, cherry-pick or revert started elsewhere. Every path the
 * renderer names must be one git reports as unmerged, and git reads it literally (no pathspec magic). A file is only
 * read or opened when it resolves (symlinks followed) to a place inside the working tree and outside any `.git`, and
 * only a plain, non-executable file that no OS runs by its name is handed to the default app.
 */
import { open } from 'node:fs/promises'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CommitMergeRequest, ConflictFile, ConflictKind, ConflictState, MarkResolvedRequest, ResolveRequest } from '../../shared/git/conflicts'
import type { RepoState, RepoStatus } from '../../shared/git/status'
import { literalPathArgs } from './args'
import { buildMessage, checkPaths, requireStatus } from './commit'
import { GitError, GitInputError } from './errors'
import type { GitRunner } from './runner'
import { readRepoState } from './status'

/** Electron's `shell.openPath`: resolves to an error message, or '' once the default app has the file. */
export type OpenPath = (path: string) => Promise<string>

const KINDS: Readonly<Record<string, ConflictKind>> = {
  UU: 'both_modified',
  AA: 'both_added',
  DU: 'deleted_by_us',
  UD: 'deleted_by_them',
  DD: 'both_deleted',
  AU: 'added_by_us',
  UA: 'added_by_them'
}

/** `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` of `git status --porcelain=v2 -z`. */
const UNMERGED_ENTRY = /^u (\S\S) \S+ \S+ (\S+) (\S+) \S+ \S+ (\S+) (\S+) (.*)$/s
/** The mode git prints for a stage that does not exist (the side deleted the file, or never had it). */
const NO_STAGE = '000000'
const GITLINK_MODE = '160000'
/** Git writes `conflict-marker-size` (7 unless an attribute says otherwise) `<`, then a space and the side's name. */
const MIN_MARKER_RUN = 7
const LESS_THAN = 0x3c
const SPACE = 0x20
const NEWLINE = 0x0a
const CHUNK_BYTES = 1024 * 1024
const MAX_LABEL_CHARS = 200
/**
 * Names macOS, Windows or a Linux desktop opens by running or launching them, whatever the content. A conflicted file
 * like this is not handed to the default app.
 */
const LAUNCHED_EXTENSIONS: Readonly<Record<string, true>> = Object.fromEntries(
  ['.app', '.command', '.tool', '.terminal', '.workflow', '.action', '.pkg', '.mpkg', '.dmg', '.webloc', '.inetloc', '.fileloc',
    '.scpt', '.scptd', '.applescript', '.jar', '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse',
    '.wsf', '.wsh', '.msc', '.msi', '.msp', '.scr', '.pif', '.cpl', '.hta', '.lnk', '.url', '.reg', '.inf', '.application',
    '.appref-ms', '.gadget', '.settingcontent-ms', '.library-ms', '.desktop', '.sh', '.run', '.bin', '.appimage', '.py', '.pyw',
    '.pyz', '.pl', '.jnlp', '.chm', '.wsc', '.sct', '.ws', '.scf', '.xbap'].map((ext) => [ext, true])
)

interface Stage {
  mode: string
  oid: string
}

interface Unmerged {
  file: ConflictFile
  /** Our side (stage 2) and their side (stage 3); the mode is `000000` when that side has no such file. */
  ours: Stage
  theirs: Stage
}

type Located = { kind: 'file'; path: string } | { kind: 'missing' } | { kind: 'outside' }

/**
 * Where `path` (git's `/`-separated path) really is, symlinks followed, refusing anything outside the working tree or
 * inside a `.git`. A path that is not there is placed under the real path of its nearest folder that is, so one under a
 * link leading out of the working tree is outside too, even when the link's target lacks the rest (`l -> C:\` names no
 * `C:\etc`).
 */
export function locate(root: string, path: string): Located {
  const { real, exists } = nearestReal(root, path.split('/'))
  const within = relative(realpathSync.native(root), real)
  const segments = within.split(sep)
  if (within === '' || segments[0] === '..' || isAbsolute(within) || segments.some((segment) => segment.toLowerCase() === '.git')) {
    return { kind: 'outside' }
  }
  return exists ? { kind: 'file', path: real } : { kind: 'missing' }
}

/** The real path of `names` under `root`, or of the nearest folder of theirs that exists with the rest joined back on. */
function nearestReal(root: string, names: string[]): { real: string; exists: boolean } {
  for (let kept = names.length; kept > 0; kept -= 1) {
    try {
      return { real: join(realpathSync.native(join(root, ...names.slice(0, kept))), ...names.slice(kept)), exists: kept === names.length }
    } catch {
      // Not there: try the folder holding it.
    }
  }
  return { real: join(realpathSync.native(root), ...names), exists: false }
}

interface MarkerScan {
  count: number
  /** How many `<` the current line starts with so far; -1 once it cannot start with a marker. */
  run: number
}

/** Carries the scan through the first `length` bytes of `chunk`; a line may continue from the chunk before. */
function scanChunk(scan: MarkerScan, chunk: Buffer, length: number): void {
  for (let at = 0; at < length; at += 1) {
    const byte = chunk[at]
    if (byte === NEWLINE) {
      scan.run = 0
    } else if (scan.run >= 0 && byte === LESS_THAN) {
      scan.run += 1
    } else {
      scan.count += scan.run >= MIN_MARKER_RUN && byte === SPACE ? 1 : 0
      scan.run = -1
    }
  }
}

/**
 * Lines of `file` that start with 7 or more `<` and a space (`<<<<<<< HEAD`, or a longer marker git was told to
 * write), read in chunks and without blocking main, so a large file neither sits in memory nor stalls the windows.
 */
async function countMarkers(file: string): Promise<number> {
  const handle = await open(file, 'r')
  const chunk = Buffer.alloc(CHUNK_BYTES)
  const scan: MarkerScan = { count: 0, run: 0 }
  try {
    let { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES)
    while (bytesRead > 0) {
      scanChunk(scan, chunk, bytesRead)
      ;({ bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES))
    }
  } finally {
    await handle.close()
  }
  return scan.count
}

/** 0 when the file is missing, not a plain file, or outside the working tree; 1 when it cannot be read (still conflicted). */
async function markersIn(root: string, path: string): Promise<number> {
  const located = locate(root, path)
  if (located.kind !== 'file') {
    return 0
  }
  try {
    return statSync(located.path).isFile() ? await countMarkers(located.path) : 0
  } catch {
    return 1
  }
}

async function readUnmerged(runner: GitRunner, root: string): Promise<Unmerged[]> {
  const result = await runner.run({ cwd: root, args: ['status', '--porcelain=v2', '-z', '--untracked-files=no'], kind: 'read' })
  const entries: Unmerged[] = []
  for (const entry of result.stdout.split('\0')) {
    const match = UNMERGED_ENTRY.exec(entry)
    const kind = match === null ? undefined : KINDS[match[1]]
    if (match !== null && kind !== undefined) {
      const path = match[6]
      const file = { path, kind, markers: await markersIn(root, path) }
      entries.push({ file, ours: { mode: match[2], oid: match[4] }, theirs: { mode: match[3], oid: match[5] } })
    }
  }
  return entries.sort((a, b) => (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0))
}

/** `Merge branch 'topic'` names `topic`; a pull's `Merge branch 'main' of <url>` keeps the `of <url>`. */
function labelOf(line: string): string {
  const match = /^Merge (?:remote-tracking branch|branch|tag|commit) '([^']+)'(?: of (\S+))?/.exec(line)
  const label = match === null ? line : match[2] === undefined ? match[1] : `${match[1]} of ${match[2]}`
  return label.slice(0, MAX_LABEL_CHARS)
}

/** The first line of MERGE_MSG as a label; null when git wrote none. */
function readLabel(path: string): string | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const first = text.split(/\r?\n/, 1)[0].trim()
  return first === '' ? null : labelOf(first)
}

interface MergeFiles {
  /** What is being merged in, from MERGE_MSG. */
  label: string | null
  /** Whether MERGE_HEAD exists: git is running a real merge, also at a `git rebase -r` merge step. */
  mergeHead: boolean
}

async function readMergeFiles(runner: GitRunner, root: string): Promise<MergeFiles> {
  const result = await runner.run({ cwd: root, args: ['rev-parse', '--git-path', 'MERGE_MSG', '--git-path', 'MERGE_HEAD'], kind: 'read' })
  const [message = '', head = ''] = result.stdout.split(/\r?\n/)
  return {
    label: message === '' ? null : readLabel(resolve(root, message)),
    mergeHead: head !== '' && existsSync(resolve(root, head))
  }
}

/**
 * The unmerged files and the sides' names. Whose side is mine is decided here alone: a rebase replaying a commit
 * checks out the upstream as git's `ours` and replays the person's commit as `theirs`; at a `git rebase -r` merge step
 * (MERGE_HEAD exists) git runs a real merge on the rewritten branch, so `ours` is the person's again, as in a merge,
 * cherry-pick, revert or `git am`. A conflict with nothing in progress is a stash restore, whose `theirs` is the
 * person's stashed work.
 */
export async function getConflicts(runner: GitRunner, folder: string): Promise<ConflictState> {
  const status = await requireStatus(runner, folder)
  const unmerged = await readUnmerged(runner, status.root)
  const merge = status.inProgress === null ? null : await readMergeFiles(runner, status.root)
  const replaying = status.inProgress === 'rebase' && merge !== null && !merge.mergeHead
  const stashRestore = status.inProgress === null && unmerged.length > 0
  return {
    ourBranch: status.branch.name,
    theirLabel: merge === null ? null : merge.label,
    mineSide: replaying || stashRestore ? 'theirs' : 'ours',
    files: unmerged.map((entry) => entry.file)
  }
}

interface FoundConflict {
  status: RepoStatus
  entry: Unmerged
}

/**
 * Whether a folder on the way to `path` (git's `/`-separated path) is a link. Git refuses to stage a path beyond a
 * symbolic link, but git for Windows takes a junction for a plain folder and would stage a file from wherever it leads.
 */
function beyondLink(root: string, path: string): boolean {
  const folders = path.split('/').slice(0, -1)
  for (let depth = 1; depth <= folders.length; depth += 1) {
    try {
      if (lstatSync(join(root, ...folders.slice(0, depth))).isSymbolicLink()) {
        return true
      }
    } catch {
      return false
    }
  }
  return false
}

/** The unmerged entry for exactly `path`; any other path (outside, normalized differently, not unmerged) is refused. */
async function findConflict(runner: GitRunner, folder: string, path: string): Promise<FoundConflict> {
  checkPaths([path])
  const status = await requireStatus(runner, folder)
  const entry = (await readUnmerged(runner, status.root)).find((candidate) => candidate.file.path === path)
  if (entry === undefined) {
    throw new GitInputError(`${path} is not a conflicted file.`)
  }
  return { status, entry }
}

function write(runner: GitRunner, root: string, args: string[]): Promise<unknown> {
  return runner.run({ cwd: root, args, kind: 'write' })
}

/**
 * Takes one side's version and stages it: a submodule's commit straight into the index (checkout does not move a
 * gitlink), and a removal when that side has no such file.
 */
export async function resolveWith(runner: GitRunner, folder: string, request: ResolveRequest): Promise<RepoState> {
  const { status, entry } = await findConflict(runner, folder, request.path)
  const root = status.root
  const paths = [request.path]
  const chosen = request.side === 'ours' ? entry.ours : entry.theirs
  if (chosen.mode === NO_STAGE) {
    await write(runner, root, literalPathArgs(['rm', '-q'], paths))
  } else if (chosen.mode === GITLINK_MODE) {
    await write(runner, root, ['update-index', '--cacheinfo', `${chosen.mode},${chosen.oid},${request.path}`])
  } else {
    await write(runner, root, literalPathArgs(['checkout', `--${request.side}`], paths))
    await write(runner, root, literalPathArgs(['add'], paths))
  }
  return readRepoState(runner, root)
}

/** Stages a file resolved by hand (its deletion when it is gone); refused while conflict markers remain. */
export async function markResolved(runner: GitRunner, folder: string, request: MarkResolvedRequest): Promise<RepoState> {
  const { status, entry } = await findConflict(runner, folder, request.path)
  if (beyondLink(status.root, request.path)) {
    throw new GitInputError(`${request.path} is reached through a linked folder, so it is not staged.`)
  }
  const { markers } = entry.file
  if (markers > 0) {
    throw new GitError('conflict_markers_remain', '', `${request.path} still has ${markers} conflict ${markers === 1 ? 'marker' : 'markers'}.`)
  }
  await write(runner, status.root, literalPathArgs(['add', '-A'], [request.path]))
  return readRepoState(runner, status.root)
}

async function requireMerge(runner: GitRunner, folder: string): Promise<RepoStatus> {
  const status = await requireStatus(runner, folder)
  if (status.inProgress !== 'merge') {
    throw new GitInputError('No merge is in progress.')
  }
  return status
}

export async function abortMerge(runner: GitRunner, folder: string): Promise<RepoState> {
  const status = await requireMerge(runner, folder)
  await write(runner, status.root, ['merge', '--abort'])
  return readRepoState(runner, status.root)
}

/** Makes the merge commit, with git's prepared message unless a summary is given. */
export async function commitMerge(runner: GitRunner, folder: string, request: CommitMergeRequest): Promise<{ oid: string }> {
  const status = await requireMerge(runner, folder)
  if (status.files.some((file) => file.kind === 'conflicted')) {
    throw new GitError('merge_conflicts', '', 'Resolve every conflicted file before committing the merge.')
  }
  const summary = (request.summary ?? '').trim()
  const description = (request.description ?? '').trim()
  if (summary === '' && description !== '') {
    throw new GitInputError('A merge commit message needs a summary.')
  }
  const root = status.root
  if (summary === '') {
    await write(runner, root, [...(await commentCharFix(runner, root)), 'commit', '-q', '--no-edit', '--cleanup=strip'])
  } else {
    await runner.run({ cwd: root, args: ['commit', '-q', '-F', '-'], kind: 'write', stdin: buildMessage(summary, description) })
  }
  const head = await runner.run({ cwd: root, args: ['rev-parse', 'HEAD'], kind: 'read' })
  return { oid: head.stdout.trim() }
}

/**
 * Pins `core.commentChar=#` when it is `auto`: git wrote MERGE_MSG's comment lines with `#`, but `auto` would pick a
 * character no line starts with, so `--cleanup=strip` would keep them.
 */
async function commentCharFix(runner: GitRunner, root: string): Promise<string[]> {
  const read = await runner.run({ cwd: root, args: ['config', '--default', '#', '--get', 'core.commentChar'], kind: 'read' })
  return read.stdout.trim() === 'auto' ? ['-c', 'core.commentChar=#'] : []
}

/** Aborts a rebase, `git am`, cherry-pick or revert in progress with `git <operation> --abort` (a merge has `abortMerge`). */
export async function abortOperation(runner: GitRunner, folder: string): Promise<RepoState> {
  const status = await requireStatus(runner, folder)
  const operation = status.inProgress
  if (operation === null || operation === 'merge') {
    throw new GitInputError('No rebase, cherry-pick or revert is in progress.')
  }
  await write(runner, status.root, [operation, '--abort'])
  return readRepoState(runner, status.root)
}

/** How `openInEditor` opens a file, and the OS facts it reads (injected so tests can act as Windows). */
interface Opener {
  openPath: OpenPath
  system?: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv }
}

/** On Windows, every extension `PATHEXT` lists also runs as a program. */
function pathExtensions({ platform, env }: NonNullable<Opener['system']>): ReadonlySet<string> {
  if (platform !== 'win32') {
    return new Set()
  }
  const listed = (env.PATHEXT ?? '').split(';').map((ext) => ext.trim().toLowerCase())
  return new Set(listed.filter((ext) => ext !== ''))
}

/** Whether the default app would run the file rather than show it: an execute bit, or a name the OS launches. */
function couldRun(path: string, stats: Stats, extra: ReadonlySet<string>): boolean {
  const ext = extname(path).toLowerCase()
  return (stats.mode & 0o111) !== 0 || LAUNCHED_EXTENSIONS[ext] === true || extra.has(ext)
}

/**
 * Opens a conflicted file in the default app, by its real path, once it is known to be a plain file inside the working
 * tree that the default app shows rather than runs.
 */
export async function openInEditor(runner: GitRunner, folder: string, path: string, opener: Opener): Promise<null> {
  const { status } = await findConflict(runner, folder, path)
  const located = locate(status.root, path)
  if (located.kind === 'missing') {
    throw new GitInputError(`${path} is not in the working tree.`)
  }
  if (located.kind === 'outside') {
    throw new GitInputError(`${path} leads outside the repository's working files.`)
  }
  const stats = statSync(located.path)
  if (!stats.isFile()) {
    throw new GitInputError(`${path} is not a file. Resolve it in a terminal.`)
  }
  const extra = pathExtensions(opener.system ?? { platform: process.platform, env: process.env })
  if (couldRun(path, stats, extra) || couldRun(located.path, stats, extra)) {
    throw new GitInputError(`${path} could run as a program, so it is not opened. Open it from your editor instead.`)
  }
  const failure = await opener.openPath(located.path)
  if (failure !== '') {
    throw new GitInputError(`Could not open ${path}: ${failure}`)
  }
  return null
}
