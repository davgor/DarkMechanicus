/**
 * The `browser:*` panel channels: exactly the contract's, every one behind the sender guard, each payload validated by
 * the strict schemas and its folder resolved through the registry before the host is reached. Stop, Take control and
 * Hand back apply ownership's effects on the tab in the same tick. Back, Forward and Reload run against the real host
 * and a real site list: a target the folder no longer allows raises the origin card and the tab never moves in history
 * (R19-1). Capture keeps the shown agent tab's PNG in a real chat image store, and never captures a Sign-in tab.
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../core/errors'
import { BROWSER_CHANNELS, type BrowserState } from '../../shared/browser/browserApi'
import type { CommandResult } from '../../shared/desktop/api'
import { pngBytes } from '../../test/images'
import { createChatImages } from '../agentChat/chatImages'
import type { ChatWindow } from '../agents/chatIpc'
import { guardIpc } from '../ipcGuard'
import { createBrowserHost, type AgentTab, type BrowserHost, type HostContents } from './browserHost'
import { createBrowserIpcHandlers, createBrowserPush, registerBrowserIpc, type PanelContents } from './browserIpc'
import { createBrowserOwnership, type BrowserOwnership } from './browserOwnership'
import { createSiteStore, type SiteStore } from './siteStore'

type Listener = Parameters<IpcMain['handle']>[1]
const APP_URL = 'http://localhost:5173'
const REPO = '/work/repo'
const CHAT = { folder: REPO, chatId: 'chat_1' }
const REF = { folder: REPO, chatId: 'chat_1' }
const INVOKED = Object.values(BROWSER_CHANNELS).filter((channel) => channel !== BROWSER_CHANNELS.event).sort()
const PNG = pngBytes(4, 3)
const frame = (url: string, parent: object | null = null) => ({ url, parent, detached: false, isDestroyed: () => false })
const TRUSTED = { sender: {}, senderFrame: frame(`${APP_URL}/`) } as unknown as IpcMainInvokeEvent
const STATE: BrowserState = { ...CHAT, enabled: true, owner: 'none', ownerLabel: null, tab: null, signIn: null, pendingOrigin: null }

/** A valid request for each invoked channel. */
const REQUESTS: Record<string, Record<string, unknown>> = {
  [BROWSER_CHANNELS.state]: CHAT,
  [BROWSER_CHANNELS.setView]: { ...CHAT, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  [BROWSER_CHANNELS.navigate]: { ...CHAT, url: 'https://a.example/' },
  [BROWSER_CHANNELS.back]: CHAT,
  [BROWSER_CHANNELS.forward]: CHAT,
  [BROWSER_CHANNELS.reload]: CHAT,
  [BROWSER_CHANNELS.stopAgent]: CHAT,
  [BROWSER_CHANNELS.takeControl]: CHAT,
  [BROWSER_CHANNELS.handBack]: CHAT,
  [BROWSER_CHANNELS.decideOrigin]: { ...CHAT, promptId: 'p1', decision: 'once' },
  [BROWSER_CHANNELS.openSignIn]: { ...CHAT, url: 'https://login.example/' },
  [BROWSER_CHANNELS.closeSignIn]: CHAT,
  [BROWSER_CHANNELS.sites]: { folder: REPO },
  [BROWSER_CHANNELS.removeSite]: { folder: REPO, origin: 'https://a.example' },
  [BROWSER_CHANNELS.setEnabled]: { enabled: false },
  [BROWSER_CHANNELS.capture]: CHAT
}

const codeOf = (result: CommandResult<unknown>) => (result.ok ? 'ok' : result.error.code)

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

let nextId = 1

/** A tab's contents with a real-shaped history: each load drops the forward entries and appends one. */
function historyContents() {
  const entries: string[] = []
  let active = -1
  const contents = {
    id: nextId++,
    loadURL: vi.fn(async (url: string) => { entries.splice(active + 1); entries.push(url); active = entries.length - 1 }),
    getURL: () => entries[active] ?? '', getTitle: () => '', isDestroyed: () => false, close: vi.fn(),
    executeJavaScriptInIsolatedWorld: vi.fn(async () => true),
    on: () => contents,
    navigationHistory: {
      getActiveIndex: () => active,
      length: () => entries.length,
      getEntryAtIndex: (index: number) => (entries[index] === undefined ? null : { url: entries[index] }),
      goBack: vi.fn(() => { active -= 1 }),
      goForward: vi.fn(() => { active += 1 })
    },
    reload: vi.fn(),
    stop: vi.fn(),
    capturePage: vi.fn(async (): Promise<{ isEmpty(): boolean; toPNG(): Buffer }> => ({ isEmpty: () => false, toPNG: () => PNG }))
  }
  return contents
}
type HistoryContents = ReturnType<typeof historyContents>

/** The guarded registrar, recording each listener once and each refused channel. */
function guarded() {
  const listeners = new Map<string, Listener>()
  const refused: string[] = []
  const ipc = guardIpc({
    handle: (channel, listener) => {
      if (listeners.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
      listeners.set(channel, listener)
    }
  }, { appUrl: APP_URL, onRefused: (channel) => { refused.push(channel) } })
  const invoke = async (channel: string, request: unknown, event = TRUSTED) => (await listeners.get(channel)!(event, request)) as CommandResult<unknown>
  return { ipc, listeners, refused, invoke }
}

/** Recording host, settings and sites over real ownership; the tab's driver and contents are fakes. */
function rig() {
  const calls: unknown[][] = []
  const record = <T>(name: string, result: T) => vi.fn((...args: unknown[]) => { calls.push([name, ...args]); return result })
  const contents = historyContents()
  const tab = { contents: contents as unknown as HostContents, state: () => ({ url: '', title: '', loading: false }), whenReady: async () => undefined } satisfies AgentTab
  const driver = { detach: vi.fn() }
  const host = {
    state: record('state', STATE), setView: record('setView', undefined),
    navigate: record('navigate', Promise.resolve({ ok: true })), agentTab: vi.fn(() => tab as AgentTab | null), isShown: vi.fn(() => true),
    frameAllowed: record('frameAllowed', Promise.resolve(true)), decideOrigin: record('decideOrigin', Promise.resolve({ ok: true })),
    openSignIn: record('openSignIn', Promise.resolve({ ok: true })), closeSignIn: record('closeSignIn', undefined), refresh: record('refresh', undefined)
  } as unknown as Pick<BrowserHost, 'state' | 'setView' | 'navigate' | 'agentTab' | 'isShown' | 'frameAllowed' | 'decideOrigin' | 'openSignIn' | 'closeSignIn' | 'refresh'>
  const ownership = createBrowserOwnership()
  const settings = { setEnabled: record('setEnabled', Promise.resolve()) }
  const sites = { list: record('list', Promise.resolve(['https://a.example'])), remove: record('remove', Promise.resolve([])) }
  const images = { put: record('put', Promise.resolve({ id: 'ci_00000000000000000000000000', mime: 'image/png' as const, width: 4, height: 3, bytes: PNG.length })) }
  const { ipc, listeners, refused, invoke } = guarded()
  const onUnexpectedError = vi.fn()
  registerBrowserIpc(ipc, createBrowserIpcHandlers({
    registry: { resolve: (path) => (path === REPO ? REPO : null) }, host, ownership, settings, sites, images,
    driverFor: (handle) => { calls.push(['driverFor', handle === tab]); return driver },
    contentsFor: (handle) => { calls.push(['contentsFor', handle === tab]); return contents as PanelContents },
    onUnexpectedError
  }))
  return { calls, host, ownership, contents, driver, listeners, refused, invoke, onUnexpectedError }
}

describe('browser panel IPC registration (c1)', () => {
  it('registers exactly the panel channels, each once, capture included: never the event channel', () => {
    expect([...rig().listeners.keys()].sort()).toEqual(INVOKED)
  })

  it('answers each channel for the app page', async () => {
    const state = rig()
    for (const channel of INVOKED) expect(codeOf(await state.invoke(channel, REQUESTS[channel])), channel).toBe('ok')
    expect(state.refused).toEqual([])
  })

  it('refuses every channel from an untrusted sender before any handler runs', async () => {
    const state = rig()
    const untrusted = [
      { sender: {}, senderFrame: frame('https://evil.example/') },
      { sender: {}, senderFrame: frame(`${APP_URL}/`, {}) },
      { sender: {}, senderFrame: null }
    ] as unknown as IpcMainInvokeEvent[]
    for (const channel of INVOKED) {
      for (const event of untrusted) expect(codeOf(await state.invoke(channel, REQUESTS[channel], event)), channel).toBe('unauthorized')
    }
    expect(state.refused).toHaveLength(INVOKED.length * untrusted.length)
    expect(state.calls).toEqual([])
    expect(state.ownership.owner(CHAT.chatId)).toBe('none')
  })

  it('refuses unknown keys and malformed payloads', async () => {
    const state = rig()
    for (const channel of INVOKED) {
      expect(codeOf(await state.invoke(channel, { ...REQUESTS[channel], extra: true })), channel).toBe('invalid_input')
      expect(codeOf(await state.invoke(channel, undefined)), channel).toBe('invalid_input')
    }
    expect(codeOf(await state.invoke(BROWSER_CHANNELS.state, { ...CHAT, chatId: '../escape' }))).toBe('invalid_input')
    expect(codeOf(await state.invoke(BROWSER_CHANNELS.setView, { ...CHAT, bounds: { x: 0, y: 0, width: 1, height: 1, z: 1 } }))).toBe('invalid_input')
    expect(codeOf(await state.invoke(BROWSER_CHANNELS.removeSite, { folder: REPO, origin: 'https://a.example/path' }))).toBe('invalid_input')
    expect(state.calls).toEqual([])
  })

  it('refuses a folder outside the registry before the host, ownership or the sites are reached', async () => {
    const state = rig()
    for (const channel of INVOKED.filter((name) => name !== BROWSER_CHANNELS.setEnabled)) {
      expect(codeOf(await state.invoke(channel, { ...REQUESTS[channel], folder: '/elsewhere' })), channel).toBe('unauthorized')
    }
    expect(state.calls).toEqual([])
    expect(state.ownership.owner(CHAT.chatId)).toBe('none')
  })
})

describe('browser panel IPC routing', () => {
  it('passes a project-less chat and its sites with a null folder', async () => {
    const state = rig()
    expect(await state.invoke(BROWSER_CHANNELS.state, { folder: null, chatId: 'chat_1' })).toEqual({ ok: true, data: STATE })
    expect(await state.invoke(BROWSER_CHANNELS.sites, { folder: null })).toEqual({ ok: true, data: ['https://a.example'] })
    expect(state.calls).toEqual([['state', { folder: null, chatId: 'chat_1' }], ['list', null]])
  })

  it('reaches the host, the site list and the settings with the resolved chat and nothing else', async () => {
    const state = rig()
    await state.invoke(BROWSER_CHANNELS.setView, REQUESTS[BROWSER_CHANNELS.setView])
    await state.invoke(BROWSER_CHANNELS.setView, { ...CHAT, bounds: null })
    await state.invoke(BROWSER_CHANNELS.navigate, REQUESTS[BROWSER_CHANNELS.navigate])
    await state.invoke(BROWSER_CHANNELS.decideOrigin, { ...CHAT, promptId: 'p1', decision: 'always' })
    await state.invoke(BROWSER_CHANNELS.openSignIn, REQUESTS[BROWSER_CHANNELS.openSignIn])
    await state.invoke(BROWSER_CHANNELS.closeSignIn, CHAT)
    await state.invoke(BROWSER_CHANNELS.removeSite, REQUESTS[BROWSER_CHANNELS.removeSite])
    await state.invoke(BROWSER_CHANNELS.setEnabled, { enabled: false })
    expect(state.calls).toEqual([
      ['setView', REF, { x: 0, y: 0, width: 400, height: 300 }],
      ['setView', REF, null],
      ['navigate', REF, 'https://a.example/', 'person'],
      ['decideOrigin', REF, 'p1', 'always'],
      ['openSignIn', REF, 'https://login.example/'],
      ['closeSignIn', REF],
      ['remove', REPO, 'https://a.example'],
      ['setEnabled', false]
    ])
  })

  it("answers a person's navigation held for the origin card as ok, and any other refusal as its error", async () => {
    const state = rig()
    vi.mocked(state.host.navigate).mockResolvedValueOnce({ ok: false, code: 'origin_blocked' })
    expect(await state.invoke(BROWSER_CHANNELS.navigate, REQUESTS[BROWSER_CHANNELS.navigate])).toEqual({ ok: true, data: null })
    vi.mocked(state.host.navigate).mockResolvedValueOnce({ ok: false, code: 'secret_refused' })
    expect(codeOf(await state.invoke(BROWSER_CHANNELS.navigate, REQUESTS[BROWSER_CHANNELS.navigate]))).toBe('secret_refused')
    vi.mocked(state.host.openSignIn).mockResolvedValueOnce({ ok: false, code: 'invalid_url' })
    expect(codeOf(await state.invoke(BROWSER_CHANNELS.openSignIn, REQUESTS[BROWSER_CHANNELS.openSignIn]))).toBe('invalid_url')
    vi.mocked(state.host.decideOrigin).mockResolvedValueOnce({ ok: false, code: 'stale_prompt' })
    expect(codeOf(await state.invoke(BROWSER_CHANNELS.decideOrigin, REQUESTS[BROWSER_CHANNELS.decideOrigin]))).toBe('stale_prompt')
    expect(state.onUnexpectedError).not.toHaveBeenCalled()
  })
})

describe('browser panel ownership effects (c2)', () => {
  it('Stop detaches the debugger and stops loading in the same tick, before the handler settles', async () => {
    const state = rig()
    const answered = state.listeners.get(BROWSER_CHANNELS.stopAgent)!(TRUSTED, CHAT) as Promise<CommandResult<null>>
    expect(state.driver.detach).toHaveBeenCalledTimes(1)
    expect(state.contents.stop).toHaveBeenCalledTimes(1)
    expect(state.ownership.owner(CHAT.chatId)).toBe('stopped')
    expect(state.calls).toContainEqual(['refresh', REF])
    expect(await answered).toEqual({ ok: true, data: null })
  })

  it("Stop aborts the agent's in-flight op at once", async () => {
    const state = rig()
    const lease = state.ownership.beginAgentOp(CHAT.chatId)
    if (!lease.ok) throw new Error('lease refused')
    void state.listeners.get(BROWSER_CHANNELS.stopAgent)!(TRUSTED, CHAT)
    expect(lease.signal.aborted).toBe(true)
    expect(lease.signal.reason).toBe('stopped')
  })

  it('Take control detaches the debugger only, and the person then owns the browser', async () => {
    const state = rig()
    const answered = state.listeners.get(BROWSER_CHANNELS.takeControl)!(TRUSTED, CHAT) as Promise<CommandResult<null>>
    expect(state.driver.detach).toHaveBeenCalledTimes(1)
    expect(state.contents.stop).not.toHaveBeenCalled()
    expect(await answered).toEqual({ ok: true, data: null })
    expect(state.ownership.owner(CHAT.chatId)).toBe('person')
    expect(state.ownership.beginAgentOp(CHAT.chatId)).toEqual({ ok: false, code: 'paused_by_person' })
  })

  it('Hand back returns the browser to the agent with no effect of its own, and a stopped one to nobody', async () => {
    const state = rig()
    await state.invoke(BROWSER_CHANNELS.takeControl, CHAT)
    state.driver.detach.mockClear()
    expect(await state.invoke(BROWSER_CHANNELS.handBack, CHAT)).toEqual({ ok: true, data: null })
    expect(state.ownership.owner(CHAT.chatId)).toBe('agent')
    await state.invoke(BROWSER_CHANNELS.stopAgent, CHAT)
    await state.invoke(BROWSER_CHANNELS.handBack, CHAT)
    expect(state.ownership.owner(CHAT.chatId)).toBe('none')
    expect(state.calls.filter(([name]) => name === 'refresh')).toHaveLength(4)
  })

  it('applies the transition with no tab: nothing to detach, and the owner still changes', async () => {
    const state = rig()
    vi.mocked(state.host.agentTab).mockReturnValue(null)
    expect(await state.invoke(BROWSER_CHANNELS.stopAgent, CHAT)).toEqual({ ok: true, data: null })
    expect(state.driver.detach).not.toHaveBeenCalled()
    expect(state.ownership.owner(CHAT.chatId)).toBe('stopped')
  })
})

/** The real host over fake tabs, a real site list and chat image store in a temp folder, and the panel channels on top. */
function hostRig(options: { sites?: (store: SiteStore) => SiteStore } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dm-browser-ipc-'))
  roots.push(root)
  const store = createSiteStore({ root, log: () => undefined })
  const sites = options.sites?.(store) ?? store
  const images = createChatImages({ root: join(root, 'chat-images') })
  const ownership: BrowserOwnership = createBrowserOwnership()
  const tabs: HistoryContents[] = []
  const pushed: BrowserState[] = []
  const host = createBrowserHost({
    createView: () => {
      const contents = historyContents()
      tabs.push(contents)
      return { webContents: contents as unknown as HostContents, setBounds: vi.fn(), setVisible: vi.fn() }
    },
    attach: vi.fn(), detach: vi.fn(), zoomFactor: () => 1, windowContentSize: () => ({ width: 1280, height: 800 }),
    appUrl: APP_URL, sites, harden: () => undefined, ownership, ownerLabel: () => null, enabled: () => true,
    push: (state) => pushed.push(state), log: () => undefined
  })
  const { ipc, invoke } = guarded()
  const onUnexpectedError = vi.fn()
  registerBrowserIpc(ipc, createBrowserIpcHandlers({
    registry: { resolve: (path) => (path === REPO ? REPO : null) }, host, ownership, settings: { setEnabled: async () => undefined }, sites,
    images, driverFor: () => ({ detach: vi.fn() }),
    contentsFor: (tab) => tab.contents as unknown as PanelContents,
    onUnexpectedError
  }))
  const tab = (): HistoryContents => tabs[0]!
  return { host, store, images, invoke, tab, tabs, pushed, onUnexpectedError }
}

/** The tab, with both origins always allowed, went a → b. */
async function wentAToB(state: ReturnType<typeof hostRig>): Promise<HistoryContents> {
  await state.store.add(REPO, 'https://a.example')
  await state.store.add(REPO, 'https://b.example')
  expect(await state.invoke(BROWSER_CHANNELS.navigate, { ...CHAT, url: 'https://a.example/' })).toEqual({ ok: true, data: null })
  expect(await state.invoke(BROWSER_CHANNELS.navigate, { ...CHAT, url: 'https://b.example/' })).toEqual({ ok: true, data: null })
  const tab = state.tab()
  expect(tab.navigationHistory.getActiveIndex()).toBe(1)
  return tab
}

describe('browser panel history re-checks the origin (c4, R19-1)', () => {
  it('Back to a removed site raises its origin card as the person and never calls goBack', async () => {
    const state = hostRig()
    const tab = await wentAToB(state)
    expect(await state.invoke(BROWSER_CHANNELS.removeSite, { folder: REPO, origin: 'https://a.example' })).toEqual({ ok: true, data: null })
    expect(await state.invoke(BROWSER_CHANNELS.back, CHAT)).toEqual({ ok: true, data: null })
    expect(tab.navigationHistory.goBack).not.toHaveBeenCalled()
    expect(tab.loadURL).toHaveBeenCalledTimes(2)
    expect(state.host.state(REF).pendingOrigin).toMatchObject({ origin: 'https://a.example', requestedBy: 'person' })
    expect(tab.navigationHistory.getActiveIndex()).toBe(1)
  })

  it('Forward to a removed site raises its origin card and never calls goForward', async () => {
    const state = hostRig()
    const tab = await wentAToB(state)
    await state.invoke(BROWSER_CHANNELS.back, CHAT)
    expect(tab.navigationHistory.goBack).toHaveBeenCalledTimes(1)
    await state.invoke(BROWSER_CHANNELS.removeSite, { folder: REPO, origin: 'https://b.example' })
    expect(await state.invoke(BROWSER_CHANNELS.forward, CHAT)).toEqual({ ok: true, data: null })
    expect(tab.navigationHistory.goForward).not.toHaveBeenCalled()
    expect(state.host.state(REF).pendingOrigin).toMatchObject({ origin: 'https://b.example', requestedBy: 'person' })
  })

  it('Reload of a removed site raises its origin card and never calls reload', async () => {
    const state = hostRig()
    const tab = await wentAToB(state)
    await state.invoke(BROWSER_CHANNELS.removeSite, { folder: REPO, origin: 'https://b.example' })
    expect(await state.invoke(BROWSER_CHANNELS.reload, CHAT)).toEqual({ ok: true, data: null })
    expect(tab.reload).not.toHaveBeenCalled()
    expect(state.host.state(REF).pendingOrigin).toMatchObject({ origin: 'https://b.example', requestedBy: 'person' })
  })

  it('allowed targets move in history and reload normally, raising no card', async () => {
    const state = hostRig()
    const tab = await wentAToB(state)
    await state.invoke(BROWSER_CHANNELS.back, CHAT)
    await state.invoke(BROWSER_CHANNELS.forward, CHAT)
    await state.invoke(BROWSER_CHANNELS.reload, CHAT)
    expect(tab.navigationHistory.goBack).toHaveBeenCalledTimes(1)
    expect(tab.navigationHistory.goForward).toHaveBeenCalledTimes(1)
    expect(tab.reload).toHaveBeenCalledTimes(1)
    expect(tab.loadURL).toHaveBeenCalledTimes(2)
    expect(state.host.state(REF).pendingOrigin).toBeNull()
  })

  it('does nothing past either end of the history or with no tab', async () => {
    const state = hostRig()
    expect(await state.invoke(BROWSER_CHANNELS.back, CHAT)).toEqual({ ok: true, data: null })
    const tab = await wentAToB(state)
    expect(await state.invoke(BROWSER_CHANNELS.forward, CHAT)).toEqual({ ok: true, data: null })
    expect(tab.navigationHistory.goForward).not.toHaveBeenCalled()
    expect(state.host.state(REF).pendingOrigin).toBeNull()
  })
})

describe('browser panel origin decisions', () => {
  it("surfaces an 'always' the site list refuses (its cap) to the caller; the card is already cleared", async () => {
    const state = hostRig({
      sites: (store) => ({ ...store, add: async () => { throw new DomainError('capacity_exceeded', 'A folder can always allow at most 200 sites.') } })
    })
    expect(await state.invoke(BROWSER_CHANNELS.navigate, { ...CHAT, url: 'https://c.example/' })).toEqual({ ok: true, data: null })
    const prompt = state.host.state(REF).pendingOrigin
    expect(prompt).toMatchObject({ origin: 'https://c.example', requestedBy: 'person' })
    const result = await state.invoke(BROWSER_CHANNELS.decideOrigin, { ...CHAT, promptId: prompt!.id, decision: 'always' })
    expect(result).toEqual({ ok: false, error: { code: 'capacity_exceeded', message: 'A folder can always allow at most 200 sites.' } })
    expect(state.host.state(REF).pendingOrigin).toBeNull()
    expect(state.tab().loadURL).not.toHaveBeenCalled()
  })
})

const BOUNDS = { x: 0, y: 0, width: 400, height: 300 }

/** The agent tab on an always-allowed page, placed on the window. */
async function shownAgentTab(state: ReturnType<typeof hostRig>): Promise<HistoryContents> {
  await state.store.add(REPO, 'https://a.example')
  expect(await state.invoke(BROWSER_CHANNELS.navigate, { ...CHAT, url: 'https://a.example/' })).toEqual({ ok: true, data: null })
  expect(await state.invoke(BROWSER_CHANNELS.setView, { ...CHAT, bounds: BOUNDS })).toEqual({ ok: true, data: null })
  return state.tab()
}

describe('browser panel camera: the stored capture and no_tab (DM-873 c1)', () => {
  it('stores one PNG of the shown agent tab in the chat image store and answers its ref', async () => {
    const state = hostRig()
    const tab = await shownAgentTab(state)
    const put = vi.spyOn(state.images, 'put')
    const result = await state.invoke(BROWSER_CHANNELS.capture, CHAT)
    expect(put).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledWith(REF, PNG)
    const image = await put.mock.results[0]!.value
    expect(image).toEqual({ id: expect.stringMatching(/^ci_/), mime: 'image/png', width: 4, height: 3, bytes: PNG.length })
    expect(result).toEqual({ ok: true, data: { image } })
    expect(tab.capturePage).toHaveBeenCalledTimes(1)
    const stored = await state.images.read(REF, image.id)
    expect(stored === null ? null : Buffer.from(stored.bytes).equals(PNG)).toBe(true)
    // The image is the chat's own: another chat of the folder cannot read it.
    expect(await state.images.read({ ...REF, chatId: 'chat_2' }, image.id)).toBeNull()
    expect(state.onUnexpectedError).not.toHaveBeenCalled()
  })

  it('refuses with no_tab when the chat has no tab, or only a Sign-in tab, and captures nothing', async () => {
    const state = hostRig()
    expect(await state.invoke(BROWSER_CHANNELS.setView, { ...CHAT, bounds: BOUNDS })).toEqual({ ok: true, data: null })
    expect(await state.invoke(BROWSER_CHANNELS.capture, CHAT)).toEqual({ ok: false, error: { code: 'no_tab', message: 'No browser tab is open.' } })
    await state.store.add(REPO, 'https://login.example')
    expect(await state.invoke(BROWSER_CHANNELS.openSignIn, { ...CHAT, url: 'https://login.example/' })).toEqual({ ok: true, data: null })
    expect(state.tabs).toHaveLength(1)
    expect(state.host.agentTab(REF)).toBeNull()
    expect(codeOf(await state.invoke(BROWSER_CHANNELS.capture, CHAT))).toBe('no_tab')
    expect(state.tab().capturePage).not.toHaveBeenCalled()
    expect(state.onUnexpectedError).not.toHaveBeenCalled()
  })
})

describe('browser panel camera: hidden views and failed captures (DM-873 c1)', () => {
  it('never captures a Sign-in tab open over the agent tab: view_hidden, and neither page is read', async () => {
    const state = hostRig()
    const agent = await shownAgentTab(state)
    await state.store.add(REPO, 'https://login.example')
    expect(await state.invoke(BROWSER_CHANNELS.openSignIn, { ...CHAT, url: 'https://login.example/' })).toEqual({ ok: true, data: null })
    const signIn = state.tabs[1]!
    expect(await state.invoke(BROWSER_CHANNELS.capture, CHAT)).toEqual({
      ok: false, error: { code: 'view_hidden', message: 'The screenshot was refused: browser view not visible.' }
    })
    expect(agent.capturePage).not.toHaveBeenCalled()
    expect(signIn.capturePage).not.toHaveBeenCalled()
  })

  it('refuses a hidden view with view_hidden, and an empty or failed capture with navigation_failed, storing nothing', async () => {
    const state = hostRig()
    const tab = await shownAgentTab(state)
    const put = vi.spyOn(state.images, 'put')
    expect(await state.invoke(BROWSER_CHANNELS.setView, { ...CHAT, bounds: null })).toEqual({ ok: true, data: null })
    expect(codeOf(await state.invoke(BROWSER_CHANNELS.capture, CHAT))).toBe('view_hidden')
    expect(tab.capturePage).not.toHaveBeenCalled()
    await state.invoke(BROWSER_CHANNELS.setView, { ...CHAT, bounds: BOUNDS })
    tab.capturePage.mockResolvedValueOnce({ isEmpty: () => true, toPNG: () => PNG })
    expect(codeOf(await state.invoke(BROWSER_CHANNELS.capture, CHAT))).toBe('navigation_failed')
    tab.capturePage.mockRejectedValueOnce(new Error('UnknownVizError'))
    expect(codeOf(await state.invoke(BROWSER_CHANNELS.capture, CHAT))).toBe('navigation_failed')
    expect(put).not.toHaveBeenCalled()
    expect(state.onUnexpectedError).not.toHaveBeenCalled()
  })

  it('refuses a view hidden while the page was being read, storing nothing', async () => {
    const state = hostRig()
    const tab = await shownAgentTab(state)
    const put = vi.spyOn(state.images, 'put')
    tab.capturePage.mockImplementationOnce(async () => {
      state.host.setView(REF, null)
      return { isEmpty: () => false, toPNG: () => PNG }
    })
    expect(codeOf(await state.invoke(BROWSER_CHANNELS.capture, CHAT))).toBe('view_hidden')
    expect(put).not.toHaveBeenCalled()
  })
})

describe('browser push', () => {
  function window(destroyed = false) {
    return { isDestroyed: () => destroyed, webContents: { isDestroyed: () => false, send: vi.fn() } } satisfies ChatWindow
  }

  it('sends a valid state to every open window on browser:event and drops an invalid one', () => {
    const open = window()
    const closed = window(true)
    const push = createBrowserPush(() => [open, closed])
    push(STATE)
    push({ ...STATE, extra: true } as BrowserState)
    push({ ...STATE, owner: 'someone' } as unknown as BrowserState)
    expect(open.webContents.send.mock.calls).toEqual([[BROWSER_CHANNELS.event, STATE]])
    expect(closed.webContents.send).not.toHaveBeenCalled()
  })
})
