import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { killProcessTree, startsOwnGroup } from './agents/processTree'
import { disposeBeforeQuit, type QuitApp } from './quitDisposal'

/** The test below starts and kills real processes, which can stall on Windows when the whole suite is running. */
vi.setConfig({ testTimeout: 60_000 })

interface FakeApp extends QuitApp {
  /** Emits before-quit; returns whether the quit was prevented. */
  beforeQuit(): boolean
  /** Calls to quit(), each of which emits before-quit like Electron does. */
  quits: number
  /** Whether the last quit() was prevented again. */
  lastQuitPrevented: boolean | null
}

function fakeApp(): FakeApp {
  const listeners: ((event: { preventDefault(): void }) => void)[] = []
  const app: FakeApp = {
    quits: 0,
    lastQuitPrevented: null,
    on: (eventName, listener) => {
      expect(eventName).toBe('before-quit')
      listeners.push(listener)
      return app
    },
    quit: () => {
      app.quits += 1
      app.lastQuitPrevented = app.beforeQuit()
    },
    beforeQuit: () => {
      let prevented = false
      for (const listener of listeners) {
        listener({ preventDefault: () => (prevented = true) })
      }
      return prevented
    }
  }
  return app
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function manualTimer(): { set: (callback: () => void, ms: number) => unknown; fire: () => void; delays: number[] } {
  const callbacks: (() => void)[] = []
  const delays: number[] = []
  return {
    set: (callback, ms) => {
      callbacks.push(callback)
      delays.push(ms)
      return callbacks.length
    },
    fire: () => {
      for (const callback of callbacks.splice(0)) {
        callback()
      }
    },
    delays
  }
}

describe('disposeBeforeQuit', () => {
  it('holds the quit while live processes are disposed, then quits for real', async () => {
    const app = fakeApp()
    let finish: () => void = () => {}
    const disposals: number[] = []
    disposeBeforeQuit(app, {
      busy: () => true,
      dispose: () => {
        disposals.push(1)
        return new Promise((resolve) => (finish = resolve))
      },
      timeoutMs: 5_000,
      timer: manualTimer(),
      release: () => {}
    })

    expect(app.beforeQuit()).toBe(true)
    expect(app.beforeQuit()).toBe(true)
    await settle()
    expect(disposals).toEqual([1])
    expect(app.quits).toBe(0)

    finish()
    await settle()
    expect([app.quits, app.lastQuitPrevented]).toEqual([1, false])
  })

  it('lets the quit through when nothing is live, still refusing new processes', async () => {
    const app = fakeApp()
    const disposals: number[] = []
    disposeBeforeQuit(app, { busy: () => false, dispose: async () => void disposals.push(1), timeoutMs: 5_000, release: () => {} })

    expect(app.beforeQuit()).toBe(false)
    await settle()
    expect(disposals).toEqual([1])
    expect(app.quits).toBe(0)
  })
})

/** The app's workspaces and `app.sqlite`: like node:sqlite, closing the database twice throws. */
function fakeStores(events: string[]): { release: () => void; closes: () => number } {
  let open = true
  let closes = 0
  return {
    release: () => {
      events.push('close workspaces')
      if (!open) {
        throw new Error('database is not open')
      }
      open = false
      closes += 1
      events.push('close app.sqlite')
    },
    closes: () => closes
  }
}

/** A chat disposal that finishes when the test says so. */
function deferredDispose(events: string[]): { dispose: () => Promise<void>; finish: () => void } {
  let finish: () => void = () => {}
  return {
    dispose: () => {
      events.push('dispose started')
      return new Promise<void>((resolve) => (finish = resolve)).then(() => void events.push('dispose finished'))
    },
    finish: () => finish()
  }
}

describe('disposeBeforeQuit closing the app stores', () => {
  it('closes the workspaces and app.sqlite once, only after a deferred quit has disposed the chats', async () => {
    const events: string[] = []
    const stores = fakeStores(events)
    const errors: unknown[] = []
    const app = fakeApp()
    const quit = app.quit
    app.quit = () => {
      events.push('quit')
      quit()
    }
    const chats = deferredDispose(events)
    disposeBeforeQuit(app, {
      busy: () => true,
      dispose: chats.dispose,
      timeoutMs: 5_000,
      timer: manualTimer(),
      release: stores.release,
      onError: (error) => errors.push(error)
    })

    expect(app.beforeQuit()).toBe(true)
    expect(app.beforeQuit()).toBe(true)
    await settle()
    expect(events).toEqual(['dispose started'])

    chats.finish()
    await settle()
    expect(() => app.beforeQuit()).not.toThrow()
    expect(events).toEqual(['dispose started', 'dispose finished', 'close workspaces', 'close app.sqlite', 'quit'])
    expect([stores.closes(), app.lastQuitPrevented, errors]).toEqual([1, false, []])
  })

  it('closes them once when nothing is live, and a repeated before-quit neither throws nor closes again', async () => {
    const events: string[] = []
    const stores = fakeStores(events)
    const errors: unknown[] = []
    const app = fakeApp()
    disposeBeforeQuit(app, {
      busy: () => false,
      dispose: async () => void events.push('dispose'),
      timeoutMs: 5_000,
      release: stores.release,
      onError: (error) => errors.push(error)
    })

    expect(app.beforeQuit()).toBe(false)
    expect(() => app.beforeQuit()).not.toThrow()
    expect(app.beforeQuit()).toBe(false)
    await settle()

    expect(events).toEqual(['dispose', 'close workspaces', 'close app.sqlite'])
    expect([stores.closes(), errors]).toEqual([1, []])
  })
})

describe('disposeBeforeQuit closing the app stores when something goes wrong', () => {
  it('still closes once and quits when disposing hangs past the timeout', async () => {
    const events: string[] = []
    const stores = fakeStores(events)
    const app = fakeApp()
    const timer = manualTimer()
    disposeBeforeQuit(app, { busy: () => true, dispose: () => new Promise(() => {}), timeoutMs: 5_000, timer, release: stores.release })

    app.beforeQuit()
    await settle()
    expect(stores.closes()).toBe(0)
    timer.fire()
    await settle()
    app.beforeQuit()

    expect([stores.closes(), app.quits, app.lastQuitPrevented]).toEqual([1, 1, false])
  })

  it('reports a failing close and quits anyway, whether or not chats were live', async () => {
    const fail = (): void => {
      throw new Error('locked')
    }
    const deferredErrors: unknown[] = []
    const deferred = fakeApp()
    disposeBeforeQuit(deferred, { busy: () => true, dispose: async () => {}, timeoutMs: 5_000, timer: manualTimer(), release: fail, onError: (error) => deferredErrors.push(error) })
    deferred.beforeQuit()
    await settle()
    expect([deferred.quits, deferred.lastQuitPrevented]).toEqual([1, false])
    expect(deferredErrors).toEqual([expect.objectContaining({ message: 'locked' })])

    const directErrors: unknown[] = []
    const direct = fakeApp()
    disposeBeforeQuit(direct, { busy: () => false, dispose: async () => {}, timeoutMs: 5_000, release: fail, onError: (error) => directErrors.push(error) })
    expect(() => direct.beforeQuit()).not.toThrow()
    expect(directErrors).toEqual([expect.objectContaining({ message: 'locked' })])
  })
})

describe('disposeBeforeQuit when disposing does not finish', () => {
  it('quits anyway when disposing hangs past the timeout or fails', async () => {
    const hung = fakeApp()
    const timer = manualTimer()
    disposeBeforeQuit(hung, { busy: () => true, dispose: () => new Promise(() => {}), timeoutMs: 5_000, timer, release: () => {} })
    hung.beforeQuit()
    await settle()
    expect(hung.quits).toBe(0)
    timer.fire()
    await settle()
    expect([hung.quits, hung.lastQuitPrevented, timer.delays]).toEqual([1, false, [5_000]])

    const failing = fakeApp()
    const errors: unknown[] = []
    disposeBeforeQuit(failing, { busy: () => true, dispose: () => Promise.reject(new Error('stuck')), timeoutMs: 5_000, timer: manualTimer(), release: () => {}, onError: (error) => errors.push(error) })
    failing.beforeQuit()
    await settle()
    expect([failing.quits, failing.lastQuitPrevented]).toEqual([1, false])
    expect(errors).toEqual([expect.objectContaining({ message: 'stuck' })])
  })
})

/** An "agent" that has started a tool of its own: it prints the tool's pid and then keeps running. */
const AGENT_WITH_A_TOOL = `
const { spawn } = require('node:child_process')
const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] })
console.log(tool.pid)
setInterval(() => {}, 1000)
`

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('quitting while an agent is mid-turn, with real processes', () => {
  it('lets the quit through only after the agent and the tool it started have exited', async () => {
    const agent: ChildProcess = spawn(process.execPath, ['-e', AGENT_WITH_A_TOOL], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: startsOwnGroup(),
      windowsHide: true
    })
    const [chunk] = (await once(agent.stdout as NonNullable<ChildProcess['stdout']>, 'data')) as [Buffer]
    const toolPid = Number(String(chunk).trim())
    const app = fakeApp()
    const quit = app.quit
    const quitReached = new Promise<{ agentExited: boolean; toolAlive: boolean }>((resolve) => {
      app.quit = () => {
        resolve({ agentExited: agent.exitCode !== null || agent.signalCode !== null, toolAlive: alive(toolPid) })
        quit()
      }
    })
    try {
      disposeBeforeQuit(app, {
        busy: () => true,
        dispose: async () => {
          await killProcessTree(agent)
        },
        timeoutMs: 30_000,
        release: () => {}
      })

      expect(app.beforeQuit()).toBe(true)

      expect(await quitReached).toEqual({ agentExited: true, toolAlive: false })
    } finally {
      for (const pid of [agent.pid, toolPid]) {
        try {
          process.kill(pid as number)
        } catch {
          // Already gone, which is what the test wants.
        }
      }
    }
  })
})
