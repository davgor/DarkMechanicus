import { afterEach, describe, expect, it } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { listRemotes, parseGithubRemote, resolveSyncRemote } from './remotes'
import { createGitRunner } from './runner'

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

describe('parseGithubRemote', () => {
  it.each([
    ['https://github.com/octo/hello.git', { owner: 'octo', repo: 'hello' }],
    ['https://github.com/octo/hello', { owner: 'octo', repo: 'hello' }],
    ['https://github.com/octo/hello/', { owner: 'octo', repo: 'hello' }],
    ['https://user@github.com/octo/hello.git', { owner: 'octo', repo: 'hello' }],
    ['https://GitHub.com/Octo/Hello.World.git', { owner: 'Octo', repo: 'Hello.World' }],
    ['git@github.com:octo/hello.git', { owner: 'octo', repo: 'hello' }],
    ['git@github.com:octo/hello', { owner: 'octo', repo: 'hello' }],
    ['ssh://git@github.com/octo/hello.git', { owner: 'octo', repo: 'hello' }],
    ['ssh://git@github.com/octo/hello', { owner: 'octo', repo: 'hello' }],
    ['ssh://git@github.com:22/octo/my-repo_1.git', { owner: 'octo', repo: 'my-repo_1' }]
  ])('parses %s', (url, expected) => {
    expect(parseGithubRemote(url)).toEqual(expected)
  })

  it.each([
    'https://gitlab.com/octo/hello.git',
    'https://github.com.evil.example/octo/hello.git',
    'https://evil.example/github.com/octo/hello.git',
    'git@gitlab.com:octo/hello.git',
    'git@github.com.evil.example:octo/hello.git',
    'ssh://git@bitbucket.org/octo/hello.git',
    'http://github.com/octo/hello.git',
    'git://github.com/octo/hello.git',
    'https://github.com/octo',
    'https://github.com/octo/hello/extra',
    'https://github.com/octo/.git',
    'https://github.com/../hello.git',
    '/srv/git/hello.git',
    'file:///srv/git/hello.git',
    ''
  ])('returns null for %j', (url) => {
    expect(parseGithubRemote(url)).toBeNull()
  })
})

describe('listRemotes', () => {
  it('lists each remote once with its fetch and push URLs', async () => {
    const r = repo()
    r.git('remote', 'add', 'origin', 'https://github.com/octo/hello.git')
    r.git('remote', 'add', 'upstream', 'git@github.com:other/hello.git')
    r.git('remote', 'set-url', '--push', 'upstream', 'ssh://git@github.com/other/push.git')
    expect(await listRemotes(runner, r.root)).toEqual([
      { name: 'origin', fetchUrl: 'https://github.com/octo/hello.git', pushUrl: 'https://github.com/octo/hello.git' },
      { name: 'upstream', fetchUrl: 'git@github.com:other/hello.git', pushUrl: 'ssh://git@github.com/other/push.git' }
    ])
  })

  it('returns nothing for a repository without remotes', async () => {
    expect(await listRemotes(runner, repo().root)).toEqual([])
  })
})

describe('resolveSyncRemote', () => {
  it("uses the upstream's remote and branch", async () => {
    const r = repo()
    const bare = scratchDir()
    cleanups.push(bare.cleanup)
    gitIn(bare.path, 'init', '-q', '--bare', '-b', 'main')
    r.git('remote', 'add', 'origin', 'https://github.com/octo/hello.git')
    r.git('remote', 'add', 'mirror', bare.path)
    r.git('push', '-q', '-u', 'mirror', 'main:trunk')
    const mirror = { name: 'mirror', fetchUrl: bare.path, pushUrl: bare.path }
    expect(await resolveSyncRemote(runner, r.root, 'main')).toEqual({ remote: mirror, upstreamRef: 'refs/heads/trunk', pushRemote: mirror })
  })

  it("pushes to git's own push remote (remote.pushDefault, branch.<name>.pushRemote) when one is set", async () => {
    const r = repo()
    const bare = scratchDir()
    cleanups.push(bare.cleanup)
    gitIn(bare.path, 'init', '-q', '--bare', '-b', 'main')
    r.git('remote', 'add', 'origin', bare.path)
    r.git('remote', 'add', 'fork', 'https://github.com/me/hello.git')
    r.git('push', '-q', '-u', 'origin', 'main')
    r.git('config', 'remote.pushDefault', 'fork')
    const target = await resolveSyncRemote(runner, r.root, 'main')
    expect(target.remote.name).toBe('origin')
    expect(target.pushRemote).toEqual({ name: 'fork', fetchUrl: 'https://github.com/me/hello.git', pushUrl: 'https://github.com/me/hello.git' })
    r.git('config', 'branch.main.pushRemote', 'origin')
    expect((await resolveSyncRemote(runner, r.root, 'main')).pushRemote.name).toBe('origin')
  })

  it('falls back to origin without an upstream, and on a detached HEAD', async () => {
    const r = repo()
    r.git('remote', 'add', 'origin', 'https://github.com/octo/hello.git')
    const origin = { name: 'origin', fetchUrl: 'https://github.com/octo/hello.git', pushUrl: 'https://github.com/octo/hello.git' }
    expect(await resolveSyncRemote(runner, r.root, 'main')).toEqual({ remote: origin, upstreamRef: null, pushRemote: origin })
    expect(await resolveSyncRemote(runner, r.root, null)).toEqual({ remote: origin, upstreamRef: null, pushRemote: origin })
  })

  it('fails remote_not_found with neither an upstream nor origin', async () => {
    const r = repo()
    r.git('remote', 'add', 'other', 'https://github.com/octo/hello.git')
    await expect(resolveSyncRemote(runner, r.root, 'main')).rejects.toMatchObject({ code: 'remote_not_found' })
  })
})
