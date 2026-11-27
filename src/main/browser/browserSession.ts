/**
 * Locks down the agent browser's session (partition) and page contents. Kept free of Electron imports, like
 * `hardenWebContents` in `src/main/desktop/navigation.ts`: both functions take only the hooks they call, so every rule
 * is unit tested with fakes. Main applies them to every agent view and every sign-in (private) view.
 *
 * - Partitions are never the default session. An agent tab uses its folder's persistent partition, named by the
 *   durable `folderStoreId` (never the per-run attachment key). The Sign-in tab is the person's private scratch tab:
 *   an in-memory partition per tab, never visible to agents, whose cookies are never shared with an agent partition.
 *   Sign-in for agent work happens in the agent tab itself, under Take control.
 * - No protocol handler is ever registered on these sessions, so the app's `dm-attachment:` and `dm-chat-image:`
 *   schemes (registered on the default session only) are unreachable from a page (docs/reports/agent-browser.md item 5).
 * - Every permission is denied, downloads are cancelled, HTTP auth, client certificates and device choosers (HID,
 *   serial, USB, Bluetooth) are refused, popups are denied and every navigation goes through the origin policy.
 * - WebRTC may not send UDP outside a proxy, since ICE and STUN traffic bypasses `webRequest` and could otherwise reach
 *   loopback and LAN hosts.
 * - Known compatibility trade-off: the origin policy refuses `about:srcdoc`, so `srcdoc` iframes are denied by
 *   `will-frame-navigate`. That stays fail closed.
 * - Requests are checked by literal host (`decideSubresource`), by every address a host name resolves to, and by the
 *   address the response actually came from (`details.ip`), so a DNS name or a rebinding cannot reach a refused host.
 */
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { CHAT_IMAGE_SCHEME } from '../../shared/agents/chatImageUrl'
import { ATTACHMENT_SCHEME } from '../../shared/desktop/attachmentUrl'
import {
  classifyHost,
  decideNavigation,
  decideSubresource,
  normalizeTarget,
  type AllowedSites,
  type HostClass
} from './originPolicy'

/** The view's web preferences: sandboxed, isolated, no Node and no preload. Main adds the tab's `partition`. */
export const BROWSER_WEB_PREFERENCES = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  spellcheck: false
})

const FOLDER_STORE_ID = /^[0-9a-f]{32}$/

/**
 * The persistent partition of a folder's agent tabs, `persist:dm-browser-<folderStoreId>`, or
 * `persist:dm-browser-projectless` for a chat of no folder. Throws for anything but a `folderStoreId`, so a per-run
 * attachment key or an empty id can never name (or collapse into) a shared partition.
 */
export function agentPartition(folderStoreId: string | null): string {
  if (folderStoreId === null) return 'persist:dm-browser-projectless'
  if (!FOLDER_STORE_ID.test(folderStoreId)) throw new Error('agentPartition needs a folderStoreId')
  return `persist:dm-browser-${folderStoreId}`
}

/**
 * A fresh in-memory partition for one Sign-in (private) tab, discarded when the tab closes. Its cookies never reach
 * an agent partition, so a sign-in there does not carry over to agent work.
 */
export function signInPartition(): string {
  return `dm-browser-signin-${randomUUID()}`
}

/** The app's own schemes, registered on the default session only; a browser session must never handle them. */
const APP_SCHEMES: readonly string[] = [ATTACHMENT_SCHEME, CHAT_IMAGE_SCHEME]

type ResourceType = 'mainFrame' | 'subFrame' | string

interface RequestDetails {
  url: string
  resourceType: ResourceType
  /** The requesting frame; null or throwing once it has navigated away or been destroyed. */
  frame?: { readonly url: string } | null
  webContents?: { getURL(): string }
}

interface ResponseDetails extends RequestDetails {
  /** The address the response came from. Electron sets it at runtime though its typings omit it. */
  ip?: string
}

interface DownloadItemLike {
  getURL(): string
  cancel(): void
}

interface PreventableEvent {
  preventDefault(): void
}

interface HardenableSession {
  setPermissionRequestHandler(
    handler: (webContents: unknown, permission: string, callback: (granted: boolean) => void) => void
  ): void
  setPermissionCheckHandler(handler: () => boolean): void
  setDevicePermissionHandler(handler: () => boolean): void
  on(event: 'will-download', listener: (event: PreventableEvent, item: DownloadItemLike) => void): unknown
  on(event: 'select-hid-device', listener: (event: PreventableEvent, details: unknown, callback: () => void) => void): unknown
  on(event: 'select-usb-device', listener: (event: PreventableEvent, details: unknown, callback: () => void) => void): unknown
  on(
    event: 'select-serial-port',
    listener: (event: PreventableEvent, ports: unknown, webContents: unknown, callback: (portId: string) => void) => void
  ): unknown
  protocol: { isProtocolHandled(scheme: string): boolean }
  webRequest: {
    onBeforeRequest(listener: (details: RequestDetails, callback: (response: { cancel?: boolean }) => void) => void): void
    onHeadersReceived(
      listener: (details: ResponseDetails, callback: (response: { cancel?: boolean }) => void) => void
    ): void
  }
}

interface SessionDeps {
  /** Every address a host name resolves to (`dns.promises.lookup(host, { all: true })`). */
  lookup: (host: string) => Promise<readonly { address: string }[]>
  log: (line: string) => void
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/** The origin of the page making a request: its frame's, else its tab's; null when neither is known. */
function pageOriginOf(details: RequestDetails): string | null {
  try {
    const url = details.frame?.url ?? details.webContents?.getURL()
    return url === undefined ? null : originOf(url)
  } catch {
    return null
  }
}

const isFrame = (details: RequestDetails): boolean =>
  details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'

const isLocal = (hostClass: HostClass): boolean => hostClass === 'loopback' || hostClass === 'private'

/**
 * Whether a request may reach a host of `hostClass`. A frame (whose navigation the origin policy already approved)
 * may reach any host but a blocked one; a subresource may reach a loopback or private host only from a page that is
 * itself loopback or private.
 */
function reachable(details: RequestDetails, hostClass: HostClass): boolean {
  if (hostClass === 'blocked') return false
  if (isFrame(details) || !isLocal(hostClass)) return true
  const page = pageOriginOf(details)
  return page !== null && isLocal(classifyHost(new URL(page).hostname))
}

/** The literal-host verdict: the origin policy's target rules for a frame, its subresource rules otherwise. */
function literallyAllowed(details: RequestDetails): boolean {
  if (isFrame(details)) return !('refused' in normalizeTarget(details.url))
  return decideSubresource(details.url, pageOriginOf(details)) === 'allow'
}

/** The host name a request would resolve through DNS, or null for an address literal or an inline payload. */
function resolvableName(url: string): string | null {
  const parsed = new URL(url)
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return null
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1')
  return isIP(host) === 0 && classifyHost(host) === 'public' ? host : null
}

/** Whether every address the request's host name resolves to is reachable; a failed lookup refuses (fail closed). */
async function resolvesReachable(details: RequestDetails, deps: SessionDeps): Promise<boolean> {
  const name = resolvableName(details.url)
  if (name === null) return true
  try {
    const addresses = await deps.lookup(name)
    return addresses.length > 0 && addresses.every(({ address }) => reachable(details, classifyHost(address)))
  } catch {
    return false
  }
}

/**
 * Locks a browser partition down: denies every permission request and check (devices included), refuses every HID,
 * USB and serial device chooser, cancels every download (logging `browser download cancelled <origin>` once per
 * item), cancels requests the origin policy refuses by literal host or by resolved address, and cancels a response
 * whose connected address is refused (DNS rebinding). Throws when an app scheme is handled on the session: these
 * sessions must never get a protocol handler.
 */
export function hardenBrowserSession(session: HardenableSession, deps: SessionDeps): void {
  const handled = APP_SCHEMES.filter((scheme) => session.protocol.isProtocolHandled(scheme))
  if (handled.length > 0) throw new Error(`browser session handles app scheme ${handled.join(', ')}`)
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  // Answering with no device (an empty port id for serial) cancels the chooser; the page gets NotFoundError.
  session.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault()
    callback()
  })
  session.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault()
    callback()
  })
  session.on('select-serial-port', (event, _ports, _webContents, callback) => {
    event.preventDefault()
    callback('')
  })
  session.on('will-download', (event, item) => {
    event.preventDefault()
    item.cancel()
    deps.log(`browser download cancelled ${originOf(item.getURL()) ?? 'null'}`)
  })
  session.webRequest.onBeforeRequest((details, callback) => {
    // Answered asynchronously once DNS is in; any throw (an unparsable URL included) cancels.
    void Promise.resolve(details)
      .then(async (request) => literallyAllowed(request) && (await resolvesReachable(request, deps)))
      .then(
        (allowed) => callback(allowed ? {} : { cancel: true }),
        () => callback({ cancel: true })
      )
  })
  session.webRequest.onHeadersReceived((details, callback) => {
    if (details.ip === undefined || details.ip === '' || reachable(details, classifyHost(details.ip))) {
      callback({})
      return
    }
    deps.log(`browser response cancelled ${originOf(details.url) ?? 'null'}: connected to a refused address`)
    callback({ cancel: true })
  })
}

interface NavigationDetails {
  url: string
  /** False for a subframe (`will-frame-navigate` of an iframe); a subframe never asks. */
  isMainFrame?: boolean
  preventDefault(): void
}

interface HardenableContents {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  on(event: 'will-navigate', listener: (details: NavigationDetails) => void): unknown
  on(event: 'will-redirect', listener: (details: NavigationDetails) => void): unknown
  on(event: 'will-frame-navigate', listener: (details: NavigationDetails) => void): unknown
  on(event: 'devtools-opened', listener: () => void): unknown
  on(
    event: 'login',
    listener: (event: PreventableEvent, details: unknown, authInfo: unknown, callback: () => void) => void
  ): unknown
  /** Electron types the callback's certificate as required; called with none, it continues without one. */
  on(
    event: 'select-client-certificate',
    listener: (event: PreventableEvent, url: string, certificates: unknown, callback: (...none: never[]) => void) => void
  ): unknown
  on(
    event: 'select-bluetooth-device',
    listener: (event: PreventableEvent, devices: unknown, callback: (deviceId: string) => void) => void
  ): unknown
  setWebRTCIPHandlingPolicy(policy: 'disable_non_proxied_udp'): void
  closeDevTools(): void
}

interface ContentsDeps {
  /** The app's own page (dev server or packaged file), which a tab never opens; null when none. */
  appUrl: string | null
  /** The tab's allowed sites at the moment of a navigation. */
  sites: () => AllowedSites
  /** A navigation to an origin the person has not approved: show the new-origin card. */
  onAsk: (origin: string, url: string) => void
  /** A page tried to open a window, which is always denied. */
  onPopupBlocked: (url: string) => void
}

/**
 * Locks a browser tab's page down: popups are denied and reported, every navigation, redirect and frame navigation is
 * decided by the origin policy (`allow` proceeds, `ask` prevents and asks the person, `deny` prevents), DevTools are
 * closed as soon as they open, HTTP auth, client-certificate and Bluetooth chooser requests are refused, and WebRTC
 * sends no UDP outside a proxy. A subframe (an ad or embed) to an unlisted origin is denied silently and never asks,
 * so iframes cannot spam the person with cards (red-team Fix 50).
 */
export function hardenBrowserContents(contents: HardenableContents, deps: ContentsDeps): void {
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  contents.setWindowOpenHandler(({ url }) => {
    deps.onPopupBlocked(url)
    return { action: 'deny' }
  })
  const guard = (details: NavigationDetails): void => {
    const target = normalizeTarget(details.url, deps.appUrl)
    const decision = decideNavigation(target, deps.sites())
    if (decision === 'allow') return
    details.preventDefault()
    if (decision === 'ask' && details.isMainFrame !== false && 'origin' in target && target.origin !== null) {
      deps.onAsk(target.origin, target.href)
    }
  }
  // A main-frame navigation fires will-frame-navigate first and will-navigate only if that was not prevented
  // (probed on Electron 42), so the person is asked once.
  contents.on('will-frame-navigate', guard)
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.on('devtools-opened', () => contents.closeDevTools())
  contents.on('login', (event, _details, _authInfo, callback) => {
    event.preventDefault()
    callback()
  })
  contents.on('select-client-certificate', (event, _url, _certificates, callback) => {
    event.preventDefault()
    callback()
  })
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault()
    callback('')
  })
}
