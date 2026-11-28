/**
 * The agent browser as main runs it, kept free of Electron imports (the view factory and the windows come in as deps)
 * so the whole join is tested with a real pipe and fakes: the settings, site lists and ownership, the host over the
 * main window, the dispatcher, and the browser pipe (`DM_BROWSER_PIPE`) whose every op the chat's live grant must
 * authorize with `browser.drive`.
 *
 * - The main window is found lazily at each attach, size and zoom read (red-team Fix 46): the bridge starts before
 *   the first window, and macOS can open a new one later. With no window, agent ops answer `no_tab`. When the window
 *   holding the views closes, every view is closed and recreated lazily in the next window.
 * - The pipe checks `browser.drive` before dispatch, after it and while it runs, through the grant's own workspace
 *   (`verifyChatGrant`); `authorize` (the grant registry's `authorizeBrowser`) has already refused other roles.
 * - The person's panel reaches the same host, ownership, settings and site lists through `registerIpc` (`browserIpc.ts`).
 * - Disposal closes the pipe (cancelling every op), then every view, then the screenshot copies.
 */
import type { IpcMain } from 'electron'
import { BROWSER_PROTOCOL } from '../../core/desktop/controlProtocol'
import type { BrowserState } from '../../shared/browser/browserApi'
import {
  BrowserControlError, type BrowserErrorCode, type BrowserOperation, type BrowserReply, type BrowserRequest
} from '../../shared/browser/browserControl'
import type { ChatImages } from '../agentChat/chatImages'
import type { ActivityBindings } from '../agents/activityBindings'
import { createControlServer, type ControlServerHandle, type ControlServerProtocol } from '../control/controlServer'
import type { FolderRegistry } from '../desktop/folderRegistry'
import { join } from 'node:path'
import { createBrowserDispatcher, type BrowserControlBinding, type BrowserDispatcher } from './browserDispatch'
import { createBrowserDriver, type BrowserDriver, type DriverContents } from './browserDriver'
import {
  createBrowserHardener, createBrowserHost, type AgentTab, type BrowserChatRef, type BrowserHost, type HostContents, type HostView
} from './browserHost'
import { createBrowserIpcHandlers, registerBrowserIpc, type PanelContents } from './browserIpc'
import { createBrowserOwnership, type BrowserOwnership, type OwnerLabelChat } from './browserOwnership'
import { BROWSER_WEB_PREFERENCES } from './browserSession'
import { createBrowserSettings, type BrowserSettings } from './browserSettings'
import { createBrowserShots, type BrowserShots } from './browserShots'
import { createSiteStore, type SiteStore } from './siteStore'

/** A view whose contents the driver can also drive and the panel move in history; Electron's `WebContentsView` satisfies it. */
export interface WiredView extends HostView {
  readonly webContents: HostContents & DriverContents & PanelContents
}

/** The parts of a `BrowserWindow` the browser uses, over its own view type. */
export interface BrowserWindowLike<View> {
  isDestroyed(): boolean
  readonly contentView: { addChildView(view: View): void; removeChildView(view: View): void }
  readonly webContents: { getZoomFactor(): number }
  getContentSize(): number[]
  isVisible(): boolean
  isMinimized(): boolean
  once(event: 'closed', listener: () => void): unknown
}

interface BrowserWiringDeps<View extends WiredView> {
  /** `<userData>/browser`: `settings.json` and the `sites` lists. */
  root: string
  /** The app's own page, which a tab never opens. */
  appUrl: string | null
  /** The tracked folders, which every panel request's folder must be one of. */
  registry: Pick<FolderRegistry, 'resolve'>
  /** Every open window, the main window first (`BrowserWindow.getAllWindows`). */
  windows(): readonly BrowserWindowLike<View>[]
  createView(webPreferences: typeof BROWSER_WEB_PREFERENCES & { partition: string }): View
  /** The live grant registry's `authorizeBrowser`. */
  authorize(token: string): BrowserControlBinding
  images: Pick<ChatImages, 'put'>
  /** The chat record (the chat store); null once it is gone. */
  chatFor(ref: BrowserChatRef): OwnerLabelChat | null
  /** The verified attempts bound to each chat's threads, and their ticket keys. */
  bindings: Pick<ActivityBindings, 'threadsOf'>
  ticketKeyOfAttempt(folder: string, attemptId: string): Promise<string | null>
  push(state: BrowserState): void
  log(line: string): void
  /** DNS for the session's address checks; the real resolver when omitted. */
  lookup?: (host: string) => Promise<readonly { address: string }[]>
  shots?: BrowserShots
}

export interface BrowserWiring {
  readonly host: BrowserHost
  readonly ownership: BrowserOwnership
  readonly settings: BrowserSettings
  readonly sites: SiteStore
  /** The pipe's address once it listens; undefined before that and when it failed to start. */
  address(): string | undefined
  /** Settles once the pipe listens; rejects (already logged) when it cannot. */
  readonly ready: Promise<void>
  /** Closes the pipe, then every view, then the uncollected screenshot copies. */
  dispose(): Promise<void>
  /** Registers the panel's `browser:*` channels on `ipc` (the sender-guarded registrar from `guardIpc`). */
  registerIpc(ipc: Pick<IpcMain, 'handle'>): void
}

/** The browser pipe's server side: status in its own lane, and `browser.drive` verified around every op. */
const BROWSER_SERVER_PROTOCOL: ControlServerProtocol<BrowserOperation, BrowserRequest, BrowserReply, BrowserErrorCode, BrowserControlBinding> = {
  ...BROWSER_PROTOCOL,
  laneOf: (operation) => (operation.op === 'browser_status' ? 'status' : 'write'),
  async verifyOperation(binding) {
    if (binding.verifyAuthority === undefined) throw new BrowserControlError('unauthorized')
    await binding.verifyAuthority('browser.drive')
  }
}

/** The ticket keys of the attempts bound to the chat's threads; a key that cannot be read is left out. */
async function boundTicketKeys(deps: Pick<BrowserWiringDeps<WiredView>, 'bindings' | 'ticketKeyOfAttempt'>, ref: BrowserChatRef): Promise<ReadonlySet<string>> {
  const folder = ref.folder
  if (folder === null) return new Set()
  const attempts = new Set(deps.bindings.threadsOf({ folder, id: ref.chatId }).flatMap((bound) => (bound.kind === 'attempt' ? [bound.attemptId] : [])))
  const keys = await Promise.all([...attempts].map((attemptId) => deps.ticketKeyOfAttempt(folder, attemptId).catch(() => null)))
  return new Set(keys.filter((key): key is string => key !== null))
}

/** Holds the views in the main window, found at each use; the window's close closes them all (`closeViews`). */
class WindowSlot<View> {
  private holder: BrowserWindowLike<View> | null = null

  constructor(private readonly windows: () => readonly BrowserWindowLike<View>[], private readonly onClosed: () => void) {}

  current(): BrowserWindowLike<View> | null {
    return this.windows().find((window) => !window.isDestroyed()) ?? null
  }

  attach(view: View): void {
    const window = this.current()
    if (window === null) return
    if (this.holder !== window) {
      this.holder = window
      window.once('closed', () => {
        if (this.holder !== window) return
        this.holder = null
        this.onClosed()
      })
    }
    window.contentView.addChildView(view)
  }

  detach(view: View): void {
    if (this.holder !== null && !this.holder.isDestroyed()) this.holder.contentView.removeChildView(view)
  }

  /** The window's content size in DIP; null with no window, or one hidden or minimized. */
  contentSize(): { width: number; height: number } | null {
    const window = this.current()
    if (window === null || !window.isVisible() || window.isMinimized()) return null
    const [width = 0, height = 0] = window.getContentSize()
    return { width, height }
  }
}

/** The browser pipe; a failure to start is logged and leaves no address, so chats launch without it. */
function listen(deps: Pick<BrowserWiringDeps<WiredView>, 'authorize' | 'log'>, dispatch: BrowserDispatcher['dispatch']): Pick<BrowserWiring, 'ready' | 'address'> & { close(): Promise<void> } {
  let server: ControlServerHandle | null = null
  const ready = createControlServer({
    protocol: BROWSER_SERVER_PROTOCOL, authorize: deps.authorize, dispatch, addressPrefix: { unix: 'dm-b-', win32: 'dm-browser-' }
  }).then((handle) => { server = handle })
  ready.catch((error: unknown) => deps.log(`Browser transport failed: ${error instanceof Error ? error.message : String(error)}`))
  return {
    ready,
    address: () => server?.address,
    close: () => ready.then(() => server?.close(), () => undefined)
  }
}

/** The views as the deps made them, which the window takes, and each tab's driver and history controls. */
function wiredViews<View extends WiredView>(createView: BrowserWiringDeps<View>['createView'], slot: WindowSlot<View>) {
  const views = new WeakMap<HostView, View>()
  const drivers = new WeakMap<HostContents, BrowserDriver>()
  const panels = new WeakMap<HostContents, PanelContents>()
  return {
    createView: (webPreferences: Parameters<typeof createView>[0]): HostView => {
      const view = createView(webPreferences)
      views.set(view, view)
      drivers.set(view.webContents, createBrowserDriver(view.webContents))
      panels.set(view.webContents, view.webContents)
      return view
    },
    attach: (view: HostView) => { const wired = views.get(view); if (wired !== undefined) slot.attach(wired) },
    detach: (view: HostView) => { const wired = views.get(view); if (wired !== undefined) slot.detach(wired) },
    driverFor: (tab: AgentTab): BrowserDriver => {
      const driver = drivers.get(tab.contents)
      if (driver === undefined) throw new BrowserControlError('no_tab')
      return driver
    },
    contentsFor: (tab: AgentTab): PanelContents => {
      const contents = panels.get(tab.contents)
      if (contents === undefined) throw new BrowserControlError('no_tab')
      return contents
    }
  }
}

export function startBrowser<View extends WiredView>(deps: BrowserWiringDeps<View>): BrowserWiring {
  const settings = createBrowserSettings({ root: deps.root })
  const sites = createSiteStore({ root: join(deps.root, 'sites'), log: deps.log })
  const ownership = createBrowserOwnership()
  const shots = deps.shots ?? createBrowserShots()
  let dispatcher: BrowserDispatcher | null = null
  const slot = new WindowSlot(deps.windows, () => host.closeViews())
  const views = wiredViews(deps.createView, slot)
  const host: BrowserHost = createBrowserHost({
    createView: views.createView,
    attach: views.attach,
    detach: views.detach,
    zoomFactor: () => slot.current()?.webContents.getZoomFactor() ?? 1,
    windowContentSize: () => slot.contentSize(),
    appUrl: deps.appUrl,
    sites,
    harden: createBrowserHardener({
      appUrl: deps.appUrl, log: deps.log, lookup: deps.lookup, frameAllowed: (webContentsId, url) => host.frameAllowed(webContentsId, url)
    }),
    ownership,
    ownerLabel: (ref, owner) => dispatcher?.ownerLabel(ref, owner) ?? null,
    enabled: () => settings.enabled(),
    push: deps.push,
    log: deps.log
  })
  dispatcher = createBrowserDispatcher({
    host, ownership, settings, shots, images: deps.images, chatFor: deps.chatFor,
    hasWindow: () => slot.current() !== null,
    boundTicketKeys: (ref) => boundTicketKeys(deps, ref),
    driverFor: views.driverFor
  })
  const pipe = listen(deps, dispatcher.dispatch)
  return {
    host, ownership, settings, sites, ready: pipe.ready, address: pipe.address,
    dispose: async () => {
      await pipe.close()
      host.dispose()
      await shots.dispose()
    },
    registerIpc: (ipc) => registerBrowserIpc(ipc, createBrowserIpcHandlers({
      registry: deps.registry, host, ownership, settings, sites, driverFor: views.driverFor, contentsFor: views.contentsFor,
      onUnexpectedError: (error) => deps.log(`Browser request failed: ${error instanceof Error ? error.message : String(error)}`)
    }))
  }
}
