import { generateKeyPairSync, randomBytes, randomUUID, sign, verify, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface DesktopFence {
  path: string
  instance: string
  pid: number
  proofEndpoint: string
  proofPublicKey: string
}

interface DesktopRuntime {
  fence: DesktopFence
  ready: Promise<void>
  dispose(): Promise<void>
}

const DOMAIN = 'DarkMechanicus.YOLO.desktop-instance.v1\0'
const SOCKET_LIFETIME_MS = 1_000
const NONCE_FRAME_BYTES = 65
const SIGNATURE_FRAME_BYTES = 129

function serveChallenge(socket: Socket, privateKey: KeyObject): void {
  let frame = ''
  const lifetime = setTimeout(() => socket.destroy(), SOCKET_LIFETIME_MS)
  socket.once('close', () => clearTimeout(lifetime))
  socket.on('error', () => socket.destroy())
  socket.on('data', (data: Buffer) => {
    if (Buffer.byteLength(frame) + data.length > NONCE_FRAME_BYTES) { socket.destroy(); return }
    frame += data.toString('utf8')
    if (!frame.includes('\n')) return
    if (!/^[0-9a-f]{64}\n$/.test(frame)) { socket.destroy(); return }
    const signature = sign(null, Buffer.from(DOMAIN + frame.slice(0, -1)), privateKey)
    socket.end(`${signature.toString('hex')}\n`)
  })
}

/** Main rotates the fence before any folder opens. The private key never leaves this closure or reaches disk. */
export function createYoloDesktopRuntime(path: string): DesktopRuntime {
  const keys = generateKeyPairSync('ed25519')
  const instance = randomUUID()
  const directory = process.platform === 'win32' ? null : mkdtempSync(join(tmpdir(), 'dm-y-'))
  const proofEndpoint = directory === null ? `\\\\.\\pipe\\dm-yolo-${instance}` : join(directory, 'p')
  const fence = { path, instance, pid: process.pid, proofEndpoint, proofPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  writeFileSync(path, JSON.stringify(fence), { mode: 0o600 })
  const clients = new Set<Socket>()
  const server = createServer((socket) => {
    clients.add(socket)
    socket.once('close', () => clients.delete(socket))
    serveChallenge(socket, keys.privateKey)
  })
  const ready = new Promise<void>((resolve, reject) => {
    server.on('error', reject)
    server.listen(proofEndpoint, () => { server.unref(); resolve() })
  })
  return { fence, ready, dispose: async () => {
    for (const client of clients) client.destroy()
    await ready.catch(() => {})
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (directory !== null) rmSync(directory, { recursive: true, force: true })
  } }
}

/** This is an eligibility check, never a substitute for a fresh signed challenge at command admission. */
export function isYoloDesktopLive(fence: DesktopFence): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(fence.path, 'utf8'))
    if (value === null || typeof value !== 'object') return false
    const current = value as Record<string, unknown>
    if (current['instance'] !== fence.instance || current['pid'] !== fence.pid || current['proofEndpoint'] !== fence.proofEndpoint || current['proofPublicKey'] !== fence.proofPublicKey) return false
    process.kill(fence.pid, 0)
    return true
  } catch {
    return false
  }
}

function validSignature(frame: string, nonce: string, publicKey: string): boolean {
  if (!/^[0-9a-f]{128}\n$/.test(frame)) return false
  try { return verify(null, Buffer.from(DOMAIN + nonce), publicKey, Buffer.from(frame.slice(0, -1), 'hex')) }
  catch { return false }
}

function challengeDesktop(fence: DesktopFence): Promise<boolean> {
  const nonce = randomBytes(32).toString('hex')
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(fence.proofEndpoint)
    let frame = ''
    let settled = false
    const finish = (accepted: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(lifetime)
      socket.destroy()
      resolve(accepted)
    }
    const lifetime = setTimeout(() => finish(false), SOCKET_LIFETIME_MS)
    socket.once('error', () => finish(false))
    socket.once('close', () => finish(false))
    socket.once('connect', () => socket.write(`${nonce}\n`))
    socket.on('data', (data: Buffer) => {
      if (Buffer.byteLength(frame) + data.length > SIGNATURE_FRAME_BYTES) { finish(false); return }
      frame += data.toString('utf8')
      if (frame.includes('\n')) finish(validSignature(frame, nonce, fence.proofPublicKey))
    })
  })
}

/** The fresh nonce prevents replay, and the pinned public key proves the specific main instance, not a reused PID. */
export async function proveYoloDesktop(fence: DesktopFence): Promise<boolean> {
  if (!isYoloDesktopLive(fence)) return false
  return await challengeDesktop(fence) && isYoloDesktopLive(fence)
}
