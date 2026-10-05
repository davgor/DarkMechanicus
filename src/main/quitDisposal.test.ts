import { describe, expect, it } from 'vitest'
import { disposeBeforeQuit, type QuitApp } from './quitDisposal'

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
