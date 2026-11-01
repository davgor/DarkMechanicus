/** A real temporary Git repository, for tests that need real history (ancestry, merges, squashes). Not shipped. */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
  'core.autocrlf=false'
]

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

function runGit(deps: GitRepoDeps, root: string, args: string[]): string {
  return deps.execFileSync('git', ['-C', root, ...CONFIG, ...args], { encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * `git init` on `main`, with the identity in the repository's own config: the code under test runs git without this
 * helper's `-c` options, and on a machine with no global identity (a CI runner) its commits would be refused.
 */
function initRepository(deps: GitRepoDeps, root: string): void {
  runGit(deps, root, ['init', '-q', '-b', 'main'])
  // Written straight into the file: a `git config` process each costs tests that build many repositories.
  appendFileSync(join(root, '.git', 'config'), '[user]\n\tname = Test\n\temail = test@example.com\n')
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
  let counter = 0
  const git = (...args: string[]): string => runGit(deps, root, args)
  const commit = (message: string): string => {
    counter += 1
    const file = `file-${counter}.txt`
    writeFileSync(join(root, file), `${message}\n${counter}\n`)
    git('add', '--', file)
    git('commit', '-q', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  commit('initial commit')
  return {
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
      return git('rev-parse', 'HEAD')
    },
    squash: (name, message) => {
      git('merge', '--squash', '-q', name)
      git('commit', '-q', '-m', message)
      return git('rev-parse', 'HEAD')
    },
    cleanup: temp?.cleanup ?? (() => rmSync(root, { recursive: true, force: true }))
  }
}
