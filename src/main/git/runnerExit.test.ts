/** `onExit`: when git is really gone, which for a cancelled run is after the run has already rejected. */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { type ChildLike, createGitRunner, type SpawnFn } from './runner'

class FakeStream extends EventEmitter {
  destroyed = false
  destroy(): void {
    this.destroyed = true
  }
}

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new FakeStream()
  stderr = new FakeStream()
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

describe('the output pipes of a git that has exited', () => {
  /** A child git left running (an sh and its sleep, an ssh) holds them open, which taskkill does not always end on Windows. */
  const pipesOf = (child: FakeChild): boolean[] => [child.stdout.destroyed, child.stderr.destroyed]

  it('are closed once a git killed on Windows has exited, so the run counts as gone without waiting on its children', async () => {
    const { spawn, children } = fakeSpawn()
    const controller = new AbortController()
    const exits: string[] = []
    const run = createGitRunner({ spawn, platform: 'win32' }).run({ cwd: 'C:\\repo', args: ['fetch'], kind: 'network', signal: controller.signal, onExit: () => exits.push('exit') })
    controller.abort()
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    const [git] = children
    expect(pipesOf(git)).toEqual([false, false])
    git.emit('exit', 1, null)
    expect(pipesOf(git)).toEqual([true, true])
    git.emit('close', 1, null)
    expect(exits).toEqual(['exit'])
  })

  it('are left to close by themselves for a git that exits on its own, and for one killed elsewhere', async () => {
    const { spawn, children } = fakeSpawn()
    const done = createGitRunner({ spawn, platform: 'win32' }).run({ cwd: 'C:\\repo', args: ['status'], kind: 'read' })
    children[0].emit('exit', 0, null)
    expect(pipesOf(children[0])).toEqual([false, false])
    children[0].emit('close', 0, null)
    await done
    const controller = new AbortController()
    const killed = createGitRunner({ spawn, platform: 'linux', killGroup: null }).run({ cwd: '/r', args: ['fetch'], kind: 'network', signal: controller.signal })
    controller.abort()
    await expect(killed).rejects.toMatchObject({ code: 'cancelled' })
    children[1].emit('exit', null, 'SIGTERM')
    expect(pipesOf(children[1])).toEqual([false, false])
  })
})
