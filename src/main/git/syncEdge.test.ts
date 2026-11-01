/** Sync edge cases: real git for local reads, a stand-in for the network command so nothing leaves the machine. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { GitError, type GitRunResult } from './errors'
import { createGitRunner, type GitRunner, type GitRunRequest } from './runner'
import { createSync, type Sync } from './sync'

const signedOut = { getAccount: () => null, getToken: () => null }
const cleanups: Array<() => void> = []
beforeEach(() => isolateGitConfig(cleanups))
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function repoWithOrigin(url: string | null): GitRepo {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  if (url !== null) {
    r.git('remote', 'add', 'origin', url)
  }
  return r
}

/** Real git, except that a network command is recorded and then succeeds or fails with `failure`. */
function standInNetwork(failure: GitError | null = null): { runner: GitRunner; calls: GitRunRequest[] } {
  const real = createGitRunner()
  const calls: GitRunRequest[] = []
  const runner: GitRunner = {
    run(request): Promise<GitRunResult> {
      if (request.kind !== 'network') {
        return real.run(request)
      }
      calls.push(request)
      return failure === null ? Promise.resolve({ code: 0, stdout: '', stderr: '' }) : Promise.reject(failure)
    }
  }
  return { runner, calls }
}

function syncWith(runner: GitRunner): Sync {
  return createSync({ runner, session: signedOut, onProgress: () => undefined, env: {} })
}

describe('pull without an upstream', () => {
  it('pulls the branch of the same name from the sync remote', async () => {
    const r = repoWithOrigin('/nowhere/origin.git')
    const { runner, calls } = standInNetwork()
    await syncWith(runner).run('pull', r.root, 'op')
    expect(calls.map((call) => call.args)).toEqual([
      ['pull', '--no-rebase', '--no-edit', '--progress', '--', 'origin', 'refs/heads/main']
    ])
  })
})

describe('no sync remote', () => {
  it('returns remote_not_found without running anything on the network', async () => {
    const r = repoWithOrigin(null)
    const { runner, calls } = standInNetwork()
    await expect(syncWith(runner).run('fetch', r.root, 'op')).rejects.toMatchObject({ code: 'remote_not_found' })
    expect(calls).toEqual([])
  })
})

describe('auth failures that stay as git reported them', () => {
  it('keeps a GitHub SSH rejection as is when signed out, since signing in would not help', async () => {
    const r = repoWithOrigin('git@github.com:octo/hello.git')
    const rejection = new GitError('auth_failed', 'git@github.com: Permission denied (publickey).')
    const { runner } = standInNetwork(rejection)
    await expect(syncWith(runner).run('fetch', r.root, 'op')).rejects.toBe(rejection)
  })
})

describe("the person's own ssh command", () => {
  it('is left alone when core.sshCommand is set, and batch mode applies when it is empty', async () => {
    const r = repoWithOrigin('git@github.com:octo/hello.git')
    const { runner, calls } = standInNetwork()
    r.git('config', 'core.sshCommand', 'ssh -i ~/.ssh/work')
    await syncWith(runner).run('fetch', r.root, 'op-1')
    r.git('config', 'core.sshCommand', '')
    await syncWith(runner).run('fetch', r.root, 'op-2')
    expect(calls.map((call) => call.env?.GIT_SSH_COMMAND)).toEqual([undefined, 'ssh -o BatchMode=yes'])
  })
})
