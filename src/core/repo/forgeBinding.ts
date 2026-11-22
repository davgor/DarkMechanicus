import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { contentHash } from '../canonical'
import { fail } from '../errors'
import { dbProjectDir, projectKey } from './storageMode'
import type { FsAdapter } from './types'

export const FORGE_POINTER = 'FORGE-WORLD.md'
const moving = new AsyncLocalStorage<string>()
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

export function bindForge(home: string, source: string, member: string, note: string) {
  const file = stateFile(home, source, 'link')
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID()
  writeFileSync(temp, JSON.stringify({ member, note: contentHash(note), epoch: randomUUID() }), { flag: 'wx' })
  renameSync(temp, file)
  const local = join(member, '.darkmechanicus', 'local')
  if (existsSync(local) && realpathSync.native(local) === local) {
    const location = join(local, 'source-checkout.json')
    const draft = location + '.' + randomUUID()
    writeFileSync(draft, JSON.stringify({ checkout: source }) + '\n', { flag: 'wx' })
    renameSync(draft, location)
  }
}

export function boundForgeRoot(fs: FsAdapter, home: string, source: string): string {
  const pointer = join(source, FORGE_POINTER)
  if (!fs.exists(pointer) || moving.getStore() === source) return source
  const file = stateFile(home, source, 'link')
  if (fs.exists(file) && !fs.isSymlink(pointer)) {
    const binding = JSON.parse(fs.readFile(file))
    if (binding.note === contentHash(fs.readFile(pointer)) && typeof binding.member === 'string' &&
      fs.isDirectory(binding.member) && fs.realpath(binding.member) === binding.member) return binding.member
  }
  return fail('conflict', 'Open this code repository in Dark Mechanicus to retrieve its Forge World before using tickets.')
}

export function assertForgeTransferIdle(fs: FsAdapter, home: string, source: string): void {
  if (moving.getStore() !== source && fs.exists(stateFile(home, source, 'move'))) {
    fail('conflict', 'Forge World conversion is pending. Resume it from Ticket source control.')
  }
  if (moving.getStore() !== source && [join(source, '.darkmechanicus'), dbProjectDir(source, home)]
    .some(store => fs.exists(join(store, 'local', 'forge-retired.json'))) && boundForgeRoot(fs, home, source) === source) {
    fail('conflict', 'This ticket store moved to a Forge World. Reconnect before continuing.')
  }
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
  if (existsSync(file)) {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    if (state.target !== target) throw new Error('Resume the pending conversion to ' + state.target)
    if ((state.force === true) !== force) throw new Error('Resume the pending conversion with the same migration option.')
    assertOwnerInactive(state.pid)
    phase = state.phase
  } else {
    writeFileSync(file, JSON.stringify({ pid: process.pid, target, phase, force }), { flag: 'wx' })
  }
  function advance(n: number) {
    const temp = file + '.' + randomUUID()
    writeFileSync(temp, JSON.stringify({ pid: process.pid, target, phase: n, force }), { flag: 'wx' })
    renameSync(temp, file)
    phase = n
  }
  owners.add(file)
  try {
    advance(phase)
    const result = await moving.run(source, () => action(phase, advance))
    unlinkSync(file)
    return result
  } catch (error) {
    if (phase === 0 && existsSync(file)) unlinkSync(file)
    throw error
  } finally { owners.delete(file) }
}
