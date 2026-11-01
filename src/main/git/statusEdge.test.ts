/** Status edge cases: malformed or truncated porcelain output, and failures that must not be mistaken for "no repo". */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { scratchDir } from '../../test/gitScratch'
import { GitError, type GitRunResult } from './errors'
import { createGitRunner, type GitRunner, type GitRunRequest } from './runner'
import { parseStatusV2, readRepoState, readRepository } from './status'

const runner = createGitRunner()
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function repo(): GitRepo {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  return r
}

/** Real git, except that a request `answer` matches gets its result (or failure) instead. */
function overriding(answer: (request: GitRunRequest) => Promise<GitRunResult> | null): GitRunner {
  return { run: (request) => answer(request) ?? runner.run(request) }
}

const ENTRY = 'N... 100644 100644 100644 aaa bbb'

describe('parseStatusV2 edge cases', () => {
  it('ignores unknown headers and reads a malformed ahead/behind as zero', () => {
    const out = '# branch.oid abc\0# branch.head main\0# stash 3\0# branch.ab ahead-ish\0'
    expect(parseStatusV2(out).branch).toEqual({ name: 'main', headOid: 'abc', upstream: null, ahead: 0, behind: 0 })
  })

  it('keeps entries for the same path, and drops a rename that was added and deleted again', () => {
    const out = `? same.txt\0? same.txt\x002 AD ${ENTRY} R100 new.txt\0old.txt\0`
    expect(parseStatusV2(out).files).toEqual([
      { path: 'same.txt', oldPath: null, kind: 'untracked' },
      { path: 'same.txt', oldPath: null, kind: 'untracked' }
    ])
  })

  it('reads a deleted rename cut off before its original path as a deletion of the new path', () => {
    expect(parseStatusV2(`2 RD ${ENTRY} R100 new.txt`).files).toEqual([{ path: 'new.txt', oldPath: null, kind: 'deleted' }])
  })
})

describe('readRepository', () => {
  it('fails not_repository for a plain folder and git_not_found when git cannot start', async () => {
    const dir = scratchDir()
    cleanups.push(dir.cleanup)
    await expect(readRepository(runner, dir.path)).rejects.toMatchObject({ code: 'not_repository' })
    const missing = createGitRunner({ gitPath: '/nonexistent/dm-git' })
    await expect(readRepository(missing, dir.path)).rejects.toMatchObject({ code: 'git_not_found' })
  })
})

describe('readRepoState failures', () => {
  it('passes on a failure finding the repository root other than "not a repository"', async () => {
    const r = repo()
    const timeout = new GitError('timeout', '', 'git timed out')
    const failing = overriding((request) => (request.args.includes('--show-toplevel') ? Promise.reject(timeout) : null))
    await expect(readRepoState(failing, r.root)).rejects.toBe(timeout)
  })

  it('passes on a failure reading the remotes instead of reporting no remote', async () => {
    const r = repo()
    const broken = new GitError('git_failed', 'fatal: bad config line 1')
    const failing = overriding((request) => (request.args[0] === 'remote' ? Promise.reject(broken) : null))
    await expect(readRepoState(failing, r.root)).rejects.toBe(broken)
  })

  it('reports no operation and no fetch when git prints no state paths', async () => {
    const r = repo()
    writeFileSync(resolve(r.root, r.git('rev-parse', '--git-path', 'MERGE_HEAD')), `${r.rev('HEAD')}\n`)
    const silent = overriding((request) =>
      request.args.includes('--git-path') ? Promise.resolve({ code: 0, stdout: '', stderr: '' }) : null
    )
    const state = await readRepoState(silent, r.root)
    expect(state).toMatchObject({ kind: 'repository', status: { inProgress: null, lastFetchedAt: null } })
    expect(await readRepoState(runner, r.root)).toMatchObject({ status: { inProgress: 'merge' } })
  })
})
