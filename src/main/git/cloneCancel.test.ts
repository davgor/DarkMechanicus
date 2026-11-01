/**
 * Cancelling a clone, with a slow fake `git clone` that writes part of a repository, goes on writing for a moment
 * after it is signalled and only then exits. Real git runs everything else (the ssh config read).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneRig, type CloneRig, type CloneRigOptions } from '../../test/cloneRig'
import { isolateGitConfig } from '../../test/gitRemotes'
import { GitError } from './errors'
import { type ChildLike, createGitRunner, type GitRunner, type SpawnFn } from './runner'

const cleanups: Array<() => void> = []
beforeEach(() => isolateGitConfig(cleanups))
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

const rig = (options: CloneRigOptions = {}): CloneRig => cloneRig(cleanups, options)

/**
 * How long the fake git keeps writing after a signal before it exits. A real delay on purpose: the cleanup under test
 * waits on a real child-process event and then removes real files, and fake timers would let the fake's late write
 * race the removal instead of following it.
 */
const EXIT_DELAY_MS = 60

class SlowClone extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { on: (): void => undefined, end: (): void => undefined }
  kills: Array<NodeJS.Signals | number | undefined> = []
  /** Settles once the fake git has exited. */
  readonly closed = new Promise<void>((resolve) => this.once('close', () => resolve()))

  constructor(readonly target: string) {
    super()
    this.write('.git/HEAD')
  }

  /** Writes a file of the repository, creating its folders as git does. */
  write(file: string): void {
    const path = join(this.target, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'partial')
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal)
    setTimeout(() => {
      this.write('.git/objects/pack/late.pack')
      this.emit('close', null, signal ?? 'SIGTERM')
    }, EXIT_DELAY_MS)
    return true
  }
}

function slowClones(): { runner: GitRunner; started(): Promise<SlowClone>; spawned: SlowClone[] } {
  const spawned: SlowClone[] = []
  const events = new EventEmitter()
  const spawn: SpawnFn = (command, args, options) => {
    if (!args.includes('clone')) {
      return nodeSpawn(command, [...args], options) as unknown as ChildLike
    }
    const child = new SlowClone(args[args.length - 1])
    spawned.push(child)
    events.emit('clone', child)
    return child as unknown as ChildLike
  }
  const started = async (): Promise<SlowClone> => spawned[0] ?? ((await once(events, 'clone')) as [SlowClone])[0]
  return { runner: createGitRunner({ spawn, platform: 'linux' }), started, spawned }
}

describe('cancelling a clone', () => {
  it('removes the half-made folder the clone created, once git is gone', async () => {
    const git = slowClones()
    const r = rig({ runner: git.runner })
    await r.cloner.chooseParent()
    const run = r.cloner.clone({ operationId: 'op', url: 'octocat/Hello-World', name: 'Hello-World' })
    const child = await git.started()
    child.stderr.emit('data', 'Receiving objects:  10% (1/10)\r')
    expect(existsSync(join(r.parent, 'Hello-World', '.git', 'HEAD'))).toBe(true)
    expect(r.cloner.cancel(r.parent, 'other')).toBe(false)
    expect(r.cloner.cancel(join(r.parent, 'Hello-World'), 'op')).toBe(false)
    expect(r.cloner.cancel(r.parent, 'op')).toBe(true)
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    expect(child.kills).toEqual(['SIGTERM'])
    // Checked once git has exited: a removal before then would miss what git wrote on its way out.
    await child.closed
    expect(existsSync(join(r.parent, 'Hello-World'))).toBe(false)
    expect(r.tracked).toEqual([])
    expect(r.events).toEqual([{ folder: r.parent, operationId: 'op', operation: 'clone', phase: 'Receiving objects', percent: 10 }])
    expect(r.cloner.cancel(r.parent, 'op')).toBe(false)
  })

  it('leaves an empty folder that was there before in place, removing nothing from it', async () => {
    const git = slowClones()
    const r = rig({ runner: git.runner })
    await r.cloner.chooseParent()
    mkdirSync(join(r.parent, 'mine'))
    const run = r.cloner.clone({ operationId: 'op', url: 'octocat/Hello-World', name: 'mine' })
    const child = await git.started()
    r.cloner.cancel(r.parent, 'op')
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    await child.closed
    // What git wrote is git's own to clear (real git empties the folder it was given); none of it is touched here.
    expect(readdirSync(join(r.parent, 'mine'))).toEqual(['.git'])
    expect(readdirSync(join(r.parent, 'mine', '.git')).sort()).toEqual(['HEAD', 'objects'])
  })

  it('cancelled before git starts, removes the folder it made and never runs git clone', async () => {
    const git = slowClones()
    const r = rig({ runner: git.runner })
    await r.cloner.chooseParent()
    const run = r.cloner.clone({ operationId: 'op', url: 'octocat/Hello-World', name: 'early' })
    expect(r.cloner.cancel(r.parent, 'op')).toBe(true)
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    expect(git.spawned).toEqual([])
    expect(existsSync(join(r.parent, 'early'))).toBe(false)
  })
})

describe('cleanup when git never reports that it is gone', () => {
  it('removes the folder after the exit wait instead of hanging', async () => {
    const real = createGitRunner()
    const runner: GitRunner = {
      run: (request) => (request.kind === 'network' ? Promise.reject(new GitError('cancelled', '')) : real.run(request))
    }
    const r = rig({ runner, exitWaitMs: 20 })
    await r.cloner.chooseParent()
    await expect(r.cloner.clone({ operationId: 'op', url: 'octocat/Hello-World', name: 'stuck' })).rejects.toMatchObject({ code: 'cancelled' })
    expect(existsSync(join(r.parent, 'stuck'))).toBe(false)
  })
})
