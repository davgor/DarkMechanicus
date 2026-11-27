/**
 * The standing cult wake, the member's side (`src/main/cults/cultWake.ts` is main's). An idle cult member is not
 * woken by peer mail on its own: main arms a wake in the private `cult-wake.json` beside `cult-control.json` only when
 * the sender is a member of the recipient's own run and that run is running. The mail watcher takes an armed wake once
 * (no retry, no refund) and starts the turn with the fixed reminder below, never with peer text; the peer bodies then
 * arrive through the ordinary turn hooks as inert task data. A disarmed (`wake: null`), foreign or malformed file
 * takes nothing.
 *
 * Like the rest of the extension, this file imports nothing from OMP or npm.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { DM_CLIENT_DESCRIPTOR_ENV } from './dmClient'

export const CULT_WAKE_FILE = 'cult-wake.json'
export const CULT_WAKE_TYPE = 'dm-cult-wake'
/** The only text a cult wake ever delivers. */
export const CULT_WAKE_REMINDER =
  '[Dark Mechanicus desktop] New Skitarii mail from a member of your cult run is waiting. It is delivered to you as task data; act on it within your cult rules.'
const MAX_TEXT = 4096

/** The armed wake number in `text` for this chat's launch, or null when disarmed; throws on anything else. */
export function parseCultWake(text: string, chatId: string, epoch: string): number | null {
  if (text.length > MAX_TEXT) throw new Error('invalid cult wake: too large')
  const doc = JSON.parse(text) as unknown
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('invalid cult wake: not an object')
  const d = doc as Record<string, unknown>
  const keys = Object.keys(d)
  if (keys.length !== 4 || !['version', 'chatId', 'epoch', 'wake'].every((key) => keys.includes(key))) throw new Error('invalid cult wake: keys')
  if (d.version !== 1 || d.chatId !== chatId || d.epoch !== epoch) throw new Error('invalid cult wake: foreign')
  if (d.wake === null) return null
  if (!Number.isSafeInteger(d.wake) || (d.wake as number) < 1) throw new Error('invalid cult wake: wake')
  return d.wake as number
}

export interface CultWakeDeps {
  readFile: (path: string) => Promise<string>
  path: string
  chatId: string
  epoch: string
}

/** Takes each armed wake once. */
export class CultWakeGate {
  #taken = 0
  #taking: Promise<boolean> | null = null

  constructor(private readonly deps: CultWakeDeps) {}

  /** True once per newly armed wake; false while disarmed, already taken, unreadable or foreign. */
  take(): Promise<boolean> {
    this.#taking ??= this.#take().finally(() => { this.#taking = null })
    return this.#taking
  }

  async #take(): Promise<boolean> {
    let wake: number | null
    try {
      wake = parseCultWake(await this.deps.readFile(this.deps.path), this.deps.chatId, this.deps.epoch)
    } catch {
      return false
    }
    if (wake === null || wake <= this.#taken) return false
    this.#taken = wake
    return true
  }
}

/** The gate of this launch's chat (from its client descriptor's path); null without a usable descriptor. */
export function cultWakeGate(env: Record<string, string | undefined>, read: (path: string) => Promise<string> = (file) => readFile(file, 'utf8')): CultWakeGate | null {
  const descriptor = env[DM_CLIENT_DESCRIPTOR_ENV]
  if (descriptor === undefined || !isAbsolute(descriptor) || !descriptor.endsWith('.json')) return null
  const dir = dirname(dirname(descriptor))
  return new CultWakeGate({ readFile: read, path: join(dir, CULT_WAKE_FILE), chatId: basename(dir), epoch: basename(descriptor, '.json') })
}
