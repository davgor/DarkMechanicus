/**
 * Restart resume: when the person presses Restart now to install an update, the run-bound orchestrator chats (each
 * run's Magos) that are live at that moment are listed in a marker beside the chat store. The next start consumes the
 * marker once and, only when the app's version went up, sends each chat that still qualifies one fixed message on its
 * same session (the GUI manager's lazy `--resume`). A legacy terminal Magos is first switched to the GUI, which never
 * stops a terminal: a live one refuses the switch. Nothing here throws at startup; every skip and failure is logged.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ChatRecord } from '../../shared/agents/chat'
import type { ChatRef, ChatStore } from '../agents/chatStore'
import type { AgentChatSessions } from './agentChatSessions'

const SEMVER = /^\d+\.\d+\.\d+$/

/** A marker older than this is ignored: the restart did not follow the install it was written for. */
const MARKER_MAX_AGE_MS = 15 * 60 * 1000
/** A marker dated further ahead than this clock skew is ignored: it was not written by the install just before this start. */
const MARKER_MAX_FUTURE_MS = 60 * 1000
const MARKER_MAX_CHATS = 20

const restartMarkerSchema = z.strictObject({
  fromVersion: z.string().regex(SEMVER),
  writtenAt: z.iso.datetime(),
  chats: z.array(z.strictObject({ folder: z.string().min(1), chatId: z.string().min(1) })).max(MARKER_MAX_CHATS)
})
export type RestartMarker = z.infer<typeof restartMarkerSchema>

export function writeRestartMarker(file: string, marker: RestartMarker): void {
  const valid = restartMarkerSchema.parse(marker)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(valid))
}

/**
 * Reads and deletes the marker: it is consumed at most once. Null when it is missing, malformed, older than 15 minutes,
 * dated more than 1 minute in the future or cannot be deleted (a marker left behind would resume the chats again at the
 * next start).
 */
export function takeRestartMarker(file: string, now: number): RestartMarker | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    rmSync(file, { force: true })
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const marker = restartMarkerSchema.safeParse(parsed)
  if (!marker.success) return null
  const age = now - Date.parse(marker.data.writtenAt)
  return age > MARKER_MAX_AGE_MS || age < -MARKER_MAX_FUTURE_MS ? null : marker.data
}

/** The one fixed message a resumed chat receives; only the two versions vary, and both must be `x.y.z`. */
export function restartResumeText(from: string, to: string): string {
  if (!SEMVER.test(from) || !SEMVER.test(to)) throw new Error('Restart resume versions must be x.y.z.')
  return `[App restarted after an update from v${from} to v${to}: resume your run from get_run]`
}

/** Orders two `x.y.z` versions numerically: negative when `a` is older, 0 when equal, positive when newer. */
export function compareVersions(a: string, b: string): number {
  if (!SEMVER.test(a) || !SEMVER.test(b)) throw new Error('Versions must be x.y.z.')
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    const difference = left[index] - right[index]
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

/** A run's Magos: an orchestrator chat Dark Mechanicus started for a run. New, Kanban, transfer and conversation chats have no run. */
function isRunOrchestrator(chat: ChatRecord): chat is ChatRecord & { runId: string } {
  return chat.role === 'orchestrator' && chat.runId !== undefined
}

interface RestartLog {
  info(message: string): void
  warn(message: string, error?: unknown): void
}

interface MarkerHookDeps {
  file: string
  version: () => string
  now: () => Date
  /** The tracked folders' canonical paths. */
  folders: () => string[]
  store: Pick<ChatStore, 'listChats'>
  /** Whether the chat's process runs now, in the GUI or in a terminal. */
  live: (ref: ChatRef) => boolean
  log: RestartLog
}

/** The live run-bound orchestrator chats of one folder; a folder whose chats cannot be listed contributes none. */
function liveOrchestrators(deps: MarkerHookDeps, folder: string): RestartMarker['chats'] {
  try {
    return deps.store.listChats(folder).flatMap(chat =>
      chat.folder !== null && isRunOrchestrator(chat) && deps.live(chat) ? [{ folder: chat.folder, chatId: chat.id }] : [])
  } catch (error) {
    deps.log.warn(`Restart resume could not list the chats of ${folder}:`, error)
    return []
  }
}

/**
 * The Restart now hook (`setBeforeInstall`): writes the marker of every live run-bound orchestrator chat, GUI or
 * legacy terminal, synchronously before the installer quits the app. A plain quit never calls it.
 */
export function restartMarkerHook(deps: MarkerHookDeps): () => void {
  return () => {
    const chats = deps.folders().flatMap(folder => liveOrchestrators(deps, folder))
    const listed = chats.slice(0, MARKER_MAX_CHATS)
    if (listed.length < chats.length) deps.log.warn(`Restart resume lists only ${listed.length} of ${chats.length} live orchestrator chats.`)
    writeRestartMarker(deps.file, { fromVersion: deps.version(), writtenAt: deps.now().toISOString(), chats: listed })
    deps.log.info(`Restart resume marker written for ${listed.length} orchestrator chat(s).`)
  }
}

interface ResumeDeps {
  file: string
  version: string
  now: number
  /** The canonical tracked path, or null when the folder is no longer tracked. */
  trackedFolder: (folder: string) => string | null
  store: Pick<ChatStore, 'getChat'>
  /** Whether the run is still in an active state in its folder. */
  runActive: (folder: string, runId: string) => Promise<boolean>
  sessions: Pick<AgentChatSessions, 'setSurface' | 'send'>
  log: RestartLog
}

/** The chat when it still qualifies (tracked, existing, a run's Magos, its run still active); otherwise why it is skipped. */
async function qualifying(deps: ResumeDeps, ref: ChatRef): Promise<ChatRecord | string> {
  if (ref.folder === null || deps.trackedFolder(ref.folder) === null) return 'its folder is no longer tracked'
  const chat = deps.store.getChat(ref)
  if (chat === null) return 'it no longer exists'
  if (!isRunOrchestrator(chat)) return 'it is not a run orchestrator'
  if (!await deps.runActive(ref.folder, chat.runId)) return 'its run is no longer active'
  return chat
}

async function resumeOne(deps: ResumeDeps, ref: ChatRef, text: string): Promise<void> {
  try {
    const chat = await qualifying(deps, ref)
    if (typeof chat === 'string') {
      deps.log.warn(`Restart resume skipped chat ${ref.id}: ${chat}.`)
      return
    }
    // A legacy terminal Magos switches first; with its terminal gone the switch needs no confirmation, and a live one refuses.
    if (chat.surface !== 'gui') await deps.sessions.setSurface(ref, 'gui')
    await deps.sessions.send(ref, { text })
    deps.log.info(`Restart resume sent chat ${ref.id} the restart message.`)
  } catch (error) {
    deps.log.warn(`Restart resume could not resume chat ${ref.id}:`, error)
  }
}

/**
 * Startup: consumes the marker synchronously, then, when the version went up, sends each listed chat that still
 * qualifies the fixed restart text once, one chat at a time. The returned promise never rejects.
 */
export function resumeAfterRestart(deps: ResumeDeps): Promise<void> {
  const marker = takeRestartMarker(deps.file, deps.now)
  if (marker === null) return Promise.resolve()
  if (!SEMVER.test(deps.version) || compareVersions(deps.version, marker.fromVersion) <= 0) {
    deps.log.info(`Restart resume: v${deps.version} is not newer than v${marker.fromVersion}; no chat is resumed.`)
    return Promise.resolve()
  }
  const text = restartResumeText(marker.fromVersion, deps.version)
  const seen = new Set<string>()
  const refs = marker.chats.flatMap(({ folder, chatId }) => {
    const key = `${folder}\n${chatId}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ folder, id: chatId }]
  })
  return refs.reduce((previous, ref) => previous.then(() => resumeOne(deps, ref, text)), Promise.resolve())
}
