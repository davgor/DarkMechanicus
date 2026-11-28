/**
 * The browser join's edges with a stub grant binding (the real grants are `browserWiring.test.ts`'s): bindings that
 * cannot verify, the owner badge's bound tickets, the main window coming and going, and IPC failures.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserClient } from '../../core/desktop/browserClient'
import type { ActivityBinding } from '../agents/activityBindings'
import { BROWSER_CHANNELS } from '../../shared/browser/browserApi'
import type { BrowserOperation } from '../../shared/browser/browserControl'
import type { BrowserControlBinding } from './browserDispatch'
import { startBrowser, type BrowserWindowLike, type WiredView } from './browserWiring'
import { fakeView, fakeWindow, type BeforeRequest, type FakeView } from './__mocks__/browserViewFakes'

type Deps = Parameters<typeof startBrowser<WiredView>>[0]

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ATTEMPT_A = `at_${'a'.repeat(26)}`
const ATTEMPT_B = `at_${'b'.repeat(26)}`

/** A live binding as the grant registry would hand it over; `verify: false` leaves `verifyAuthority` out. */
function binding(folder: string | null, chatId: string, verify = true): BrowserControlBinding {
  const base = { folder, chatId, signal: new AbortController().signal, assertCurrent: () => undefined }
  return verify ? { ...base, verifyAuthority: async () => undefined } : base
}

async function rig(overrides: Partial<Deps> & { binding?: BrowserControlBinding } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-browser-edges-')))
  const folder = join(root, 'repo')
  mkdirSync(folder)
  const windows: BrowserWindowLike<WiredView>[] = []
  const views: FakeView[] = []
  const beforeRequests = new Map<string, BeforeRequest>()
  const log = vi.fn<(line: string) => void>()
  const wiring = startBrowser<WiredView>({
    root: join(root, 'browser'), appUrl: 'http://localhost:5173', windows: () => windows,
    registry: { resolve: (path) => (path === folder ? path : null) },
    createView: (webPreferences) => {
      const view = fakeView(beforeRequests, webPreferences.partition)
      views.push(view)
      return view as unknown as WiredView
    },
    authorize: () => overrides.binding ?? binding(folder, 'chat-a'),
    images: { put: vi.fn() }, chatFor: () => ({ role: 'worker', title: 'Browser chat' }),
    bindings: { threadsOf: () => [] }, ticketKeyOfAttempt: async () => null,
    push: vi.fn(), log, lookup: async () => [{ address: '93.184.216.34' }],
    ...overrides
  })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => wiring.dispose())
  await wiring.ready
  const env = { DM_BROWSER_PIPE: wiring.address(), DM_SESSION_TOKEN: 'stub-token' }
  const call = (operation: BrowserOperation) => createBrowserClient({ env }).request(operation)
  return { wiring, windows, views, log, folder, root, call }
}

const NAVIGATE: BrowserOperation = { op: 'browser_navigate', args: { url: 'https://a.example/', as: 'Acolyte:DM-442' } }

describe('browser pipe bindings', () => {
  it('refuses a binding that cannot verify browser.drive, before anything runs', async () => {
    const fake = await rig({ binding: binding(null, 'chat-a', false) })
    fake.windows.push(fakeWindow().window)
    expect(await fake.call(NAVIGATE)).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(fake.views).toHaveLength(0)
    expect(fake.wiring.ownership.owner('chat-a')).toBe('none')
  })

  it("labels the driving agent by the chat's bound tickets: each attempt read once, an unreadable key left out", async () => {
    const threadsOf = vi.fn((_chat: { folder: string; id: string }): ActivityBinding[] => [
      { kind: 'run', runId: `rn_${'c'.repeat(26)}`, chatId: 'chat-a', threadId: null, folder: '', role: 'orchestrator' },
      { kind: 'attempt', attemptId: ATTEMPT_A, chatId: 'chat-a', threadId: 't1', folder: '', role: 'worker' },
      { kind: 'attempt', attemptId: ATTEMPT_B, chatId: 'chat-a', threadId: 't2', folder: '', role: 'worker' },
      { kind: 'attempt', attemptId: ATTEMPT_A, chatId: 'chat-a', threadId: 't3', folder: '', role: 'worker' }
    ])
    const ticketKeyOfAttempt = vi.fn(async (_folder: string, attemptId: string) => {
      if (attemptId === ATTEMPT_B) throw new Error('timeline unreadable')
      return 'DM-442'
    })
    const fake = await rig({ bindings: { threadsOf }, ticketKeyOfAttempt })
    fake.windows.push(fakeWindow().window)
    await fake.wiring.sites.add(fake.folder, 'https://a.example')
    expect(await fake.call(NAVIGATE)).toMatchObject({ ok: true })
    expect(threadsOf).toHaveBeenCalledWith({ folder: fake.folder, id: 'chat-a' })
    expect(ticketKeyOfAttempt.mock.calls).toEqual([[fake.folder, ATTEMPT_A], [fake.folder, ATTEMPT_B]])
    expect(fake.wiring.host.state({ folder: fake.folder, chatId: 'chat-a' }).ownerLabel).toBe('Acolyte:DM-442')
  })

  it("names a project-less chat's agent by the chat itself: it has no bound tickets to read", async () => {
    const threadsOf = vi.fn((): ActivityBinding[] => [])
    const fake = await rig({ binding: binding(null, 'loose'), bindings: { threadsOf } })
    fake.windows.push(fakeWindow().window)
    await fake.wiring.sites.add(null, 'https://a.example')
    expect(await fake.call(NAVIGATE)).toMatchObject({ ok: true })
    expect(threadsOf).not.toHaveBeenCalled()
    expect(fake.wiring.host.state({ folder: null, chatId: 'loose' }).ownerLabel).toBe('Browser chat')
  })
})

describe('browser views and the main window (Fix 46)', () => {
  it("ignores a late close of a window already replaced: the new window's views stay open", async () => {
    const fake = await rig()
    const first = fakeWindow()
    fake.windows.push(first.window)
    fake.wiring.host.ensureAgentTab({ folder: fake.folder, chatId: 'chat-a' })
    first.destroy()
    const second = fakeWindow()
    fake.windows.push(second.window)
    fake.wiring.host.ensureAgentTab({ folder: fake.folder, chatId: 'chat-b' })
    expect(second.window.contentView.addChildView).toHaveBeenCalledWith(fake.views[1])
    first.fireClosed()
    expect(fake.views[1].webContents.close).not.toHaveBeenCalled()
    expect(fake.wiring.host.agentTab({ folder: fake.folder, chatId: 'chat-b' })).not.toBeNull()
  })

  it('removes a closed view from a live window, and never touches a destroyed one', async () => {
    const fake = await rig()
    const main = fakeWindow()
    fake.windows.push(main.window)
    fake.wiring.host.ensureAgentTab({ folder: fake.folder, chatId: 'chat-a' })
    fake.wiring.host.ensureAgentTab({ folder: fake.folder, chatId: 'chat-b' })
    fake.wiring.host.disposeChat({ folder: fake.folder, chatId: 'chat-a' })
    expect(main.window.contentView.removeChildView).toHaveBeenCalledWith(fake.views[0])
    main.destroy()
    fake.wiring.host.disposeChat({ folder: fake.folder, chatId: 'chat-b' })
    expect(main.window.contentView.removeChildView).toHaveBeenCalledTimes(1)
    expect(fake.views[1].webContents.close).toHaveBeenCalledOnce()
  })
})

describe('browser view placement on the main window', () => {
  const ref = (folder: string) => ({ folder, chatId: 'chat-a' })
  const BOUNDS = { x: 10, y: 20, width: 100, height: 50 }

  it("places the view in the window's zoom, and counts it shown only on a visible, unminimized window", async () => {
    const fake = await rig()
    const main = fakeWindow({ zoom: 1.5 })
    fake.windows.push(main.window)
    fake.wiring.host.ensureAgentTab(ref(fake.folder))
    fake.wiring.host.setView(ref(fake.folder), BOUNDS)
    expect(fake.views[0].setBounds).toHaveBeenLastCalledWith({ x: 15, y: 30, width: 150, height: 75 })
    expect(fake.wiring.host.isShown(ref(fake.folder))).toBe(true)
    main.state.minimized = true
    expect(fake.wiring.host.isShown(ref(fake.folder))).toBe(false)
    main.state.minimized = false
    main.state.visible = false
    expect(fake.wiring.host.isShown(ref(fake.folder))).toBe(false)
  })

  it('counts a window that reports no content size as showing nothing', async () => {
    const fake = await rig()
    fake.windows.push(fakeWindow({ size: [] }).window)
    fake.wiring.host.ensureAgentTab(ref(fake.folder))
    fake.wiring.host.setView(ref(fake.folder), BOUNDS)
    expect(fake.wiring.host.isShown(ref(fake.folder))).toBe(false)
  })

  it('never asks a destroyed window for its zoom: with no window left the view is placed at zoom 1 and not shown', async () => {
    const fake = await rig()
    const main = fakeWindow({ zoom: 2 })
    fake.windows.push(main.window)
    fake.wiring.host.ensureAgentTab(ref(fake.folder))
    main.destroy()
    expect(() => fake.wiring.host.setView(ref(fake.folder), BOUNDS)).not.toThrow()
    expect(fake.views[0].setBounds).toHaveBeenLastCalledWith(BOUNDS)
    expect(fake.wiring.host.isShown(ref(fake.folder))).toBe(false)
  })
})

describe('browser IPC failures', () => {
  it('answers a setting it cannot save as an error and logs it', async () => {
    const fake = await rig()
    // A folder where the settings file goes: the save cannot rename over it.
    mkdirSync(join(fake.root, 'browser', 'settings.json'), { recursive: true })
    const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
    fake.wiring.registerIpc({ handle: (channel, listener) => { handlers.set(channel, listener as never) } })
    const reply = await handlers.get(BROWSER_CHANNELS.setEnabled)?.({}, { enabled: false })
    expect(reply).toMatchObject({ ok: false })
    expect(fake.log).toHaveBeenCalledWith(expect.stringMatching(/^Browser request failed: \S/))
  })
})
