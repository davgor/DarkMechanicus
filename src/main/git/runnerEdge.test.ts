/** Runner edge cases with a fake spawn: string chunks, late events, signal exits, odd spawn failures, Windows kills. */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { GitError } from './errors'
import { type ChildLike, createGitRunner, type GitRunRequest, type SpawnFn } from './runner'

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = Object.assign(new EventEmitter(), { end: (): void => undefined })
  kills: Array<NodeJS.Signals | number | undefined> = []
  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal)
    return true
  }
}

/** A spawn handing out fake children; `throwFor` makes spawning that command throw instead. */
function fakeSpawn(throwFor: { command: string; error: unknown } | null = null): { spawn: SpawnFn; children: FakeChild[] } {
  const children: FakeChild[] = []
  const spawn: SpawnFn = (command) => {
    if (throwFor !== null && command === throwFor.command) {
      throw throwFor.error
    }
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ChildLike
  }
  return { spawn, children }
}

const req = (over: Partial<GitRunRequest> = {}): GitRunRequest => ({ cwd: '/fake/repo', args: ['status'], kind: 'read', ...over })

describe('output (fake spawn)', () => {
  it('accepts string chunks on stdout and stderr, progress lines included', async () => {
    const { spawn, children } = fakeSpawn()
    const lines: string[] = []
    const run = createGitRunner({ spawn }).run(req({ onProgress: (line) => lines.push(line) }))
    children[0].stdout.emit('data', 'text out')
    children[0].stderr.emit('data', 'Counting: 50%\r')
    children[0].emit('close', 0, null)
    expect(await run).toEqual({ code: 0, stdout: 'text out', stderr: 'Counting: 50%\r' })
    expect(lines).toEqual(['Counting: 50%'])
  })

  it('ignores output and errors arriving after git closed', async () => {
    const { spawn, children } = fakeSpawn()
    const lines: string[] = []
    const run = createGitRunner({ spawn }).run(req({ onProgress: (line) => lines.push(line) }))
    children[0].stdout.emit('data', Buffer.from('ok'))
    children[0].emit('close', 0, null)
    children[0].stdout.emit('data', Buffer.from('late'))
    children[0].stderr.emit('data', Buffer.from('late progress\n'))
    children[0].emit('error', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))
    expect(await run).toEqual({ code: 0, stdout: 'ok', stderr: '' })
    expect(lines).toEqual([])
  })

  it('survives git closing stdin before reading it', async () => {
    const { spawn, children } = fakeSpawn()
    const run = createGitRunner({ spawn }).run(req({ kind: 'write', stdin: 'message' }))
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    expect(() => children[0].stdin.emit('error', epipe)).not.toThrow()
    children[0].emit('close', 0, null)
    expect(await run).toMatchObject({ code: 0 })
  })
})

describe('exit codes and spawn failures (fake spawn)', () => {
  it('reports a git killed by a signal as exit code -1', async () => {
    const { spawn, children } = fakeSpawn()
    const runner = createGitRunner({ spawn })
    const accepted = runner.run(req({ acceptExitCodes: [-1] }))
    children[0].emit('close', null, 'SIGKILL')
    expect(await accepted).toEqual({ code: -1, stdout: '', stderr: '' })
    const refused = runner.run(req())
    children[1].emit('close', null, 'SIGKILL')
    await expect(refused).rejects.toBeInstanceOf(GitError)
  })

  it('reports a spawn that throws something other than ENOENT as git_failed', async () => {
    const { spawn } = fakeSpawn({ command: 'git', error: 'EMFILE: too many open files' })
    const failure = createGitRunner({ spawn }).run(req())
    await expect(failure).rejects.toBeInstanceOf(GitError)
    await expect(failure).rejects.toMatchObject({ code: 'git_failed', message: 'git could not be started' })
    await expect(failure).rejects.toMatchObject({ detail: expect.stringContaining('EMFILE') })
  })
})

describe('Windows kills (fake spawn)', () => {
  it('kills git itself when taskkill fails to start', async () => {
    const { spawn, children } = fakeSpawn()
    const controller = new AbortController()
    const run = createGitRunner({ spawn, platform: 'win32' }).run(req({ kind: 'network', signal: controller.signal }))
    const settled = expect(run).rejects.toMatchObject({ code: 'cancelled' })
    controller.abort()
    await settled
    expect(children[0].kills).toEqual([])
    children[1].emit('error', Object.assign(new Error('spawn taskkill ENOENT'), { code: 'ENOENT' }))
    expect(children[0].kills).toEqual([undefined])
  })

  it('kills git itself when spawning taskkill throws', async () => {
    const { spawn, children } = fakeSpawn({ command: 'taskkill', error: new Error('EPERM') })
    const controller = new AbortController()
    const run = createGitRunner({ spawn, platform: 'win32' }).run(req({ kind: 'network', signal: controller.signal }))
    const settled = expect(run).rejects.toMatchObject({ code: 'cancelled' })
    controller.abort()
    await settled
    expect(children[0].kills).toEqual([undefined])
  })
})
