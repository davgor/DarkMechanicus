/** Names and refs refused before git runs, and the remote and credentials a remote branch deletion uses. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { checkBranchName } from './args'
import { createBranch, deleteBranch, mergeIntoCurrent, renameBranch, switchBranch } from './branches'
import { GitError, GitInputError } from './errors'
import { createGitRunner, type GitRunner, type GitRunRequest } from './runner'
import { discardStash, restoreStash } from './stash'

const cleanups: Array<() => void> = []
beforeEach(() => isolateGitConfig(cleanups))
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function repo(): GitRepo {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  r.git('branch', 'other')
  return r
}

/** The real runner, recording every request; a network run is answered by `network` instead of git. */
function spyRunner(network: (request: GitRunRequest) => Promise<{ code: number; stdout: string; stderr: string }> = () => Promise.resolve({ code: 0, stdout: '', stderr: '' })): {
  runner: GitRunner
  requests: GitRunRequest[]
} {
  const real = createGitRunner()
  const requests: GitRunRequest[] = []
  return {
    requests,
    runner: { run: (request) => (requests.push(request), request.kind === 'network' ? network(request) : real.run(request)) }
  }
}

const BAD_NAMES = [
  '-D',
  '--force',
  '-',
  '',
  'a..b',
  '..',
  '@{-1}',
  'main@{u}',
  '@',
  'a\u0001b',
  'a\u007fb',
  'a\nb',
  'a b',
  'a\u0000b',
  'a~1',
  'a^',
  'a:b',
  'a?b',
  'a*',
  'a[b',
  'a\\b',
  'x.lock',
  'a/.hidden',
  'trailing/',
  '/leading',
  'a//b',
  'dot.',
  'x'.repeat(256)
]

describe('branch names', () => {
  it.each(BAD_NAMES.map((name) => [JSON.stringify(name).slice(0, 40), name]))('refuses %s before any branch command runs', async (_label, name) => {
    const r = repo()
    const { runner, requests } = spyRunner()
    const signedOut = { getAccount: () => null, getToken: () => null }
    const attempts = [
      () => createBranch(runner, r.root, { name, startPoint: 'current' }),
      () => switchBranch(runner, r.root, { name, uncommitted: 'stash' }),
      () => renameBranch(runner, r.root, { from: 'other', to: name }),
      () => renameBranch(runner, r.root, { from: name, to: 'fine' }),
      () => deleteBranch({ runner, session: signedOut }, r.root, { name, deleteRemote: true, force: true }),
      () => mergeIntoCurrent(runner, r.root, { branch: name })
    ]
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(GitInputError)
    }
    // Only git's own name check may have seen the name.
    expect(requests.every((request) => request.args[0] === 'check-ref-format')).toBe(true)
    expect(r.git('for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main\nrefs/heads/other')
    expect((await checkBranchName(runner, r.root, name)).valid).toBe(false)
  })

  it('accepts ordinary names with slashes, dots, dashes and non-ASCII letters', async () => {
    const r = repo()
    const runner = createGitRunner()
    for (const name of ['feature/x', 'fix-1.2', 'José/ünïcode', 'a-'.repeat(60)]) {
      expect(await checkBranchName(runner, r.root, name)).toEqual({ valid: true, normalized: name })
    }
  })
})

describe('stash refs', () => {
  it.each(['stash@{-1}', 'stash@{0}^', 'stash@{0} x', 'refs/stash', '-p', '--all', 'stash@{1.day.ago}', 'main', 'stash@{99999999}', ''])(
    'refuses %s before git runs',
    async (ref) => {
      const r = repo()
      const { runner, requests } = spyRunner()
      await expect(restoreStash(runner, r.root, ref)).rejects.toBeInstanceOf(GitInputError)
      await expect(discardStash(runner, r.root, ref)).rejects.toBeInstanceOf(GitInputError)
      expect(requests).toEqual([])
    }
  )
})

const signedIn = { getAccount: () => ({ login: 'octo' }), getToken: () => 'gho_secret' }

/** `feature` tracks `feature` on `upstream` (a GitHub remote with its own push URL), not the `feature` on `origin`. */
function githubRepo(): GitRepo {
  const r = repo()
  r.git('remote', 'add', 'origin', 'https://github.com/acme/app.git')
  r.git('remote', 'add', 'upstream', 'https://github.com/acme/upstream.git')
  r.git('config', 'remote.upstream.pushurl', 'https://github.com/acme/upstream-push.git')
  r.git('update-ref', 'refs/remotes/upstream/feature', r.rev('main'))
  r.git('update-ref', 'refs/remotes/origin/feature', r.rev('main'))
  r.git('branch', 'feature', 'main')
  r.git('config', 'branch.feature.remote', 'upstream')
  r.git('config', 'branch.feature.merge', 'refs/heads/feature')
  return r
}

describe('remote branch deletion', () => {
  it("pushes the deletion to the upstream's remote with the account's credentials for its push URL, guarded by a lease", async () => {
    const r = githubRepo()
    const { runner, requests } = spyRunner()
    await deleteBranch({ runner, session: signedIn, env: {} }, r.root, { name: 'feature', deleteRemote: true, force: false })
    const push = requests.filter((request) => request.kind === 'network')
    expect(push).toHaveLength(1)
    expect(push[0].args).toEqual([
      '-c',
      'credential.https://github.com.helper=',
      '-c',
      expect.stringContaining('DM_GITHUB_TOKEN'),
      'push',
      `--force-with-lease=refs/heads/feature:${r.rev('main')}`,
      '--delete',
      '--',
      'upstream',
      'refs/heads/feature'
    ])
    expect(push[0].env).toMatchObject({ DM_GITHUB_LOGIN: 'octo', DM_GITHUB_TOKEN: 'gho_secret', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' })
    expect(push[0].redact).toContain('gho_secret')
    expect(push[0].args.join(' ')).not.toContain('gho_secret')
    expect(r.git('for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main\nrefs/heads/other')
  })
})

describe('remote branch deletion without the token', () => {
  it('sends no token to a remote that is not GitHub HTTPS', async () => {
    const r = githubRepo()
    r.git('config', 'remote.upstream.pushurl', 'git@gitlab.com:acme/upstream.git')
    const { runner, requests } = spyRunner()
    await deleteBranch({ runner, session: signedIn, env: {} }, r.root, { name: 'feature', deleteRemote: true, force: false })
    const push = requests.filter((request) => request.kind === 'network')
    expect(push[0].args.slice(0, 2)).toEqual(['push', `--force-with-lease=refs/heads/feature:${r.rev('main')}`])
    expect(JSON.stringify(push[0].env)).not.toContain('gho_secret')
  })

  it('reports a rejected token as auth_failed', async () => {
    const r = githubRepo()
    const { runner } = spyRunner(() =>
      Promise.reject(new GitError('auth_failed', "fatal: Authentication failed for 'https://github.com/acme/upstream-push.git/'"))
    )
    await expect(deleteBranch({ runner, session: signedIn, env: {} }, r.root, { name: 'feature', deleteRemote: true, force: false })).rejects.toMatchObject({
      code: 'auth_failed',
      message: expect.stringMatching(/Sign in to GitHub again/)
    })
  })

  it('refuses an upstream remote whose name starts with "-", deleting nothing', async () => {
    const r = githubRepo()
    r.git('config', 'remote.-x.url', 'https://github.com/acme/x.git')
    r.git('config', 'remote.-x.fetch', '+refs/heads/*:refs/remotes/-x/*')
    r.git('config', 'branch.feature.remote', '-x')
    r.git('update-ref', 'refs/remotes/-x/feature', r.rev('main'))
    const { runner, requests } = spyRunner()
    await expect(deleteBranch({ runner, session: signedIn, env: {} }, r.root, { name: 'feature', deleteRemote: true, force: false })).rejects.toBeInstanceOf(
      GitInputError
    )
    expect(requests.some((request) => request.kind !== 'read')).toBe(false)
  })
})
