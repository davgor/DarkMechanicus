import type { WebContentsView } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { BrowserState } from '../../shared/browser/browserApi'
import { folderStoreId } from '../agentChat/folderStoreId'
import { createBrowserHardener, createBrowserHost, type HostContents, type HostView, type SitePromptEvent } from './browserHost'
import { createBrowserOwnership } from './browserOwnership'
import { createSiteStore } from './siteStore'

type Listener = (...args: never[]) => unknown

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const FOLDER = join(tmpdir(), 'Browser Repo')
const CHAT = { folder: FOLDER, chatId: 'chat-a' }
const OTHER = { folder: FOLDER, chatId: 'chat-b' }
const GRANT = `dmg_${'ab12'.repeat(16)}`

/** A recording stand-in for an Electron session: just enough for `hardenBrowserSession`. */
function fakeSession() {
  return {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    on: vi.fn(),
    protocol: { isProtocolHandled: () => false },
    webRequest: { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() }
  }
}

let nextContentsId = 1

/** A recording stand-in for a view's WebContents; `emit` fires a listener the host or the hardener added. */
function fakeContents(session: ReturnType<typeof fakeSession>) {
  const listeners = new Map<string, Listener[]>()
  let url = ''
  let title = ''
  let destroyed = false
  // The repository's ES library predates Promise.withResolvers.
  let paintNow: () => void = () => undefined
  const nextPaint = () => new Promise<unknown>((resolve) => { paintNow = () => resolve(true) })
  let paint = nextPaint()
  const contents = {
    id: nextContentsId++,
    session,
    loadURL: vi.fn(async (next: string) => { url = next }),
    getURL: () => url,
    getTitle: () => title,
    isDestroyed: () => destroyed,
    close: vi.fn(() => { destroyed = true }),
    executeJavaScriptInIsolatedWorld: vi.fn(() => paint),
    setWindowOpenHandler: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn(),
    closeDevTools: vi.fn(),
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return contents
    }
  }
  return {
    contents,
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) (listener as (...a: unknown[]) => unknown)(...args)
    },
    setPage(next: { url?: string; title?: string }) {
      url = next.url ?? url
      title = next.title ?? title
    },
    painted() {
      paintNow()
      paint = nextPaint()
    }
  }
}

interface FakeView {
  partition: string
  webPreferences: Record<string, unknown>
  view: { webContents: ReturnType<typeof fakeContents>['contents']; setBounds: ReturnType<typeof vi.fn>; setVisible: ReturnType<typeof vi.fn> }
  page: ReturnType<typeof fakeContents>
}

function setup(options: { zoom?: number; windowSize?: { width: number; height: number } | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dm-host-sites-'))
  roots.push(root)
  const sites = createSiteStore({ root, log: () => undefined })
  const ownership = createBrowserOwnership()
  const views: FakeView[] = []
  const sessions = new Map<string, ReturnType<typeof fakeSession>>()
  const pushed: BrowserState[] = []
  const lines: string[] = []
  const sitePrompts: SitePromptEvent[] = []
  const attach = vi.fn()
  const detach = vi.fn()
  let clock = 1_000_000
  const harden = createBrowserHardener({
    appUrl: 'http://localhost:5173', log: (line) => lines.push(line), lookup: async () => [],
    frameAllowed: (webContentsId, url) => host.frameAllowed(webContentsId, url)
  })
  const hardenSpy = vi.fn(harden)
  const host = createBrowserHost({
    createView(webPreferences) {
      const session = sessions.get(webPreferences.partition) ?? fakeSession()
      sessions.set(webPreferences.partition, session)
      const page = fakeContents(session)
      const view = { webContents: page.contents, setBounds: vi.fn(), setVisible: vi.fn() }
      views.push({ partition: webPreferences.partition, webPreferences: { ...webPreferences }, view, page })
      return view as unknown as HostView
    },
    attach,
    detach,
    zoomFactor: () => options.zoom ?? 1,
    windowContentSize: () => (options.windowSize === undefined ? { width: 1600, height: 900 } : options.windowSize),
    appUrl: 'http://localhost:5173',
    sites,
    harden: hardenSpy,
    ownership,
    ownerLabel: (_ref, owner) => (owner === 'agent' ? 'Acolyte:DM-865' : null),
    enabled: () => true,
    push: (state) => pushed.push(state),
    onSitePrompt: (event) => sitePrompts.push(event),
    log: (line) => lines.push(line),
    now: () => clock
  })
  const last = () => pushed.at(-1)
  const pageAsk = (index: number, url: string) =>
    views[index].page.emit('will-navigate', { url, isMainFrame: true, preventDefault: vi.fn() })
  return {
    host, sites, ownership, views, sessions, pushed, lines, attach, detach, hardenSpy, last, pageAsk, sitePrompts,
    advance: (ms: number) => { clock += ms }
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('createBrowserHost tabs', () => {
  it("creates the agent tab lazily, once, in the folder's persistent partition, hardened and attached", () => {
    const fake = setup()
    expect(fake.host.agentTab(CHAT)).toBeNull()
    expect(fake.views).toHaveLength(0)
    const tab = fake.host.ensureAgentTab(CHAT)
    fake.host.ensureAgentTab(CHAT)
    expect(fake.views).toHaveLength(1)
    expect(fake.views[0].partition).toBe(`persist:dm-browser-${folderStoreId(FOLDER)}`)
    expect(fake.views[0].webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false })
    expect(fake.attach).toHaveBeenCalledOnce()
    expect(fake.hardenSpy).toHaveBeenCalledOnce()
    expect(tab.contents).toBe(fake.views[0].view.webContents)
    expect(fake.host.agentTab(CHAT)?.contents).toBe(tab.contents)
    fake.host.ensureAgentTab({ folder: null, chatId: 'loose' })
    expect(fake.views[1].partition).toBe('persist:dm-browser-projectless')
  })

  it('hardens each partition session once and every view, agent and sign-in alike', async () => {
    const fake = setup()
    fake.host.ensureAgentTab(CHAT)
    fake.host.ensureAgentTab(OTHER)
    await fake.host.openSignIn(CHAT, 'https://login.example/')
    expect(fake.views).toHaveLength(3)
    expect(fake.sessions.size).toBe(2)
    for (const session of fake.sessions.values()) expect(session.setPermissionRequestHandler).toHaveBeenCalledOnce()
    for (const { view } of fake.views) {
      expect(view.webContents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
      expect(view.webContents.setWindowOpenHandler).toHaveBeenCalledOnce()
    }
  })

  it('keeps the sign-in tab in memory and away from the agent tab accessor', async () => {
    const fake = setup()
    expect(await fake.host.openSignIn(CHAT, 'https://login.example/')).toEqual({ ok: false, code: 'origin_blocked' })
    expect(fake.views[0].partition).toMatch(/^dm-browser-signin-[0-9a-f-]{36}$/)
    expect(fake.host.agentTab(CHAT)).toBeNull()
    const agent = fake.host.ensureAgentTab(CHAT)
    expect(agent.contents).toBe(fake.views[1].view.webContents)
    expect(fake.host.agentTab(CHAT)?.contents).not.toBe(fake.views[0].view.webContents)
    expect(fake.host.state(CHAT).signIn).toEqual({ url: '', title: '' })
    fake.host.closeSignIn(CHAT)
    expect(fake.views[0].view.webContents.close).toHaveBeenCalledOnce()
    expect(fake.detach).toHaveBeenCalledWith(fake.views[0].view)
    expect(fake.host.state(CHAT).signIn).toBeNull()
  })
})

describe('createBrowserHost navigation and origin prompts', () => {
  it('blocks an unlisted origin before loadURL and raises one pending prompt', async () => {
    const fake = setup()
    expect(await fake.host.navigate(CHAT, 'https://new.example/a?q=1', 'agent')).toEqual({ ok: false, code: 'origin_blocked' })
    expect(fake.views[0].view.webContents.loadURL).not.toHaveBeenCalled()
    const pending = fake.last()?.pendingOrigin
    expect(pending).toEqual({ id: expect.any(String), origin: 'https://new.example', requestedBy: 'agent' })
    expect(fake.host.state(CHAT).pendingOrigin).toEqual(pending)
  })

  it('asks the person too: their navigation to a new origin is blocked until they decide', async () => {
    const fake = setup()
    expect(await fake.host.navigate(CHAT, 'https://new.example/', 'person')).toEqual({ ok: false, code: 'origin_blocked' })
    expect(fake.views[0].view.webContents.loadURL).not.toHaveBeenCalled()
    expect(fake.last()?.pendingOrigin?.requestedBy).toBe('person')
  })

  it('refuses unusable targets without asking or loading', async () => {
    const fake = setup()
    expect(await fake.host.navigate(CHAT, 'file:///C:/Windows/win.ini', 'agent')).toEqual({ ok: false, code: 'invalid_url' })
    expect(await fake.host.navigate(CHAT, 'http://localhost:5173/', 'agent')).toEqual({ ok: false, code: 'invalid_url' })
    expect(await fake.host.navigate(CHAT, `https://x.example/?t=${GRANT}`, 'agent')).toEqual({ ok: false, code: 'secret_refused' })
    expect(fake.views[0].view.webContents.loadURL).not.toHaveBeenCalled()
    expect(fake.host.state(CHAT).pendingOrigin).toBeNull()
  })

  it('once loads the URL and allows the origin for this tab only, without persisting it', async () => {
    const fake = setup()
    await fake.host.navigate(CHAT, 'https://new.example/a', 'agent')
    const id = fake.host.state(CHAT).pendingOrigin?.id ?? ''
    expect(await fake.host.decideOrigin(CHAT, id, 'once')).toEqual({ ok: true })
    const contents = fake.views[0].view.webContents
    expect(contents.loadURL.mock.calls).toEqual([['https://new.example/a']])
    expect(fake.host.state(CHAT).pendingOrigin).toBeNull()
    expect(await fake.host.navigate(CHAT, 'https://new.example/b', 'agent')).toEqual({ ok: true })
    expect(await fake.sites.list(FOLDER)).toEqual([])
    expect(await fake.host.navigate(OTHER, 'https://new.example/', 'agent')).toEqual({ ok: false, code: 'origin_blocked' })
  })
})

describe('createBrowserHost origin decisions', () => {
  it("always persists the origin to the folder's site store and loads", async () => {
    const fake = setup()
    await fake.host.navigate(CHAT, 'https://new.example/a', 'agent')
    const id = fake.host.state(CHAT).pendingOrigin?.id ?? ''
    expect(await fake.host.decideOrigin(CHAT, id, 'always')).toEqual({ ok: true })
    expect(await fake.sites.list(FOLDER)).toEqual(['https://new.example'])
    expect(fake.views[0].view.webContents.loadURL.mock.calls).toEqual([['https://new.example/a']])
    expect(await fake.host.navigate(OTHER, 'https://new.example/z', 'agent')).toEqual({ ok: true })
  })

  it('deny clears the prompt without loading, and the same answer again is stale', async () => {
    const fake = setup()
    await fake.host.navigate(CHAT, 'https://new.example/', 'agent')
    const id = fake.host.state(CHAT).pendingOrigin?.id ?? ''
    expect(await fake.host.decideOrigin(CHAT, id, 'deny')).toEqual({ ok: true })
    expect(fake.last()?.pendingOrigin).toBeNull()
    expect(fake.views[0].view.webContents.loadURL).not.toHaveBeenCalled()
    expect(await fake.host.decideOrigin(CHAT, id, 'once')).toEqual({ ok: false, code: 'stale_prompt' })
    expect(await fake.host.decideOrigin(OTHER, id, 'once')).toEqual({ ok: false, code: 'stale_prompt' })
    expect(fake.views[0].view.webContents.loadURL).not.toHaveBeenCalled()
  })

  it('a newer ask supersedes an older one, whose answer is then stale', async () => {
    const fake = setup()
    await fake.host.navigate(CHAT, 'https://first.example/', 'agent')
    const first = fake.host.state(CHAT).pendingOrigin?.id ?? ''
    await fake.host.navigate(CHAT, 'https://second.example/', 'person')
    expect(fake.host.state(CHAT).pendingOrigin).toEqual({ id: expect.any(String), origin: 'https://second.example', requestedBy: 'person' })
    expect(await fake.host.decideOrigin(CHAT, first, 'always')).toEqual({ ok: false, code: 'stale_prompt' })
    expect(await fake.sites.list(FOLDER)).toEqual([])
    expect(fake.views[0].view.webContents.loadURL).not.toHaveBeenCalled()
    expect(fake.lines).toContain('browser prompt for https://first.example superseded; denied')
  })
})

describe('createBrowserHost page asks (Fix 50)', () => {
  it('a page ask is labelled page, and allow once loads its URL', async () => {
    const fake = setup()
    fake.host.ensureAgentTab(CHAT)
    await flush()
    fake.pageAsk(0, 'https://page.example/next')
    expect(fake.last()?.pendingOrigin).toEqual({ id: expect.any(String), origin: 'https://page.example', requestedBy: 'page' })
    await fake.host.decideOrigin(CHAT, fake.last()?.pendingOrigin?.id ?? '', 'once')
    expect(fake.views[0].view.webContents.loadURL.mock.calls).toEqual([['https://page.example/next']])
  })

  it('a page ask does not replace an agent prompt', async () => {
    const fake = setup()
    await fake.host.navigate(CHAT, 'https://agent.example/', 'agent')
    const agentPrompt = fake.host.state(CHAT).pendingOrigin
    fake.pageAsk(0, 'https://evil.example/')
    expect(fake.host.state(CHAT).pendingOrigin).toEqual(agentPrompt)
    expect(fake.lines).toContain('browser page ask for https://evil.example dropped: a agent prompt is pending')
  })

  it('a second page ask within 10 s is dropped; one after 10 s is raised', async () => {
    const fake = setup()
    fake.host.ensureAgentTab(CHAT)
    fake.pageAsk(0, 'https://one.example/')
    const first = fake.host.state(CHAT).pendingOrigin
    fake.advance(9_999)
    fake.pageAsk(0, 'https://two.example/')
    expect(fake.host.state(CHAT).pendingOrigin).toEqual(first)
    expect(fake.lines).toContain('browser page ask for https://two.example dropped: one page ask per 10 s')
    fake.advance(1)
    fake.pageAsk(0, 'https://three.example/')
    expect(fake.host.state(CHAT).pendingOrigin?.origin).toBe('https://three.example')
  })

  it('an iframe to an unlisted origin is denied with no prompt', () => {
    const fake = setup()
    fake.host.ensureAgentTab(CHAT)
    const preventDefault = vi.fn()
    fake.views[0].page.emit('will-frame-navigate', { url: 'https://ads.example/frame', isMainFrame: false, preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(fake.host.state(CHAT).pendingOrigin).toBeNull()
    expect(fake.pushed.every((state) => state.pendingOrigin === null)).toBe(true)
  })
})

describe('createBrowserHost placement', () => {
  it('converts CSS bounds by the zoom factor, shows only the selected chat and hides on null', () => {
    const fake = setup({ zoom: 1.25 })
    fake.host.ensureAgentTab(CHAT)
    fake.host.ensureAgentTab(OTHER)
    const [a, b] = fake.views.map((entry) => entry.view)
    fake.host.setView(CHAT, { x: 10, y: 20, width: 300, height: 201 })
    expect(a.setBounds).toHaveBeenLastCalledWith({ x: 13, y: 25, width: 375, height: 251 })
    expect(a.setVisible).toHaveBeenLastCalledWith(true)
    expect(b.setVisible).toHaveBeenLastCalledWith(false)
    expect(b.setBounds).not.toHaveBeenCalled()
    fake.host.setView(OTHER, { x: 0, y: 0, width: 100, height: 100 })
    expect(a.setVisible).toHaveBeenLastCalledWith(false)
    expect(b.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 125, height: 125 })
    expect(b.setVisible).toHaveBeenLastCalledWith(true)
    fake.host.setView(OTHER, null)
    expect(a.setVisible).toHaveBeenLastCalledWith(false)
    expect(b.setVisible).toHaveBeenLastCalledWith(false)
    expect(fake.attach).toHaveBeenCalledTimes(2)
  })

  it('places a tab created after its chat was selected, and shows the sign-in tab over the agent tab', async () => {
    const fake = setup()
    fake.host.setView(CHAT, { x: 1, y: 2, width: 3, height: 4 })
    fake.host.ensureAgentTab(CHAT)
    const agent = fake.views[0].view
    expect(agent.setBounds).toHaveBeenLastCalledWith({ x: 1, y: 2, width: 3, height: 4 })
    expect(agent.setVisible).toHaveBeenLastCalledWith(true)
    await fake.host.openSignIn(CHAT, 'https://login.example/')
    expect(agent.setVisible).toHaveBeenLastCalledWith(false)
    expect(fake.views[1].view.setVisible).toHaveBeenLastCalledWith(true)
    fake.host.closeSignIn(CHAT)
    expect(agent.setVisible).toHaveBeenLastCalledWith(true)
  })
})

describe('createBrowserHost isShown', () => {
  it('isShown only while the agent tab is the selected view on a visible window', async () => {
    const shown = setup({ zoom: 1.5, windowSize: { width: 1000, height: 800 } })
    shown.host.ensureAgentTab(CHAT)
    expect(shown.host.isShown(CHAT)).toBe(false)
    shown.host.setView(CHAT, { x: 600, y: 0, width: 200, height: 300 })
    expect(shown.host.isShown(CHAT)).toBe(true)
    expect(shown.host.isShown(OTHER)).toBe(false)
    shown.host.setView(CHAT, { x: 700, y: 0, width: 200, height: 300 })
    expect(shown.host.isShown(CHAT)).toBe(false)
    shown.host.setView(CHAT, { x: 0, y: 0, width: 0, height: 300 })
    expect(shown.host.isShown(CHAT)).toBe(false)
    shown.host.setView(CHAT, { x: 0, y: 0, width: 100, height: 100 })
    await shown.host.openSignIn(CHAT, 'https://login.example/')
    expect(shown.host.isShown(CHAT)).toBe(false)
    const hidden = setup({ windowSize: null })
    hidden.host.ensureAgentTab(CHAT)
    hidden.host.setView(CHAT, { x: 0, y: 0, width: 100, height: 100 })
    expect(hidden.host.isShown(CHAT)).toBe(false)
  })
})

describe('createBrowserHost state and readiness', () => {
  it('tracks loading, URL and title with ownership, and masks secrets in what it pushes', () => {
    const fake = setup()
    fake.host.ensureAgentTab(CHAT)
    const lease = fake.ownership.beginAgentOp(CHAT.chatId)
    expect(lease.ok).toBe(true)
    const page = fake.views[0].page
    page.emit('did-start-loading')
    expect(fake.last()).toMatchObject({ owner: 'agent', ownerLabel: 'Acolyte:DM-865', enabled: true, tab: { loading: true } })
    page.emit('did-navigate', {}, `https://ok.example/cb?token=${GRANT}`)
    page.emit('page-title-updated', {}, `Signed in ${GRANT}`)
    const masked = fake.last()?.tab
    expect(JSON.stringify(fake.pushed)).not.toContain(GRANT)
    expect(masked?.url).toMatch(/^https:\/\/ok\.example\/cb\?token=/)
    expect(masked?.title).toMatch(/^Signed in /)
    page.setPage({ url: 'https://ok.example/done', title: 'Done' })
    page.emit('did-stop-loading')
    expect(fake.last()?.tab).toEqual({ url: 'https://ok.example/done', title: 'Done', loading: false })
    page.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(fake.lines).toContain('browser tab renderer gone')
  })

  it('admits agent ops only after the first paint following a load, probed in an isolated world', async () => {
    const fake = setup()
    const tab = fake.host.ensureAgentTab(CHAT)
    await expect(tab.whenReady()).resolves.toBeUndefined()
    const page = fake.views[0].page
    page.emit('did-start-loading')
    let ready = false
    void tab.whenReady().then(() => { ready = true })
    page.emit('did-stop-loading')
    await flush()
    expect(ready).toBe(false)
    const [world, scripts] = fake.views[0].view.webContents.executeJavaScriptInIsolatedWorld.mock.calls[0] as unknown as [number, { code: string }[]]
    expect(world).not.toBe(0)
    expect(scripts[0].code).toContain('requestAnimationFrame')
    page.painted()
    await flush()
    expect(ready).toBe(true)
    page.emit('did-start-loading')
    const controller = new AbortController()
    const waiting = tab.whenReady(controller.signal)
    controller.abort('stopped')
    await expect(waiting).rejects.toBe('stopped')
  })
})

describe('createBrowserHost lifecycle', () => {
  it('disposeChat destroys the chat views and forgets its ownership; dispose closes everything', async () => {
    const fake = setup()
    fake.host.ensureAgentTab(CHAT)
    await fake.host.openSignIn(CHAT, 'https://login.example/')
    fake.host.ensureAgentTab(OTHER)
    fake.ownership.stop(CHAT.chatId)
    fake.host.disposeChat(CHAT)
    expect(fake.views[0].view.webContents.close).toHaveBeenCalledOnce()
    expect(fake.views[1].view.webContents.close).toHaveBeenCalledOnce()
    expect(fake.detach).toHaveBeenCalledTimes(2)
    expect(fake.ownership.owner(CHAT.chatId)).toBe('none')
    expect(fake.host.agentTab(CHAT)).toBeNull()
    expect(fake.views[2].view.webContents.close).not.toHaveBeenCalled()
    fake.host.dispose()
    expect(fake.views[2].view.webContents.close).toHaveBeenCalledOnce()
    expect(fake.detach).toHaveBeenCalledTimes(3)
    expect(() => fake.host.ensureAgentTab(OTHER)).toThrow('disposed')
  })
})

// Compile-time only (`npm run typecheck`): Electron's own view and contents satisfy what the host drives.
expectTypeOf<WebContentsView>().toExtend<HostView>()
expectTypeOf<WebContentsView['webContents']>().toExtend<HostContents>()

describe('createBrowserHost frame decisions (R19-3)', () => {
  it("allows an agent tab's frames only to its folder's always list, read fresh, plus that tab's once set", async () => {
    const fake = setup()
    const id = fake.host.ensureAgentTab(CHAT).contents.id
    expect(await fake.host.frameAllowed(id, 'https://a.example/')).toBe(false)
    await fake.sites.add(FOLDER, 'https://a.example')
    expect(await fake.host.frameAllowed(id, 'https://a.example/page')).toBe(true)
    expect(await fake.host.frameAllowed(id, 'https://b.example/')).toBe(false)
    await fake.sites.remove(FOLDER, 'https://a.example')
    expect(await fake.host.frameAllowed(id, 'https://a.example/page')).toBe(false)
    await fake.host.navigate(CHAT, 'https://once.example/', 'agent')
    await fake.host.decideOrigin(CHAT, fake.host.state(CHAT).pendingOrigin?.id ?? '', 'once')
    expect(await fake.host.frameAllowed(id, 'https://once.example/x')).toBe(true)
    expect(await fake.host.frameAllowed(fake.host.ensureAgentTab(OTHER).contents.id, 'https://once.example/x')).toBe(false)
  })

  it('leaves contents that are no agent tab (the Sign-in tab) to the session rules', async () => {
    const fake = setup()
    await fake.host.openSignIn(CHAT, 'https://login.example/')
    expect(await fake.host.frameAllowed(fake.views[0].view.webContents.id, 'https://login.example/')).toBe(true)
    expect(await fake.host.frameAllowed(undefined, 'https://login.example/')).toBe(true)
  })
})

describe('createBrowserHost agent prompt and window close', () => {
  it("reports the agent tab's pending origin, never the Sign-in tab's", async () => {
    const fake = setup()
    await fake.host.openSignIn(CHAT, 'https://login.example/')
    expect(fake.host.agentPendingOrigin(CHAT)).toBeNull()
    await fake.host.navigate(CHAT, 'https://new.example/', 'agent')
    expect(fake.host.agentPendingOrigin(CHAT)).toBe('https://new.example')
  })

  it('closeViews closes every view but keeps ownership; the next tab is made and attached anew', () => {
    const fake = setup()
    fake.host.ensureAgentTab(CHAT)
    fake.ownership.stop(CHAT.chatId)
    fake.host.closeViews()
    expect(fake.views[0].view.webContents.close).toHaveBeenCalledOnce()
    expect(fake.host.agentTab(CHAT)).toBeNull()
    expect(fake.ownership.owner(CHAT.chatId)).toBe('stopped')
    fake.host.ensureAgentTab(CHAT)
    expect(fake.views).toHaveLength(2)
    expect(fake.attach).toHaveBeenLastCalledWith(fake.views[1].view)
  })
})

describe('createBrowserHost site prompt events (DM-897)', () => {
  it('tells each raised, replaced and decided prompt with its chat, id, origin and requester', async () => {
    const fake = setup()
    await fake.host.navigate(CHAT, 'https://first.example/a', 'agent')
    const first = fake.host.state(CHAT).pendingOrigin?.id ?? ''
    await fake.host.navigate(CHAT, 'https://second.example/', 'person')
    const second = fake.host.state(CHAT).pendingOrigin?.id ?? ''
    await fake.host.decideOrigin(CHAT, second, 'deny')
    expect(fake.sitePrompts).toEqual([
      { kind: 'site', folder: FOLDER, chatId: CHAT.chatId, promptId: first, origin: 'https://first.example', requestedBy: 'agent' },
      { kind: 'site', folder: FOLDER, chatId: CHAT.chatId, promptId: second, origin: 'https://second.example', requestedBy: 'person' },
      { kind: 'site_cleared', folder: FOLDER, chatId: CHAT.chatId }
    ])
  })

  it('clears the prompt when its Sign-in tab closes, every view closes, or the chat goes; a stale answer tells nothing', async () => {
    const fake = setup()
    await fake.host.openSignIn(CHAT, 'https://login.example/')
    fake.host.closeSignIn(CHAT)
    await fake.host.navigate(OTHER, 'https://other.example/', 'agent')
    fake.host.closeViews()
    await fake.host.navigate(CHAT, 'https://again.example/', 'agent')
    expect(await fake.host.decideOrigin(CHAT, 'stale', 'deny')).toEqual({ ok: false, code: 'stale_prompt' })
    fake.host.disposeChat(CHAT)
    expect(fake.sitePrompts.map((event) => [event.kind, event.chatId, event.kind === 'site' ? event.requestedBy : null])).toEqual([
      ['site', CHAT.chatId, 'person'], ['site_cleared', CHAT.chatId, null],
      ['site', OTHER.chatId, 'agent'], ['site_cleared', OTHER.chatId, null],
      ['site', CHAT.chatId, 'agent'], ['site_cleared', CHAT.chatId, null]
    ])
  })

  it('a throwing listener is logged and never breaks the prompt', async () => {
    const fake = setup()
    fake.sitePrompts.push = () => { throw new Error('listener broke') }
    expect(await fake.host.navigate(CHAT, 'https://new.example/', 'agent')).toEqual({ ok: false, code: 'origin_blocked' })
    expect(fake.host.state(CHAT).pendingOrigin?.origin).toBe('https://new.example')
    expect(fake.lines).toContain('browser site prompt listener failed')
  })
})

describe('createBrowserHost tab state edges', () => {
  it('clips a long title without splitting a surrogate pair', () => {
    const fake = setup()
    fake.host.ensureAgentTab(CHAT)
    fake.views[0].page.emit('page-title-updated', {}, `${'a'.repeat(511)}😀`)
    expect(fake.host.state(CHAT).tab?.title).toBe('a'.repeat(511))
  })

  it('rejects at once when the op signal is already aborted, with its reason', async () => {
    const fake = setup()
    const controller = new AbortController()
    controller.abort('timeout')
    await expect(fake.host.ensureAgentTab(CHAT).whenReady(controller.signal)).rejects.toBe('timeout')
  })

  it("never lets an earlier load's paint admit ops for the page loading now", async () => {
    const fake = setup()
    const tab = fake.host.ensureAgentTab(CHAT)
    const page = fake.views[0].page
    page.emit('did-start-loading')
    page.emit('did-stop-loading')
    page.emit('did-start-loading')
    let ready = false
    void tab.whenReady().then(() => { ready = true })
    page.painted()
    await flush()
    expect(ready).toBe(false)
    page.emit('did-stop-loading')
    page.painted()
    await flush()
    expect(ready).toBe(true)
  })

  it('ignores the page events of a closed tab: nothing pushed, logged or probed', () => {
    const fake = setup()
    fake.host.ensureAgentTab(CHAT)
    const { page, view } = fake.views[0]
    fake.host.closeViews()
    const pushed = fake.pushed.length
    for (const event of ['did-start-loading', 'did-stop-loading', 'render-process-gone']) page.emit(event)
    page.emit('did-navigate', {}, 'https://late.example/')
    expect(fake.pushed).toHaveLength(pushed)
    expect(fake.lines).not.toContain('browser tab renderer gone')
    expect(view.webContents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })
})

describe('createBrowserHost loads that fail or race a close', () => {
  it('answers navigation_failed for a load that fails, logging only its origin', async () => {
    const fake = setup()
    await fake.sites.add(FOLDER, 'https://a.example')
    fake.host.ensureAgentTab(CHAT)
    fake.views[0].view.webContents.loadURL.mockRejectedValueOnce(new Error('ERR_NAME_NOT_RESOLVED https://a.example/secret'))
    expect(await fake.host.navigate(CHAT, 'https://a.example/secret', 'agent')).toEqual({ ok: false, code: 'navigation_failed' })
    expect(fake.lines).toContain('browser load of https://a.example failed')
    expect(fake.lines.join('\n')).not.toContain('/secret')
  })

  it('neither logs nor pushes a failed load of a chat deleted meanwhile', async () => {
    const fake = setup()
    await fake.sites.add(FOLDER, 'https://a.example')
    fake.host.ensureAgentTab(CHAT)
    let fail: (error: Error) => void = () => undefined
    fake.views[0].view.webContents.loadURL.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject }))
    const navigation = fake.host.navigate(CHAT, 'https://a.example/', 'agent')
    await vi.waitFor(() => expect(fake.views[0].view.webContents.loadURL).toHaveBeenCalled())
    fake.host.disposeChat(CHAT)
    const pushed = fake.pushed.length
    fail(new Error('ERR_ABORTED'))
    expect(await navigation).toEqual({ ok: false, code: 'navigation_failed' })
    expect(fake.pushed).toHaveLength(pushed)
    expect(fake.lines.some((line) => line.startsWith('browser load of'))).toBe(false)
  })

  it('loads nothing when the tab closes while the site list is read', async () => {
    const fake = setup()
    await fake.sites.add(FOLDER, 'https://a.example')
    const navigation = fake.host.navigate(CHAT, 'https://a.example/', 'agent')
    fake.host.closeViews()
    expect(await navigation).toEqual({ ok: false, code: 'navigation_failed' })
    expect(fake.views[0].view.webContents.loadURL).not.toHaveBeenCalled()
  })

  it('loads nothing when the tab that asked closes while an always answer is saved', async () => {
    const fake = setup()
    await fake.host.navigate(CHAT, 'https://new.example/', 'agent')
    const deciding = fake.host.decideOrigin(CHAT, fake.host.state(CHAT).pendingOrigin?.id ?? '', 'always')
    fake.host.closeViews()
    expect(await deciding).toEqual({ ok: true })
    expect(await fake.sites.list(FOLDER)).toEqual(['https://new.example'])
    expect(fake.views[0].view.webContents.loadURL).not.toHaveBeenCalled()
    expect(fake.views).toHaveLength(1)
  })
})

describe('createBrowserHost Sign-in and disposal edges', () => {
  it("loads an approved Sign-in prompt in the Sign-in tab, never the agent tab", async () => {
    const fake = setup()
    fake.host.ensureAgentTab(CHAT)
    await fake.host.openSignIn(CHAT, 'https://login.example/start')
    await fake.host.decideOrigin(CHAT, fake.host.state(CHAT).pendingOrigin?.id ?? '', 'once')
    expect(fake.views[1].view.webContents.loadURL).toHaveBeenCalledWith('https://login.example/start')
    expect(fake.views[0].view.webContents.loadURL).not.toHaveBeenCalled()
  })

  it("closing the Sign-in tab keeps an agent prompt, and closing none changes nothing", async () => {
    const fake = setup()
    fake.host.closeSignIn(CHAT)
    expect(fake.pushed).toHaveLength(0)
    expect(fake.detach).not.toHaveBeenCalled()
    await fake.host.openSignIn(CHAT, 'https://login.example/')
    await fake.host.navigate(CHAT, 'https://new.example/', 'agent')
    fake.host.closeSignIn(CHAT)
    expect(fake.host.agentPendingOrigin(CHAT)).toBe('https://new.example')
  })

  it('forgets the ownership of a chat with no tabs, keeps another chat shown, and closes a destroyed view once', () => {
    const fake = setup()
    fake.ownership.stop(CHAT.chatId)
    fake.host.disposeChat(CHAT)
    expect(fake.ownership.owner(CHAT.chatId)).toBe('none')
    fake.host.ensureAgentTab(CHAT)
    fake.host.ensureAgentTab(OTHER)
    fake.host.setView(OTHER, { x: 0, y: 0, width: 400, height: 300 })
    fake.views[0].view.webContents.close()
    fake.host.disposeChat(CHAT)
    expect(fake.views[0].view.webContents.close).toHaveBeenCalledOnce()
    expect(fake.host.isShown(OTHER)).toBe(true)
  })

  it('pushes nothing once disposed', () => {
    const fake = setup()
    fake.host.dispose()
    fake.host.refresh(CHAT)
    expect(fake.pushed).toHaveLength(0)
  })
})
