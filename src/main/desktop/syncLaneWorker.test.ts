import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { LaneMessage, LaneReply } from './syncLane'

/** The worker's port as the thread sees it: messages in, replies recorded. */
class FakePort extends EventEmitter {
  readonly replies: LaneReply[] = []
  postMessage(reply: LaneReply): void {
    this.replies.push(reply)
  }
}

const dirs: string[] = []
afterEach(() => {
  vi.doUnmock('node:worker_threads')
  vi.resetModules()
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function startWorker(port: FakePort | null): Promise<void> {
  vi.resetModules()
  vi.doMock('node:worker_threads', () => ({ parentPort: port }))
  // Dynamic on purpose: the worker wires its port when the module loads, so each test loads it afresh with its own port.
  await import('./syncLaneWorker')
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dm-lane-worker-'))
  dirs.push(dir)
  return dir
}

function send(port: FakePort, message: LaneMessage): LaneReply | undefined {
  port.emit('message', message)
  return port.replies.at(-1)
}

it('refuses to start outside a worker thread', async () => {
  await expect(startWorker(null)).rejects.toThrow('The sync lane runs only as a worker thread.')
})

it('answers a release, and a reconcile it cannot run with the error shape the owner rethrows', async () => {
  vi.stubEnv('DM_LANE_OBSERVE_FILE', '')
  const port = new FakePort()
  await startWorker(port)
  expect(send(port, { id: 1, type: 'release' })).toEqual({ id: 1, ok: true })
  const home = scratch()
  const reply = send(port, {
    id: 2,
    type: 'reconcile',
    request: { path: scratch(), home, ownerPid: process.pid, mode: 'explicit', authority: undefined, sessionId: 'ss_1', machineId: 'mc_1' }
  })
  expect(reply).toMatchObject({ id: 2, ok: false, error: { code: 'not_initialized' } })
})

it('observes into the file the harness names, and still answers when that file cannot be written', async () => {
  const dir = scratch()
  const file = join(dir, 'lane.jsonl')
  vi.stubEnv('DM_LANE_OBSERVE_FILE', join(dir, 'missing', 'lane.jsonl'))
  const unwritable = new FakePort()
  await startWorker(unwritable)
  expect(send(unwritable, { id: 1, type: 'release' })).toEqual({ id: 1, ok: true })
  vi.stubEnv('DM_LANE_OBSERVE_FILE', file)
  const port = new FakePort()
  await startWorker(port)
  const reply = send(port, {
    id: 3,
    type: 'reconcile',
    request: { path: scratch(), home: dir, ownerPid: process.pid, mode: 'member', authority: undefined, sessionId: 'ss_1', machineId: 'mc_1' }
  })
  // No project database: nothing was reconciled, so nothing was observed, and the failure still reaches the owner.
  expect(reply).toMatchObject({ id: 3, ok: false, error: { code: 'not_initialized' } })
  expect(() => readFileSync(file, 'utf8')).toThrow()
})
