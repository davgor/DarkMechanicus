/** `onExit`: when git is really gone, which for a cancelled run is after the run has already rejected. */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { type ChildLike, createGitRunner, type SpawnFn } from './runner'

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { on: (): void => undefined, end: (): void => undefined }
  kill(): boolean {
    return true
  }
}

function fakeSpawn(): { spawn: SpawnFn; children: FakeChild[] } {
  const children: FakeChild[] = []
  const spawn: SpawnFn = () => {
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ChildLike
  }
  return { spawn, children }
}

describe('GitRunRequest.onExit', () => {
  it('is called once git is gone (the runner counts an error event as gone, like its own queue), not when a cancelled run rejects', async () => {
    const { spawn, children } = fakeSpawn()
    const controller = new AbortController()
    const exits: string[] = []
    const run = createGitRunner({ spawn, platform: 'linux' }).run({ cwd: '/r', args: ['clone'], kind: 'network', signal: controller.signal, onExit: () => exits.push('exit') })
    controller.abort()
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    expect(exits).toEqual([])
    children[0].emit('close', null, 'SIGTERM')
    expect(exits).toEqual(['exit'])
    children[0].emit('error', new Error('late'))
    expect(exits).toEqual(['exit'])
  })

  it('is called on a normal exit and when git never starts', async () => {
    const { spawn, children } = fakeSpawn()
    const exits: string[] = []
    const runner = createGitRunner({ spawn })
    const done = runner.run({ cwd: '/r', args: ['status'], kind: 'read', onExit: () => exits.push('done') })
    children[0].emit('close', 0, null)
    await done
    const controller = new AbortController()
    controller.abort()
    await expect(runner.run({ cwd: '/r', args: ['fetch'], kind: 'network', signal: controller.signal, onExit: () => exits.push('never started') })).rejects.toMatchObject({ code: 'cancelled' })
    expect(exits).toEqual(['done', 'never started'])
  })
})
