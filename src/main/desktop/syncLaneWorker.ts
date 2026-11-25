/** Entry point of a project owner's sync lane thread (`syncLane.ts`). One message at a time, each on the lane's own connection. */
import { parentPort } from 'node:worker_threads'
import { toErrorShape } from '../../core/errors'
import type { LaneMessage, LaneReply } from './syncLane'
import { reconcileOnLane, releaseLane, type LaneState } from './syncLaneCore'

const port = parentPort
if (port === null) throw new Error('The sync lane runs only as a worker thread.')
const state: LaneState = {}
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
