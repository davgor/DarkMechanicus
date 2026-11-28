/** Stand-ins for the Electron views and windows the browser wiring drives, shared by its tests. */
import { vi } from 'vitest'
import type { BrowserWindowLike, WiredView } from '../browserWiring'

type Listener = (...args: never[]) => unknown
export type BeforeRequest = (details: Record<string, unknown>, callback: (answer: { cancel?: boolean }) => void) => void

let nextId = 100

/** A stand-in for a `WebContentsView`: what the host, the hardener and the driver call. */
export function fakeView(beforeRequests: Map<string, BeforeRequest>, partition: string) {
  const listeners = new Map<string, Listener[]>()
  let url = ''
  const session = {
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(), on: vi.fn(),
    protocol: { isProtocolHandled: () => false },
    webRequest: { onBeforeRequest: (listener: BeforeRequest) => { beforeRequests.set(partition, listener) }, onHeadersReceived: vi.fn() }
  }
  const webContents = {
    id: nextId++, session, loadURL: vi.fn(async (next: string) => { url = next }), getURL: () => url, getTitle: () => '',
    isDestroyed: vi.fn(() => false), close: vi.fn(), executeJavaScriptInIsolatedWorld: vi.fn(async () => true),
    setWindowOpenHandler: vi.fn(), setWebRTCIPHandlingPolicy: vi.fn(), closeDevTools: vi.fn(),
    debugger: { attach: vi.fn(), detach: vi.fn(), isAttached: () => true, sendCommand: vi.fn(async () => ({ nodes: [] })), on: vi.fn() },
    capturePage: vi.fn(), stop: vi.fn(), reload: vi.fn(),
    navigationHistory: { getActiveIndex: () => 0, length: () => 1, getEntryAtIndex: () => ({ url }), goBack: vi.fn(), goForward: vi.fn() },
    on(event: string, listener: Listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); return webContents }
  }
  return { webContents, setBounds: vi.fn(), setVisible: vi.fn() }
}
export type FakeView = ReturnType<typeof fakeView>

/**
 * A main window. Like Electron's, a destroyed window throws when asked for its zoom; `destroy` destroys it without
 * the `closed` event (which `close` fires), as a window torn down before its listeners ran.
 */
export function fakeWindow(options: { zoom?: number; size?: number[] } = {}) {
  const onClosed: (() => void)[] = []
  const state = { destroyed: false, visible: true, minimized: false }
  const window = {
    isDestroyed: () => state.destroyed, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: {
      getZoomFactor: () => {
        if (state.destroyed) throw new Error('Object has been destroyed')
        return options.zoom ?? 1
      }
    },
    getContentSize: () => options.size ?? [1440, 900], isVisible: () => state.visible, isMinimized: () => state.minimized,
    once: (_event: 'closed', listener: () => void) => { onClosed.push(listener) }
  } satisfies BrowserWindowLike<WiredView>
  return {
    window, state,
    destroy: () => { state.destroyed = true },
    close: () => { state.destroyed = true; for (const listener of onClosed) listener() },
    /** Fires the `closed` listeners again, as a late event from a window already replaced. */
    fireClosed: () => { for (const listener of onClosed) listener() }
  }
}
