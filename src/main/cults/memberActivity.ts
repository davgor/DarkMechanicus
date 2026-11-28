/**
 * Each live cult member's activity, as structured data for the run snapshots (`docs/design/cults.md` section 8): whether
 * it is working, and its last tool call with a reduced target. Main never writes prose; the renderer phrases it.
 *
 * - Working or idle comes from the private `cult-status.json` beside the member's `cult-control.json` when the extension
 *   wrote one; otherwise from the member's OMP session JSONL (the newest assistant message ending its turn is idle).
 * - The last tool call is the newest assistant `toolCall` block of the session JSONL. Its target is reduced from the
 *   input (a file tool's last two path segments, a shell command's first 40 characters, a search tool's pattern), with
 *   control characters stripped and capped at 80 characters; the raw input never passes through.
 * - Only a tracked member's own files are read: the paths come from its chat id alone. Polling runs on the supervisor's
 *   clock once per `ACTIVITY_THROTTLE_MS`, so each member publishes at most one update per 2 s; it stops when the last
 *   tracked member of every run is dropped. Every read opens and closes its file synchronously: no handle stays open.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { MemberActivity } from '../../shared/cults/cultApi'
import { ompFilePaths } from '../terminals/ompSession'
import type { SupervisorClock } from './runTimer'

/** At most one published update per member per this many milliseconds. */
export const ACTIVITY_THROTTLE_MS = 2000
const TARGET_MAX = 80
const SHELL_PREFIX = 40
/** How much of a session file's end is read: enough for the last few entries, never the whole transcript. */
const TAIL_BYTES = 64 * 1024
const SESSION_FILE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f-]+\.jsonl$/i
const STATUS_FILE = 'cult-status.json'
const IDLE_STOPS = new Set(['stop', 'aborted', 'error'])
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'multiedit', 'notebook_edit', 'notebook', 'view', 'create', 'delete', 'ls'])
const SHELL_TOOLS = new Set(['bash', 'shell', 'exec', 'sh', 'powershell', 'cmd', 'terminal', 'python', 'eval'])
const SEARCH_TOOLS = new Set(['grep', 'glob', 'find', 'search', 'rg', 'ast_grep', 'web_search'])
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/** The files the tracker reads; injectable so tests can see every path it touches. */
export interface ActivityFiles {
  list(dir: string): string[]
  /** The file's last `TAIL_BYTES` as text, or null when it is missing. */
  tail(path: string): string | null
}

export interface MemberActivityTracker {
  track(runId: string, chatId: string): void
  /** The member left: its activity is dropped and never read again. */
  untrack(chatId: string): void
  /** The run ended: every member of it is dropped; with nothing tracked, the poll stops. */
  endRun(runId: string): void
  of(chatId: string): MemberActivity | null
  /** Called with the run whose member's published activity changed. */
  onChange(listener: (runId: string) => void): () => void
  /** Stops all tracking and the poll. */
  dispose(): void
  /** Whether the poll timer is armed (for tests and quit checks). */
  polling(): boolean
}

interface Options {
  userData: string
  clock: Pick<SupervisorClock, 'after' | 'now'>
  files?: ActivityFiles
}

interface Tracked {
  runId: string
  activity: MemberActivity | null
  publishedAt: number
}

type Json = Record<string, unknown>

const clean = (text: string, max: number): string => text.replace(CONTROLS, '').trim().slice(0, max)
const record = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

function lastSegments(path: string): string {
  return path.split(/[\\/]+/).filter((part) => part !== '').slice(-2).join('/')
}

/** A tool input reduced to what the bubble may show; anything else gives an empty target. */
export function reduceTarget(name: string, input: unknown): string {
  const args = record(input)
  const tool = name.toLowerCase()
  if (FILE_TOOLS.has(tool)) return clean(lastSegments(text(args.path ?? args.file_path ?? args.filePath ?? args.notebook_path)), TARGET_MAX)
  if (SHELL_TOOLS.has(tool)) return clean(text(args.command ?? args.cmd ?? args.code).replace(CONTROLS, ' ').trim().slice(0, SHELL_PREFIX), TARGET_MAX)
  if (SEARCH_TOOLS.has(tool)) return clean(text(args.pattern ?? args.query), TARGET_MAX)
  return ''
}

interface Reading {
  working: boolean
  tool: MemberActivity['tool']
}

function readEntry(line: string): Json | null {
  try {
    return record(JSON.parse(line))
  } catch {
    return null
  }
}

/** Folds one session entry into the reading: a user or tool result means a turn is under way. */
function fold(reading: Reading, entry: Json): Reading {
  if (entry.type !== 'message') return reading
  const message = record(entry.message)
  if (message.role !== 'assistant') return message.role === 'user' || message.role === 'toolResult' ? { ...reading, working: true } : reading
  const calls = (Array.isArray(message.content) ? message.content : []).map(record).filter((block) => block.type === 'toolCall')
  const call = calls[calls.length - 1]
  const tool = call === undefined ? reading.tool : { name: clean(text(call.name).toLowerCase(), TARGET_MAX), target: reduceTarget(text(call.name), call.arguments) }
  return { tool, working: !IDLE_STOPS.has(text(message.stopReason)) }
}

/** What the session JSONL tail says; the first line is dropped when the tail cut it. */
function readTranscript(tail: string, whole: boolean): Reading {
  const lines = tail.split('\n')
  if (!whole) lines.shift()
  return lines.map(readEntry).reduce<Reading>((reading, entry) => (entry === null ? reading : fold(reading, entry)), { working: false, tool: null })
}

function statusWorking(files: ActivityFiles, dir: string): boolean | null {
  const raw = files.tail(join(dir, STATUS_FILE))
  const state = raw === null ? undefined : readEntry(raw)?.state
  return state === 'working' ? true : state === 'idle' ? false : null
}

function readMember(files: ActivityFiles, userData: string, chatId: string): Reading | null {
  const { sessionDir, config } = ompFilePaths(userData, chatId)
  const newest = files.list(sessionDir).filter((name) => SESSION_FILE.test(name)).sort().pop()
  const tail = newest === undefined ? null : files.tail(join(sessionDir, newest))
  const fromTranscript = tail === null ? { working: false, tool: null } : readTranscript(tail, tail.length < TAIL_BYTES)
  const status = statusWorking(files, dirname(config))
  if (tail === null && status === null) return null
  return { tool: fromTranscript.tool, working: status ?? fromTranscript.working }
}

const sameReading = (a: MemberActivity | null, b: Reading): boolean =>
  a !== null && a.working === b.working && a.tool?.name === b.tool?.name && a.tool?.target === b.tool?.target

function tailOf(path: string): string | null {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const size = statSync(path).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const diskFiles: ActivityFiles = {
  list: (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
  tail: tailOf
}

interface TrackerState {
  options: Options
  files: ActivityFiles
  members: Map<string, Tracked>
  listeners: Set<(runId: string) => void>
  cancel: (() => void) | null
}

/** Reads one member and publishes a change unless the member published within the throttle window. */
function refresh(t: TrackerState, chatId: string, entry: Tracked, changed: Set<string>): void {
  const reading = readMember(t.files, t.options.userData, chatId)
  if (reading === null || sameReading(entry.activity, reading)) return
  const at = t.options.clock.now()
  const now = Date.parse(at)
  if (entry.activity !== null && now - entry.publishedAt < ACTIVITY_THROTTLE_MS) return
  entry.activity = { working: reading.working, tool: reading.tool, at }
  entry.publishedAt = now
  changed.add(entry.runId)
}

function poll(t: TrackerState): void {
  t.cancel = null
  const changed = new Set<string>()
  for (const [chatId, entry] of t.members) refresh(t, chatId, entry, changed)
  arm(t)
  for (const runId of changed) for (const listener of t.listeners) listener(runId)
}

function arm(t: TrackerState): void {
  if (t.cancel !== null || t.members.size === 0) return
  t.cancel = t.options.clock.after(() => poll(t), ACTIVITY_THROTTLE_MS)
}

function disarmWhenEmpty(t: TrackerState): void {
  if (t.members.size > 0 || t.cancel === null) return
  t.cancel()
  t.cancel = null
}

export function createMemberActivity(options: Options): MemberActivityTracker {
  const t: TrackerState = { options, files: options.files ?? diskFiles, members: new Map(), listeners: new Set(), cancel: null }
  return {
    track: (runId, chatId) => {
      if (!t.members.has(chatId)) t.members.set(chatId, { runId, activity: null, publishedAt: Number.NEGATIVE_INFINITY })
      arm(t)
    },
    untrack: (chatId) => {
      t.members.delete(chatId)
      disarmWhenEmpty(t)
    },
    endRun: (runId) => {
      for (const [chatId, entry] of t.members) if (entry.runId === runId) t.members.delete(chatId)
      disarmWhenEmpty(t)
    },
    of: (chatId) => t.members.get(chatId)?.activity ?? null,
    onChange: (listener) => {
      t.listeners.add(listener)
      return () => {
        t.listeners.delete(listener)
      }
    },
    dispose: () => {
      t.members.clear()
      t.listeners.clear()
      disarmWhenEmpty(t)
    },
    polling: () => t.cancel !== null
  }
}
