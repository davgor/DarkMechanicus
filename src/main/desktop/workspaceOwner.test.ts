import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const served = vi.hoisted(() => ({ options: [] as unknown[], lanes: [] as string[] }))
vi.mock('./workspaceOwnerRuntime', () => ({ serveWorkspaceOwner: (options: unknown) => { served.options.push(options) } }))
vi.mock('./syncLane', () => ({ openWorkerLane: (entry: string) => { served.lanes.push(entry); return { entry } } }))

const argv = process.argv
afterEach(() => {
  process.argv = argv
  served.options.length = 0
  served.lanes.length = 0
})

/** Loads the utility entry as Electron starts it: its last four arguments name the owner. */
async function start(...args: string[]): Promise<void> {
  process.argv = ['electron', 'workspaceOwner.js', ...args]
  vi.resetModules()
  // Dynamic on purpose: the entry reads its arguments and starts serving when the module loads.
  await import('./workspaceOwner')
}

it('serves the owner its arguments name, reconciling on a sync lane thread beside it', async () => {
  await start('7', '4242', '/home/dm', '1.2.3')
  expect(served.options).toEqual([{ generation: 7, ownerPid: 4242, home: '/home/dm', version: '1.2.3', lane: { entry: expect.any(String) } }])
  expect(served.lanes.map((entry) => entry.endsWith(join('desktop', 'syncLaneWorker.js')))).toEqual([true])
})

it.each([
  ['too few arguments', ['7', '4242', '/home/dm']],
  ['a generation that is not an integer', ['x', '4242', '/home/dm', '1.2.3']],
  ['an owner pid that is not an integer', ['7', '42.5', '/home/dm', '1.2.3']]
])('refuses to start with %s', async (_case, args) => {
  process.argv = []
  await expect(start(...args)).rejects.toThrow('Project utility needs a desktop owner.')
  expect(served.options).toEqual([])
})
