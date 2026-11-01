/** A real repository with a local bare `origin` and a teammate's clone, under an isolated git config. Not shipped. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { vi } from 'vitest'
import { createGitRepo, type GitRepo } from './gitRepo'
import { gitIn, put, scratchDir } from './gitScratch'

interface RemoteRepos {
  /** The repository under test, on `main`, tracking `origin/main`. */
  local: GitRepo
  /** Another clone of the same bare `origin`, standing in for a teammate. */
  other: string
  bare: string
}

/**
 * Neither the person's global config nor the system one takes part; the isolated global config holds an
 * identity, so the code under test can stash and merge. Undo with `vi.unstubAllEnvs()`.
 */
export function isolateGitConfig(cleanups: Array<() => void>): void {
  const home = scratchDir('dm-git-home-')
  cleanups.push(home.cleanup)
  writeFileSync(join(home.path, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n')
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(home.path, 'gitconfig'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
}

/** A bare repository on `main`. */
export function bareRepo(cleanups: Array<() => void>): string {
  const bare = scratchDir()
  cleanups.push(bare.cleanup)
  gitIn(bare.path, 'init', '-q', '--bare', '-b', 'main')
  return bare.path
}

export function remoteRepos(cleanups: Array<() => void>): RemoteRepos {
  const local = createGitRepo()
  const others = scratchDir()
  cleanups.push(local.cleanup, others.cleanup)
  const bare = bareRepo(cleanups)
  local.git('remote', 'add', 'origin', bare)
  local.git('push', '-q', '-u', 'origin', 'main')
  const other = join(others.path, 'other')
  gitIn(others.path, 'clone', '-q', bare, other)
  return { local, other, bare }
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
