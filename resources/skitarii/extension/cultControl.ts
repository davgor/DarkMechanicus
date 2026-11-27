/**
 * The cult control watcher: the main session polls `cult-control.json`, which main writes beside
 * `context-outbox.json`, and applies each new action once, in order. Only fixed templates are rendered; from the file
 * only the validated integer `granted` and the JSON-quoted absolute `folder`/`tokenFile` reach the agent.
 *
 * Main stamps the file with the `epoch` of the launch it wrote for: the launch generation that names this process's
 * client descriptor. A file of another launch is ignored, so a restarted member never re-applies an earlier launch's
 * actions; within one launch the applied cursor outlives a session restart.
 *
 * Like the rest of the extension, this file imports nothing from OMP or npm.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { DM_CLIENT_DESCRIPTOR_ENV } from './dmClient'
import type { Timers } from './skitarii'

export const CULT_CONTROL_FILE = 'cult-control.json'
export const CULT_CONTROL_TYPE = 'dm-cult-control'
export const CULT_CONTROL_POLL_MS = 1_000
const MAX_TEXT = 64 * 1024
const MAX_ENTRIES = 32
const MAX_PATH = 4096

export type CultControlAction = 'interrupt' | 'resume' | 'wind_down' | 'conclude' | 'shutdown' | 'petition'
type CultPetitionKind = 'acolytes' | 'allow_save' | 'folder_access'

export interface CultPetition {
  kind: CultPetitionKind
  approved: boolean
  granted?: number
  folder?: string
  tokenFile?: string
}

interface CultControlEntry {
  seq: number
  action: CultControlAction
  petition?: CultPetition
}

const ACTIONS: readonly string[] = ['interrupt', 'resume', 'wind_down', 'conclude', 'shutdown', 'petition']
const KINDS: readonly string[] = ['acolytes', 'allow_save', 'folder_access']

function fail(why: string): never {
  throw new Error(`invalid cult control: ${why}`)
}

function record(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${what} is not an object`)
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${what} has unknown key ${key}`)
  return value as Record<string, unknown>
}

function path(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > MAX_PATH || !isAbsolute(value)) fail(`${what} is not an absolute path`)
  return value
}

function parsePetition(value: unknown): CultPetition {
  const p = record(value, ['kind', 'approved', 'granted', 'folder', 'tokenFile'], 'petition')
  if (typeof p.kind !== 'string' || !KINDS.includes(p.kind)) fail('unknown petition kind')
  if (typeof p.approved !== 'boolean') fail('petition approved is not a boolean')
  const petition: CultPetition = { kind: p.kind as CultPetitionKind, approved: p.approved }
  if (p.granted !== undefined) {
    if (!Number.isInteger(p.granted) || (p.granted as number) < 1 || (p.granted as number) > 24) fail('granted out of range')
    petition.granted = p.granted as number
  }
  const folder = path(p.folder, 'folder')
  const tokenFile = path(p.tokenFile, 'tokenFile')
  if (folder !== undefined) petition.folder = folder
  if (tokenFile !== undefined) petition.tokenFile = tokenFile
  return petition
}

function parseEntry(value: unknown, previous: number): CultControlEntry {
  const e = record(value, ['seq', 'action', 'petition'], 'entry')
  if (!Number.isInteger(e.seq) || (e.seq as number) < 1 || (e.seq as number) <= previous) fail('bad seq')
  if (typeof e.action !== 'string' || !ACTIONS.includes(e.action)) fail('unknown action')
  const entry: CultControlEntry = { seq: e.seq as number, action: e.action as CultControlAction }
  if ((e.action === 'petition') !== (e.petition !== undefined)) fail('petition field mismatch')
  if (e.petition !== undefined) entry.petition = parsePetition(e.petition)
  return entry
}

function parseHeader(value: unknown, chatId: string, epoch: string): unknown[] {
  const doc = record(value, ['version', 'chatId', 'epoch', 'actions'], 'file')
  if (doc.version !== 1) fail('wrong version')
  if (doc.chatId !== chatId) fail('chatId mismatch')
  if (doc.epoch !== epoch) fail('epoch mismatch')
  if (!Array.isArray(doc.actions) || doc.actions.length > MAX_ENTRIES) fail('bad actions')
  return doc.actions
}

/** Parses and validates the control file for `chatId`'s launch `epoch`; throws on anything malformed or foreign. */
export function parseCultControl(text: string, chatId: string, epoch: string): CultControlEntry[] {
  if (text.length > MAX_TEXT) fail('too large')
  const actions = parseHeader(JSON.parse(text), chatId, epoch)
  const entries: CultControlEntry[] = []
  for (const value of actions) entries.push(parseEntry(value, entries.at(-1)?.seq ?? 0))
  return entries
}

const PREFIX = '[Dark Mechanicus desktop] '
const PERSON = `${PREFIX}The person `
const PAUSED = `${PERSON}paused this cult. Stop and wait; you will be told when it resumes.`
const RESUMED = `${PERSON}resumed this cult. Continue your current task.`
const WIND_DOWN = `${PREFIX}This cult run is ending. Order every acolyte to conclude now, then write the chronicle and conclude the run within the times your cult rules give.`
const CONCLUDE = `${PREFIX}This cult run is ending. Finish now, send your final report and conclude within the time your cult rules give.`

/** The fixed sentence for a petition decision. */
function petitionText(p: CultPetition): string {
  if (!p.approved) return `${PERSON}denied your petition (${p.kind}).`
  if (p.kind === 'acolytes') return `${PERSON}approved your petition: the cap rose by ${p.granted ?? 0} acolytes.`
  if (p.kind === 'allow_save') return `${PERSON}approved your petition to save: Allow save is on for this run.`
  return `${PERSON}approved your petition for folder access: run dm --repo ${JSON.stringify(p.folder ?? '')} --token-file ${JSON.stringify(p.tokenFile ?? '')} <command> to act in that folder for this run.`
}

/** The last applied seq of one launch, shared by the watchers of its sessions. */
interface CultControlCursor {
  lastApplied: number
}

interface CultControlDeps {
  readFile: (path: string) => Promise<string>
  timers: Timers
  path: string
  chatId: string
  /** This launch's generation: the only `epoch` a file it applies may carry. */
  epoch: string
  /** Where the applied seq is kept; the watcher's own when absent. */
  cursor?: CultControlCursor
  abort: () => void
  shutdown: () => void
  send: (content: string, triggerTurn: boolean) => void
}

export class CultControlWatcher {
  #handle: unknown = null
  #running = false
  readonly #cursor: CultControlCursor

  constructor(private readonly deps: CultControlDeps) {
    this.#cursor = deps.cursor ?? { lastApplied: 0 }
  }

  start(): void {
    if (this.#handle !== null) return
    this.#handle = this.deps.timers.setInterval(() => void this.tick(), CULT_CONTROL_POLL_MS)
  }

  stop(): void {
    if (this.#handle !== null) this.deps.timers.clearInterval(this.#handle)
    this.#handle = null
  }

  /** One poll; overlapping polls are skipped. */
  async tick(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      const entries = await this.#read()
      for (const entry of entries) {
        if (entry.seq <= this.#cursor.lastApplied) continue
        this.#cursor.lastApplied = entry.seq
        this.#apply(entry)
      }
    } finally {
      this.#running = false
    }
  }

  async #read(): Promise<CultControlEntry[]> {
    try {
      return parseCultControl(await this.deps.readFile(this.deps.path), this.deps.chatId, this.deps.epoch)
    } catch {
      return []
    }
  }

  #apply(entry: CultControlEntry): void {
    const { deps } = this
    if (entry.action === 'interrupt') {
      deps.abort()
      deps.send(PAUSED, false)
    } else if (entry.action === 'resume') deps.send(RESUMED, true)
    else if (entry.action === 'wind_down') deps.send(WIND_DOWN, true)
    else if (entry.action === 'conclude') deps.send(CONCLUDE, true)
    else if (entry.action === 'shutdown') {
      // A busy turn is interrupted first, so the close does not wait for it (`docs/design/cults.md`, section 3).
      this.stop()
      deps.abort()
      deps.shutdown()
    } else if (entry.petition !== undefined) deps.send(petitionText(entry.petition), true)
  }
}

export interface CultControlContext {
  agent?: { kind?: string }
  abort?(): void
  shutdown?(): void
}

export interface CultControlApi {
  on: (event: string, handler: (event: unknown, ctx: CultControlContext) => unknown) => void
  sendMessage?: (
    message: { customType: string; content: string; display: boolean },
    options: { deliverAs: 'aside'; triggerTurn: boolean }
  ) => Promise<void> | undefined
}

/** Starts the watcher in the main session of a chat with a descriptor; stops it when the session ends. */
export function attachCultControl(pi: CultControlApi, timers: Timers, env: Record<string, string | undefined>): void {
  const descriptor = env[DM_CLIENT_DESCRIPTOR_ENV]
  if (descriptor === undefined || !isAbsolute(descriptor) || !descriptor.endsWith('.json')) return
  const dir = dirname(dirname(descriptor))
  const epoch = basename(descriptor, '.json')
  const cursor: CultControlCursor = { lastApplied: 0 }
  let watcher: CultControlWatcher | null = null
  pi.on('session_start', (_event, ctx) => {
    if (ctx.agent?.kind !== 'main' || watcher !== null) return
    watcher = new CultControlWatcher({
      readFile: (file) => readFile(file, 'utf8'),
      timers,
      path: join(dir, CULT_CONTROL_FILE),
      chatId: basename(dir),
      epoch,
      cursor,
      abort: () => ctx.abort?.(),
      shutdown: () => ctx.shutdown?.(),
      send: (content, triggerTurn) =>
        void pi.sendMessage?.({ customType: CULT_CONTROL_TYPE, content, display: true }, { deliverAs: 'aside', triggerTurn })?.catch?.(() => {})
    })
    watcher.start()
  })
  pi.on('session_shutdown', () => {
    watcher?.stop()
    watcher = null
  })
}
