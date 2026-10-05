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
      timer: manualTimer()
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
    disposeBeforeQuit(app, { busy: () => false, dispose: async () => void disposals.push(1), timeoutMs: 5_000 })

    expect(app.beforeQuit()).toBe(false)
    await settle()
    expect(disposals).toEqual([1])
    expect(app.quits).toBe(0)
  })
})

describe('disposeBeforeQuit when disposing does not finish', () => {
  it('quits anyway when disposing hangs past the timeout or fails', async () => {
    const hung = fakeApp()
    const timer = manualTimer()
    disposeBeforeQuit(hung, { busy: () => true, dispose: () => new Promise(() => {}), timeoutMs: 5_000, timer })
    hung.beforeQuit()
    await settle()
    expect(hung.quits).toBe(0)
    timer.fire()
    await settle()
    expect([hung.quits, hung.lastQuitPrevented, timer.delays]).toEqual([1, false, [5_000]])

    const failing = fakeApp()
    const errors: unknown[] = []
    disposeBeforeQuit(failing, { busy: () => true, dispose: () => Promise.reject(new Error('stuck')), timeoutMs: 5_000, timer: manualTimer(), onError: (error) => errors.push(error) })
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
        timeoutMs: 30_000
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
