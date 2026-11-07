/** A real repository with a local bare `origin` and a teammate's clone, under an isolated git config. Not shipped. */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { vi } from 'vitest'
import { createGitRepo, openGitRepo, type GitRepo } from './gitRepo'
import { copyRepositories, useTemplate } from './gitTemplate'
import { gitIn, put, scratchDir } from './gitScratch'

/** No automatic maintenance after a commit, fetch or push (see `REPO_CONFIG`). */
const NO_MAINTENANCE = '[maintenance]\n\tauto = false\n'

interface RemoteRepos {
  /** The repository under test, on `main`, tracking `origin/main`. */
  local: GitRepo
  /** Another clone of the same bare `origin`, standing in for a teammate. */
  other: string
  bare: string
}

/**
 * Neither the person's global config nor the system one takes part; the isolated global config holds an
 * identity, so the code under test can stash and merge, and turns off automatic maintenance (see `REPO_CONFIG`).
 * Undo with `vi.unstubAllEnvs()`.
 */
export function isolateGitConfig(cleanups: Array<() => void>): void {
  const home = scratchDir('dm-git-home-')
  cleanups.push(home.cleanup)
  writeFileSync(join(home.path, 'gitconfig'), `[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n${NO_MAINTENANCE}`)
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(home.path, 'gitconfig'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
}

/** A bare repository on `main` at `path`, without automatic maintenance after a push (see `REPO_CONFIG`). */
function initBare(path: string): void {
  gitIn(path, 'init', '-q', '--bare', '-b', 'main')
  appendFileSync(join(path, 'config'), NO_MAINTENANCE)
}

/** A bare repository on `main`. */
export function bareRepo(cleanups: Array<() => void>): string {
  const bare = scratchDir()
  cleanups.push(bare.cleanup)
  initBare(bare.path)
  return bare.path
}

/**
 * A repository on `main` tracking its bare `origin`, and a teammate's clone of that origin: built once for the file
 * (see `useTemplate`) and copied for each call, each copy with its own bare origin, without the dozen git processes
 * that build them.
 */
export function useRemoteRepos(): (cleanups: Array<() => void>) => RemoteRepos {
  const template = useTemplate((cleanups) => {
    const base = scratchDir('dm-remotes-')
    cleanups.push(base.cleanup)
    const local = createGitRepo({ root: join(base.path, 'local') })
    const bare = join(base.path, 'bare.git')
    mkdirSync(bare)
    initBare(bare)
    local.git('remote', 'add', 'origin', bare)
    local.git('push', '-q', '-u', 'origin', 'main')
    gitIn(base.path, 'clone', '-q', bare, join(base.path, 'other'))
    return base.path
  })
  return (cleanups) => {
    const copy = copyRepositories(template(), cleanups)
    // createGitRepo's initial commit wrote file-1.txt.
    return { local: openGitRepo(join(copy, 'local'), 1, () => undefined), other: join(copy, 'other'), bare: join(copy, 'bare.git') }
  }
}

/** Commits `file` in a clone `count` times and pushes the current branch to its origin. */
export function teammatePushes(other: string, file: string, count = 1): void {
  for (let i = 1; i <= count; i += 1) {
    put(other, file, `teammate ${i}\n`)
    gitIn(other, 'add', '.')
    gitIn(other, 'commit', '-q', '-m', `teammate ${i}`)
  }
  gitIn(other, 'push', '-q', 'origin', 'HEAD')
}
