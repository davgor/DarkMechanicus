import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'

/** How many app-wide overlays (the image Lightbox, modal dialogs) are open in this document. */
interface OverlayStore {
  /** Counts one overlay open until the returned function closes it. */
  open(): () => void
  subscribe(listener: () => void): () => void
  count(): number
}

function createOverlayStore(): OverlayStore {
  let open = 0
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  return {
    open() {
      open += 1
      notify()
      let closed = false
      return () => {
        if (closed) return
        closed = true
        open -= 1
        notify()
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    count: () => open
  }
}

/**
 * The renderer is one document, so its single default store serves the whole app: an overlay anywhere and the Browser
 * panel see the same count without a provider.
 */
const OverlayContext = createContext<OverlayStore>(createOverlayStore())

/**
 * Marks an app-wide overlay open while the calling component is mounted. The in-app browser's native view draws over
 * every renderer element, so the Browser panel hides it while any overlay is open (red-team Fix 57).
 */
export function useOverlayOpen(): void {
  const store = useContext(OverlayContext)
  useEffect(() => store.open(), [store])
}

/** True while any overlay registered with `useOverlayOpen` is mounted. */
export function useAnyOverlayOpen(): boolean {
  const store = useContext(OverlayContext)
  return useSyncExternalStore(store.subscribe, () => store.count() > 0)
}
