import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GithubAccountView } from '../../shared/github/api'
import { createFakeHttp, jsonResponse, type FakeHttp } from '../../test/fakeHttp'
import type { HttpResponse } from './http'
import { createAccountStore, type AccountCrypto } from './accountStore'
import { createGithubClient } from './client'
import { GithubError } from './errors'
import { createGhCli, type GhRunRequest, type GhRunResult } from './ghCli'
import { createGithubHandlers, type GithubHandlers } from './handlers'
import { createGithubSession } from './session'

const TOKEN = 'gho_FAKE_TOKEN_never_leak_123'
const USER_ANSWER = jsonResponse(200, { login: 'octocat', name: 'The Octocat' }, { 'X-OAuth-Scopes': 'repo, read:user, workflow' })
const GH_OK: GhRunResult = { kind: 'exited', exitCode: 0, stdout: `${TOKEN}\n`, stderr: '' }

type Answer = GhRunResult | ((request: GhRunRequest) => Promise<GhRunResult>)

interface RigOptions {
  encryptionAvailable?: boolean
  encrypt?: AccountCrypto['encrypt']
  gh?: Answer
}

interface Rig {
  handlers: GithubHandlers
  http: FakeHttp
  file: string
  events: Array<GithubAccountView | null>
  logs: unknown[]
  ghRuns: GhRunRequest[]
  results: unknown[]
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dm-github-handlers-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function rig(options: RigOptions = {}): Rig {
  const http = createFakeHttp()
  const file = join(dir, 'github-account.json')
  const events: Rig['events'] = []
  const logs: unknown[] = []
  const ghRuns: GhRunRequest[] = []
  const crypto: AccountCrypto = {
    isAvailable: () => options.encryptionAvailable ?? true,
    encrypt: options.encrypt ?? ((text) => Buffer.from(text).reverse()),
    decrypt: (data) => Buffer.from(data).reverse().toString()
  }
  const session = createGithubSession({ store: createAccountStore({ file, crypto }), onAccountChanged: (account) => events.push(account) })
  const answer = options.gh ?? GH_OK
  const gh = createGhCli({
    env: { PATH: '/opt/homebrew/bin' },
    platform: 'darwin',
    exists: (path) => path === '/opt/homebrew/bin/gh',
    run: async (request) => {
      ghRuns.push(request)
      return typeof answer === 'function' ? answer(request) : answer
    }
  })
  const handlers = createGithubHandlers({
    session,
    readGhToken: (signal) => gh.readGhToken(signal),
    fetchUser: (token) => createGithubClient({ fetch: http.fetch, getToken: () => token, appVersion: '1', onUnauthorized: () => undefined }).getUser(),
    onUnexpectedError: (error) => logs.push(error)
  })
  return { handlers, http, file, events, logs, ghRuns, results: [] }
}

/** Calls a handler and keeps its result for the token search. */
async function call<T>(r: Rig, result: Promise<T>): Promise<T> {
  const value = await result
  r.results.push(value)
  return value
}

/** Every result, broadcast, log line, gh command line and the account file, as text the token must never appear in. */
function expectNoToken(r: Rig): void {
  const logLines = r.logs.map((entry) => (entry instanceof Error ? `${String(entry)}\n${entry.stack ?? ''}\n${String(entry.cause)}` : String(entry)))
  const commandLines = r.ghRuns.map((run) => [run.file, ...run.args].join(' '))
  const fileText = existsSync(r.file) ? readFileSync(r.file, 'utf8') : ''
  const text = [JSON.stringify(r.results), JSON.stringify(r.events), ...logLines, ...commandLines, fileText].join('\n')
  expect(text).not.toContain(TOKEN)
  expect(text).not.toContain(TOKEN.slice(4))
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('github handlers: signIn', () => {
  it('reads the gh token, checks it with GET /user, stores the account encrypted and broadcasts it', async () => {
    const r = rig()
    r.http.answer(USER_ANSWER)
    expect(await call(r, r.handlers.getAccount())).toEqual({ ok: true, data: null })
    expect(await call(r, r.handlers.signIn())).toEqual({ ok: true, data: { login: 'octocat', name: 'The Octocat' } })
    expect(r.events).toEqual([{ login: 'octocat', name: 'The Octocat' }])
    expect(await call(r, r.handlers.getAccount())).toEqual({ ok: true, data: { login: 'octocat', name: 'The Octocat' } })
    expect(r.http.requests.map((request) => [request.method, request.url])).toEqual([['GET', 'https://api.github.com/user']])
    expect(r.http.requests[0].headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(r.ghRuns.map((run) => run.args)).toEqual([['auth', 'token', '--hostname', 'github.com']])
    const stored = JSON.parse(readFileSync(r.file, 'utf8'))
    expect(stored).toMatchObject({ version: 1, login: 'octocat', scopes: 'repo, read:user, workflow' })
    expect(Buffer.from(stored.token, 'base64').reverse().toString()).toBe(TOKEN)
    expect(r.logs).toEqual([])
    expectNoToken(r)
  })

  it('refuses with secure_storage_unavailable before running gh when OS encryption is unavailable', async () => {
    const r = rig({ encryptionAvailable: false })
    expect(await call(r, r.handlers.signIn())).toMatchObject({ ok: false, error: { code: 'secure_storage_unavailable' } })
    expect(r.ghRuns).toEqual([])
    expect(r.http.requests).toEqual([])
    expect(existsSync(r.file)).toBe(false)
  })

  it.each([
    ['gh is not installed', { kind: 'spawn_failed' }, 'gh_not_installed'],
    ['gh has no github.com login', { kind: 'exited', exitCode: 1, stdout: '', stderr: `no oauth token for ${TOKEN}` }, 'gh_not_signed_in'],
    ['gh times out', { kind: 'timeout' }, 'cancelled']
  ] as const)('ends with its own code when %s, without contacting GitHub', async (_case, gh, code) => {
    const r = rig({ gh })
    expect(await call(r, r.handlers.signIn())).toMatchObject({ ok: false, error: { code } })
    expect(r.http.requests).toEqual([])
    expect(r.events).toEqual([])
    expectNoToken(r)
  })
})

describe('github handlers: signIn refused by GitHub', () => {
  it('refuses a token without the repo scope with gh_missing_scope, naming the gh refresh command', async () => {
    const r = rig()
    r.http.answer(jsonResponse(200, { login: 'octocat', name: null }, { 'X-OAuth-Scopes': 'read:org, repository, gist' }))
    const result = await call(r, r.handlers.signIn())
    expect(result).toMatchObject({ ok: false, error: { code: 'gh_missing_scope', message: expect.stringContaining('gh auth refresh -h github.com -s repo,workflow') } })
    expect(existsSync(r.file)).toBe(false)
    expect(r.events).toEqual([])
    expectNoToken(r)
  })

  it('accepts repo anywhere in the scope list', async () => {
    const r = rig()
    r.http.answer(jsonResponse(200, { login: 'octocat', name: null }, { 'X-OAuth-Scopes': 'gist,repo' }))
    expect(await call(r, r.handlers.signIn())).toEqual({ ok: true, data: { login: 'octocat', name: null } })
  })

  it('returns auth_failed for a 401 and network_unreachable when GitHub cannot be reached', async () => {
    const r = rig()
    r.http.answer(jsonResponse(401, { message: `Bad credentials ${TOKEN}` }), new TypeError(`fetch failed ${TOKEN}`))
    expect(await call(r, r.handlers.signIn())).toMatchObject({ ok: false, error: { code: 'auth_failed' } })
    expect(await call(r, r.handlers.signIn())).toMatchObject({ ok: false, error: { code: 'network_unreachable' } })
    expect(existsSync(r.file)).toBe(false)
    expect(r.events).toEqual([])
    expectNoToken(r)
  })

  it('a 401 at sign-in leaves an already stored account alone', async () => {
    const r = rig()
    r.http.answer(USER_ANSWER, jsonResponse(401, {}))
    await call(r, r.handlers.signIn())
    expect(await call(r, r.handlers.signIn())).toMatchObject({ ok: false, error: { code: 'auth_failed' } })
    expect(await call(r, r.handlers.getAccount())).toEqual({ ok: true, data: { login: 'octocat', name: 'The Octocat' } })
  })
})

describe('github handlers: concurrent sign-in', () => {
  it('a second signIn while one runs returns the same promise and runs gh once', async () => {
    const gh = deferred<GhRunResult>()
    const r = rig({ gh: () => gh.promise })
    r.http.answer(USER_ANSWER)
    const first = r.handlers.signIn()
    const second = r.handlers.signIn()
    expect(second).toBe(first)
    gh.resolve(GH_OK)
    expect(await call(r, first)).toMatchObject({ ok: true })
    expect(r.ghRuns).toHaveLength(1)
    expect(r.http.requests).toHaveLength(1)
    expect(r.events).toHaveLength(1)
  })

  it('starts a new attempt once the previous one ended', async () => {
    const r = rig()
    r.http.answer(USER_ANSWER, USER_ANSWER)
    const first = r.handlers.signIn()
    await first
    const second = r.handlers.signIn()
    expect(second).not.toBe(first)
    await second
    expect(r.ghRuns).toHaveLength(2)
  })

  it('signOut during a sign-in aborts it: the attempt ends cancelled and stores nothing', async () => {
    const user = deferred<HttpResponse>()
    const r = rig()
    r.http.answer(() => user.promise)
    const pending = r.handlers.signIn()
    await expectEventually(() => r.http.requests.length === 1)
    expect(await call(r, r.handlers.signOut())).toEqual({ ok: true, data: null })
    user.resolve(USER_ANSWER)
    expect(await call(r, pending)).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(existsSync(r.file)).toBe(false)
    expect(r.events).toEqual([null])
  })

  it('passes an abort signal to gh that signOut aborts', async () => {
    const r = rig({
      gh: (request) =>
        new Promise((resolve) => request.signal?.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true }))
    })
    const pending = r.handlers.signIn()
    await expectEventually(() => r.ghRuns.length === 1)
    await r.handlers.signOut()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(r.http.requests).toEqual([])
  })
})

describe('github handlers: sign-in after a sign-out', () => {
  it('an aborted attempt that ends late leaves the newer one running: a call meanwhile still joins it', async () => {
    const runs: Array<(result: GhRunResult) => void> = []
    const r = rig({ gh: () => new Promise((resolve) => runs.push(resolve)) })
    r.http.answer(USER_ANSWER, USER_ANSWER)
    const first = r.handlers.signIn()
    await expectEventually(() => runs.length === 1)
    await r.handlers.signOut()
    const second = r.handlers.signIn()
    expect(second).not.toBe(first)
    await expectEventually(() => runs.length === 2)
    runs[0](GH_OK)
    expect(await first).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(r.handlers.signIn()).toBe(second)
    runs[1](GH_OK)
    expect(await second).toMatchObject({ ok: true, data: { login: 'octocat' } })
    expect(r.ghRuns).toHaveLength(2)
    expect(r.events).toEqual([null, { login: 'octocat', name: 'The Octocat' }])
  })
})

/** Waits on microtasks (no clock) until `condition` holds. */
async function expectEventually(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50 && !condition(); turn += 1) {
    await Promise.resolve()
  }
  expect(condition()).toBe(true)
}

describe('github handlers: unexpected failures', () => {
  it('logs an unexpected failure with the token scrubbed and returns github_failed', async () => {
    const r = rig({
      encrypt: (text) => {
        throw new Error(`cannot encrypt ${text}`)
      }
    })
    r.http.answer(USER_ANSWER)
    expect(await call(r, r.handlers.signIn())).toMatchObject({ ok: false, error: { code: 'github_failed' } })
    expect(r.logs).toHaveLength(1)
    expect(String(r.logs[0])).toContain('cannot encrypt [redacted]')
    expect(existsSync(r.file)).toBe(false)
    expectNoToken(r)
  })

  it('a GithubError keeps its code, fixed message and detail', async () => {
    const r = rig()
    const failing = createGithubHandlers({
      session: createGithubSession({ store: createAccountStore({ file: r.file, crypto: { isAvailable: () => true, encrypt: Buffer.from, decrypt: String } }), onAccountChanged: () => undefined }),
      readGhToken: async () => Promise.reject(new GithubError('gh_not_signed_in', undefined, 'not logged in')),
      fetchUser: async () => Promise.reject(new Error('unused')),
      onUnexpectedError: (error) => r.logs.push(error)
    })
    expect(await failing.signIn()).toEqual({ ok: false, error: { code: 'gh_not_signed_in', message: expect.any(String), detail: 'not logged in' } })
    expect(r.logs).toEqual([])
  })
})

describe('github handlers: sign-out', () => {
  it('deletes only the account file and broadcasts the signed-out account; gh is not run', async () => {
    const r = rig()
    r.http.answer(USER_ANSWER)
    await call(r, r.handlers.signIn())
    expect(existsSync(r.file)).toBe(true)
    expect(await call(r, r.handlers.signOut())).toEqual({ ok: true, data: null })
    expect(existsSync(r.file)).toBe(false)
    expect(r.events.at(-1)).toBeNull()
    expect(r.ghRuns).toHaveLength(1)
    expect(await call(r, r.handlers.getAccount())).toEqual({ ok: true, data: null })
    expectNoToken(r)
  })

  it('reports a failing sign-out as github_failed and logs it', async () => {
    const r = rig()
    const failing = createGithubHandlers({
      session: {
        getAccount: () => null,
        getToken: () => null,
        canStoreToken: () => true,
        signIn: () => undefined,
        signOut: () => {
          throw new Error('EPERM')
        }
      },
      readGhToken: async () => Promise.reject(new Error('unused')),
      fetchUser: async () => Promise.reject(new Error('unused')),
      onUnexpectedError: (error) => r.logs.push(error)
    })
    expect(await failing.signOut()).toMatchObject({ ok: false, error: { code: 'github_failed' } })
    expect(r.logs).toHaveLength(1)
  })
})
