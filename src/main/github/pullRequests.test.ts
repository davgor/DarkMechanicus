/** Pull request data: a scripted GitHub API over real temporary repositories whose remotes point at github.com. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeHttp, jsonResponse, type FakeHttp } from '../../test/fakeHttp'
import { isolateGitConfig } from '../../test/gitRemotes'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { createGitRunner } from '../git/runner'
import { createSessionClient } from './client'
import { GithubError } from './errors'
import { createPullRequests, type PullRequests } from './pullRequests'

const TOKEN = 'gho_FAKE_TOKEN_pull_requests_1'
const runner = createGitRunner()
const cleanups: Array<() => void> = []

beforeEach(() => isolateGitConfig(cleanups))

afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function repo(url: string | null = 'https://github.com/octo/repo.git'): GitRepo {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  if (url !== null) {
    r.git('remote', 'add', 'origin', url)
  }
  return r
}

interface ApiPull {
  number: number
  title: string
  user: { login: string } | null
  draft: boolean
  html_url: string
  updated_at: string
  base: { ref: string }
  head: { ref: string; repo: { full_name: string } | null }
}

function pull(number: number, headRef = `topic-${number}`, headRepo: string | null = 'octo/repo'): ApiPull {
  return {
    number,
    title: `Pull ${number}`,
    user: { login: 'mona' },
    draft: false,
    html_url: `https://example.invalid/${number}`,
    updated_at: '2026-10-30T12:00:00Z',
    base: { ref: 'main' },
    head: { ref: headRef, repo: headRepo === null ? null : { full_name: headRepo } }
  }
}

function pulls(from: number, count: number): ApiPull[] {
  return Array.from({ length: count }, (_, index) => pull(from + index))
}

interface Setup {
  http: FakeHttp
  prs: PullRequests
  clock: { now: number }
  signedIn(): boolean
  signOut(): void
}

function setup(): Setup {
  const http = createFakeHttp()
  let token: string | null = TOKEN
  const session = {
    getAccount: () => (token === null ? null : { login: 'octocat' }),
    getToken: () => token,
    signOut: () => {
      token = null
    }
  }
  const clock = { now: 1_000_000 }
  const client = createSessionClient(session, { fetch: http.fetch, appVersion: '1' })
  const prs = createPullRequests({ runner, session, client, now: () => clock.now, env: {} })
  return { http, prs, clock, signedIn: () => token !== null, signOut: session.signOut }
}

async function failure(promise: Promise<unknown>): Promise<GithubError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(GithubError)
  return error as GithubError
}

describe('getPullRequests: the repository and paging', () => {
  it('lists the open pull requests of the origin GitHub repository, 100 a page, with summaries built in main', async () => {
    const r = repo()
    const { http, prs } = setup()
    http.answer(jsonResponse(200, [{ ...pull(7, 'fix/x', 'fork/repo'), draft: true, user: null }, pull(3)]))
    const info = await prs.get(r.root, false)
    expect(http.requests.map((request) => request.url)).toEqual(['https://api.github.com/repos/octo/repo/pulls?state=open&per_page=100&page=1'])
    expect(http.requests[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(info.repository).toEqual({ owner: 'octo', repo: 'repo' })
    expect(info.open).toEqual([
      {
        number: 7,
        title: 'Pull 7',
        author: 'ghost',
        isDraft: true,
        url: 'https://github.com/octo/repo/pull/7',
        updatedAt: '2026-10-30T12:00:00Z',
        baseRef: 'main',
        headRef: 'fix/x',
        headRepoFullName: 'fork/repo',
        fromFork: true
      },
      expect.objectContaining({ number: 3, author: 'mona', isDraft: false, headRepoFullName: 'octo/repo', fromFork: false })
    ])
  })

  it('reads further pages while a page is full, up to 3 pages', async () => {
    const r = repo()
    const { http, prs } = setup()
    http.answer(jsonResponse(200, pulls(1, 100)), jsonResponse(200, pulls(101, 100)), jsonResponse(200, pulls(201, 5)))
    expect((await prs.get(r.root, false)).open).toHaveLength(205)
    expect(http.requests.map((request) => request.url.slice(-6))).toEqual(['page=1', 'page=2', 'page=3'])

    const { http: more, prs: capped } = setup()
    more.answer(jsonResponse(200, pulls(1, 100)), jsonResponse(200, pulls(101, 100)), jsonResponse(200, pulls(201, 100)))
    expect((await capped.get(r.root, false)).open).toHaveLength(300)
    expect(more.requests).toHaveLength(3)
  })
})

describe('getPullRequests: which repository', () => {
  it('uses the upstream remote before origin, and a deleted fork is a fork with no head repository', async () => {
    const r = repo('https://github.com/someone/elsewhere.git')
    r.git('remote', 'add', 'upstream', 'git@github.com:Octo/Repo.git')
    r.git('config', 'branch.main.remote', 'upstream')
    r.git('config', 'branch.main.merge', 'refs/heads/main')
    const { http, prs } = setup()
    http.answer(jsonResponse(200, [pull(4, 'gone', null)]))
    const info = await prs.get(r.root, false)
    expect(http.requests[0]?.url).toBe('https://api.github.com/repos/Octo/Repo/pulls?state=open&per_page=100&page=1')
    expect(info.open[0]).toMatchObject({ headRepoFullName: null, fromFork: true, url: 'https://github.com/Octo/Repo/pull/4' })
  })

  it('returns none, without asking GitHub, for a repository whose remote is not on GitHub or that has no remote', async () => {
    const { http, prs } = setup()
    for (const url of ['https://gitlab.com/octo/repo.git', null]) {
      await expect(prs.get(repo(url).root, false)).resolves.toEqual({ repository: null, current: null, open: [] })
    }
    expect(http.requests).toEqual([])
  })

  it('names the GitHub repository a rewritten (insteadOf) remote stands for', async () => {
    const r = repo()
    r.git('config', 'url./srv/mirror/repo.git.insteadOf', 'https://github.com/octo/repo.git')
    const { http, prs } = setup()
    http.answer(jsonResponse(200, []))
    expect((await prs.get(r.root, false)).repository).toEqual({ owner: 'octo', repo: 'repo' })
  })

  it('fails github_failed on an answer that is not a list of pull requests', async () => {
    const r = repo()
    const { http, prs } = setup()
    http.answer(jsonResponse(200, [{ number: 'x' }]))
    expect((await failure(prs.get(r.root, false))).code).toBe('github_failed')
  })
})

describe('getPullRequests: the current branch', () => {
  it('is the pull request whose head is the current branch in this repository', async () => {
    const r = repo()
    r.branch('feature')
    const { http, prs } = setup()
    http.answer(jsonResponse(200, [pull(1, 'feature', 'fork/repo'), pull(2, 'other'), pull(3, 'feature', 'OCTO/repo')]))
    expect((await prs.get(r.root, false)).current?.number).toBe(3)
  })

  it("matches the upstream's branch name too", async () => {
    const r = repo()
    r.branch('local-name')
    r.git('config', 'branch.local-name.remote', 'origin')
    r.git('config', 'branch.local-name.merge', 'refs/heads/remote-name')
    const { http, prs } = setup()
    http.answer(jsonResponse(200, [pull(5, 'remote-name')]))
    expect((await prs.get(r.root, false)).current?.number).toBe(5)
  })

  it('is null for a fork head of the same name, and on a detached HEAD', async () => {
    const r = repo()
    const { http, prs } = setup()
    http.answer(jsonResponse(200, [pull(1, 'main', 'fork/repo'), pull(2, 'main', null)]))
    expect((await prs.get(r.root, false)).current).toBeNull()
    r.git('switch', '-q', '--detach')
    http.answer(jsonResponse(200, [pull(3, 'main')]))
    expect((await prs.get(r.root, true)).current).toBeNull()
  })
})

describe('getPullRequests: sign-in, 401 and the cache', () => {
  it('returns auth_required without a request when signed out', async () => {
    const r = repo()
    const { http, prs, signOut } = setup()
    signOut()
    expect((await failure(prs.get(r.root, false))).code).toBe('auth_required')
    expect(http.requests).toEqual([])
  })

  it('returns auth_required on a 401 and signs the account out', async () => {
    const r = repo()
    const { http, prs, signedIn } = setup()
    http.answer(jsonResponse(401, { message: 'Bad credentials' }))
    expect((await failure(prs.get(r.root, false))).code).toBe('auth_required')
    expect(signedIn()).toBe(false)
  })

  it('answers from a 60 s cache per folder unless a refresh is asked, recomputing the current branch each time', async () => {
    const r = repo()
    const other = repo()
    const { http, prs, clock } = setup()
    http.answer(jsonResponse(200, [pull(1, 'feature')]))
    expect((await prs.get(r.root, false)).current).toBeNull()
    r.branch('feature')
    clock.now += 59_999
    const cached = await prs.get(r.root, false)
    expect(cached.current?.number).toBe(1)
    expect(http.requests).toHaveLength(1)

    http.answer(jsonResponse(200, [pull(2)]))
    expect((await prs.get(other.root, false)).open.map((p) => p.number)).toEqual([2])
    http.answer(jsonResponse(200, [pull(3)]))
    expect((await prs.get(r.root, true)).open.map((p) => p.number)).toEqual([3])
    clock.now += 60_000
    http.answer(jsonResponse(200, [pull(4)]))
    expect((await prs.get(r.root, false)).open.map((p) => p.number)).toEqual([4])
    expect(http.requests).toHaveLength(4)
  })

  it('never answers from the cache when signed out, nor for another repository behind the same folder', async () => {
    const r = repo()
    const { http, prs, signOut } = setup()
    http.answer(jsonResponse(200, [pull(1)]))
    await prs.get(r.root, false)
    r.git('remote', 'set-url', 'origin', 'https://github.com/octo/other.git')
    http.answer(jsonResponse(200, [pull(9)]))
    expect((await prs.get(r.root, false)).open.map((p) => p.number)).toEqual([9])
    signOut()
    expect((await failure(prs.get(r.root, false))).code).toBe('auth_required')
  })
})
