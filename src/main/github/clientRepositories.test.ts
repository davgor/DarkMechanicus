/** The account's repositories: paging through `Link: rel="next"`, the fields kept, and the limits. */
import { describe, expect, it } from 'vitest'
import type { GithubRepository } from '../../shared/github/api'
import { createFakeHttp, jsonResponse, type FakeHttp } from '../../test/fakeHttp'
import { createGithubClient, type GithubClient } from './client'
import { GithubError } from './errors'

const TOKEN = 'gho_FAKE_TOKEN_never_leak_123'
const FIRST = 'https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=pushed'

function apiRepo(owner: string, name: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    full_name: `${owner}/${name}`,
    name,
    owner: { login: owner, id: 2 },
    private: false,
    fork: false,
    description: null,
    clone_url: `https://github.com/${owner}/${name}.git`,
    pushed_at: '2026-10-01T12:00:00Z',
    ...patch
  }
}

function repository(owner: string, name: string, patch: Partial<GithubRepository> = {}): GithubRepository {
  return {
    fullName: `${owner}/${name}`,
    owner,
    name,
    private: false,
    fork: false,
    description: null,
    cloneUrl: `https://github.com/${owner}/${name}.git`,
    pushedAt: '2026-10-01T12:00:00Z',
    ...patch
  }
}

function page(n: number): string {
  return `${FIRST}&page=${n}`
}

function client(http: FakeHttp, token: string | null = TOKEN, unauthorized: string[] = []): GithubClient {
  return createGithubClient({ fetch: http.fetch, getToken: () => token, appVersion: '1', onUnauthorized: (rejected) => unauthorized.push(rejected) })
}

async function failure(promise: Promise<unknown>): Promise<GithubError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(GithubError)
  return error as GithubError
}

describe('listRepositories: paging', () => {
  it('follows Link rel="next" with the token and keeps the fields the clone dialog shows', async () => {
    const http = createFakeHttp()
    http.answer(
      jsonResponse(200, [apiRepo('octocat', 'Hello-World', { description: 'My first repository' })], { Link: `<${page(2)}>; rel="next", <${page(3)}>; rel="last"` }),
      jsonResponse(200, [apiRepo('octo-org', 'tools', { private: true }), apiRepo('octocat', 'Spoon-Knife', { fork: true, pushed_at: null })], {
        Link: `<${page(1)}>; rel="prev", <${page(3)}>; rel="next"`
      }),
      jsonResponse(200, [apiRepo('someone', 'shared')], { Link: `<${page(1)}>; rel="first", <${page(2)}>; rel="prev"` })
    )
    expect(await client(http).listRepositories()).toEqual([
      repository('octocat', 'Hello-World', { description: 'My first repository' }),
      repository('octo-org', 'tools', { private: true }),
      repository('octocat', 'Spoon-Knife', { fork: true, pushedAt: null }),
      repository('someone', 'shared')
    ])
    expect(http.requests.map((request) => request.url)).toEqual([FIRST, page(2), page(3)])
    for (const request of http.requests) {
      expect(request).toMatchObject({ method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` }, redirect: 'error' })
    }
  })

  it('stops at 1,000 repositories', async () => {
    const http = createFakeHttp()
    for (let n = 1; n <= 11; n += 1) {
      const repos = Array.from({ length: 100 }, (_, i) => apiRepo('octocat', `repo-${n}-${i}`))
      http.answer(jsonResponse(200, repos, { Link: `<${page(n + 1)}>; rel="next"` }))
    }
    const repositories = await client(http).listRepositories()
    expect(repositories).toHaveLength(1000)
    expect(http.requests).toHaveLength(10)
  })
})

describe('listRepositories: each limit on its own', () => {
  function pages(http: FakeHttp, count: number, perPage: number): void {
    for (let n = 1; n <= count; n += 1) {
      const repos = Array.from({ length: perPage }, (_, i) => apiRepo('octocat', `repo-${n}-${i}`))
      http.answer(jsonResponse(200, repos, { Link: `<${page(n + 1)}>; rel="next"` }))
    }
  }

  it('asks for ten pages at most, however short they are', async () => {
    const http = createFakeHttp()
    pages(http, 12, 1)
    expect(await client(http).listRepositories()).toHaveLength(10)
    expect(http.requests).toHaveLength(10)
  })

  it('stops once it has 1,000 repositories, and keeps no more', async () => {
    const http = createFakeHttp()
    pages(http, 8, 150)
    expect(await client(http).listRepositories()).toHaveLength(1000)
    expect(http.requests).toHaveLength(7)
  })
})

describe('listRepositories: what it refuses', () => {
  it('never follows a next link off https://api.github.com, so the token goes nowhere else', async () => {
    for (const next of ['https://evil.example.com/user/repos?page=2', 'http://api.github.com/user/repos?page=2', 'https://api.github.com.evil.example/user/repos', 'https://api.github.com@evil.example/x']) {
      const http = createFakeHttp()
      http.answer(jsonResponse(200, [apiRepo('octocat', 'Hello-World')], { Link: `<${next}>; rel="next"` }))
      expect((await failure(client(http).listRepositories())).code, next).toBe('github_failed')
      expect(http.requests.map((request) => request.url), next).toEqual([FIRST])
    }
  })

  it('fails github_failed on a body that is not a list, and leaves out entries it cannot read', async () => {
    const http = createFakeHttp()
    http.answer(jsonResponse(200, { message: 'not a list' }), jsonResponse(200, [apiRepo('octocat', 'ok'), { full_name: 7 }, apiRepo('octocat', 'bad', { private: 'yes' })]))
    expect((await failure(client(http).listRepositories())).code).toBe('github_failed')
    expect(await client(http).listRepositories()).toEqual([repository('octocat', 'ok')])
  })

  it('is auth_required without a request when signed out, and on a 401 after reporting the rejected token', async () => {
    const signedOut = createFakeHttp()
    expect((await failure(client(signedOut, null).listRepositories())).code).toBe('auth_required')
    expect(signedOut.requests).toEqual([])
    const http = createFakeHttp()
    const unauthorized: string[] = []
    http.answer(jsonResponse(401, { message: 'Bad credentials' }))
    expect((await failure(client(http, TOKEN, unauthorized).listRepositories())).code).toBe('auth_required')
    expect(unauthorized).toEqual([TOKEN])
  })
})
