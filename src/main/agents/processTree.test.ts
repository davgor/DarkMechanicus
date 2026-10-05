import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { killProcessTree, startsOwnGroup } from './processTree'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

type Deps = NonNullable<Parameters<typeof killProcessTree>[1]>

/** A child as the helper sees it: an id, the fields Node fills in when it ends, and the events. */
class FakeProcess extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kill = vi.fn()

  constructor(readonly pid: number | undefined) {
    super()
  }

  /** Ends the process the way Node reports it. */
  end(code: number | null = 0): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess
  }
}

/** Lets promise callbacks and timers that are already due run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** A flag that turns true once `promise` has settled, so a test can say "not yet" and then "now". */
function watch<T>(promise: Promise<T>): { done: () => boolean; value: Promise<T> } {
  let done = false
  const value = promise.then((result) => {
    done = true
    return result
  })
  return { done: () => done, value }
}

interface World {
  deps: Deps
  /** Every `[group, signal]` sent through `signalGroup`. */
  signals: [number, string | number][]
  /** The pids `taskkill` was asked about. */
  taskkills: number[]
  /** How many times the helper slept between group checks. */
  sleeps: number[]
}

/** Dependencies that record what the helper does; `groupLives` is how many group checks still find the group. */
function world(platform: string, options: { groupLives?: number; taskkillResult?: Promise<number | null> } = {}): World {
  let lives = options.groupLives ?? 0
  const w: World = { deps: {}, signals: [], taskkills: [], sleeps: [] }
  w.deps = {
    platform,
    signalGroup: (pgid, signal) => {
      w.signals.push([pgid, signal])
      if (signal === 0) {
        if (lives <= 0) {
          throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
        }
        lives -= 1
      }
    },
    taskkill: (pid) => {
      w.taskkills.push(pid)
      return options.taskkillResult ?? Promise.resolve(0)
    },
    sleep: (ms) => {
      w.sleeps.push(ms)
      return Promise.resolve()
    }
  }
  return w
}

beforeEach(() => {
  vi.mocked(spawn).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('startsOwnGroup', () => {
  it('is true wherever there are process groups and false on Windows', () => {
    expect(startsOwnGroup('linux')).toBe(true)
    expect(startsOwnGroup('darwin')).toBe(true)
    expect(startsOwnGroup('win32')).toBe(false)
  })

  it('looks at the running platform when none is given', () => {
    expect(startsOwnGroup()).toBe(process.platform !== 'win32')
  })
})

describe('killProcessTree: a process that is already gone', () => {
  it('signals nothing and says it is gone, for a process that exited or was ended by a signal', async () => {
    const w = world('linux')
    const exited = new FakeProcess(10)
    exited.exitCode = 0
    const signalled = new FakeProcess(11)
    signalled.signalCode = 'SIGTERM'

    expect(await killProcessTree(exited.asChild(), w.deps)).toBe(true)
    expect(await killProcessTree(signalled.asChild(), w.deps)).toBe(true)

    expect(w.signals).toEqual([])
    expect(w.taskkills).toEqual([])
    expect(exited.kill).not.toHaveBeenCalled()
  })
})

describe('killProcessTree on macOS and Linux', () => {
  it('sends SIGKILL to the process group of the child and not to the child alone', async () => {
    const w = world('darwin')
    const child = new FakeProcess(4242)

    const result = killProcessTree(child.asChild(), w.deps)
    child.end()
    await result

    expect(w.signals[0]).toEqual([4242, 'SIGKILL'])
    expect(w.taskkills).toEqual([])
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('sends the signal before it returns, not after something else has been awaited', () => {
    const w = world('linux')

    void killProcessTree(new FakeProcess(7).asChild(), w.deps)

    expect(w.signals[0]).toEqual([7, 'SIGKILL'])
  })

  it('resolves only once the child has exited', async () => {
    const w = world('linux')
    const child = new FakeProcess(4242)

    const stopping = watch(killProcessTree(child.asChild(), w.deps))
    await settle()
    expect(stopping.done()).toBe(false)
    child.end()

    expect(await stopping.value).toBe(true)
  })

})

describe('killProcessTree on macOS and Linux: the group and what is left of it', () => {
  it('keeps checking until the group is empty, so what the child started is gone too', async () => {
    const w = world('linux', { groupLives: 3 })
    const child = new FakeProcess(4242)

    const result = killProcessTree(child.asChild(), w.deps)
    child.end()

    expect(await result).toBe(true)
    expect(w.signals.filter(([, signal]) => signal === 0)).toHaveLength(4)
    expect(w.sleeps).toEqual([10, 10, 10])
  })

  it('reports a group that never empties as not gone, after a bounded number of checks', async () => {
    const w = world('linux', { groupLives: Number.POSITIVE_INFINITY })
    const child = new FakeProcess(4242)

    const result = killProcessTree(child.asChild(), w.deps)
    child.end()

    expect(await result).toBe(false)
    expect(w.sleeps).toHaveLength(100)
  })

  it('ends the child itself when it has no group of its own to signal, and says the tree may remain', async () => {
    const w = world('linux')
    w.deps.signalGroup = () => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    }
    const child = new FakeProcess(4242)

    const result = killProcessTree(child.asChild(), w.deps)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.end()

    expect(await result).toBe(false)
  })

  it('ends a child that has no pid to address a group by directly', async () => {
    const w = world('linux')
    const child = new FakeProcess(undefined)

    const result = killProcessTree(child.asChild(), w.deps)
    child.end()

    expect(await result).toBe(true)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(w.signals).toEqual([])
  })

  it('signals a group with the real process.kill when no signal function is given', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })
    const child = new FakeProcess(4242)

    const result = killProcessTree(child.asChild(), { platform: 'linux' })
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
    child.end()
    await result
    kill.mockRestore()
  })
})

describe('killProcessTree on Windows', () => {
  it('runs taskkill for the whole tree and does not signal a group', async () => {
    const w = world('win32')
    const child = new FakeProcess(4242)

    const result = killProcessTree(child.asChild(), w.deps)
    child.end()

    expect(await result).toBe(true)
    expect(w.taskkills).toEqual([4242])
    expect(w.signals).toEqual([])
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('starts taskkill before it returns, not after something else has been awaited', () => {
    const w = world('win32')

    void killProcessTree(new FakeProcess(7).asChild(), w.deps)

    expect(w.taskkills).toEqual([7])
  })

  it('waits for taskkill itself to finish, not only for the child to exit', async () => {
    let finish: (code: number) => void = () => {}
    const w = world('win32', {
      taskkillResult: new Promise<number>((resolve) => {
        finish = resolve
      })
    })
    const child = new FakeProcess(4242)

    const stopping = watch(killProcessTree(child.asChild(), w.deps))
    child.end()
    await settle()
    expect(stopping.done()).toBe(false)
    finish(0)

    expect(await stopping.value).toBe(true)
  })

})

describe('killProcessTree on Windows: waiting and failing', () => {
  it('waits for the child to exit after taskkill has finished', async () => {
    const w = world('win32')
    const child = new FakeProcess(4242)

    const stopping = watch(killProcessTree(child.asChild(), w.deps))
    await settle()
    expect(stopping.done()).toBe(false)
    child.end()

    expect(await stopping.value).toBe(true)
  })

  it('treats "no such process" from taskkill as a tree that is already gone', async () => {
    const w = world('win32', { taskkillResult: Promise.resolve(128) })
    const child = new FakeProcess(4242)

    const result = killProcessTree(child.asChild(), w.deps)
    child.end()

    expect(await result).toBe(true)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it.each([
    ['could not be started', null],
    ['refused', 1]
  ])('ends the child itself when taskkill %s, and says the tree may remain', async (_why, code) => {
    const w = world('win32', { taskkillResult: Promise.resolve(code) })
    const child = new FakeProcess(4242)

    const result = killProcessTree(child.asChild(), w.deps)
    child.end()

    expect(await result).toBe(false)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('ends a child that has no pid directly', async () => {
    const w = world('win32')
    const child = new FakeProcess(undefined)

    const result = killProcessTree(child.asChild(), w.deps)
    child.end()

    expect(await result).toBe(true)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(w.taskkills).toEqual([])
  })
})

describe('killProcessTree: asked again for the same child', () => {
  it('shares the kill that is already running instead of racing a second one against it', async () => {
    const w = world('win32')
    const child = new FakeProcess(4242)

    const first = killProcessTree(child.asChild(), w.deps)
    const second = killProcessTree(child.asChild(), w.deps)
    child.end()

    expect(second).toBe(first)
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(w.taskkills).toEqual([4242])
  })

  it('starts a new kill once the earlier one has settled without the child going', async () => {
    vi.useFakeTimers()
    const w = world('win32')
    const child = new FakeProcess(4242)

    const first = killProcessTree(child.asChild(), { ...w.deps, waitMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect(await first).toBe(false)
    const second = killProcessTree(child.asChild(), w.deps)
    child.end()

    expect(await second).toBe(true)
    expect(w.taskkills).toEqual([4242, 4242])
  })
})

describe('killProcessTree: the real taskkill', () => {
  /** A taskkill process that ends when told to. */
  function fakeTaskkill(): EventEmitter {
    const killer = new EventEmitter()
    vi.mocked(spawn).mockReturnValue(killer as never)
    return killer
  }

  it('starts taskkill.exe from the system folder with the pid and the tree and force switches, without a shell', async () => {
    vi.stubEnv('SystemRoot', 'D:\\Win')
    const killer = fakeTaskkill()
    const child = new FakeProcess(4242)

    const result = killProcessTree(child.asChild(), { platform: 'win32' })
    killer.emit('exit', 0, null)
    child.end()

    expect(await result).toBe(true)
    expect(spawn).toHaveBeenCalledWith('D:\\Win\\System32\\taskkill.exe', ['/pid', '4242', '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    })
  })

  it('falls back to C:\\Windows when the environment does not name the system folder', async () => {
    // Stubbed first so `unstubAllEnvs` puts the real value back after the delete.
    vi.stubEnv('SystemRoot', 'placeholder')
    delete process.env['SystemRoot']
    const killer = fakeTaskkill()
    const child = new FakeProcess(1)

    const result = killProcessTree(child.asChild(), { platform: 'win32' })
    killer.emit('exit', 0, null)
    child.end()
    await result

    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe('C:\\Windows\\System32\\taskkill.exe')
  })

  it('ends the child itself when taskkill cannot be started or is itself killed', async () => {
    const killer = fakeTaskkill()
    const child = new FakeProcess(4242)

    const result = killProcessTree(child.asChild(), { platform: 'win32' })
    killer.emit('error', Object.assign(new Error('spawn taskkill ENOENT'), { code: 'ENOENT' }))
    child.end()

    expect(await result).toBe(false)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')

    const second = fakeTaskkill()
    const other = new FakeProcess(5)
    const again = killProcessTree(other.asChild(), { platform: 'win32' })
    second.emit('exit', null, 'SIGTERM')
    other.end()
    expect(await again).toBe(false)
  })
})

describe('killProcessTree: a child that does not go', () => {
  it('stops waiting after the limit and says it is not gone', async () => {
    vi.useFakeTimers()
    const w = world('linux')
    const child = new FakeProcess(4242)

    const stopping = watch(killProcessTree(child.asChild(), { ...w.deps, waitMs: 1000 }))
    await vi.advanceTimersByTimeAsync(999)
    expect(stopping.done()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(await stopping.value).toBe(false)
  })

  it('counts a child that failed to start as ended, so the wait does not run out', async () => {
    vi.useFakeTimers()
    const w = world('linux')
    const child = new FakeProcess(undefined)

    const result = killProcessTree(child.asChild(), w.deps)
    child.emit('error', new Error('spawn ENOENT'))

    expect(await result).toBe(true)
  })

  it('does not leave its timer behind once the child has gone', async () => {
    vi.useFakeTimers()
    const w = world('linux')
    const child = new FakeProcess(4242)

    const result = killProcessTree(child.asChild(), w.deps)
    child.end()
    await result

    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits with the real timer between group checks when no sleep is given', async () => {
    vi.useFakeTimers()
    let lives = 1
    const child = new FakeProcess(4242)

    const result = killProcessTree(child.asChild(), {
      platform: 'linux',
      signalGroup: (_pgid, signal) => {
        if (signal === 0) {
          if (lives === 0) {
            throw new Error('ESRCH')
          }
          lives -= 1
        }
      }
    })
    child.end()
    await vi.advanceTimersByTimeAsync(10)

    expect(await result).toBe(true)
  })
})
