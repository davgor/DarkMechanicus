import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { basename, dirname } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { EchoError, echoProtocol } from '../../core/desktop/__mocks__/echoProtocol'
import { createControlClient } from '../../core/desktop/controlClient'
import type { ControlLimits } from '../../core/desktop/controlProtocol'
import { createControlServer, type ControlBinding, type ControlServerHandle } from './controlServer'

const servers: ControlServerHandle[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())) })

const binding = (): ControlBinding => ({ folder: null, chatId: 'chat', signal: new AbortController().signal, assertCurrent: () => {} })
const KIB_40 = 40 * 1024

async function echoServer(options: {
  limits?: Partial<ControlLimits>
  authorize?: (token: string) => ControlBinding
  dispatch?: (operation: { op: 'echo'; args: { bytes: number } }) => unknown
  prefix?: string
} = {}): Promise<ControlServerHandle> {
  const prefix = options.prefix ?? 'dm-echo-'
  const server = await createControlServer({
    protocol: echoProtocol(options.limits),
    authorize: options.authorize ?? binding,
    dispatch: options.dispatch ?? ((operation) => ({ text: 'x'.repeat(operation.args.bytes) })),
    addressPrefix: { unix: prefix, win32: prefix }
  })
  servers.push(server)
  return server
}

/** A raw wire client, independent of the generic client under test elsewhere. */
async function send(address: string, line: string): Promise<{ raw: string; reply: { ok: boolean; requestId: string; data?: { text: string }; error?: { code: string; message: string } } }> {
  const socket = createConnection(address)
  const chunks: Buffer[] = []
  const raw = await new Promise<string>((resolve, reject) => {
    socket.on('connect', () => socket.write(line))
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); socket.destroy() })
    socket.on('error', reject)
  })
  return { raw, reply: JSON.parse(raw) as never }
}
const echo = (bytes: number, token = 'grant'): string => JSON.stringify({ version: 1, requestId: 'r1', token, op: 'echo', args: { bytes } }) + '\n'

it('returns a 40 KiB reply under its own 64 KiB response limit, and response_too_large above it', async () => {
  const server = await echoServer()
  const ok = await send(server.address, echo(KIB_40))
  expect(ok.reply).toMatchObject({ ok: true, requestId: 'r1' })
  expect(ok.reply.data?.text).toHaveLength(KIB_40)
  expect(Buffer.byteLength(ok.raw)).toBeGreaterThan(KIB_40)
  expect(Buffer.byteLength(ok.raw)).toBeLessThanOrEqual(65_536)
  expect((await send(server.address, echo(70_000))).reply).toEqual({ version: 1, requestId: 'r1', ok: false, error: { code: 'response_too_large', message: 'Echo: response_too_large.' } })
})

it('applies the smaller limit of a protocol that declares one: 40 KiB fails at 8 KiB', async () => {
  const server = await echoServer({ limits: { responseBytes: 8192 } })
  expect((await send(server.address, echo(KIB_40))).reply).toMatchObject({ ok: false, error: { code: 'response_too_large' } })
  expect((await send(server.address, echo(4000))).reply).toMatchObject({ ok: true })
})

it('bounds the request frame by its own requestBytes', async () => {
  const server = await echoServer({ limits: { requestBytes: 128 } })
  const padded = JSON.stringify({ version: 1, requestId: 'r'.repeat(120), token: 'grant', op: 'echo', args: { bytes: 1 } }) + '\n'
  expect(Buffer.byteLength(padded)).toBeGreaterThan(128)
  expect((await send(server.address, padded)).reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect((await send(server.address, echo(1))).reply).toMatchObject({ ok: true })
})

it('answers unauthorized when authorize throws, without dispatching', async () => {
  const dispatch = vi.fn(() => ({ text: 'never' }))
  const server = await echoServer({ authorize: () => { throw new Error('grant secret-token-value revoked') }, dispatch })
  const { raw, reply } = await send(server.address, echo(1, 'stale'))
  expect(reply).toEqual({ version: 1, requestId: 'r1', ok: false, error: { code: 'unauthorized', message: 'Echo: unauthorized.' } })
  expect(raw).not.toContain('secret-token-value')
  expect(dispatch).not.toHaveBeenCalled()
})

it("maps failures through the protocol's own error factory and fixed messages", async () => {
  const refused = await echoServer({ dispatch: () => { throw new EchoError('echo_refused') } })
  expect((await send(refused.address, echo(1))).reply).toEqual({ version: 1, requestId: 'r1', ok: false, error: { code: 'echo_refused', message: 'Echo: echo_refused.' } })
  const leaky = await echoServer({ dispatch: () => { throw new Error('transcript: private text') } })
  const leaked = await send(leaky.address, echo(1))
  expect(leaked.reply).toMatchObject({ ok: false, error: { code: 'internal_error', message: 'Echo: internal_error.' } })
  expect(leaked.raw).not.toContain('private text')
  // A server-made deadline error is the protocol's own error type, so its code survives errorCodeOf.
  const expired = await echoServer({ limits: { serverMs: 0 } })
  expect((await send(expired.address, echo(1))).reply).toMatchObject({ ok: false, error: { code: 'timeout' } })
})

it('runs two servers with different prefixes side by side and closes them independently', async () => {
  const first = await echoServer({ prefix: 'dm-echo-a-' })
  const second = await echoServer({ prefix: 'dm-echo-b-' })
  expect(first.address).not.toBe(second.address)
  if (process.platform === 'win32') {
    expect(first.address).toMatch(/^\\\\\.\\pipe\\dm-echo-a-[0-9a-f-]{36}$/)
    expect(second.address).toMatch(/^\\\\\.\\pipe\\dm-echo-b-[0-9a-f-]{36}$/)
  } else {
    expect(basename(dirname(first.address))).toMatch(/^dm-echo-a-/)
    expect(basename(dirname(second.address))).toMatch(/^dm-echo-b-/)
  }
  await first.close()
  await first.close()
  if (process.platform !== 'win32') {
    expect(existsSync(dirname(first.address))).toBe(false)
    expect(existsSync(dirname(second.address))).toBe(true)
  }
  await expect(send(first.address, echo(1))).rejects.toThrow()
  expect((await send(second.address, echo(KIB_40))).reply).toMatchObject({ ok: true })
  await second.close()
  if (process.platform !== 'win32') { expect(existsSync(dirname(second.address))).toBe(false) }
  await expect(send(second.address, echo(1))).rejects.toThrow()
})

it('serves the generic client end to end on its own address variable', async () => {
  const server = await echoServer()
  const client = createControlClient({ protocol: echoProtocol(), envVar: 'DM_ECHO_PIPE', env: { DM_ECHO_PIPE: server.address, DM_SESSION_TOKEN: 'grant' } })
  const reply = await client.request({ op: 'echo', args: { bytes: KIB_40 } })
  expect(reply.ok && reply.data.text.length).toBe(KIB_40)
  const refused = await echoServer({ authorize: () => { throw new Error('revoked') } })
  const stale = createControlClient({ protocol: echoProtocol(), envVar: 'DM_ECHO_PIPE', env: { DM_ECHO_PIPE: refused.address, DM_SESSION_TOKEN: 'stale' } })
  expect(await stale.request({ op: 'echo', args: { bytes: 1 } })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
})
