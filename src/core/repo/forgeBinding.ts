import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { contentHash } from '../canonical'
import { fail } from '../errors'
import { dbProjectDir, projectKey } from './storageMode'
import type { FsAdapter } from './types'
import { FORGE_CONFIG, readForgeReference } from './forgeReference'
import { nodeFs } from './nodeFs'

export const FORGE_POINTER = 'FORGE-WORLD.md'
export interface ForgeTransferAuthority {
  source: string
  target: string
  lease: string
}
const moving = new AsyncLocalStorage<ForgeTransferAuthority & { pid: number }>()

export function currentForgeTransfer(): ForgeTransferAuthority | undefined {
  return moving.getStore()
}

/** The private workspace utility can act for the live desktop reservation for its exact endpoints. */
export function withForgeOwnerAuthority<T>(options: { home: string; ownerPid: number; path: string; authority?: ForgeTransferAuthority }, action: () => T): T {
  const { home, ownerPid, path, authority } = options
  if (authority === undefined || ![authority.source, authority.target, authority.target.replace(/[/\\](repo|db)$/, '')].includes(path)) return action()
  const reservation = { ...authority, pid: ownerPid }
  assertReservation(home, reservation)
  return moving.run(reservation, action)
}

function assertReservation(home: string, authority: ForgeTransferAuthority & { pid: number }): void {
  const file = stateFile(home, authority.source, 'move')
  if (!existsSync(file)) fail('conflict', 'The Forge conversion reservation ended.')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  if (state.pid !== authority.pid || state.target !== authority.target || state.lease !== authority.lease) fail('conflict', 'The Forge conversion reservation changed.')
}
const owners = new Set<string>()
function stateFile(home: string, source: string, kind: string) {
  return join(home, 'forge-bindings', projectKey(source) + '.' + kind + '.json')
}

export function isForgeMember(fs: FsAdapter, member: string): boolean {
  const file = join(dirname(member), 'forge-world.json')
  if (!fs.exists(file) || fs.isSymlink(file)) return false
  try {
    const data = JSON.parse(fs.readFile(file))
    return data.version === 1 && Array.isArray(data.projects) && data.projects.some((p: { folder?: string }) => p?.folder === basename(member))
  } catch { return false }
}

export function pendingForgeTransfer(home: string, source: string): string | null {
  const file = stateFile(home, source, 'move')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).target : null
}

export function pendingForgeForce(home: string, source: string): boolean {
  const file = stateFile(home, source, 'move')
  return existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).force === true
}

export function forgeBindingEpoch(fs: FsAdapter, home: string, source: string): string | null {
  const file = stateFile(home, source, 'link')
  return fs.exists(file) ? contentHash(fs.readFile(file)) : null
}

function forceReservations(fs: FsAdapter, home: string) {
  const dir = join(home, 'forge-bindings')
  if (!fs.exists(dir)) return []
  return fs.readdir(dir).filter(name => name.endsWith('.move.json')).flatMap(name => {
    const file = join(dir, name)
    const state = JSON.parse(fs.readFile(file))
    return state.force === true && typeof state.target === 'string' ? [{ file, target: state.target as string }] : []
  })
}

function ownsReservation(home: string, file: string): boolean {
  const active = moving.getStore()
  if (active === undefined || stateFile(home, active.source, 'move') !== file) return false
  assertReservation(home, active)
  return true
}

/** Survives app restart: ordinary background/manual sync cannot publish an unverified export. */
export function assertForgeWorldSyncAllowed(fs: FsAdapter, home: string, root: string): void {
  if (forceReservations(fs, home).some(reservation => dirname(reservation.target) === root && !ownsReservation(home, reservation.file))) {
    fail('conflict', 'Forge World conversion is pending. Resume Force migrate before syncing.')
  }
}

export function bindForge(home: string, source: string, member: string, note: string) {
  const config = join(source, FORGE_CONFIG)
  if (existsSync(config) || nodeFs.isSymlink(config)) readForgeReference(nodeFs, source)
  const file = stateFile(home, source, 'link')
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID()
  writeFileSync(temp, JSON.stringify({ member, note: contentHash(note), config: existsSync(config) ? contentHash(readFileSync(config, 'utf8')) : undefined, epoch: randomUUID() }), { flag: 'wx' })
  renameSync(temp, file)
  const local = join(member, '.darkmechanicus', 'local')
  if (existsSync(local) && realpathSync.native(local) === local) {
    const location = join(local, 'source-checkout.json')
    const draft = location + '.' + randomUUID()
    writeFileSync(draft, JSON.stringify({ checkout: source }) + '\n', { flag: 'wx' })
    renameSync(draft, location)
  }
}

function pointerHashes(fs: FsAdapter, source: string): { note: string; config: string | undefined } | null {
  const pointer = join(source, FORGE_POINTER)
  const config = join(source, FORGE_CONFIG)
  if (![pointer, config].some(file => fs.exists(file) || fs.isSymlink(file))) return null
  if (fs.exists(config) || fs.isSymlink(config)) readForgeReference(fs, source)
  if (fs.isSymlink(pointer)) fail('conflict', 'Open this code repository in Dark Mechanicus to retrieve its Forge World before using tickets.')
  return { note: contentHash(fs.exists(pointer) ? fs.readFile(pointer) : ''), config: fs.exists(config) ? contentHash(fs.readFile(config)) : undefined }
}

export function boundForgeRoot(fs: FsAdapter, home: string, source: string): string {
  const active = moving.getStore()
  if (active?.source === source) {
    assertReservation(home, active)
    return source
  }
  const hashes = pointerHashes(fs, source)
  if (hashes === null) return source
  const file = stateFile(home, source, 'link')
  if (fs.exists(file)) {
    const binding = JSON.parse(fs.readFile(file))
    if (binding.note === hashes.note && binding.config === hashes.config && typeof binding.member === 'string' &&
      fs.isDirectory(binding.member) && fs.realpath(binding.member) === binding.member) return binding.member
  }
  return fail('conflict', 'Open this code repository in Dark Mechanicus to retrieve its Forge World before using tickets.')
}

export function assertForgeTransferIdle(fs: FsAdapter, home: string, source: string): void {
  const active = moving.getStore()
  const ownsSource = active?.source === source
  if (ownsSource) assertReservation(home, active)
  else if (fs.exists(stateFile(home, source, 'move'))) {
    fail('conflict', 'Forge World conversion is pending. Resume it from Ticket source control.')
  }
  if (forceReservations(fs, home).some(reservation => reservation.target === source && !ownsReservation(home, reservation.file))) {
    fail('conflict', 'Forge World conversion is pending. Resume it before opening the destination.')
  }
  if (!ownsSource && isRetiredSource(fs, home, source)) fail('conflict', 'This ticket store moved to a Forge World. Reconnect before continuing.')
}

/** The storage fence every write transaction of a ticket store checks under the writer lock: its Forge binding is the one it opened with. */
export function assertForgeStorage(fs: FsAdapter, home: string, root: string, epoch: string | null): void {
  assertForgeTransferIdle(fs, home, root)
  if (forgeBindingEpoch(fs, home, root) !== epoch) fail('conflict', 'Ticket storage changed. Reconnect before continuing.')
  if (boundForgeRoot(fs, home, root) !== root) fail('conflict', 'Reconnect to the Forge World ticket store.')
}

function isRetiredSource(fs: FsAdapter, home: string, source: string): boolean {
  return [join(source, '.darkmechanicus'), dbProjectDir(source, home)]
    .some(store => fs.exists(join(store, 'local', 'forge-retired.json'))) && boundForgeRoot(fs, home, source) === source
}

function assertOwnerInactive(pid: number): void {
  if (pid === process.pid) return
  try { process.kill(pid, 0) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error }
  throw new Error('Another Dark Mechanicus process owns this conversion.')
}

export async function withForgeTransfer<T>(home: string, source: string, destination: string | { target: string; force: boolean }, action: (phase: number, advance: (n: number) => void) => Promise<T>) {
  const target = typeof destination === 'string' ? destination : destination.target
  const force = typeof destination === 'string' ? false : destination.force
  const file = stateFile(home, source, 'move')
  if (owners.has(file)) throw new Error('This conversion is already running.')
  mkdirSync(dirname(file), { recursive: true })
  let phase = 0
  const lease = randomUUID()
  if (existsSync(file)) {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    if (state.target !== target) throw new Error('Resume the pending conversion to ' + state.target)
    if ((state.force === true) !== force) throw new Error('Resume the pending conversion with the same migration option.')
    assertOwnerInactive(state.pid)
    phase = state.phase
  } else {
    writeFileSync(file, JSON.stringify({ pid: process.pid, target, lease, phase, force }), { flag: 'wx' })
  }
  function advance(n: number) {
    const temp = file + '.' + randomUUID()
    writeFileSync(temp, JSON.stringify({ pid: process.pid, target, lease, phase: n, force }), { flag: 'wx' })
    renameSync(temp, file)
    phase = n
  }
  owners.add(file)
  try {
    advance(phase)
    const result = await moving.run({ source, target, lease, pid: process.pid }, () => action(phase, advance))
    unlinkSync(file)
    return result
  } catch (error) {
    if (phase === 0 && existsSync(file)) unlinkSync(file)
    throw error
  } finally { owners.delete(file) }
}
