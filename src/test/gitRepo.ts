/** A real temporary Git repository, for tests that need real history (ancestry, merges, squashes). Not shipped. */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { removeScratch } from './removeScratch'
import { createTempRepo, type TempRepo } from './tempRepo'

export interface GitRepo {
  root: string
  /** Runs git in the repository and returns its trimmed output. */
  git(...args: string[]): string
  /** Commits one new file on the current branch (so `git add` never picks up record files) and returns the commit id. */
  commit(message: string): string
  /** The commit id `ref` names. */
  rev(ref: string): string
  /** Creates `name` at the current commit and switches to it. */
  branch(name: string): void
  switchTo(name: string): void
  /** Merges `name` into the current branch as a merge commit (never fast-forwarded); returns the merge commit id. */
  merge(name: string): string
  /** Squashes `name` into the current branch as one new single-parent commit; returns its id. */
  squash(name: string, message: string): string
  cleanup(): void
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
    delete env[key]
  }
  return env
}

const CONFIG = [
  '-c',
  'user.name=Test',
  '-c',
  'user.email=test@example.com',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'maintenance.auto=false'
]

/**
 * Written into each new repository's own config: the identity (see `initRepository`) and no automatic maintenance.
 * Git otherwise starts a detached `git maintenance run --auto` after every commit, merge, fetch and push, the code
 * under test's included: one more process each time, and one that can still hold the folder when the test removes it.
 */
const REPO_CONFIG = '[user]\n\tname = Test\n\temail = test@example.com\n[maintenance]\n\tauto = false\n'

/** What the helper runs and creates, so a test can make `git init` or the temp folder fail. */
interface GitRepoDeps {
  execFileSync: (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string
  createTempRepo: () => TempRepo
  /** Told about each failure that is retried, so a retry never hides a flake from the test log. */
  warn: (message: string) => void
  /** Blocks between attempts: the helper is synchronous, like the tests that call it. */
  pause: (ms: number) => void
}

const DEFAULT_DEPS: GitRepoDeps = {
  execFileSync,
  createTempRepo,
  warn: (message) => console.warn(message),
  pause: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** How many times the temp folder and `git init` are tried before the failure is thrown. */
const ATTEMPTS = 3
/** The wait after the first failed attempt; it grows by this much after each one. */
const BACKOFF_MS = 50

/**
 * The transient failures: a temp folder another process holds for a moment (on Windows an indexer or a virus
 * scanner can) while it is created, or while `git init` writes the new repository into it. These are the
 * examples DM-214 names, not a reproduced failure.
 */
const BUSY_CODES: Record<string, true> = { EBUSY: true, EPERM: true, EACCES: true }
/** The calls that create the temp folder. The same codes from starting git (`spawnSync git`) are not a busy folder. */
const TEMP_FOLDER_CALLS: Record<string, true> = { mkdtemp: true, mkdir: true, realpath: true }
/** What git prints when it finds the new repository's files locked or busy. */
const GIT_BUSY = /could not lock|Device or resource busy|Permission denied/

function isBusyFolder(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  if ('syscall' in error) {
    return 'code' in error && BUSY_CODES[String(error.code)] === true && TEMP_FOLDER_CALLS[String(error.syscall)] === true
  }
  return 'stderr' in error && typeof error.stderr === 'string' && GIT_BUSY.test(error.stderr)
}

function failureText(error: unknown): string {
  const stderr = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : ''
  return stderr !== '' ? stderr : String(error)
}

/** A git command slower than this is reported, so a stalled CI run shows which command stalled. */
const SLOW_GIT_MS = 2_000

function runGit(deps: GitRepoDeps, root: string, args: string[]): string {
  const started = performance.now()
  try {
    return deps.execFileSync('git', ['-C', root, ...CONFIG, ...args], { encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } finally {
    const ms = Math.round(performance.now() - started)
    if (ms > SLOW_GIT_MS) {
      deps.warn(`slow git: git ${args.join(' ')} took ${ms} ms`)
    }
  }
}

/**
 * `git init` on `main`, with the identity in the repository's own config: the code under test runs git without this
 * helper's `-c` options, and on a machine with no global identity (a CI runner) its commits would be refused.
 */
function initRepository(deps: GitRepoDeps, root: string): void {
  runGit(deps, root, ['init', '-q', '-b', 'main'])
  // Written straight into the file: a `git config` process each costs tests that build many repositories.
  appendFileSync(join(root, '.git', 'config'), REPO_CONFIG)
}

/** A temp folder holding a new, empty repository on `main`; each failed attempt's folder is removed. */
function initFolder(deps: GitRepoDeps): TempRepo {
  for (let attempt = 1; ; attempt += 1) {
    let temp: TempRepo | undefined
    try {
      temp = deps.createTempRepo()
      initRepository(deps, temp.root)
      return temp
    } catch (error: unknown) {
      if (temp !== undefined) {
        removeScratch(temp.base)
      }
      if (attempt === ATTEMPTS || !isBusyFolder(error)) {
        throw error
      }
      const wait = BACKOFF_MS * attempt
      deps.warn(`createGitRepo: the new repository's folder was busy (attempt ${attempt} of ${ATTEMPTS}), retrying in ${wait} ms: ${failureText(error)}`)
      deps.pause(wait)
    }
  }
}

/** The text of `path` when it is a file, else null. */
function fileText(path: string): string | null {
  return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8').trim() : null
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/**
 * The commit HEAD names, read from the repository's files when HEAD is a loose branch ref or a detached commit (one
 * git process fewer per commit); anything else, such as a packed ref or a worktree's `.git` file, asks git.
 */
function headCommit(root: string, git: (...args: string[]) => string): string {
  const head = fileText(join(root, '.git', 'HEAD')) ?? ''
  const ref = /^ref: (refs\/heads\/\S+)$/.exec(head)
  const oid = ref === null ? head : (fileText(join(root, '.git', ref[1] ?? '')) ?? '')
  return OID.test(oid) ? oid : git('rev-parse', 'HEAD')
}

/** How many files each repository's `commit` has written, so a copy carries on from its template's count. */
const counters = new WeakMap<GitRepo, () => number>()

function openRepo(deps: GitRepoDeps, root: string, start: number, cleanup: () => void): GitRepo {
  let counter = start
  const git = (...args: string[]): string => runGit(deps, root, args)
  const commit = (message: string): string => {
    counter += 1
    const file = `file-${counter}.txt`
    writeFileSync(join(root, file), `${message}\n${counter}\n`)
    git('add', '--', file)
    git('commit', '-q', '-m', message)
    return headCommit(root, git)
  }
  const repo: GitRepo = {
    root,
    git,
    commit,
    rev: (ref) => git('rev-parse', '--verify', `${ref}^{commit}`),
    branch: (name) => {
      git('checkout', '-q', '-b', name)
    },
    switchTo: (name) => {
      git('checkout', '-q', name)
    },
    merge: (name) => {
      git('merge', '--no-ff', '--no-edit', '-q', name)
      return headCommit(root, git)
    },
    squash: (name, message) => {
      git('merge', '--squash', '-q', name)
      git('commit', '-q', '-m', message)
      return headCommit(root, git)
    },
    cleanup
  }
  counters.set(repo, () => counter)
  return repo
}

/**
 * A repository whose `main` branch holds one initial commit: in a temporary directory of its own, or at `root`
 * (created here, and removed by `cleanup`), e.g. a child of a folder of repositories. A temporary directory and its
 * `git init` are tried up to three times while the folder is busy; any other failure, and every failure after
 * `git init`, throws at once.
 */
export function createGitRepo(options: { root?: string } & Partial<GitRepoDeps> = {}): GitRepo {
  const { root: at, ...overrides } = options
  const deps: GitRepoDeps = { ...DEFAULT_DEPS, ...overrides }
  const temp = at === undefined ? initFolder(deps) : null
  const root = at ?? temp?.root ?? ''
  if (temp === null) {
    mkdirSync(root)
    initRepository(deps, root)
  }
  const repo = openRepo(deps, root, 0, temp?.cleanup ?? (() => rmSync(root, { recursive: true, force: true })))
  repo.commit('initial commit')
  return repo
}

/**
 * A copy of `template` (history, branches, index, working files and any operation in progress), made without a git
 * process: in a temporary directory of its own, or at `root` (created here, and removed by `cleanup`). Its `commit`
 * carries on from the template's file count. The template must name no other repository by path (a remote); copy a
 * folder of repositories with `copyRepositories` instead.
 */
export function copyGitRepo(template: GitRepo, options: { root?: string } = {}): GitRepo {
  const temp = options.root === undefined ? createTempRepo() : null
  const root = options.root ?? temp?.root ?? ''
  cpSync(template.root, root, { recursive: true })
  return openRepo(DEFAULT_DEPS, root, counters.get(template)?.() ?? 0, temp?.cleanup ?? (() => rmSync(root, { recursive: true, force: true })))
}

/** A repository already on disk at `root`, as `createGitRepo` would give it, whose `commit` has written `files` files. */
export function openGitRepo(root: string, files: number, cleanup: () => void): GitRepo {
  return openRepo(DEFAULT_DEPS, root, files, cleanup)
}
