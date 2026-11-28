/**
 * Hosts each chat's agent browser as native views over the rail's Browser area: one agent tab per chat, created
 * lazily in the folder's persistent partition, and at most one Sign-in tab in its own in-memory partition, which agent
 * APIs never see. Kept free of Electron imports: the view factory, the main window's `contentView` and its zoom come
 * in as deps, so every rule is unit tested with fakes.
 *
 * - Every navigation main starts goes through the origin policy **before** `loadURL`, because a main-process load
 *   fires no `will-*` event (docs/reports/agent-browser.md item 4). An unlisted origin never loads: it raises the
 *   chat's one pending origin prompt and answers `origin_blocked` until the person decides.
 * - One pending prompt per chat. An agent or person ask supersedes (denies) an older one. A page ask (script
 *   navigation, meta refresh, redirect) never supersedes an agent or person prompt, and a tab raises at most one page
 *   ask per 10 s; dropped asks are logged. Subframes never ask (`hardenBrowserContents`, red-team Fix 50).
 * - Agent ops wait for the tab's first paint after each load (`whenReady`): before it, clicks and keys are dropped
 *   and capture fails (DM-866).
 * - Pushed state masks grant and claim tokens in every URL and title.
 */
import { promises as dns } from 'node:dns'
import { randomUUID } from 'node:crypto'
import type { BrowserState } from '../../shared/browser/browserApi'
import type { BrowserErrorCode } from '../../shared/browser/browserControl'
import { folderStoreId } from '../agentChat/folderStoreId'
import { maskAgentChatSecretsDeep } from '../agentChat/secretMask'
import type { BrowserOwnership } from './browserOwnership'
import {
  agentPartition,
  BROWSER_WEB_PREFERENCES,
  hardenBrowserContents,
  hardenBrowserSession,
  signInPartition
} from './browserSession'
import { decideNavigation, normalizeTarget, type AllowedSites } from './originPolicy'
import type { SiteStore } from './siteStore'

/** A chat's browser: its folder's canonical path (null when project-less) and its id. */
export interface BrowserChatRef {
  folder: string | null
  chatId: string
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

type BrowserTab = NonNullable<BrowserState['tab']>
type Requester = NonNullable<BrowserState['pendingOrigin']>['requestedBy']
type TabKind = 'agent' | 'signIn'

type HardenableContents = Parameters<typeof hardenBrowserContents>[0]
type HardenableSession = Parameters<typeof hardenBrowserSession>[0]

/** The parts of a view's `WebContents` the host uses; Electron's `WebContents` satisfies it. */
export type HostContents = HardenableContents & {
  readonly id: number
  readonly session: HardenableSession
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  isDestroyed(): boolean
  close(): void
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>
  on(event: 'did-start-loading' | 'did-stop-loading', listener: () => void): unknown
  on(event: 'did-navigate' | 'did-navigate-in-page', listener: (event: unknown, url: string) => void): unknown
  on(event: 'page-title-updated', listener: (event: unknown, title: string) => void): unknown
  on(event: 'render-process-gone', listener: () => void): unknown
}

/** A native view; Electron's `WebContentsView` satisfies it. */
export interface HostView {
  readonly webContents: HostContents
  setBounds(bounds: Rect): void
  setVisible(visible: boolean): void
}

/** What a tab's contents must answer to `hardenBrowserContents`, minus the app URL the hardener already knows. */
interface TabHooks {
  sites: () => AllowedSites
  onAsk: (origin: string, url: string) => void
  onPopupBlocked: (url: string) => void
}

type Harden = (contents: HostContents, hooks: TabHooks) => void

interface BrowserHostDeps {
  createView(webPreferences: typeof BROWSER_WEB_PREFERENCES & { partition: string }): HostView
  /** Adds the view to the main window's `contentView`, once per view. */
  attach(view: HostView): void
  detach(view: HostView): void
  /** The main window renderer's zoom factor: the placeholder's CSS px times it are the view's DIP. */
  zoomFactor(): number
  /** The main window's content size in DIP, or null while it is hidden or minimized (nothing is on screen). */
  windowContentSize(): { width: number; height: number } | null
  /** The app's own page, which a tab never opens. */
  appUrl: string | null
  sites: SiteStore
  /** Locks down the view's session and contents (`createBrowserHardener`). */
  harden: Harden
  ownership: BrowserOwnership
  /** The ownership badge for the chat (`ownerLabel`, with the chat record and the agent's last `as`). */
  ownerLabel(ref: BrowserChatRef, owner: BrowserState['owner']): string | null
  /** Whether the in-app browser is turned on. */
  enabled(): boolean
  push(state: BrowserState): void
  log(line: string): void
  now?: () => number
}

/** A chat's agent tab as agent APIs see it; the Sign-in tab is never one. */
export interface AgentTab {
  readonly contents: HostContents
  state(): BrowserTab
  /** Resolves once the current document has painted (rejects when `signal` aborts first). */
  whenReady(signal?: AbortSignal): Promise<void>
}

export type NavigateResult = { ok: true } | { ok: false; code: Extract<BrowserErrorCode, 'origin_blocked' | 'invalid_url' | 'secret_refused' | 'navigation_failed'> }
type DecideResult = { ok: true } | { ok: false; code: 'stale_prompt' }

export interface BrowserHost {
  /** The chat's agent tab, created lazily in the folder's partition. */
  ensureAgentTab(ref: BrowserChatRef): AgentTab
  /** The chat's agent tab if it exists; never the Sign-in tab. */
  agentTab(ref: BrowserChatRef): AgentTab | null
  navigate(ref: BrowserChatRef, url: string, by: 'agent' | 'person'): Promise<NavigateResult>
  decideOrigin(ref: BrowserChatRef, promptId: string, decision: 'once' | 'always' | 'deny'): Promise<DecideResult>
  openSignIn(ref: BrowserChatRef, url: string): Promise<NavigateResult>
  closeSignIn(ref: BrowserChatRef): void
  /** Shows the chat's visible tab at the placeholder's CSS bounds and hides every other view; null hides it. */
  setView(ref: BrowserChatRef, bounds: Rect | null): void
  /** Whether the chat's agent tab is the shown view and lies on the visible window (screenshots need it). */
  isShown(ref: BrowserChatRef): boolean
  state(ref: BrowserChatRef): BrowserState
  /** The origin the chat's agent tab asks for, if any; a Sign-in tab's prompt is never reported. */
  agentPendingOrigin(ref: BrowserChatRef): string | null
  /**
   * Whether an agent tab may load `url` as a frame: the folder's always list, read fresh, plus that tab's once set.
   * Contents that are no agent tab (the Sign-in tab) keep the session's own rules.
   */
  frameAllowed(webContentsId: number | undefined, url: string): Promise<boolean>
  /** Pushes the chat's state again (after an ownership or settings change). */
  refresh(ref: BrowserChatRef): void
  /** The window holding the views closed: every view is closed, and recreated lazily in the next window. */
  closeViews(): void
  disposeChat(ref: BrowserChatRef): void
  dispose(): void
}

/** The isolated world the paint probe runs in, apart from the page's own globals. */
const PAINT_WORLD = 4865
/** Two frames: the second callback runs once the first frame after load was produced. */
const PAINT_PROBE = 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'
const PAGE_ASK_INTERVAL_MS = 10_000
const URL_LIMIT = 2048
const TITLE_LIMIT = 512

interface PendingOrigin {
  id: string
  origin: string
  url: string
  requestedBy: Requester
  tab: TabKind
}

interface Deferred {
  promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

interface Tab {
  kind: TabKind
  view: HostView
  once: Set<string>
  url: string
  title: string
  loading: boolean
  ready: Deferred
  lastPageAsk: number | null
  closed: boolean
}

interface ChatBrowser {
  ref: BrowserChatRef
  agent: Tab | null
  signIn: Tab | null
  pending: PendingOrigin | null
}

function clip(text: string, limit: number): string {
  const masked = maskAgentChatSecretsDeep(text)
  const clipped = masked.slice(0, limit)
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'null'
  }
}

function tabState(tab: Tab): BrowserTab {
  return { url: clip(tab.url, URL_LIMIT), title: clip(tab.title, TITLE_LIMIT), loading: tab.loading }
}

/** The placeholder's CSS rect in the window's DIP. */
function toDip(bounds: Rect, zoom: number): Rect {
  return {
    x: Math.round(bounds.x * zoom), y: Math.round(bounds.y * zoom),
    width: Math.round(bounds.width * zoom), height: Math.round(bounds.height * zoom)
  }
}

/** Whether a DIP rect overlaps a window content area of `size` with a positive area. */
function overlaps(rect: Rect, size: { width: number; height: number }): boolean {
  const left = Math.max(0, rect.x)
  const top = Math.max(0, rect.y)
  return Math.min(size.width, rect.x + rect.width) > left && Math.min(size.height, rect.y + rect.height) > top
}

/** Waits for the tab's current readiness; an aborted signal rejects with its reason. */
function readyOf(tab: Tab, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return tab.ready.promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void tab.ready.promise.then(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    })
  })
}

function agentHandle(tab: Tab): AgentTab {
  return { contents: tab.view.webContents, state: () => tabState(tab), whenReady: (signal) => readyOf(tab, signal) }
}

function closeTab(tab: Tab, deps: BrowserHostDeps): void {
  tab.closed = true
  tab.view.setVisible(false)
  deps.detach(tab.view)
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
}

class Host implements BrowserHost {
  private readonly chats = new Map<string, ChatBrowser>()
  /** Each folder's always list as last read; null until read or when unreadable, so the policy asks. */
  private readonly always = new Map<string | null, readonly string[] | null>()
  private placement: { chatId: string; bounds: Rect } | null = null
  private disposed = false
  private readonly now: () => number

  constructor(private readonly deps: BrowserHostDeps) {
    this.now = deps.now ?? Date.now
  }

  ensureAgentTab(ref: BrowserChatRef): AgentTab {
    return agentHandle(this.ensureTab(this.chatOf(ref), 'agent'))
  }

  agentTab(ref: BrowserChatRef): AgentTab | null {
    const tab = this.chats.get(ref.chatId)?.agent ?? null
    return tab === null ? null : agentHandle(tab)
  }

  navigate(ref: BrowserChatRef, url: string, by: 'agent' | 'person'): Promise<NavigateResult> {
    const chat = this.chatOf(ref)
    return this.navigateTab(chat, this.ensureTab(chat, 'agent'), url, by)
  }

  async decideOrigin(ref: BrowserChatRef, promptId: string, decision: 'once' | 'always' | 'deny'): Promise<DecideResult> {
    const chat = this.chats.get(ref.chatId)
    const pending = chat?.pending
    if (chat === undefined || pending == null || pending.id !== promptId) return { ok: false, code: 'stale_prompt' }
    chat.pending = null
    this.push(chat)
    if (decision === 'deny') return { ok: true }
    if (decision === 'always') this.always.set(chat.ref.folder, await this.deps.sites.add(chat.ref.folder, pending.origin))
    this.loadApproved(chat, pending, decision === 'once')
    return { ok: true }
  }

  /** Loads an approved prompt's URL in the tab that asked, if it is still open; `once` allows the origin there. */
  private loadApproved(chat: ChatBrowser, pending: PendingOrigin, once: boolean): void {
    const tab = pending.tab === 'agent' ? chat.agent : chat.signIn
    if (tab === null || tab.closed) return
    if (once) tab.once.add(pending.origin)
    this.load(chat, tab, pending.url).catch(() => undefined)
  }

  openSignIn(ref: BrowserChatRef, url: string): Promise<NavigateResult> {
    const chat = this.chatOf(ref)
    return this.navigateTab(chat, this.ensureTab(chat, 'signIn'), url, 'person')
  }

  closeSignIn(ref: BrowserChatRef): void {
    const chat = this.chats.get(ref.chatId)
    if (chat?.signIn == null) return
    closeTab(chat.signIn, this.deps)
    chat.signIn = null
    if (chat.pending?.tab === 'signIn') chat.pending = null
    this.place()
    this.push(chat)
  }

  setView(ref: BrowserChatRef, bounds: Rect | null): void {
    this.placement = bounds === null ? null : { chatId: ref.chatId, bounds: { ...bounds } }
    this.place()
  }

  isShown(ref: BrowserChatRef): boolean {
    const chat = this.chats.get(ref.chatId)
    if (chat?.agent == null || chat.signIn !== null || this.placement?.chatId !== ref.chatId) return false
    const size = this.deps.windowContentSize()
    return size !== null && overlaps(toDip(this.placement.bounds, this.deps.zoomFactor()), size)
  }

  state(ref: BrowserChatRef): BrowserState {
    return this.stateOf(this.chats.get(ref.chatId) ?? { ref, agent: null, signIn: null, pending: null })
  }

  agentPendingOrigin(ref: BrowserChatRef): string | null {
    const pending = this.chats.get(ref.chatId)?.pending
    return pending?.tab === 'agent' ? pending.origin : null
  }

  async frameAllowed(webContentsId: number | undefined, url: string): Promise<boolean> {
    const chat = [...this.chats.values()].find((each) => each.agent !== null && each.agent.view.webContents.id === webContentsId)
    const tab = chat?.agent
    if (chat === undefined || tab == null) return true
    const always = await this.readSites(chat.ref.folder)
    return !tab.closed && decideNavigation(normalizeTarget(url, this.deps.appUrl), { always, once: tab.once }) === 'allow'
  }

  closeViews(): void {
    for (const chat of this.chats.values()) {
      for (const tab of [chat.agent, chat.signIn]) if (tab !== null) closeTab(tab, this.deps)
      chat.agent = null
      chat.signIn = null
      chat.pending = null
      this.push(chat)
    }
  }

  refresh(ref: BrowserChatRef): void {
    if (!this.disposed) this.deps.push(this.state(ref))
  }

  disposeChat(ref: BrowserChatRef): void {
    const chat = this.chats.get(ref.chatId)
    this.deps.ownership.forget(ref.chatId)
    if (chat === undefined) return
    this.chats.delete(ref.chatId)
    for (const tab of [chat.agent, chat.signIn]) if (tab !== null) closeTab(tab, this.deps)
    if (this.placement?.chatId === ref.chatId) this.placement = null
  }

  dispose(): void {
    for (const chat of this.chats.values()) this.disposeChat(chat.ref)
    this.disposed = true
  }

  private chatOf(ref: BrowserChatRef): ChatBrowser {
    let chat = this.chats.get(ref.chatId)
    if (chat === undefined) {
      chat = { ref: { folder: ref.folder, chatId: ref.chatId }, agent: null, signIn: null, pending: null }
      this.chats.set(ref.chatId, chat)
    }
    return chat
  }

  private async readSites(folder: string | null): Promise<readonly string[] | null> {
    try {
      const list = await this.deps.sites.list(folder)
      this.always.set(folder, list)
      return list
    } catch {
      this.always.set(folder, null)
      this.deps.log('browser sites unreadable; asking')
      return null
    }
  }

  private stateOf(chat: ChatBrowser): BrowserState {
    const owner = this.deps.ownership.owner(chat.ref.chatId)
    const { pending, signIn } = chat
    return {
      folder: chat.ref.folder,
      chatId: chat.ref.chatId,
      enabled: this.deps.enabled(),
      owner,
      ownerLabel: this.deps.ownerLabel(chat.ref, owner),
      tab: chat.agent === null ? null : tabState(chat.agent),
      signIn: signIn === null ? null : { url: clip(signIn.url, URL_LIMIT), title: clip(signIn.title, TITLE_LIMIT) },
      pendingOrigin: pending === null ? null : { id: pending.id, origin: pending.origin, requestedBy: pending.requestedBy }
    }
  }

  private push(chat: ChatBrowser): void {
    if (!this.disposed && this.chats.get(chat.ref.chatId) === chat) this.deps.push(this.stateOf(chat))
  }

  /** Shows the selected chat's tab (the Sign-in tab while it is open, else the agent tab) and hides every other. */
  private place(): void {
    const placement = this.placement
    const selected = placement === null ? undefined : this.chats.get(placement.chatId)
    const shown = selected === undefined ? null : (selected.signIn ?? selected.agent)
    for (const chat of this.chats.values()) {
      for (const tab of [chat.agent, chat.signIn]) if (tab !== null && tab !== shown) tab.view.setVisible(false)
    }
    if (shown === null || placement === null) return
    shown.view.setBounds(toDip(placement.bounds, this.deps.zoomFactor()))
    shown.view.setVisible(true)
  }

  /** Raises the chat's prompt; a page ask never replaces an agent or person prompt and comes at most once per 10 s. */
  private raise(chat: ChatBrowser, tab: Tab, ask: Omit<PendingOrigin, 'id' | 'tab'>): void {
    const current = chat.pending
    if (ask.requestedBy === 'page') {
      if (current !== null && current.requestedBy !== 'page') {
        this.deps.log(`browser page ask for ${ask.origin} dropped: a ${current.requestedBy} prompt is pending`)
        return
      }
      const at = this.now()
      if (tab.lastPageAsk !== null && at - tab.lastPageAsk < PAGE_ASK_INTERVAL_MS) {
        this.deps.log(`browser page ask for ${ask.origin} dropped: one page ask per 10 s`)
        return
      }
      tab.lastPageAsk = at
    }
    if (current !== null) this.deps.log(`browser prompt for ${current.origin} superseded; denied`)
    chat.pending = { ...ask, id: randomUUID(), tab: tab.kind }
    this.push(chat)
  }

  private load(chat: ChatBrowser, tab: Tab, url: string): Promise<void> {
    return tab.view.webContents.loadURL(url).catch((error: unknown) => {
      if (!tab.closed) this.deps.log(`browser load of ${originOf(url)} failed`)
      this.push(chat)
      throw error
    })
  }

  private ensureTab(chat: ChatBrowser, kind: TabKind): Tab {
    if (this.disposed) throw new Error('browser host disposed')
    const existing = kind === 'agent' ? chat.agent : chat.signIn
    if (existing !== null) return existing
    const tab = this.makeTab(chat, kind)
    if (kind === 'agent') chat.agent = tab
    else chat.signIn = tab
    if (!this.always.has(chat.ref.folder)) void this.readSites(chat.ref.folder)
    this.place()
    this.push(chat)
    return tab
  }

  private makeTab(chat: ChatBrowser, kind: TabKind): Tab {
    const partition = kind === 'agent'
      ? agentPartition(chat.ref.folder === null ? null : folderStoreId(chat.ref.folder))
      : signInPartition()
    const view = this.deps.createView({ ...BROWSER_WEB_PREFERENCES, partition })
    const tab: Tab = {
      kind, view, once: new Set(), url: '', title: '', loading: false, ready: deferred(), lastPageAsk: null, closed: false
    }
    // A tab that never loaded has nothing to paint; agent ops may run on it at once.
    tab.ready.resolve()
    this.deps.harden(view.webContents, {
      sites: () => ({ always: this.always.get(chat.ref.folder) ?? null, once: tab.once }),
      onAsk: (origin, url) => this.raise(chat, tab, { origin, url, requestedBy: 'page' }),
      onPopupBlocked: (url) => this.deps.log(`browser popup blocked ${originOf(url)}`)
    })
    this.track(chat, tab)
    this.deps.attach(view)
    return tab
  }

  /** Keeps the tab's `{url, title, loading}` and readiness current from its page events. */
  private track(chat: ChatBrowser, tab: Tab): void {
    const contents = tab.view.webContents
    const update = (change: Partial<Pick<Tab, 'url' | 'title' | 'loading'>>): void => {
      if (tab.closed) return
      Object.assign(tab, change)
      this.push(chat)
    }
    contents.on('did-start-loading', () => {
      if (!tab.closed) tab.ready = deferred()
      update({ loading: true })
    })
    contents.on('did-stop-loading', () => {
      update({ loading: false, url: contents.getURL(), title: contents.getTitle() })
      if (!tab.closed) probePaint(tab)
    })
    contents.on('did-navigate', (_event, url) => update({ url }))
    contents.on('did-navigate-in-page', (_event, url) => update({ url }))
    contents.on('page-title-updated', (_event, title) => update({ title }))
    contents.on('render-process-gone', () => {
      if (tab.closed) return
      this.deps.log('browser tab renderer gone')
      tab.ready = deferred()
      update({ loading: false })
    })
  }

  private async navigateTab(chat: ChatBrowser, tab: Tab, url: string, by: Requester): Promise<NavigateResult> {
    const target = normalizeTarget(url, this.deps.appUrl)
    if ('refused' in target) return { ok: false, code: target.refused === 'secret_refused' ? 'secret_refused' : 'invalid_url' }
    const always = await this.readSites(chat.ref.folder)
    if (tab.closed) return { ok: false, code: 'navigation_failed' }
    const decision = decideNavigation(target, { always, once: tab.once })
    if (decision === 'deny') return { ok: false, code: 'invalid_url' }
    if (decision === 'ask' && target.origin !== null) {
      this.raise(chat, tab, { origin: target.origin, url: target.href, requestedBy: by })
      return { ok: false, code: 'origin_blocked' }
    }
    try {
      await this.load(chat, tab, target.href)
      return { ok: true }
    } catch {
      return { ok: false, code: 'navigation_failed' }
    }
  }
}

/** Resolves the tab's readiness once the document loaded last has painted a frame. */
function probePaint(tab: Tab): void {
  const ready = tab.ready
  tab.view.webContents
    .executeJavaScriptInIsolatedWorld(PAINT_WORLD, [{ code: PAINT_PROBE }])
    .then(() => { if (tab.ready === ready) ready.resolve() }, () => undefined)
}

export function createBrowserHost(deps: BrowserHostDeps): BrowserHost {
  return new Host(deps)
}

/**
 * The real `harden` dep: locks each partition's session down once (with `dns.promises.lookup(host, { all: true })`
 * for its DNS checks) and every view's contents, agent and Sign-in tabs alike.
 */
export function createBrowserHardener(options: {
  appUrl: string | null
  log: (line: string) => void
  lookup?: (host: string) => Promise<readonly { address: string }[]>
  /** The host's `frameAllowed`: an agent tab's frames go through its origin decision (red-team R19-3). */
  frameAllowed: BrowserHost['frameAllowed']
}): Harden {
  const lookup = options.lookup ?? ((host: string) => dns.lookup(host, { all: true }))
  const hardened = new WeakSet<object>()
  return (contents, hooks) => {
    const session = contents.session
    if (!hardened.has(session)) {
      hardenBrowserSession(session, {
        lookup, log: options.log, frameAllowed: (details) => options.frameAllowed(details.webContentsId, details.url)
      })
      hardened.add(session)
    }
    hardenBrowserContents(contents, { appUrl: options.appUrl, ...hooks })
  }
}
