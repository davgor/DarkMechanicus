/** The owner's side of its sync lane: one `worker_threads` Worker with its own connection to the project database. */
import { Worker } from 'node:worker_threads'
import { DomainError } from '../../core/errors'
import type { DomainErrorShape } from '../../shared/domain/errors'
import { reconcileOnLane, releaseLane, type LaneRequest, type LaneState } from './syncLaneCore'
import type { SyncValue } from './workspaceClient'

export type LaneMessage = { id: number } & ({ type: 'reconcile'; request: LaneRequest } | { type: 'release' })
export type LaneReply = { id: number } & ({ ok: true; value?: SyncValue } | { ok: false; error: DomainErrorShape })

export interface SyncLane {
  reconcile(request: LaneRequest): Promise<SyncValue>
  /** Closes the lane's connection before the owner moves or replaces the store; the next reconcile reopens it. */
  release(): Promise<void>
  /** Stops the lane's thread. */
  close(): Promise<void>
}

interface Waiting {
  resolve(value: SyncValue | undefined): void
  reject(error: unknown): void
}

const stopped = () => new DomainError('internal', 'The project sync lane stopped before confirming its reconcile. Reconcile again to check.',
  { completion: 'unknown' })

/** `entry` is the built worker script; the thread starts on the first reconcile and restarts after it stops. */
export function openWorkerLane(entry: string, execArgv?: string[]): SyncLane {
  let worker: Worker | undefined
  let sequence = 0
  const waiting = new Map<number, Waiting>()
  function fail(error: unknown): void {
    worker = undefined
    for (const pending of waiting.values()) pending.reject(error)
    waiting.clear()
  }
  function start(): Worker {
    if (worker) return worker
    const thread = new Worker(entry, execArgv ? { execArgv } : {})
    thread.on('message', (reply: LaneReply) => {
      const pending = waiting.get(reply.id)
      waiting.delete(reply.id)
      if (reply.ok) pending?.resolve(reply.value)
      else pending?.reject(new DomainError(reply.error.code, reply.error.message, reply.error.details))
    })
    thread.on('error', error => { if (worker === thread) fail(error) })
    thread.on('exit', () => { if (worker === thread) fail(stopped()) })
    worker = thread
    return thread
  }
  function post(message: { type: 'reconcile'; request: LaneRequest } | { type: 'release' }): Promise<SyncValue | undefined> {
    const thread = start()
    const id = ++sequence
    return new Promise<SyncValue | undefined>((resolve, reject) => {
      waiting.set(id, { resolve, reject })
      thread.postMessage({ id, ...message } satisfies LaneMessage)
    })
  }
  return {
    reconcile: async request => (await post({ type: 'reconcile', request }))!,
    release: async () => { if (worker) await post({ type: 'release' }) },
    close: async () => {
      const thread = worker
      worker = undefined
      if (thread) await thread.terminate()
      fail(stopped())
    }
  }
}

/**
 * A lane on a second connection of the owner's own thread, for an owner hosted in another process's thread (tests and
 * in-process hosts). It keeps the lane's contract (own connection, admission, release and close) but not its concurrency.
 */
export function inThreadLane(): SyncLane {
  const state: LaneState = {}
  return {
    reconcile: async request => reconcileOnLane(state, request),
    release: async () => releaseLane(state),
    close: async () => releaseLane(state)
  }
}
