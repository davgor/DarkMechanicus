import { afterEach, describe, expect, it, vi } from 'vitest'
import { killPtyTree, type PtyTree } from './processTree'

type Deps = NonNullable<Parameters<typeof killPtyTree>[1]>

/** A PTY child as the tree kill sees it: node-pty's pid and kill, and its exit, which the test reports. */
class FakePty implements PtyTree {
  /** How many times node-pty's own kill was called. */
  kills = 0
  /** What node-pty's kill throws, when it should. */
  killError: Error | null = null
  readonly exited: Promise<void>
  private exitedFlag = false
  private reportExit: () => void = () => {}

  constructor(readonly pid: number) {
    // Promise.withResolvers is outside the TypeScript lib this repo targets.
    this.exited = new Promise((resolve) => {
      this.reportExit = resolve
    })
  }

  hasExited(): boolean {
    return this.exitedFlag
  }

  kill(): void {
    this.kills += 1
    if (this.killError !== null) {
      throw this.killError
    }
  }

  /** Reports the exit the way the PTY host does: the flag first, then the promise. */
  end(): void {
    this.exitedFlag = true
    this.reportExit()
  }
}

/** A PTY whose exit was already reported before anything asked to kill it. */
function exitedPty(pid: number): FakePty {
  const pty = new FakePty(pid)
  pty.end()
  return pty
}

/** Lets promise callbacks that are already due run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

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
  signals: [number, string | number][]
  taskkills: number[]
}

/** Dependencies that record what the kill does; `groupLives` is how many group checks still find a member. */
function world(platform: string, options: { groupLives?: number; taskkillResult?: Promise<number | null> } = {}): World {
  let lives = options.groupLives ?? 0
  const w: World = { deps: {}, signals: [], taskkills: [] }
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
    sleep: () => Promise.resolve()
  }
  return w
}

afterEach(() => {
  vi.useRealTimers()
})

describe('killPtyTree on macOS and Linux: a running PTY', () => {
  it('sends SIGKILL to the process group the PTY made its child lead, before it returns', () => {
    const w = world('darwin')
    const pty = new FakePty(4242)

    void killPtyTree(pty, w.deps)

    expect(w.signals[0]).toEqual([4242, 'SIGKILL'])
    expect(w.taskkills).toEqual([])
    expect(pty.kills).toBe(0)
  })

  it('resolves true only once the exit is reported and the group is empty', async () => {
    const w = world('linux', { groupLives: 2 })
    const pty = new FakePty(4242)

    const stopping = watch(killPtyTree(pty, w.deps))
    await settle()
    expect(stopping.done()).toBe(false)
    pty.end()

    expect(await stopping.value).toBe(true)
    expect(w.signals).toEqual([
      [4242, 'SIGKILL'],
      [4242, 0],
      [4242, 0],
      [4242, 0]
    ])
  })

  it('says the tree is not gone when the group never empties', async () => {
    const w = world('linux', { groupLives: Number.POSITIVE_INFINITY })
    const pty = new FakePty(4242)

    const result = killPtyTree(pty, w.deps)
    pty.end()

    expect(await result).toBe(false)
  })
})

describe('killPtyTree on macOS and Linux: a running PTY that does not go', () => {
  it("falls back to node-pty's own kill when there is no group to signal, and says the tree may remain", async () => {
    const w = world('linux')
    w.deps.signalGroup = () => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    }
    const pty = new FakePty(4242)

    const result = killPtyTree(pty, w.deps)
    expect(pty.kills).toBe(1)
    pty.end()

    expect(await result).toBe(false)
  })

  it('stops waiting after its timeout when the exit is never reported', async () => {
    vi.useFakeTimers()
    const w = world('linux')

    const stopping = watch(killPtyTree(new FakePty(4242), { ...w.deps, waitMs: 1000 }))
    await vi.advanceTimersByTimeAsync(999)
    expect(stopping.done()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(await stopping.value).toBe(false)
  })
})

describe('killPtyTree on macOS and Linux: a PTY whose process already exited', () => {
  it('ends what it left running in its group: one check, SIGKILL to the group, then checks until empty', async () => {
    const w = world('darwin', { groupLives: 2 })
    const pty = exitedPty(4242)

    expect(await killPtyTree(pty, w.deps)).toBe(true)

    expect(w.signals).toEqual([
      [4242, 0],
      [4242, 'SIGKILL'],
      [4242, 0],
      [4242, 0]
    ])
    expect(pty.kills).toBe(0)
  })

  it('leaves an empty group alone, and repeats that answer without looking again', async () => {
    const w = world('linux')
    const pty = exitedPty(4242)

    expect(await killPtyTree(pty, w.deps)).toBe(true)
    expect(await killPtyTree(pty, w.deps)).toBe(true)

    expect(w.signals).toEqual([[4242, 0]])
  })
})

describe('killPtyTree on Windows', () => {
  it("runs taskkill /t /f on the pid first, then node-pty's own kill to close the pseudo-console", async () => {
    let finish: (code: number) => void = () => {}
    const w = world('win32', {
      taskkillResult: new Promise<number>((resolve) => {
        finish = resolve
      })
    })
    const pty = new FakePty(4242)

    const stopping = watch(killPtyTree(pty, w.deps))
    expect(w.taskkills).toEqual([4242])
    await settle()
    expect(pty.kills).toBe(0)
    finish(0)
    await settle()
    expect(pty.kills).toBe(1)
    expect(stopping.done()).toBe(false)
    pty.end()

    expect(await stopping.value).toBe(true)
    expect(w.signals).toEqual([])
  })

  it('treats "no such process" from taskkill as a tree that is already gone', async () => {
    const w = world('win32', { taskkillResult: Promise.resolve(128) })
    const pty = new FakePty(4242)

    const result = killPtyTree(pty, w.deps)
    pty.end()

    expect(await result).toBe(true)
  })
})

describe('killPtyTree on Windows: when taskkill or node-pty fails, or the PTY already exited', () => {
  it.each([
    ['could not be started', null],
    ['refused', 1]
  ])('still closes the PTY when taskkill %s, and says the tree may remain', async (_why, code) => {
    const w = world('win32', { taskkillResult: Promise.resolve(code) })
    const pty = new FakePty(4242)

    const result = killPtyTree(pty, w.deps)
    pty.end()

    expect(await result).toBe(false)
    expect(pty.kills).toBe(1)
  })

  it("tolerates node-pty's kill throwing for a pseudo-console that is already closed", async () => {
    const w = world('win32')
    const pty = new FakePty(4242)
    pty.killError = new Error('already closed')

    const result = killPtyTree(pty, w.deps)
    pty.end()

    expect(await result).toBe(true)
  })

  it('leaves a PTY whose process already exited alone: no taskkill by a pid that may be reused', async () => {
    const w = world('win32', { groupLives: 5 })
    const pty = exitedPty(4242)

    expect(await killPtyTree(pty, w.deps)).toBe(true)

    expect(w.taskkills).toEqual([])
    expect(w.signals).toEqual([])
    expect(pty.kills).toBe(0)
  })
})

describe('killPtyTree: asked again for the same PTY', () => {
  it('shares the kill that is already running', async () => {
    const w = world('win32')
    const pty = new FakePty(4242)

    const first = killPtyTree(pty, w.deps)
    const second = killPtyTree(pty, w.deps)
    pty.end()

    expect(second).toBe(first)
    expect(await first).toBe(true)
    expect(w.taskkills).toEqual([4242])
  })

  it('starts a new kill once an earlier one settled with the process still running', async () => {
    vi.useFakeTimers()
    const w = world('linux')
    const pty = new FakePty(4242)

    const first = killPtyTree(pty, { ...w.deps, waitMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect(await first).toBe(false)
    const second = killPtyTree(pty, w.deps)
    pty.end()

    expect(await second).toBe(true)
    expect(w.signals.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(2)
  })
})
