import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { EchoError, echoProtocol } from './__mocks__/echoProtocol'
import { createControlClient } from './controlClient'
import { createControlFrame } from './controlFrame'
import type { ControlLimits } from './controlProtocol'

interface EchoWire { requestId: string; token: string; op: string; args: { bytes: number } }
const closers: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())) })

/** A raw endpoint standing in for a server: answers each request line with `reply(request)`. */
async function endpoint(prefix: string, reply: (request: EchoWire) => unknown): Promise<{ address: string; close(): Promise<void> }> {
  const root = process.platform === 'win32' ? null : mkdtempSync(join(tmpdir(), prefix))
  const address = root === null ? `\\\\.\\pipe\\${prefix}${randomUUID()}` : join(root, 'p')
  const sockets = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let text = ''
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      if (text.endsWith('\n')) { socket.end(JSON.stringify(reply(JSON.parse(text) as EchoWire)) + '\n') }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address, resolve) })
  let closed: Promise<void> | null = null
  const close = (): Promise<void> => {
    closed ??= new Promise<void>((resolve) => {
      for (const socket of sockets) { socket.destroy() }
      server.close(() => { if (root !== null) { rmSync(root, { recursive: true, force: true }) } resolve() })
    })
    return closed
  }
  closers.push(close)
  return { address, close }
}
const echoed = (request: EchoWire) => ({ version: 1, requestId: request.requestId, ok: true, data: { text: 'x'.repeat(request.args.bytes) } })
const failed = (code: string) => (request: EchoWire) => ({ version: 1, requestId: request.requestId, ok: false, error: { code, message: 'server text is not trusted' } })
const KIB_40 = 40 * 1024
const ECHO = (bytes: number) => ({ op: 'echo', args: { bytes } }) as const
function echoClient(address: string, limits: Partial<ControlLimits> = {}) {
  return createControlClient({ protocol: echoProtocol(limits), envVar: 'DM_ECHO_PIPE', env: { DM_ECHO_PIPE: address, DM_SESSION_TOKEN: 'grant' }, requestId: () => 'r1' })
}

it('carries a 40 KiB reply only within its own negotiated response limit', async () => {
  const { address } = await endpoint('dm-echo-c-', echoed)
  const reply = await echoClient(address).request(ECHO(KIB_40))
  expect(reply.ok).toBe(true)
  expect(reply.ok && reply.data.text).toHaveLength(KIB_40)
  // A client declaring the naming-sized 8 KiB bound refuses the same bytes before buffering them.
  expect(await echoClient(address, { responseBytes: 8192 }).request(ECHO(KIB_40)))
    .toEqual({ version: 1, requestId: 'r1', ok: false, error: { code: 'invalid_request', message: 'Echo: invalid_request.' } })
})

it('rebuilds server failures (response_too_large, unauthorized) with its own fixed messages', async () => {
  const tooLarge = await endpoint('dm-echo-c-', failed('response_too_large'))
  expect(await echoClient(tooLarge.address).request(ECHO(70_000)))
    .toEqual({ version: 1, requestId: 'r1', ok: false, error: { code: 'response_too_large', message: 'Echo: response_too_large.' } })
  const unauthorized = await endpoint('dm-echo-c-', failed('unauthorized'))
  expect(await echoClient(unauthorized.address).request(ECHO(1)))
    .toEqual({ version: 1, requestId: 'r1', ok: false, error: { code: 'unauthorized', message: 'Echo: unauthorized.' } })
})

it('sends its own wire envelope, read from its own address variable only', async () => {
  const seen: EchoWire[] = []
  const { address } = await endpoint('dm-echo-c-', (request) => { seen.push(request); return echoed(request) })
  const borrowed = createControlClient({ protocol: echoProtocol(), envVar: 'DM_ECHO_PIPE', env: { DM_DESKTOP_PIPE: address, DM_SESSION_TOKEN: 'grant' }, requestId: () => 'r1' })
  expect(await borrowed.request(ECHO(1))).toEqual({ version: 1, requestId: 'r1', ok: false, error: { code: 'desktop_unavailable', message: 'Echo: desktop_unavailable.' } })
  expect(await echoClient(address).request({ op: 'echo', args: { bytes: -1 } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect(seen).toEqual([])
  expect(await echoClient(address).request(ECHO(3))).toMatchObject({ ok: true, data: { text: 'xxx' } })
  expect(seen).toEqual([{ version: 1, requestId: 'r1', token: 'grant', op: 'echo', args: { bytes: 3 } }])
})

it('frames with the protocol error factory and keeps the naming default', () => {
  const echoFrame = createControlFrame(4, (code) => new EchoError(code))
  expect(() => echoFrame.push(Buffer.from('12345'))).toThrow(EchoError)
  expect(() => createControlFrame(4).push(Buffer.from('12345'))).toThrow(expect.objectContaining({ name: 'NamingControlError', code: 'invalid_request' }))
})

it('drives two pipes side by side; closing one leaves the other working', async () => {
  const first = await endpoint('dm-echo-a-', echoed)
  const second = await endpoint('dm-echo-b-', echoed)
  expect(first.address).not.toBe(second.address)
  await first.close()
  expect(await echoClient(first.address).request(ECHO(1))).toMatchObject({ ok: false, error: { code: 'desktop_unavailable' } })
  expect(await echoClient(second.address).request(ECHO(KIB_40))).toMatchObject({ ok: true })
})
