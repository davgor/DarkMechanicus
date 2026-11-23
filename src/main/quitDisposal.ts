/**
 * Disposes agent processes before the app exits, then releases what the app holds open. Electron's
 * `before-quit` cannot wait for async work, so while processes are live the first quit is
 * prevented, they are disposed (each adapter kills its process tree with `killProcessTree` and
 * resolves once the tree is gone; bounded by `timeoutMs` so a stuck one cannot keep the app open),
 * `release` runs, and the quit is then repeated. Callers with asynchronous store closure can
 * also require this sequence when no chat is live. Otherwise, an idle quit starts both cleanup
 * steps and goes through immediately. In either case `release` runs once, and later quit events
 * pass through.
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
  /** Closes what the app holds open (workspaces, `app.sqlite`); runs once, after `dispose`. */
  release: () => void | Promise<void>
  /** Defer an idle quit until stores have closed. */
  waitForRelease?: boolean
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

async function releaseReportingErrors(options: QuitDisposalOptions): Promise<void> {
  try {
    await options.release()
  } catch (error) {
    options.onError?.(error)
  }
}

/** Disposes, releases, then quits again; `app.quit()` emits before-quit at once, so `letQuit` must run first. */
async function disposeThenQuit(app: QuitApp, options: QuitDisposalOptions, letQuit: () => void): Promise<void> {
  try {
    await waitAtMost(options.dispose(), options)
  } catch (error) {
    options.onError?.(error)
  }
  await releaseReportingErrors(options)
  letQuit()
  app.quit()
}

export function disposeBeforeQuit(app: QuitApp, options: QuitDisposalOptions): void {
  let state: 'running' | 'disposing' | 'done' = 'running'
  app.on('before-quit', (event) => {
    if (state === 'done') {
      return
    }
    if (state === 'running' && !options.busy() && !options.waitForRelease) {
      state = 'done'
      options.dispose().catch((error: unknown) => options.onError?.(error))
      releaseReportingErrors(options)
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
