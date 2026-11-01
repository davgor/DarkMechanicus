import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitRepo, type GitRepo } from './gitRepo'
import { createTempRepo, type TempRepo } from './tempRepo'
import { thrownBy } from './thrownBy'

const repos: GitRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) {
    repo.cleanup()
  }
})

function track(repo: GitRepo): GitRepo {
  repos.push(repo)
  return repo
}

/** What `execFileSync` throws when git ran and exited with an error: its exit status and its stderr. */
function gitFailure(stderr: string): Error {
  return Object.assign(new Error(`Command failed: git init -q -b main\n${stderr}`), { status: 128, stderr, stdout: '' })
}

/** What a failed system call throws: `fs` errors and a git that could not be started both look like this. */
function systemError(code: string, syscall: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, syscall, path, errno: -1 })
}

/** Records what the helper reports and how long it waits, instead of printing and sleeping. */
function observed() {
  const warnings: string[] = []
  const waits: number[] = []
  const deps = {
    warn: (message: string) => {
      warnings.push(message)
    },
    pause: (ms: number) => {
      waits.push(ms)
    }
  }
  return { warnings, waits, deps }
}

/**
 * A runner whose first `failures` calls to `git init` throw `error`; every other call runs git for real. It
 * records the folder each `git init` was asked to create.
 */
function failingInit(error: Error, failures: number) {
  const inits: string[] = []
  const run = (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding): string => {
    if (args.includes('init')) {
      inits.push(args[1] ?? '')
      if (inits.length <= failures) {
        throw error
      }
    }
    return execFileSync(file, args, options)
  }
  return { run, inits }
}

/** A temp-folder factory whose first `failures` calls throw `error`; the others create a real folder. */
function failingTemp(error: Error, failures: number) {
  const created: TempRepo[] = []
  let count = 0
  const create = (): TempRepo => {
    count += 1
    if (count <= failures) {
      throw error
    }
    const temp = createTempRepo()
    created.push(temp)
    return temp
  }
  return { create, attempts: () => count, created }
}

const LOCKED = 'error: could not lock config file C:/Users/dev/AppData/Local/Temp/dm-repo-a1/repo/.git/config: File exists\n'
const BUSY =
  "fatal: cannot copy 'C:/Program Files/Git/mingw64/share/git-core/templates/hooks/pre-commit.sample' to 'C:/Users/dev/AppData/Local/Temp/dm-repo-a1/repo/.git/hooks/pre-commit.sample': Device or resource busy\n"
const DENIED = "fatal: could not create leading directories of 'C:/Users/dev/AppData/Local/Temp/dm-repo-a1/repo/.git/objects/pack': Permission denied\n"

describe('createGitRepo: a git init that fails on a busy or locked folder', () => {
  it('is retried in a fresh folder after a short wait, and the repository it returns works', () => {
    const seen = observed()
    const git = failingInit(gitFailure(LOCKED), 1)

    const repo = track(createGitRepo({ execFileSync: git.run, ...seen.deps }))

    expect(git.inits).toHaveLength(2)
    expect(git.inits[1]).toBe(repo.root)
    expect(git.inits[0]).not.toBe(repo.root)
    expect(existsSync(git.inits[0] ?? '')).toBe(false)
    expect(repo.git('branch', '--show-current')).toBe('main')
    expect(repo.git('log', '--format=%s')).toBe('initial commit')
    expect(seen.waits).toEqual([50])
    expect(seen.warnings).toHaveLength(1)
    expect(seen.warnings[0]).toContain('attempt 1 of 3')
    expect(seen.warnings[0]).toContain('could not lock config file')
  })

  it.each([
    ['could not lock', LOCKED],
    ['Device or resource busy', BUSY],
    ['Permission denied', DENIED]
  ])('is retried when git says %s', (_phrase, stderr) => {
    const git = failingInit(gitFailure(stderr), 2)

    const repo = track(createGitRepo({ execFileSync: git.run, ...observed().deps }))

    expect(git.inits).toHaveLength(3)
    expect(repo.rev('HEAD')).toMatch(/^[0-9a-f]{40}$/)
  })

  it("throws git's own error once three attempts have failed, and leaves no folder behind", () => {
    const seen = observed()
    const failure = gitFailure(BUSY)
    const git = failingInit(failure, Number.POSITIVE_INFINITY)

    const thrown = thrownBy(() => track(createGitRepo({ execFileSync: git.run, ...seen.deps })))

    expect(thrown).toBe(failure)
    expect(git.inits).toHaveLength(3)
    expect(git.inits.map((root) => existsSync(root))).toEqual([false, false, false])
    expect(seen.waits).toEqual([50, 100])
    expect(seen.warnings.map((message) => /attempt (\d) of 3/.exec(message)?.[1])).toEqual(['1', '2'])
  })
})

describe('createGitRepo: any other git failure', () => {
  it.each([
    ['a git error that is not a busy folder', gitFailure("fatal: invalid initial branch name: 'main'\n")],
    ['git that cannot be started', systemError('EACCES', 'spawnSync git', 'git')],
    ['git that is missing', systemError('ENOENT', 'spawnSync git', 'git')]
  ])('throws on the first attempt for %s', (_name, failure) => {
    const seen = observed()
    const git = failingInit(failure, 1)

    const thrown = thrownBy(() => track(createGitRepo({ execFileSync: git.run, ...seen.deps })))

    expect(thrown).toBe(failure)
    expect(git.inits).toHaveLength(1)
    expect(existsSync(git.inits[0] ?? '')).toBe(false)
    expect(seen.warnings).toEqual([])
    expect(seen.waits).toEqual([])
  })

  it('is not retried after the repository was created', () => {
    const seen = observed()
    const failure = gitFailure(LOCKED)
    let fail = false
    const run = (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding): string => {
      if (fail) {
        throw failure
      }
      return execFileSync(file, args, options)
    }
    const repo = track(createGitRepo({ execFileSync: run, ...seen.deps }))

    fail = true

    expect(thrownBy(() => repo.commit('second'))).toBe(failure)
    expect(seen.warnings).toEqual([])
  })
})

describe('createGitRepo: creating the temp folder', () => {
  it.each(['EBUSY', 'EPERM', 'EACCES'])('is retried when the temp folder answers %s', (code) => {
    const seen = observed()
    const temp = failingTemp(systemError(code, 'mkdtemp', '/tmp/dm-repo-XXXXXX'), 2)

    const repo = track(createGitRepo({ createTempRepo: temp.create, ...seen.deps }))

    expect(temp.attempts()).toBe(3)
    expect(temp.created.map((created) => created.root)).toEqual([repo.root])
    expect(repo.git('log', '--format=%s')).toBe('initial commit')
    expect(seen.waits).toEqual([50, 100])
    expect(seen.warnings[0]).toContain(code)
  })

  it.each([
    ['a full disk', systemError('ENOSPC', 'mkdtemp', '/tmp/dm-repo-XXXXXX')],
    ['a busy file that is not the temp folder', systemError('EBUSY', 'open', '/tmp/dm-repo-a1/repo/file')]
  ])('throws on the first attempt for %s', (_name, failure) => {
    const temp = failingTemp(failure, 1)

    const thrown = thrownBy(() => track(createGitRepo({ createTempRepo: temp.create, ...observed().deps })))

    expect(thrown).toBe(failure)
    expect(temp.attempts()).toBe(1)
  })

  it('throws the last error once three attempts have failed', () => {
    const failure = systemError('EPERM', 'mkdir', '/tmp/dm-repo-a1/repo')
    const temp = failingTemp(failure, Number.POSITIVE_INFINITY)

    const thrown = thrownBy(() => track(createGitRepo({ createTempRepo: temp.create, ...observed().deps })))

    expect(thrown).toBe(failure)
    expect(temp.attempts()).toBe(3)
  })
})
