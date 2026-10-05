/**
 * Disposes agent processes before the app exits. Electron's `before-quit` cannot wait for async
 * work, so while processes are live the first quit is prevented, they are disposed (each adapter
 * kills its process tree; bounded by `timeoutMs` so a stuck one cannot keep the app open), and
 * the quit is then repeated. With nothing live the quit goes straight through; `dispose` still
 * runs so nothing new starts. Free of Electron runtime imports so it can be unit tested.
 */

/** What this needs of Electron's `app`. */
export interface QuitApp {
  on(eventName: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown
  quit(): void
}

interface QuitDisposalOptions {
  /** True while there are processes to dispose. */
  busy: () => boolean
  dispose: () => Promise<void>
  /** The longest the quit waits for `dispose`. */
  timeoutMs: number
  timer?: { set(callback: () => void, ms: number): unknown }
  onError?: (error: unknown) => void
}

function waitAtMost(work: Promise<void>, options: QuitDisposalOptions): Promise<void> {
  const timer = options.timer ?? { set: (callback: () => void, ms: number) => setTimeout(callback, ms) }
  const timeout = new Promise<void>((resolve) => {
    timer.set(resolve, options.timeoutMs)
  })
  return Promise.race([work, timeout])
}

/** Disposes, then quits again; `app.quit()` emits before-quit at once, so `letQuit` must run first. */
async function disposeThenQuit(app: QuitApp, options: QuitDisposalOptions, letQuit: () => void): Promise<void> {
  try {
    await waitAtMost(options.dispose(), options)
  } catch (error) {
    options.onError?.(error)
  }
  letQuit()
  app.quit()
}

export function disposeBeforeQuit(app: QuitApp, options: QuitDisposalOptions): void {
  let state: 'running' | 'disposing' | 'done' = 'running'
  app.on('before-quit', (event) => {
    if (state === 'done') {
      return
    }
    if (state === 'running' && !options.busy()) {
      state = 'done'
      options.dispose().catch((error: unknown) => options.onError?.(error))
      return
    }
    event.preventDefault()
    if (state === 'running') {
      state = 'disposing'
      void disposeThenQuit(app, options, () => {
        state = 'done'
      })
    }
  })
}
