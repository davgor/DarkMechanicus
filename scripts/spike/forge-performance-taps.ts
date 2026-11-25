/**
 * Timeline taps for the revamp matrix, installed in the profiler's Electron main before the built app loads. They only
 * observe: every desktop command IPC (`dm:command`) and every message to and from a production project utility keeps its
 * arguments, order and result. Recorded fields are command names, fixture paths, times and sizes.
 */
import { existsSync, readFileSync } from 'node:fs'
import { serialize } from 'node:v8'
import { ipcMain, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from 'electron'
import type { WorkspaceRequest, WorkspaceResponse } from '../../src/main/desktop/workspaceClient'
import { absoluteNow, type HoldRecord } from './forge-performance-sinks'

interface IpcRecord { path: string; name: string; recvAt: number; doneAt: number; bytes: number }
interface OwnerRecord { path: string; name: string; postAt: number; replyAt: number | null }

/** One window of renderer commands split into where their time went. */
export interface WindowSplit {
  calls: number
  /** Calls whose utility request was found; the rest were answered in main (or not yet posted). */
  matched: number
  /** Sum over calls of pool queue wait: IPC received in main until the request was posted to the utility. */
  queueWaitMs: number
  /** Sum over calls of utility time: post until reply, including the owner's two per-request `identity()` checks. */
  ownerRunMs: number
  /** Structured-clone bytes of every reply in the window. */
  payloadBytes: number
  /** First IPC received to last IPC answered. */
  ipcSpanMs: number
  /** When main answered the last call (epoch ms), or null when no call fell in the window. */
  lastDoneAt: number | null
  /** Utility work for the same project that was not one of these calls (heartbeat, reconcile, polls), by name. */
  otherWork: Record<string, number>
}

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const ipc: IpcRecord[] = []
const owner: OwnerRecord[] = []
let lastActivity = 0

/** The desktop's 15-second timers (`HEARTBEAT_INTERVAL_MS` pool heartbeat and the Forge tick). */
const fifteenSecondTimers: (() => void)[] = []
const FIFTEEN_SECONDS = 15_000
function tapCommand(handler: Handler): Handler {
  return async (event, ...args) => {
    const recvAt = absoluteNow()
    lastActivity = recvAt
    const result = await handler(event, ...args)
    const doneAt = absoluteNow()
    lastActivity = doneAt
    // Structured-clone size of the reply, as Electron sends it.
    ipc.push({ path: String(args[0]), name: String(args[1]), recvAt, doneAt, bytes: serialize(result).byteLength })
    return result
  }
}

function tapOwner(child: UtilityProcess): void {
  const post = child.postMessage.bind(child)
  const pending = new Map<number, OwnerRecord>()
  child.postMessage = (value: unknown, transfer) => {
    const request = value as WorkspaceRequest
    // An explicit reconcile runs on the utility's sync lane (DM-963): it keeps its command's name here.
    const name = request.type === 'work' ? (request.work.kind === 'heartbeat' ? 'heartbeat' : request.work.name)
      : request.type === 'sync' ? (request.mode === 'explicit' ? 'reconcileRepository' : `sync:${request.mode}`) : undefined
    if (name !== undefined && request.type !== 'close') {
      const record: OwnerRecord = { path: request.path, name, postAt: absoluteNow(), replyAt: null }
      pending.set(request.id, record)
      owner.push(record)
    }
    post(value, transfer)
  }
  child.on('message', (message: WorkspaceResponse) => {
    const record = pending.get(message.id)
    if (record === undefined) return
    record.replyAt = absoluteNow()
    pending.delete(message.id)
  })
}

/** Must run before the built app registers its IPC handlers and forks its first project utility. */
export function installTaps(): void {
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel: string, handler: Handler) => handle(channel, channel === 'dm:command' ? tapCommand(handler) : handler)
  const fork = utilityProcess.fork.bind(utilityProcess)
  utilityProcess.fork = (modulePath, args, options) => {
    const child = fork(modulePath, args, options)
    if (modulePath.endsWith('workspaceOwner.js')) tapOwner(child)
    return child
  }
  // Keep a handle on the desktop's 15-second timers (pool heartbeat, Forge tick) so a scenario can fire them on demand.
  const schedule = globalThis.setInterval
  globalThis.setInterval = ((callback: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === FIFTEEN_SECONDS) fifteenSecondTimers.push(callback)
    return schedule(callback, ms, ...rest)
  }) as typeof globalThis.setInterval
}

/** Runs the desktop's 15-second timers now, as their next tick would (the heartbeat a sync carries). */
export function fireFifteenSecondTimers(): number {
  for (const callback of fifteenSecondTimers) callback()
  return fifteenSecondTimers.length
}

/** Epoch ms of the last desktop command received or answered, for any folder. */
export function lastCommandAt(): number {
  return lastActivity
}

/** Pairs each call with the first unused utility request of the same project and name posted after it was received. */
function matchOwner(path: string, calls: readonly IpcRecord[]) {
  const used = new Set<OwnerRecord>()
  let queueWaitMs = 0
  let ownerRunMs = 0
  for (const call of calls) {
    const match = owner.find((row) => !used.has(row) && row.path === path && row.name === call.name && row.postAt >= call.recvAt && row.replyAt !== null)
    if (match === undefined) continue
    used.add(match)
    queueWaitMs += match.postAt - call.recvAt
    ownerRunMs += (match.replyAt ?? match.postAt) - match.postAt
  }
  return { used, queueWaitMs, ownerRunMs }
}

/** Utility work for `path` overlapping `from`..`to` that is not in `used`, counted by name. */
function otherWorkOf(path: string, used: ReadonlySet<OwnerRecord>, from: number, to: number): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of owner) {
    const overlaps = row.postAt <= to && (row.replyAt ?? Infinity) >= from
    if (row.path === path && !used.has(row) && overlaps) counts[row.name] = (counts[row.name] ?? 0) + 1
  }
  return counts
}

/** Splits the commands in `names` the renderer issued for `path` between `from` and `to` (epoch ms); see `WindowSplit`. */
export function splitWindow(path: string, names: readonly string[], from: number, to: number): WindowSplit {
  const calls = ipc.filter((row) => row.path === path && names.includes(row.name) && row.recvAt >= from && row.doneAt <= to)
  const { used, queueWaitMs, ownerRunMs } = matchOwner(path, calls)
  const lastDoneAt = calls.length === 0 ? null : Math.max(...calls.map((row) => row.doneAt))
  return {
    calls: calls.length, matched: used.size, queueWaitMs, ownerRunMs, payloadBytes: calls.reduce((sum, row) => sum + row.bytes, 0),
    ipcSpanMs: lastDoneAt === null ? 0 : lastDoneAt - Math.min(...calls.map((row) => row.recvAt)), lastDoneAt,
    otherWork: otherWorkOf(path, used, from, to)
  }
}

/** Utility work posted for `path` at or after `from` (epoch ms), counted by operation name. */
export function ownerWorkSince(path: string, from: number): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of owner) {
    if (row.path === path && row.postAt >= from) counts[row.name] = (counts[row.name] ?? 0) + 1
  }
  return counts
}

/**
 * Whether every reconcile posted for `path` on the utility's sync lane (DM-963) has answered. Reads no longer queue
 * behind the heartbeat a sync carries, so a scenario waits for it here, as the baseline's next sample did on the queue.
 */
export function laneSettled(path: string): boolean {
  return owner.every((row) => row.path !== path || row.replyAt !== null || (row.name !== 'reconcileRepository' && !row.name.startsWith('sync:')))
}

interface LaneRow { at: number; kind: 'hold' | 'reconcile'; tag?: string | null; outcome?: string; acquireMs?: number; holdMs?: number; mode?: string; ms?: number; fileReads?: { prepared: number; locked: number } }

/** The sync lanes' rows (`DM_LANE_OBSERVE_FILE`, written by `syncLaneWorker.ts`) between `from` and `to` (epoch ms). */
export function laneDuring(from: number, to: number): { holds: HoldRecord[]; reconciles: { mode: string; ms: number; fileReads: { prepared: number; locked: number } }[] } {
  const file = process.env['DM_LANE_OBSERVE_FILE']
  const rows: LaneRow[] = file && existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as LaneRow).filter((row) => row.at >= from && row.at <= to)
    : []
  return {
    holds: rows.filter((row) => row.kind === 'hold').map((row) => ({ tag: row.tag ?? null, outcome: row.outcome ?? 'commit', acquireMs: row.acquireMs ?? 0, holdMs: row.holdMs ?? 0 })),
    reconciles: rows.filter((row) => row.kind === 'reconcile').map((row) => ({ mode: row.mode ?? '', ms: row.ms ?? 0, fileReads: row.fileReads ?? { prepared: 0, locked: 0 } }))
  }
}

/** Local time of day in ms, as `GIT_TRACE` stamps its lines. */
function timeOfDay(epochMs: number): number {
  const at = new Date(epochMs)
  return ((at.getHours() * 60 + at.getMinutes()) * 60 + at.getSeconds()) * 1000 + at.getMilliseconds()
}

/**
 * Git processes the desktop ran between `from` and `to` (epoch ms), counted by their first four arguments, from the
 * `GIT_TRACE` file the profiler names (every git process the app spawns inherits it). Null when no trace was asked for.
 */
export function gitRunsDuring(from: number, to: number): Record<string, number> | null {
  const file = process.env['GIT_TRACE']
  if (!file || !existsSync(file)) return null
  const [start, end] = [timeOfDay(from), timeOfDay(to)]
  const counts: Record<string, number> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^(\d\d):(\d\d):(\d\d)\.(\d{6}) .*trace: built-in: git (.*)$/.exec(line.trimEnd())
    if (match === null) continue
    const [, h, m, s, micros, args] = match
    const at = ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(micros) / 1000
    if (at < start || at > end) continue
    const command = args!.split(' ').slice(0, 4).join(' ')
    counts[command] = (counts[command] ?? 0) + 1
  }
  return counts
}
