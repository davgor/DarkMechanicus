import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { discoverGithubForgeSetup } from './forgeSetupGithub'

const repository = 'https://github.com/example/project.git'
const endpoint = 'https://api.github.com/repos/example/project'
const commit = 'a'.repeat(40)
const tree = 'b'.repeat(40)
const packageText = '{"name":"fixture","engines":{"node":">=24"},"scripts":{"build":"vite build"}}'
const size = Buffer.byteLength(packageText)
const blob = createHash('sha1').update('blob ' + size + '\0').update(packageText).digest('hex')
const descriptor = { path: 'package.json', type: 'blob', mode: '100644', size, sha: blob }

function headResponse() { return Response.json([{ sha: commit, commit: { tree: { sha: tree } } }]) }

function githubFixture() {
  const connection: { login: string | null; token: string | null } = {
    login: 'example', token: 'fixture-read-token'
  }
  const session = {
    getAccount: () => connection.login === null ? null : { login: connection.login },
    getToken: () => connection.token
  }
  const fetch = vi.fn<Parameters<typeof discoverGithubForgeSetup>[2]>()
  const discover = () => discoverGithubForgeSetup(repository, session, fetch)
  return { connection, fetch, discover }
}

it('reads an authenticated GitHub snapshot pinned to the commit tree and the selected raw blob', async () => {
  const { connection, fetch, discover } = githubFixture()
  fetch.mockResolvedValueOnce(headResponse()).mockResolvedValueOnce(Response.json({
    tree: [descriptor, { ...descriptor, path: 'package-lock.json' }, { ...descriptor, path: 'README.md' }], truncated: false
  })).mockResolvedValueOnce(new Response(packageText))

  const result = await discover()
  expect(result).toMatchObject({ status: 'detected', source: { repository, commit }, facts: [
    { kind: 'node', source: 'package.json', value: '>=24' },
    { kind: 'script', source: 'package.json', value: 'build' },
    { kind: 'lockfile', source: 'package-lock.json', value: 'npm' }
  ] })
  expect(JSON.stringify(result)).not.toContain(connection.token)
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    endpoint + '/commits?per_page=1', endpoint + '/git/trees/' + tree, endpoint + '/git/blobs/' + blob
  ])
  const signal = fetch.mock.calls[0][1].signal
  expect(signal).toBeInstanceOf(AbortSignal)
  for (const [index, [, options]] of fetch.mock.calls.entries()) {
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', signal })
    const headers = new Headers(options.headers)
    expect(headers.get('Authorization')).toBe('Bearer ' + connection.token)
    expect(headers.get('Accept')).toBe('application/vnd.github' + (index === 2 ? '.raw' : '') + '+json')
  }
})

it.each(['missing', 'empty-repository', 'empty-heads', 'unauthorized', 'missing-body'] as const)(
  'reports unavailable setup when the initial head is %s', async scenario => {
    const { connection, fetch, discover } = githubFixture()
    connection.login = null
    connection.token = null
    const responses = {
      missing: () => new Response(null, { status: 404 }),
      'empty-repository': () => new Response(null, { status: 409 }),
      'empty-heads': () => Response.json([]),
      unauthorized: () => new Response(null, { status: 403 }),
      'missing-body': () => new Response(null)
    }
    fetch.mockResolvedValueOnce(responses[scenario]())
    await expect(discover()).resolves.toMatchObject({ status: 'unavailable', source: null, facts: [] })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(new Headers(fetch.mock.calls[0][1].headers).has('Authorization')).toBe(false)
  }
)

it.each(['server-truncated', 'too-many-entries'] as const)('does not request any descriptor blob for a %s tree', async scenario => {
  const { fetch, discover } = githubFixture()
  const entries = scenario === 'server-truncated' ? [descriptor] :
    [descriptor, ...Array.from({ length: 2048 }, (_, index) => ({ ...descriptor, path: index + '.txt' }))]
  fetch.mockResolvedValueOnce(headResponse()).mockResolvedValueOnce(Response.json({
    tree: entries, truncated: scenario === 'server-truncated'
  }))
  await expect(discover()).resolves.toMatchObject({
    status: 'unavailable', reason: 'descriptor-limits', source: { repository, commit }, facts: []
  })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('stops a pinned lookup if the account token changes while it waits for the tree', async () => {
  const { connection, fetch, discover } = githubFixture()
  fetch.mockResolvedValueOnce(headResponse()).mockImplementationOnce(async () => {
    connection.token = 'new-fixture-token'
    return Response.json({ tree: [descriptor], truncated: false })
  })
  await expect(discover()).resolves.toMatchObject({
    status: 'unavailable', reason: 'source-unavailable', source: { repository, commit }, facts: []
  })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it.each(['refused-blob', 'oversized-blob'] as const)('keeps pinned provenance without emitting facts after a %s response', async scenario => {
  const { fetch, discover } = githubFixture()
  fetch.mockResolvedValueOnce(headResponse())
    .mockResolvedValueOnce(Response.json({ tree: [descriptor], truncated: false }))
    .mockResolvedValueOnce(scenario === 'refused-blob' ? new Response(null, { status: 404 }) : new Response(packageText + ' '))
  await expect(discover()).resolves.toMatchObject({ status: 'unavailable', source: { repository, commit }, facts: [] })
  expect(fetch).toHaveBeenCalledTimes(3)
})

it.each(['header', 'stream'] as const)('rejects a %s-over-limit descriptor even when cancelling its body fails', async (limit) => {
  const cancel = vi.fn(async () => { throw new Error('The stream closed while cancelling') })
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(33 * 1024)) },
    cancel
  })
  const headers = limit === 'header' ? { 'content-length': '33792' } : undefined
  const fetch = vi.fn(async () => new Response(body, { headers }))
  const result = await discoverGithubForgeSetup(repository, { getAccount: () => null, getToken: () => null }, fetch)
  expect(result).toMatchObject({ status: 'unavailable', source: null, facts: [] })
  expect(fetch).toHaveBeenCalledOnce()
  expect(cancel).toHaveBeenCalledOnce()
})
