import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { openWorkerLane, type SyncLane } from './syncLane'
import type { LaneRequest } from './syncLaneCore'

/**
 * A stand-in lane thread speaking the lane's message protocol: it answers by the request's `path`, so each test scripts
 * the thread's reply (a value, a domain error, a crash, an exit or silence) without a project database.
 */
const SCRIPT = `
const { parentPort, threadId } = require('node:worker_threads')
let released = 0
parentPort.on('message', (message) => {
  if (message.type === 'release') {
    released += 1
    parentPort.postMessage({ id: message.id, ok: true })
    return
  }
  const path = message.request.path
  if (path === 'value') parentPort.postMessage({ id: message.id, ok: true, value: { result: null, hasLocalCache: true, threadId, released } })
  else if (path === 'refuse') parentPort.postMessage({ id: message.id, ok: false, error: { code: 'not_initialized', message: 'No project database.', details: { path } } })
  else if (path === 'crash') setImmediate(() => { throw new Error('lane crashed') })
  else if (path === 'exit') process.exit(3)
  else if (path === 'argv') parentPort.postMessage({ id: message.id, ok: true, value: { result: null, hasLocalCache: process.execArgv.includes('--no-warnings') } })
})
`

let dir = ''
let entry = ''
const lanes: SyncLane[] = []
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dm-sync-lane-'))
  entry = join(dir, 'lane.cjs')
  writeFileSync(entry, SCRIPT)
})
afterEach(async () => {
  for (const lane of lanes.splice(0)) await lane.close()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function lane(execArgv?: string[]): SyncLane {
  const opened = openWorkerLane(entry, execArgv)
  lanes.push(opened)
  return opened
}

function request(path: string): LaneRequest {
  return { path, home: dir, ownerPid: process.pid, mode: 'explicit', authority: undefined, sessionId: 'ss_1', machineId: 'mc_1' }
}

it('starts its thread on the first reconcile and keeps it for the next', async () => {
  const opened = lane()
  // Before any reconcile there is no thread, so a release asks nothing of one.
  await opened.release()
  const first = await opened.reconcile(request('value')) as unknown as { threadId: number; released: number }
  await opened.release()
  const second = await opened.reconcile(request('value')) as unknown as { threadId: number; released: number }
  expect(second.threadId).toBe(first.threadId)
  expect([first.released, second.released]).toEqual([0, 1])
})

it('passes its exec arguments to the thread it starts', async () => {
  expect(await lane(['--no-warnings']).reconcile(request('argv'))).toEqual({ result: null, hasLocalCache: true })
  expect(await lane().reconcile(request('argv'))).toEqual({ result: null, hasLocalCache: false })
})

it('rejects with the domain error the thread reports, and keeps serving after it', async () => {
  const opened = lane()
  const refused = await opened.reconcile(request('refuse')).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(DomainError)
  expect(refused).toMatchObject({ code: 'not_initialized', message: 'No project database.', details: { path: 'refuse' } })
  await expect(opened.reconcile(request('value'))).resolves.toMatchObject({ hasLocalCache: true })
})

it('rejects the waiting reconcile with the error that crashed the thread, then starts a new thread', async () => {
  const opened = lane()
  const first = await opened.reconcile(request('value')) as unknown as { threadId: number }
  await expect(opened.reconcile(request('crash'))).rejects.toThrow('lane crashed')
  const after = await opened.reconcile(request('value')) as unknown as { threadId: number }
  expect(after.threadId).not.toBe(first.threadId)
})

it('reports a reconcile whose thread exited as of unknown completion', async () => {
  const opened = lane()
  const exited = await opened.reconcile(request('exit')).catch((error: unknown) => error)
  expect(exited).toBeInstanceOf(DomainError)
  expect(exited).toMatchObject({ code: 'internal', details: { completion: 'unknown' } })
  expect((exited as Error).message).toMatch(/stopped before confirming its reconcile/)
  await expect(opened.reconcile(request('value'))).resolves.toMatchObject({ hasLocalCache: true })
})

it('rejects a reconcile still waiting when the lane closes, and closes without a thread too', async () => {
  const idle = openWorkerLane(entry)
  await expect(idle.close()).resolves.toBeUndefined()
  const opened = openWorkerLane(entry)
  const silent = opened.reconcile(request('silent')).catch((error: unknown) => error)
  // Let the thread start and receive the request before it is stopped.
  await opened.reconcile(request('value'))
  await opened.close()
  expect(await silent).toMatchObject({ code: 'internal', details: { completion: 'unknown' } })
})
