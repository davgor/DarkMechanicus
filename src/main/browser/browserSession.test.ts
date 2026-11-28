import type { Session, WebContents } from 'electron'
import { describe, expect, expectTypeOf, it, vi, type Mock } from 'vitest'
import { folderStoreId } from '../agentChat/folderStoreId'
import {
  BROWSER_WEB_PREFERENCES,
  agentPartition,
  hardenBrowserContents,
  hardenBrowserSession,
  signInPartition
} from './browserSession'
import type { AllowedSites } from './originPolicy'

type Listener = (...args: never[]) => unknown
interface WebRequestAnswer {
  cancel?: boolean
}
type WebRequestListener = (
  details: { url: string; resourceType: string },
  callback: (answer: WebRequestAnswer) => void
) => void

interface RequestInput {
  url: string
  resourceType?: string
  /** The requesting frame's URL; null for a frame that is gone. */
  page?: string | null
  ip?: string
}

/** A recording stand-in for an Electron session. `protocol.handle` throws: hardening must never register one. */
function fakeSession(handledSchemes: readonly string[] = []) {
  const listeners = new Map<string, Listener>()
  const handlers: {
    permissionRequest?: (wc: unknown, permission: string, callback: (granted: boolean) => void) => void
    permissionCheck?: () => boolean
    devicePermission?: () => boolean
    beforeRequest?: WebRequestListener
    headersReceived?: WebRequestListener
  } = {}
  const handle = vi.fn(() => {
    throw new Error('protocol.handle must never be called on a browser session')
  })
  const session = {
    setPermissionRequestHandler: (handler: typeof handlers.permissionRequest) => void (handlers.permissionRequest = handler),
    setPermissionCheckHandler: (handler: typeof handlers.permissionCheck) => void (handlers.permissionCheck = handler),
    setDevicePermissionHandler: (handler: typeof handlers.devicePermission) => void (handlers.devicePermission = handler),
    on: (event: string, listener: Listener) => listeners.set(event, listener),
    protocol: { isProtocolHandled: (scheme: string) => handledSchemes.includes(scheme), handle },
    webRequest: {
      onBeforeRequest: (listener: WebRequestListener) => void (handlers.beforeRequest = listener),
      onHeadersReceived: (listener: WebRequestListener) => void (handlers.headersReceived = listener)
    }
  }
  return { session, handle, listeners, handlers }
}

const detailsOf = ({ url, resourceType = 'xhr', page = 'https://page.example/', ip }: RequestInput) => ({
  url,
  resourceType,
  frame: page === null ? null : { url: page },
  ...(ip === undefined ? {} : { ip })
})

function hardened(dns: Record<string, readonly string[]> = {}, frameAllowed: (details: { url: string; webContentsId?: number }) => boolean = () => true) {
  const fake = fakeSession()
  const log = vi.fn<(line: string) => void>()
  const lookup = vi.fn(async (host: string) => {
    const addresses = dns[host]
    if (addresses === undefined) throw new Error(`ENOTFOUND ${host}`)
    return addresses.map((address) => ({ address }))
  })
  hardenBrowserSession(fake.session, { lookup, log, frameAllowed })
  const { handlers } = fake
  return {
    ...fake,
    log,
    lookup,
    requestPermission(permission: string): boolean | undefined {
      let granted: boolean | undefined
      handlers.permissionRequest?.(null, permission, (answer) => (granted = answer))
      return granted
    },
    /** The asynchronous onBeforeRequest answer for raw details. */
    requestRaw(details: { url: string; resourceType: string; [field: string]: unknown }): Promise<WebRequestAnswer> {
      // The repository's ES library predates Promise.withResolvers.
      return new Promise((resolve) => handlers.beforeRequest?.(details, resolve))
    },
    request(input: RequestInput): Promise<WebRequestAnswer> {
      return this.requestRaw(detailsOf(input))
    },
    respond(input: RequestInput): WebRequestAnswer | undefined {
      let answer: WebRequestAnswer | undefined
      handlers.headersReceived?.(detailsOf(input), (response) => (answer = response))
      return answer
    }
  }
}

const CANCEL = { cancel: true }
const PASS = {}

describe('hardenBrowserSession permissions and downloads', () => {
  it.each([
    'media',
    'geolocation',
    'notifications',
    'clipboard-read',
    'clipboard-sanitized-write',
    'display-capture',
    'fullscreen',
    'pointerLock',
    'keyboardLock',
    'openExternal',
    'midi',
    'midiSysex',
    'mediaKeySystem',
    'idle-detection',
    'storage-access',
    'top-level-storage-access',
    'window-management',
    'speaker-selection',
    'fileSystem',
    'unknown'
  ])('denies the %s permission request', (permission) => {
    expect(hardened().requestPermission(permission)).toBe(false)
  })

  it('denies every permission check and every device permission', () => {
    const { handlers } = hardened()
    expect(handlers.permissionCheck?.()).toBe(false)
    expect(handlers.devicePermission?.()).toBe(false)
  })

  it('cancels every download and logs it once per item by origin, never a payload or an unparsable URL', () => {
    const fake = hardened()
    const downloads = ['https://files.example/dm-e2e-1.bin?token=x', 'http://127.0.0.1:8123/download', 'data:text/plain,secret-payload', 'not a url'].map((url) => ({
      event: { preventDefault: vi.fn() },
      item: { getURL: () => url, cancel: vi.fn() }
    }))
    const listener = fake.listeners.get('will-download') as (event: object, item: object) => void
    for (const { event, item } of downloads) listener(event, item)
    for (const { event, item } of downloads) {
      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(item.cancel).toHaveBeenCalledOnce()
    }
    expect(fake.log.mock.calls).toEqual([
      ['browser download cancelled https://files.example'],
      ['browser download cancelled http://127.0.0.1:8123'],
      ['browser download cancelled null'],
      ['browser download cancelled null']
    ])
  })
})

describe('hardenBrowserSession device choosers', () => {
  it.each([
    ['select-hid-device', [{ deviceList: [{ deviceId: 'hid-1' }] }], []],
    ['select-usb-device', [{ deviceList: [{ deviceId: 'usb-1' }] }], []],
    ['select-serial-port', [[{ portId: 'COM3' }], {}], ['']]
  ])('answers %s with no device', (event, args, answer) => {
    const fake = hardened()
    const preventDefault = vi.fn()
    const callback = vi.fn()
    ;(fake.listeners.get(event) as (...a: unknown[]) => void)({ preventDefault }, ...args, callback)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(...answer)
  })
})

describe('hardenBrowserSession app schemes', () => {
  it('never registers a protocol handler, and app-scheme requests are cancelled', async () => {
    const fake = hardened()
    expect(await fake.request({ url: 'dm-attachment://key/id' })).toEqual(CANCEL)
    expect(await fake.request({ url: 'dm-chat-image://key/chat/image', resourceType: 'image' })).toEqual(CANCEL)
    expect(await fake.request({ url: 'dm-attachment://key/id', resourceType: 'mainFrame' })).toEqual(CANCEL)
    expect(fake.handle).not.toHaveBeenCalled()
  })

  it.each(['dm-attachment', 'dm-chat-image'])('refuses to harden a session that handles %s', (scheme) => {
    const fake = fakeSession([scheme])
    expect(() => hardenBrowserSession(fake.session, { lookup: vi.fn(), log: vi.fn(), frameAllowed: vi.fn() })).toThrow(scheme)
    expect(fake.handlers.beforeRequest).toBeUndefined()
    expect(fake.handle).not.toHaveBeenCalled()
  })
})

describe('hardenBrowserSession requests by literal host', () => {
  const dns = { 'cdn.example': ['93.184.216.34'] }

  it.each([
    'file:///C:/Users/dev/secret.txt',
    'chrome://settings',
    'ftp://cdn.example/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://[fd00:ec2::254]/',
    'http://100.100.100.200/',
    'http://[::ffff:169.254.169.254]/',
    'https://user:pass@cdn.example/',
    `https://cdn.example/?grant=dmg_${'0123456789abcdef'.repeat(2)}`,
    'http://127.0.0.1:5173/',
    'http://localhost:3000/api',
    'http://192.168.1.10/',
    'ws://10.0.0.5/socket',
    'not a url'
  ])('cancels the subresource %s from a public page', async (url) => {
    expect(await hardened(dns).request({ url })).toEqual(CANCEL)
  })

  it.each([
    'https://cdn.example/app.js',
    'wss://cdn.example/socket',
    'data:image/png;base64,AAAA',
    'blob:https://page.example/1234'
  ])('lets the subresource %s through from a public page', async (url) => {
    expect(await hardened(dns).request({ url })).toEqual(PASS)
  })
})

describe('hardenBrowserSession requests by page and frame', () => {
  it('lets a loopback or private page reach loopback and private hosts, never blocked ones', async () => {
    const fake = hardened()
    expect(await fake.request({ url: 'http://127.0.0.1:5173/x', page: 'http://localhost:5173/' })).toEqual(PASS)
    expect(await fake.request({ url: 'http://192.168.1.10/x', page: 'http://10.0.0.2/' })).toEqual(PASS)
    expect(await fake.request({ url: 'http://169.254.169.254/', page: 'http://localhost:5173/' })).toEqual(CANCEL)
  })

  it('lets an approved frame navigation reach a loopback host, never a refused target', async () => {
    const fake = hardened()
    expect(await fake.request({ url: 'http://localhost:5173/', resourceType: 'mainFrame' })).toEqual(PASS)
    expect(await fake.request({ url: 'http://10.0.0.5/', resourceType: 'subFrame' })).toEqual(PASS)
    expect(await fake.request({ url: 'file:///C:/Windows/win.ini', resourceType: 'mainFrame' })).toEqual(CANCEL)
    expect(await fake.request({ url: 'http://169.254.169.254/', resourceType: 'subFrame' })).toEqual(CANCEL)
    expect(await fake.request({ url: 'https://u:p@localhost/', resourceType: 'mainFrame' })).toEqual(CANCEL)
  })

  it("uses the tab's URL when the frame is gone and refuses local hosts when no page is known", async () => {
    const fake = hardened()
    const local = 'http://127.0.0.1:1/'
    const tab = { getURL: () => 'http://localhost:1/' }
    expect(await fake.requestRaw({ url: local, resourceType: 'xhr', frame: null, webContents: tab })).toEqual(PASS)
    const disposed = {
      get url(): string {
        throw new Error('Render frame was disposed')
      }
    }
    expect(await fake.requestRaw({ url: local, resourceType: 'xhr', frame: disposed, webContents: tab })).toEqual(CANCEL)
    expect(await fake.requestRaw({ url: local, resourceType: 'xhr' })).toEqual(CANCEL)
  })
})

describe('hardenBrowserSession requests by resolved address', () => {
  it.each([
    ['metadata.example', ['169.254.169.254']],
    ['rebind.example', ['93.184.216.34', '127.0.0.1']],
    ['intranet.example', ['10.1.2.3']],
    ['mapped.example', ['::ffff:169.254.169.254']],
    ['v6local.example', ['::1']],
    ['empty.example', []]
  ])('cancels a subresource on %s resolving to %j', async (host, addresses) => {
    const fake = hardened({ [host]: addresses })
    expect(await fake.request({ url: `https://${host}/x` })).toEqual(CANCEL)
    expect(fake.lookup).toHaveBeenCalledWith(host)
  })

  it('cancels when the name does not resolve', async () => {
    expect(await hardened().request({ url: 'https://nowhere.example/' })).toEqual(CANCEL)
  })

  it('lets a name resolving only to public addresses through', async () => {
    const fake = hardened({ 'cdn.example': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] })
    expect(await fake.request({ url: 'https://cdn.example/app.js' })).toEqual(PASS)
  })

  it('lets a local page reach a name resolving to a private address, never a blocked one', async () => {
    const fake = hardened({ 'nas.lan.example': ['192.168.1.20'], 'meta.example': ['169.254.169.254'] })
    expect(await fake.request({ url: 'http://nas.lan.example/', page: 'http://localhost:5173/' })).toEqual(PASS)
    expect(await fake.request({ url: 'http://meta.example/', page: 'http://localhost:5173/' })).toEqual(CANCEL)
  })

  it('checks frame navigations by resolved address too, refusing only blocked addresses', async () => {
    const fake = hardened({ 'dev.example': ['127.0.0.1'], 'meta.example': ['fe80::1'] })
    expect(await fake.request({ url: 'http://dev.example/', resourceType: 'mainFrame' })).toEqual(PASS)
    expect(await fake.request({ url: 'http://meta.example/', resourceType: 'mainFrame' })).toEqual(CANCEL)
  })

  it('never looks up an address literal, localhost or an inline payload', async () => {
    const fake = hardened()
    await fake.request({ url: 'https://93.184.216.34/' })
    await fake.request({ url: 'http://[2606:2800:220:1::1]/' })
    await fake.request({ url: 'http://localhost:1/', page: 'http://localhost:1/' })
    await fake.request({ url: 'data:text/plain,hi' })
    expect(fake.lookup).not.toHaveBeenCalled()
  })
})

describe('hardenBrowserSession connected address (DNS rebinding)', () => {
  it('cancels a response from a blocked address and logs it by origin', () => {
    const fake = hardened()
    expect(fake.respond({ url: 'https://cdn.example/x?token=1', ip: '169.254.169.254' })).toEqual(CANCEL)
    expect(fake.respond({ url: 'https://cdn.example/', resourceType: 'mainFrame', ip: 'fd00:ec2::254' })).toEqual(CANCEL)
    expect(fake.log).toHaveBeenCalledWith('browser response cancelled https://cdn.example: connected to a refused address')
  })

  it('cancels a subresource of a public page served from a loopback or private address', () => {
    const fake = hardened()
    expect(fake.respond({ url: 'https://evil.example/api', ip: '127.0.0.1' })).toEqual(CANCEL)
    expect(fake.respond({ url: 'https://evil.example/api', ip: '10.0.0.8' })).toEqual(CANCEL)
  })

  it('passes public addresses, local pages, approved frames and responses without an address', () => {
    const fake = hardened()
    expect(fake.respond({ url: 'https://cdn.example/x', ip: '93.184.216.34' })).toEqual(PASS)
    expect(fake.respond({ url: 'http://dev.example/x', page: 'http://localhost:1/', ip: '127.0.0.1' })).toEqual(PASS)
    expect(fake.respond({ url: 'http://dev.example/', resourceType: 'mainFrame', ip: '127.0.0.1' })).toEqual(PASS)
    expect(fake.respond({ url: 'https://cdn.example/cached' })).toEqual(PASS)
    expect(fake.log).not.toHaveBeenCalled()
  })
})

interface NavigationDetails {
  url: string
  preventDefault: Mock
}

/** A recording stand-in for an Electron WebContents. */
function hardenedContents(sites: AllowedSites = { always: [], once: new Set() }, appUrl: string | null = null) {
  const listeners = new Map<string, Listener>()
  let windowOpen: ((details: { url: string }) => { action: 'deny' }) | null = null
  const contents = {
    setWindowOpenHandler: (handler: typeof windowOpen) => void (windowOpen = handler),
    on: (event: string, listener: Listener) => listeners.set(event, listener),
    setWebRTCIPHandlingPolicy: vi.fn(),
    closeDevTools: vi.fn()
  }
  const onAsk = vi.fn<(origin: string, url: string) => void>()
  const onPopupBlocked = vi.fn<(url: string) => void>()
  hardenBrowserContents(contents, { appUrl, sites: () => sites, onAsk, onPopupBlocked })
  return {
    contents,
    listeners,
    onAsk,
    onPopupBlocked,
    openWindow: (url: string) => windowOpen?.({ url }),
    navigate(event: string, url: string, isMainFrame?: boolean): NavigationDetails {
      const details = { url, preventDefault: vi.fn(), ...(isMainFrame === undefined ? {} : { isMainFrame }) }
      ;(listeners.get(event) as (details: NavigationDetails) => void)(details)
      return details
    }
  }
}

const NAVIGATION_EVENTS = ['will-navigate', 'will-redirect', 'will-frame-navigate']

describe('hardenBrowserContents', () => {
  it('denies every popup and reports it', () => {
    const tab = hardenedContents({ always: ['https://example.com'], once: new Set() })
    expect(tab.openWindow('https://example.com/popup')).toEqual({ action: 'deny' })
    expect(tab.openWindow('about:blank')).toEqual({ action: 'deny' })
    expect(tab.onPopupBlocked.mock.calls).toEqual([['https://example.com/popup'], ['about:blank']])
  })

  it.each(NAVIGATION_EVENTS)('%s lets an always-allowed, allowed-once or blank target proceed', (event) => {
    const tab = hardenedContents({ always: ['https://example.com'], once: new Set(['http://localhost:5173']) })
    for (const url of ['https://example.com/a', 'http://localhost:5173/b', 'about:blank']) {
      expect(tab.navigate(event, url).preventDefault).not.toHaveBeenCalled()
    }
    expect(tab.onAsk).not.toHaveBeenCalled()
  })

  it.each(NAVIGATION_EVENTS)('%s prevents a new origin and asks the person', (event) => {
    const tab = hardenedContents({ always: ['https://example.com'], once: new Set() })
    expect(tab.navigate(event, 'https://other.example/path?q=1').preventDefault).toHaveBeenCalledOnce()
    expect(tab.onAsk).toHaveBeenCalledWith('https://other.example', 'https://other.example/path?q=1')
  })

  it.each(NAVIGATION_EVENTS)('%s asks when the site list is unreadable', (event) => {
    const tab = hardenedContents({ always: null, once: new Set() })
    expect(tab.navigate(event, 'https://example.com/').preventDefault).toHaveBeenCalledOnce()
    expect(tab.onAsk).toHaveBeenCalledWith('https://example.com', 'https://example.com/')
  })

  it.each(NAVIGATION_EVENTS)('%s denies refused targets without asking', (event) => {
    const tab = hardenedContents({ always: ['http://localhost:5173'], once: new Set() }, 'http://localhost:5173')
    for (const url of [
      'file:///C:/Users/dev/secret.txt',
      'javascript:alert(1)',
      'data:text/html,<p>x</p>',
      'dm-attachment://key/id',
      'http://169.254.169.254/latest/meta-data/',
      'https://user:pass@example.com/',
      'http://localhost:5173/'
    ]) {
      expect(tab.navigate(event, url).preventDefault).toHaveBeenCalledOnce()
    }
    expect(tab.onAsk).not.toHaveBeenCalled()
  })
})

describe('hardenBrowserContents redirects, DevTools and credentials', () => {
  it('denies a redirect to file: even from an allowed origin', () => {
    const tab = hardenedContents({ always: ['https://example.com'], once: new Set() })
    expect(tab.navigate('will-redirect', 'file:///C:/Windows/win.ini').preventDefault).toHaveBeenCalledOnce()
    expect(tab.onAsk).not.toHaveBeenCalled()
  })

  it('closes DevTools as soon as they open', () => {
    const tab = hardenedContents()
    ;(tab.listeners.get('devtools-opened') as () => void)()
    expect(tab.contents.closeDevTools).toHaveBeenCalledOnce()
  })

  it.each([
    ['login', [{}, {}]],
    ['select-client-certificate', ['https://example.com', [{ subjectName: 'me' }]]]
  ])('cancels %s without credentials', (event, args) => {
    const tab = hardenedContents()
    const preventDefault = vi.fn()
    const callback = vi.fn()
    ;(tab.listeners.get(event) as (...a: unknown[]) => void)({ preventDefault }, ...args, callback)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith()
  })
})

describe('hardenBrowserContents WebRTC, Bluetooth and srcdoc', () => {
  it('keeps WebRTC from sending UDP outside a proxy', () => {
    const tab = hardenedContents()
    expect(tab.contents.setWebRTCIPHandlingPolicy.mock.calls).toEqual([['disable_non_proxied_udp']])
  })

  it('answers the Bluetooth chooser with no device', () => {
    const tab = hardenedContents()
    const preventDefault = vi.fn()
    const callback = vi.fn()
    const listener = tab.listeners.get('select-bluetooth-device') as (...a: unknown[]) => void
    listener({ preventDefault }, [{ deviceId: 'bt-1', deviceName: 'Keyboard' }], callback)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(callback.mock.calls).toEqual([['']])
  })

  it('denies a srcdoc iframe without asking (fail-closed trade-off)', () => {
    const tab = hardenedContents({ always: ['https://example.com'], once: new Set() })
    expect(tab.navigate('will-frame-navigate', 'about:srcdoc').preventDefault).toHaveBeenCalledOnce()
    expect(tab.onAsk).not.toHaveBeenCalled()
  })

  it('denies a subframe to an unlisted origin silently, without asking (Fix 50)', () => {
    const tab = hardenedContents({ always: ['https://example.com'], once: new Set() })
    expect(tab.navigate('will-frame-navigate', 'https://ads.example/frame', false).preventDefault).toHaveBeenCalledOnce()
    expect(tab.navigate('will-frame-navigate', 'https://example.com/embed', false).preventDefault).not.toHaveBeenCalled()
    expect(tab.onAsk).not.toHaveBeenCalled()
    expect(tab.navigate('will-frame-navigate', 'https://ads.example/', true).preventDefault).toHaveBeenCalledOnce()
    expect(tab.onAsk).toHaveBeenCalledOnce()
  })
})

describe('partitions and web preferences', () => {
  const id = folderStoreId('C:\\Users\\dev\\project', 'win32')

  it("names a folder's persistent agent partition by its folderStoreId", () => {
    expect(agentPartition(id)).toBe(`persist:dm-browser-${id}`)
    expect(agentPartition(folderStoreId('c:\\users\\dev\\PROJECT', 'win32'))).toBe(agentPartition(id))
    expect(agentPartition(null)).toBe('persist:dm-browser-projectless')
  })

  it.each(['', 'default', 'ABCDEF0123456789ABCDEF0123456789', '0123abcd', 'a'.repeat(33), '../x'])(
    'refuses %j as a folderStoreId',
    (bad) => {
      expect(() => agentPartition(bad)).toThrow('folderStoreId')
    }
  )

  it('gives every sign-in tab its own in-memory partition', () => {
    const first = signInPartition()
    const second = signInPartition()
    expect(first).toMatch(/^dm-browser-signin-[0-9a-f-]{36}$/)
    expect(first).not.toBe(second)
    for (const partition of [first, agentPartition(id), agentPartition(null)]) {
      expect(partition).not.toBe('')
      expect(partition).not.toMatch(/^(persist:)?(default)?$/)
    }
  })

  it('locks the view down with no preload, and never throttles a hidden view (agents drive hidden views)', () => {
    expect(BROWSER_WEB_PREFERENCES).toEqual({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      backgroundThrottling: false
    })
    expect(BROWSER_WEB_PREFERENCES).not.toHaveProperty('preload')
    expect(Object.isFrozen(BROWSER_WEB_PREFERENCES)).toBe(true)
  })

  it("accepts Electron's own Session and WebContents", () => {
    expectTypeOf<Session>().toExtend<Parameters<typeof hardenBrowserSession>[0]>()
    expectTypeOf<WebContents>().toExtend<Parameters<typeof hardenBrowserContents>[0]>()
  })
})

describe('hardenBrowserSession frame gate (R19-3)', () => {
  const dns = { 'a.example': ['93.184.216.34'], 'b.example': ['93.184.216.35'] }
  const allowA = (details: { url: string }) => new URL(details.url).hostname === 'a.example'

  it.each(['mainFrame', 'subFrame'])('cancels a %s request the tab does not allow, and passes one it does', async (resourceType) => {
    const fake = hardened(dns, allowA)
    expect(await fake.request({ url: 'https://b.example/', resourceType })).toEqual(CANCEL)
    expect(await fake.request({ url: 'https://a.example/', resourceType })).toEqual(PASS)
  })

  it('asks with the request (its tab id and URL), and never for a subresource', async () => {
    const frameAllowed = vi.fn(allowA)
    const fake = hardened(dns, frameAllowed)
    expect(await fake.requestRaw({ url: 'https://a.example/x', resourceType: 'mainFrame', webContentsId: 7 })).toEqual(PASS)
    expect(frameAllowed).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://a.example/x', webContentsId: 7 }))
    frameAllowed.mockClear()
    expect(await fake.request({ url: 'https://b.example/script.js', resourceType: 'script' })).toEqual(PASS)
    expect(frameAllowed).not.toHaveBeenCalled()
  })

  it('cancels a frame when the decision throws', async () => {
    const fake = hardened(dns, () => { throw new Error('no answer') })
    expect(await fake.request({ url: 'https://a.example/', resourceType: 'mainFrame' })).toEqual(CANCEL)
  })
})
