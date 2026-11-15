import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NAMING_CONTROL, type NamingRequest } from '../../shared/agents/chatNaming'
import { createDesktopClient } from './desktopClient'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())) })

async function endpoint(reply: (socket: Socket, request: NamingRequest) => void): Promise<string> {
  const root = process.platform === 'win32' ? null : mkdtempSync(join(tmpdir(), 'dm-client-'))
  const address = root === null ? `\\\\.\\pipe\\dm-client-${randomUUID()}` : join(root, 'control.sock')
  const sockets = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let text = ''
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      if (text.endsWith('\n')) { reply(socket, JSON.parse(text) as NamingRequest) }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address, resolve) })
  cleanups.push(async () => {
    for (const socket of sockets) { socket.destroy() }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (root !== null) { rmSync(root, { recursive: true, force: true }) }
  })
  return address
}
const NAME = { op: 'name_chat', args: { title: 'Semantic label' } } as const

it('reports unavailable for absent or unreachable transport and unauthorized for missing authority', async () => {
  expect(await createDesktopClient({ env: {} }).request(NAME)).toMatchObject({ error: { code: 'desktop_unavailable' } })
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\dm-absent-${randomUUID()}` : join(tmpdir(), `dm-absent-${randomUUID()}.sock`)
  expect(await createDesktopClient({ env: { DM_DESKTOP_PIPE: address, DM_SESSION_TOKEN: 'grant' } }).request(NAME)).toMatchObject({ error: { code: 'desktop_unavailable' } })
  expect(await createDesktopClient({ env: { DM_DESKTOP_PIPE: address } }).request(NAME)).toMatchObject({ error: { code: 'unauthorized' } })
})
it('sends only the strict scoped wire envelope and correlates a fragmented real reply', async () => {
  const seen: NamingRequest[] = []
  const address = await endpoint((socket, request) => {
    seen.push(request)
    const reply = JSON.stringify({ version: 1, requestId: request.requestId, ok: true, data: { applied: true } }) + '\n'
    const bytes = Buffer.from(reply)
    const split = Math.floor(bytes.length / 2)
    socket.write(bytes.subarray(0, split))
    socket.end(bytes.subarray(split))
  })
  const client = createDesktopClient({ env: { DM_DESKTOP_PIPE: address, DM_SESSION_TOKEN: 'grant' }, requestId: () => 'correlated' })
  expect(await client.request(NAME)).toEqual({ version: 1, requestId: 'correlated', ok: true, data: { applied: true } })
  expect(seen).toEqual([{ version: 1, requestId: 'correlated', token: 'grant', op: 'name_chat', args: { title: 'Semantic label' } }])
})
it('enforces the total 25s deadline across a connected but stalled real transport, without retry', async () => {
  let calls = 0
  let expire = (): void => {}
  let cancelled = 0
  let bound = 0
  const address = await endpoint(() => { calls += 1 })
  const client = createDesktopClient({ env: { DM_DESKTOP_PIPE: address, DM_SESSION_TOKEN: 'grant' }, after: (callback, ms) => { expire = callback; bound = ms; return () => { cancelled += 1 } } })
  const pending = client.request(NAME)
  await vi.waitFor(() => expect(calls).toBe(1))
  expect(bound).toBe(25_000)
  expire()
  expect(await pending).toMatchObject({ error: { code: 'timeout' } })
  expect([calls, cancelled]).toEqual([1, 1])
})
it('aborts a connected operation and does not connect for an already aborted request', async () => {
  let calls = 0
  const address = await endpoint(() => { calls += 1 })
  const client = createDesktopClient({ env: { DM_DESKTOP_PIPE: address, DM_SESSION_TOKEN: 'grant' } })
  const controller = new AbortController()
  const pending = client.request(NAME, { signal: controller.signal })
  await vi.waitFor(() => expect(calls).toBe(1))
  controller.abort()
  expect(await pending).toMatchObject({ error: { code: 'cancelled' } })
  expect(await client.request(NAME, { signal: controller.signal })).toMatchObject({ error: { code: 'cancelled' } })
  expect(calls).toBe(1)
})
describe('strict bounded response framing', () => {
  it.each([
    (_request: NamingRequest) => Buffer.alloc(NAMING_CONTROL.responseBytes + 1, 120),
    (_request: NamingRequest) => Buffer.from([0xff, 10]),
    (_request: NamingRequest) => Buffer.from('not-json\n'),
    (request: NamingRequest) => Buffer.from(JSON.stringify({ version: 2, requestId: request.requestId, ok: true, data: {} }) + '\n'),
    (_request: NamingRequest) => Buffer.from(JSON.stringify({ version: 1, requestId: 'wrong', ok: true, data: {} }) + '\n'),
    (request: NamingRequest) => Buffer.from((JSON.stringify({ version: 1, requestId: request.requestId, ok: true, data: {} }) + '\n').repeat(2)),
    (request: NamingRequest) => Buffer.from(JSON.stringify({ version: 1, requestId: request.requestId, ok: false, error: { code: 'unauthorized', message: 'x'.repeat(257) } }) + '\n')
  ])('rejects oversized, invalid UTF-8, malformed, uncorrelated and extra replies (%#)', async (bytes) => {
    const address = await endpoint((socket, request) => socket.end(bytes(request)))
    const reply = await createDesktopClient({ env: { DM_DESKTOP_PIPE: address, DM_SESSION_TOKEN: 'grant' } }).request(NAME)
    expect(reply).toMatchObject({ error: { code: 'invalid_request' } })
  })
})
it('validates an operation before opening a socket or exposing authority', async () => {
  const connect = vi.fn(() => { throw new Error('must not connect') })
  const client = createDesktopClient({ env: { DM_DESKTOP_PIPE: 'present', DM_SESSION_TOKEN: 'grant' }, connect })
  expect(await client.request({ op: 'capture_pane', args: { pane: 'viewer', waitForLoad: true } } as unknown as Parameters<typeof client.request>[0])).toMatchObject({ error: { code: 'invalid_request' } })
  expect(connect).not.toHaveBeenCalled()
})

it('uses the current hosted environment and replaces untrusted transport error messages', async () => {
  const address = await endpoint((socket, request) => socket.end(JSON.stringify({ version: 1, requestId: request.requestId, ok: false, error: { code: 'unauthorized', message: 'private credential from peer' } }) + '\n'))
  vi.stubEnv('DM_DESKTOP_PIPE', address)
  vi.stubEnv('DM_SESSION_TOKEN', 'grant')
  try {
    const reply = await createDesktopClient().request(NAME)
    expect(reply).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(JSON.stringify(reply)).not.toContain('private credential')
  } finally { vi.unstubAllEnvs() }
})

it('rejects an oversized inherited grant before it can publish metadata', async () => {
  const address = await endpoint((socket, request) => socket.end(JSON.stringify({ version: 1, requestId: request.requestId, ok: true, data: { applied: true } }) + '\n'))
  expect(await createDesktopClient({ env: { DM_DESKTOP_PIPE: address, DM_SESSION_TOKEN: 'x'.repeat(1025) } }).request(NAME)).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
})

it('reports an empty peer reply as invalid without treating metadata as applied', async () => {
  const address = await endpoint(socket => socket.end())
  expect(await createDesktopClient({ env: { DM_DESKTOP_PIPE: address, DM_SESSION_TOKEN: 'grant' } }).request(NAME)).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
})

it('bounds serialized credential bytes, including JSON escape expansion, before connecting', async () => {
  const connect = vi.fn(() => { throw new Error('oversized wire must not connect') })
  const client = createDesktopClient({ env: { DM_DESKTOP_PIPE: 'present', DM_SESSION_TOKEN: '\x01'.repeat(1024) }, connect })
  expect(await client.request(NAME)).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect(connect).not.toHaveBeenCalled()
})
