import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Work, WorkspaceRequest } from './workspaceClient'
import { openUtilityWorkspace } from './utilityWorkspace'

const fork = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ utilityProcess: { fork } }))

class Child extends EventEmitter {
  requests: WorkspaceRequest[] = []
  postMessage(request: WorkspaceRequest): void { this.requests.push(request) }
  kill() { this.emit('exit', 0); return true }
}

beforeEach(() => fork.mockReset())
const read: Work = { kind: 'command', name: 'getProject', input: undefined }
const write: Work = { kind: 'command', name: 'createKanbanCard', input: { title: 'One' } }

it('forks the built entry and correlates a response by both generation and request ID', async () => {
  const child = new Child()
  fork.mockReturnValue(child)
  const owner = openUtilityWorkspace(12, '/home', '1.0.0')
  expect(fork).toHaveBeenCalledWith(expect.stringMatching(/workspaceOwner\.js$/), ['12', String(process.pid), '/home', '1.0.0'], { serviceName: 'Dark Mechanicus project' })
  const result = owner.run('/project', read, undefined, 'expected')
  const request = child.requests[0]
  expect(request).toMatchObject({ path: '/project', generation: 12, id: 1, expected: 'expected', work: read })
  await expect(owner.run('/project', read)).rejects.toThrow('overlapping')
  child.emit('message', { ok: true, generation: 13, id: 1, result: { value: 'wrong generation' } })
  child.emit('message', { ok: true, generation: 12, id: 2, result: { value: 'wrong request' } })
  child.emit('message', { ok: true, generation: 12, id: 1, result: { value: 'project', binding: 'expected' } })
  await expect(result).resolves.toEqual({ value: 'project', binding: 'expected' })
  const closing = owner.close()
  expect(child.requests[1]).toEqual({ type: 'close', generation: 12, id: 2 })
  child.emit('message', { ok: true, generation: 12, id: 2, result: { value: undefined } })
  await closing
})

it.each([
  { work: write, completion: 'unknown' },
  { work: { kind: 'command', name: 'getKanbanCard', input: { cardId: 'active' } } as Work, completion: 'unknown' },
  { work: { kind: 'command', name: 'getRunTiming', input: { runId: 'active' } } as Work, completion: 'unknown' },
  { work: read, completion: 'unknown' }
])('classifies a lost $work.name by its possible durable effects', async ({ work, completion }) => {
  const child = new Child()
  fork.mockReturnValue(child)
  const owner = openUtilityWorkspace(1, '/home', '1.0.0')
  const pending = owner.run('/project', work)
  child.emit('exit', 103)
  await expect(pending).rejects.toMatchObject({ code: 'internal', details: { ownerStopped: true, completion } })
  await expect(owner.run('/project', write)).rejects.toMatchObject({ details: { completion: 'unavailable' } })
  await owner.close()
  expect(child.requests).toHaveLength(1)
})

it('propagates command refusals and distinguishes a refusal before a request was posted', async () => {
  const child = new Child()
  fork.mockReturnValue(child)
  const owner = openUtilityWorkspace(2, '/home', '1.0.0')
  const pending = owner.run('/project', write)
  child.emit('message', { ok: false, generation: 2, id: 1, error: { code: 'unauthorized', message: 'Denied' } })
  await expect(pending).rejects.toMatchObject({ code: 'unauthorized', message: 'Denied' })
  vi.spyOn(child, 'postMessage').mockImplementationOnce(() => { throw new Error('disconnected') })
  await expect(owner.run('/project', write)).rejects.toMatchObject({ details: { completion: 'unavailable' } })
  child.emit('exit', 1)
  await owner.close()
})

it('reports a lost warm project summary as unavailable once the child confirmed its binding', async () => {
  const child = new Child()
  fork.mockReturnValue(child)
  const owner = openUtilityWorkspace(1, '/home', '1.0.0')
  const first = owner.run('/project', read)
  child.emit('message', { ok: true, generation: 1, id: 1, result: { value: 'project', binding: 'p1' } })
  await first
  const summary = owner.run('/project', read)
  child.emit('exit', 11)
  await expect(summary).rejects.toMatchObject({ details: { completion: 'unavailable' } })
  await owner.close()
})
