import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeHttp, jsonResponse } from '../../test/fakeHttp'
import { createAccountStore } from './accountStore'
import { createGithubClient, createSessionClient } from './client'
import { GithubError } from './errors'
import { createGithubSession, type GithubSession } from './session'

const TOKEN = 'gho_FAKE_TOKEN_never_leak_123'

async function failure(promise: Promise<unknown>): Promise<GithubError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(GithubError)
  return error as GithubError
}

describe('createGithubClient', () => {
  it('gets the user with the bearer token, GitHub JSON headers and the app user agent, keeping X-OAuth-Scopes', async () => {
    const http = createFakeHttp()
    http.answer(jsonResponse(200, { login: 'octocat', name: 'The Octocat', id: 1 }, { 'X-OAuth-Scopes': 'repo, read:user, workflow' }))
    const client = createGithubClient({ fetch: http.fetch, getToken: () => TOKEN, appVersion: '1.2.3', onUnauthorized: () => undefined })
    await expect(client.getUser()).resolves.toEqual({ login: 'octocat', name: 'The Octocat', scopes: 'repo, read:user, workflow' })
    expect(http.requests).toEqual([
      {
        url: 'https://api.github.com/user',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'DarkMechanicus/1.2.3'
        },
        form: {},
        redirect: 'error'
      }
    ])
  })

  it('keeps a null name and an empty scope list when GitHub sends none', async () => {
    const http = createFakeHttp()
    http.answer(jsonResponse(200, { login: 'octocat', name: null }))
    const client = createGithubClient({ fetch: http.fetch, getToken: () => TOKEN, appVersion: '1', onUnauthorized: () => undefined })
    await expect(client.getUser()).resolves.toEqual({ login: 'octocat', name: null, scopes: '' })
  })

  it('returns auth_required without a request when signed out', async () => {
    const http = createFakeHttp()
    const client = createGithubClient({ fetch: http.fetch, getToken: () => null, appVersion: '1', onUnauthorized: () => undefined })
    expect((await failure(client.getUser())).code).toBe('auth_required')
    expect(http.requests).toEqual([])
  })

  it('reports other failures as github_failed or network_unreachable, never carrying the token', async () => {
    const http = createFakeHttp()
    http.answer(
      jsonResponse(500, { message: `boom ${TOKEN}` }),
      jsonResponse(200, { login: 7 }),
      Object.assign(new TypeError('fetch failed'), { cause: { headers: { Authorization: `Bearer ${TOKEN}` } } })
    )
    const client = createGithubClient({ fetch: http.fetch, getToken: () => TOKEN, appVersion: '1', onUnauthorized: () => undefined })
    const errors = [await failure(client.getUser()), await failure(client.getUser()), await failure(client.getUser())]
    expect(errors.map((error) => error.code)).toEqual(['github_failed', 'github_failed', 'network_unreachable'])
    for (const error of errors) {
      expect(JSON.stringify({ ...error, message: error.message, stack: error.stack, cause: String(error.cause) })).not.toContain(TOKEN)
    }
  })
})

describe('createGithubClient: redirects', () => {
  it('never follows a redirect with the token: authenticated requests fail on one instead', async () => {
    const http = createFakeHttp()
    http.answer(jsonResponse(200, { login: 'octocat', name: null }))
    const client = createGithubClient({ fetch: http.fetch, getToken: () => TOKEN, appVersion: '1', onUnauthorized: () => undefined })
    await client.getUser()
    expect(http.requests[0]?.redirect).toBe('error')
  })
})

let dir: string
let file: string
let changes: unknown[]
let session: GithubSession

/** A session signed in as octocat with TOKEN, over a real store in a temp folder. */
function signIn(): void {
  dir = mkdtempSync(join(tmpdir(), 'dm-github-client-'))
  file = join(dir, 'github-account.json')
  const crypto = { isAvailable: () => true, encrypt: (text: string) => Buffer.from(text).reverse(), decrypt: (data: Buffer) => Buffer.from(data).reverse().toString() }
  changes = []
  session = createGithubSession({ store: createAccountStore({ file, crypto }), onAccountChanged: (account) => changes.push(account) })
  session.signIn({ login: 'octocat', name: null, scopes: 'repo' }, TOKEN)
}

function cleanUp(): void {
  rmSync(dir, { recursive: true, force: true })
}

describe('a 401 from the GitHub API (createSessionClient)', () => {
  beforeEach(signIn)
  afterEach(cleanUp)

  it('signs the account out locally (deleting the file), broadcasts the sign-out and returns auth_required', async () => {
    const http = createFakeHttp()
    http.answer(jsonResponse(401, { message: 'Bad credentials' }))
    const client = createSessionClient(session, { fetch: http.fetch, appVersion: '1' })

    const error = await failure(client.getUser())
    expect(error.code).toBe('auth_required')
    expect(http.requests[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(existsSync(file)).toBe(false)
    expect(session.getAccount()).toBeNull()
    expect(session.getToken()).toBeNull()
    expect(changes).toEqual([{ login: 'octocat', name: null }, null])
    expect(JSON.stringify(changes)).not.toContain(TOKEN)
  })

  it('keeps a newer sign-in when the rejected token is no longer the stored one', async () => {
    const http = createFakeHttp()
    http.answer(() => {
      session.signIn({ login: 'hubot', name: null, scopes: 'repo' }, 'gho_NEWER_token')
      return jsonResponse(401, { message: 'Bad credentials' })
    })
    const client = createSessionClient(session, { fetch: http.fetch, appVersion: '1' })

    expect((await failure(client.getUser())).code).toBe('auth_required')
    expect(existsSync(file)).toBe(true)
    expect(session.getAccount()).toMatchObject({ login: 'hubot' })
    expect(session.getToken()).toBe('gho_NEWER_token')
    expect(changes).toEqual([{ login: 'octocat', name: null }, { login: 'hubot', name: null }])
  })
})

describe('createSessionClient: the stored token', () => {
  beforeEach(signIn)
  afterEach(cleanUp)

  it('uses the stored token on every call and returns auth_required without a request once signed out', async () => {
    const http = createFakeHttp()
    http.answer(jsonResponse(200, { login: 'octocat', name: null }))
    const client = createSessionClient(session, { fetch: http.fetch, appVersion: '1' })
    await client.getUser()
    session.signOut()
    expect((await failure(client.getUser())).code).toBe('auth_required')
    expect(http.requests).toHaveLength(1)
  })
})
