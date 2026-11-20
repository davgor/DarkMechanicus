import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { createYoloDesktopRuntime, isYoloDesktopLive, proveYoloDesktop } from './yoloFence'

const directories: string[] = []
const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function runtime() {
  const directory = mkdtempSync(join(tmpdir(), 'dm-yolo-proof-'))
  directories.push(directory)
  const desktop = createYoloDesktopRuntime(join(directory, 'desktop.json'))
  await desktop.ready
  disposers.push(desktop.dispose)
  return desktop
}

async function signature(endpoint: string, request: string): Promise<string> {
  const socket = createConnection(endpoint)
  socket.write(request)
  let frame = ''
  for await (const data of socket) {
    frame += String(data)
    if (frame.includes('\n')) break
  }
  return frame
}

async function proxy(serve: (socket: Socket) => void): Promise<{ server: Server; endpoint: string }> {
  const directory = process.platform === 'win32' ? null : mkdtempSync(join(tmpdir(), 'dm-yp-'))
  if (directory !== null) directories.push(directory)
  const endpoint = directory === null ? `\\\\.\\pipe\\dm-yolo-test-${randomUUID()}` : join(directory, 'p')
  const server = createServer(serve)
  server.listen(endpoint)
  await once(server, 'listening')
  disposers.push(async () => {
    const closed = once(server, 'close')
    server.close()
    await closed
  })
  return { server, endpoint }
}

it('requires the live signing instance even while the recorded PID remains alive', async () => {
  const desktop = await runtime()
  expect(await proveYoloDesktop(desktop.fence)).toBe(true)
  expect(readFileSync(desktop.fence.path, 'utf8')).not.toContain('PRIVATE KEY')
  await desktop.dispose()
  expect(isYoloDesktopLive(desktop.fence)).toBe(true)
  expect(await proveYoloDesktop(desktop.fence)).toBe(false)
})

it('rejects replay of a formerly valid signature against the next fresh challenge', async () => {
  const desktop = await runtime()
  let captured = ''
  const relay = await proxy((socket) => socket.once('data', (data) => {
    const response = captured === '' ? signature(desktop.fence.proofEndpoint, data.toString()) : Promise.resolve(captured)
    void response.then((frame) => { captured = frame; socket.end(frame) }, () => socket.destroy())
  }))
  const pinned = { ...desktop.fence, proofEndpoint: relay.endpoint }
  writeFileSync(pinned.path, JSON.stringify(pinned))
  expect(await proveYoloDesktop(pinned)).toBe(true)
  expect(await proveYoloDesktop(pinned)).toBe(false)
})

it('rejects a forged or oversized response instead of granting persisted eligibility', async () => {
  const desktop = await runtime()
  const falseSigner = await proxy((socket) => socket.once('data', () => socket.end(`${'0'.repeat(128)}\n`)))
  const pinned = { ...desktop.fence, proofEndpoint: falseSigner.endpoint }
  writeFileSync(pinned.path, JSON.stringify(pinned))
  expect(await proveYoloDesktop(pinned)).toBe(false)
  const oversized = await proxy((socket) => socket.once('data', () => socket.end('0'.repeat(130))))
  const oversizedFence = { ...pinned, proofEndpoint: oversized.endpoint }
  writeFileSync(pinned.path, JSON.stringify(oversizedFence))
  expect(await proveYoloDesktop(oversizedFence)).toBe(false)
})
