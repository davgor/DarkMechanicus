/** A real temporary Git repository, for tests that need real history (ancestry, merges, squashes). Not shipped. */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTempRepo } from './tempRepo'

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

/** A repository whose `main` branch holds one initial commit. */
export function createGitRepo(): GitRepo {
  const temp = createTempRepo()
  const root = temp.root
  let counter = 0
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', root, ...CONFIG, ...args], { encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = (message: string): string => {
    counter += 1
    const file = `file-${counter}.txt`
    writeFileSync(join(root, file), `${message}\n${counter}\n`)
    git('add', '--', file)
    git('commit', '-q', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q', '-b', 'main')
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
    cleanup: temp.cleanup
  }
}
