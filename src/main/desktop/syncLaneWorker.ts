/** Entry point of a project owner's sync lane thread (`syncLane.ts`). One message at a time, each on the lane's own connection. */
import { appendFileSync } from 'node:fs'
import { parentPort } from 'node:worker_threads'
import { toErrorShape } from '../../core/errors'
import type { LaneMessage, LaneReply } from './syncLane'
import { reconcileOnLane, releaseLane, type LaneObserver, type LaneState } from './syncLaneCore'

const port = parentPort
if (port === null) throw new Error('The sync lane runs only as a worker thread.')

/**
 * Measurement only: the revamp harness names a JSONL file in `DM_LANE_OBSERVE_FILE` to receive the lane's write-lock
 * holds and per-reconcile file reads (no paths, inputs or results). Unset, the lane observes nothing.
 */
function fileObserver(file: string | undefined): LaneObserver | undefined {
  if (!file) return undefined
  const write = (row: object) => {
    try { appendFileSync(file, JSON.stringify({ at: performance.timeOrigin + performance.now(), pid: process.pid, ...row }) + '\n') }
    catch { /* Measurement never changes the reconcile. */ }
  }
  return { onTransaction: hold => write({ kind: 'hold', ...hold }), onReconcile: row => write({ kind: 'reconcile', ...row }) }
}

const observer = fileObserver(process.env['DM_LANE_OBSERVE_FILE'])
const state: LaneState = observer ? { observer } : {}
port.on('message', (message: LaneMessage) => {
  let reply: LaneReply
  try {
    if (message.type === 'release') {
      releaseLane(state)
      reply = { id: message.id, ok: true }
    } else reply = { id: message.id, ok: true, value: reconcileOnLane(state, message.request) }
  } catch (error) {
    reply = { id: message.id, ok: false, error: toErrorShape(error) }
  }
  port.postMessage(reply)
})
