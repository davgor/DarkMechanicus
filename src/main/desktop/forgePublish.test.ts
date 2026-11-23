import { expect, it, vi } from 'vitest'
import type { HttpFetch } from '../github/http'
import { createForgeRepositoryPublisher, ForgeCreationRefused, publishForgeRepository } from './forgePublish'

it('creates an initialized private repository and reports permission errors without leaking credentials', async () => {
  const sent: Request[] = []
  let status = 201
  const request: typeof fetch = async (url, options) => {
    sent.push(new Request(url, options))
    return new Response(null, { status })
  }
  await expect(publishForgeRepository('tickets', null, request)).rejects.toThrow('Sign into GitHub')
  expect(sent).toHaveLength(0)
  await publishForgeRepository('tickets', 'test-credential', request)
  expect(sent[0].url).toBe('https://api.github.com/user/repos')
  expect(sent[0].method).toBe('POST')
  expect(sent[0].headers.get('Authorization')).toBe('Bearer test-credential')
  expect(await sent[0].json()).toEqual({ name: 'tickets', private: true, auto_init: true })
  status = 403
  await expect(publishForgeRepository('tickets', 'test-credential', request)).rejects.toThrow(/^GitHub could not create this private repository \(403\)\.$/)
})

const account = { login: 'owner', id: 101 }
const code = 'https://github.com/owner/code.git'
const provenance = 'Created by Dark Mechanicus (fixture-operation)'
const request = { account, name: 'code', visibility: 'public' as const, provenance }

function remote(options: { private?: boolean; url?: string } = {}) {
  return {
    id: 202, name: 'code', owner: { login: 'owner', id: 101 }, private: options.private ?? false,
    clone_url: options.url ?? code, description: provenance
  }
}

function publication() {
  const connection: { login: string | null; token: string | null } = {
    login: 'Owner', token: 'isolated-fixture-token'
  }
  const fetch = vi.fn<HttpFetch>()
  const publisher = createForgeRepositoryPublisher({
    getAccount: () => connection.login === null ? null : { login: connection.login },
    getToken: () => connection.token
  }, fetch)
  return { publisher, fetch, connection }
}

it.each(['public', 'private'] as const)('binds %s publication to the verified account and immutable repository receipt', async visibility => {
  const { publisher, fetch, connection } = publication()
  const response = remote({ private: visibility === 'private' })
  fetch.mockResolvedValueOnce(Response.json(account))
    .mockResolvedValueOnce(Response.json(account))
    .mockResolvedValueOnce(Response.json(response, { status: 201 }))
    .mockResolvedValueOnce(Response.json(account))
    .mockResolvedValueOnce(Response.json(response))

  expect(await publisher.account()).toEqual(account)
  const receipt = { id: 202, owner: 'owner', ownerId: 101, name: 'code', visibility, url: code, provenance }
  await expect(publisher.createRemote({ ...request, visibility })).resolves.toEqual(receipt)
  await expect(publisher.findRemote(account, 'code')).resolves.toEqual(receipt)
  expect(fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
    ['https://api.github.com/user', 'GET'], ['https://api.github.com/user', 'GET'],
    ['https://api.github.com/user/repos', 'POST'], ['https://api.github.com/user', 'GET'],
    ['https://api.github.com/repos/owner/code', 'GET']
  ])
  expect(JSON.parse(fetch.mock.calls[2][1].body!)).toEqual({
    name: 'code', description: provenance, private: visibility === 'private', auto_init: false
  })
  for (const [, options] of fetch.mock.calls) {
    expect(options.redirect).toBe('error')
    expect(options.headers.Authorization).toBe('Bearer ' + connection.token)
  }
})

it.each(['missing-login', 'missing-token', 'changed-token', 'changed-account-id', 'wrong-login'] as const)(
  'refuses before any POST when verification sees %s', async change => {
    const { publisher, fetch, connection } = publication()
    if (change === 'missing-login') connection.login = null
    if (change === 'missing-token') connection.token = null
    fetch.mockImplementationOnce(async () => {
      if (change === 'changed-token') connection.token = 'new-fixture-token'
      return Response.json({
        id: change === 'changed-account-id' ? 303 : account.id,
        login: change === 'wrong-login' ? 'other' : account.login
      })
    })
    await expect(publisher.createRemote(request)).rejects.toBeInstanceOf(ForgeCreationRefused)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(
      change.startsWith('missing') ? [] : ['https://api.github.com/user']
    )
  }
)

it('distinguishes a missing repository from unreadable or substituted repository metadata', async () => {
  const { publisher, fetch } = publication()
  fetch.mockResolvedValueOnce(Response.json(account)).mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json(account)).mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(Response.json(account)).mockResolvedValueOnce(Response.json(remote({ url: 'https://github.com/owner/other.git' })))
    .mockResolvedValueOnce(Response.json(account)).mockResolvedValueOnce(Response.json({ id: 202 }))

  await expect(publisher.inspectRemote(account, code)).resolves.toBeNull()
  await expect(publisher.inspectRemote(account, code)).rejects.toThrow('could not verify the repository')
  await expect(publisher.inspectRemote(account, code)).rejects.toThrow('returned a different repository')
  await expect(publisher.inspectRemote(account, code)).rejects.toThrow('valid repository receipt')
})

it.each([400, 401, 403, 404, 422])('classifies a definitive HTTP %s creation failure without reading its body', async status => {
  const { publisher, fetch } = publication()
  const json = vi.fn(async () => ({ detail: 'private response body' }))
  fetch.mockResolvedValueOnce(Response.json(account)).mockResolvedValueOnce({ status, json, ok: false, headers: new Headers() })
  const pending = publisher.createRemote(request)
  await expect(pending).rejects.toBeInstanceOf(ForgeCreationRefused)
  await expect(pending).rejects.toThrow('GitHub refused repository creation (' + status + ').')
  expect(json).not.toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledTimes(2)
})

it.each(['lost-response', 'rate-limit', 'unconfirmed', 'invalid-receipt'] as const)(
  'leaves creation outcome ambiguous after %s at the publication boundary', async outcome => {
    const { publisher, fetch, connection } = publication()
    fetch.mockResolvedValueOnce(Response.json(account))
    if (outcome === 'lost-response') fetch.mockRejectedValueOnce(new Error('Lost request: ' + connection.token))
    else if (outcome === 'invalid-receipt') fetch.mockResolvedValueOnce(Response.json({ id: 202 }, { status: 201 }))
    else fetch.mockResolvedValueOnce(new Response(null, { status: outcome === 'rate-limit' ? 429 : 202 }))

    const failure = await publisher.createRemote(request).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(ForgeCreationRefused)
    expect(String(failure)).not.toContain(connection.token)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://api.github.com/user', 'https://api.github.com/user/repos'])
  }
)
