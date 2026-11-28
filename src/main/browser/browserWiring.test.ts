/**
 * The browser join with no Electron: a real browser pipe and `createBrowserClient`, real chat grants in a real
 * desktop workspace (so `browser.drive` is checked by the real `verifyChatGrant`), and fake windows and views.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserClient } from '../../core/desktop/browserClient'
import { openWorkspace } from '../../core/workspace'
import type { ChatRole } from '../../shared/agents/chat'
import type { BrowserOperation } from '../../shared/browser/browserControl'
import { createSequentialIds, createTestClock } from '../../test/testContext'
import { createFakeGit, TEST_STORAGE } from '../../test/workspaceHarness'
import { createChatGrants, type ChatGrants } from '../agents/chatGrants'
import { buildCliConfig } from '../desktop/cliConfig'
import { createTestWorkspacePool } from '../desktop/__mocks__/projectWorkspaceFixture'
import type { BrowserControlBinding } from './browserDispatch'
import { startBrowser, type BrowserWindowLike, type BrowserWiring, type WiredView } from './browserWiring'
import { fakeView, fakeWindow, type BeforeRequest, type FakeView } from './__mocks__/browserViewFakes'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Real chat grants in a real desktop workspace of a fresh folder; `browserAddress` comes from the wiring. */
async function grantsRig(browserAddress: () => string | undefined) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-browser-wiring-')))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const clock = createTestClock('2026-04-01T09:00:00.000Z')
  const git = createFakeGit({ branch: 'main', commit: 'b'.repeat(40), detached: false })
  const pool = createTestWorkspacePool((repoRoot) => openWorkspace({
    repoRoot, role: 'desktop', label: 'Desktop', transport: 'desktop', homeDir: join(root, 'home'), clock, ids: createSequentialIds(), git, ...TEST_STORAGE
  }))
  await pool.get(repo).initializeRepository({ name: 'repo' })
  const grants = createChatGrants({
    workspaceFor: (folder) => pool.get(folder), minutes: 60, log: () => undefined, browserAddress,
    cliFor: (folder) => buildCliConfig({ execPath: '/bin/electron', appPath: '/app', repoPath: folder })
  })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => pool.closeAll(), () => grants.dispose())
  /** Issues and binds a live grant for the chat, as a chat start does. */
  const live = async (role: ChatRole, chatId: string) => {
    const issued = await grants.issueChatCli(repo, { role, allowSave: false, label: `${role} chat` })
    await grants.bindChatGrant(issued.grantId, { folder: repo, chatId, generation: 'gen-1' })
    return { ...issued, env: issued.cli.env }
  }
  return { grants, repo, pool, root, live }
}

function wiringRig(options: { grants: () => ChatGrants; root: string; authorize?: (token: string) => BrowserControlBinding }) {
  const windows: BrowserWindowLike<WiredView>[] = []
  const views: FakeView[] = []
  const beforeRequests = new Map<string, BeforeRequest>()
  const wiring: BrowserWiring = startBrowser<WiredView>({
    root: join(options.root, 'browser'), appUrl: 'http://localhost:5173', windows: () => windows,
    registry: { resolve: (path) => (path === join(options.root, 'repo') ? path : null) },
    createView: (webPreferences) => {
      const view = fakeView(beforeRequests, webPreferences.partition)
      views.push(view)
      return view as unknown as WiredView
    },
    authorize: options.authorize ?? ((token) => options.grants().authorizeBrowser(token)),
    images: { put: vi.fn() }, chatFor: () => ({ role: 'worker', title: 'Browser chat' }),
    bindings: { threadsOf: () => [] }, ticketKeyOfAttempt: async () => null,
    push: vi.fn(), log: vi.fn(), lookup: async (host) => [{ address: host === 'a.example' ? '93.184.216.34' : '93.184.216.35' }]
  })
  cleanups.push(() => wiring.dispose())
  return { wiring, windows, views, beforeRequests }
}

/** One request over the real pipe with the chat's issued environment. */
function call(env: Readonly<Record<string, string | undefined>>, operation: BrowserOperation) {
  return createBrowserClient({ env }).request(operation)
}

async function setup(authorize?: (grants: ChatGrants) => (token: string) => BrowserControlBinding) {
  let wiring: BrowserWiring | undefined
  const state = await grantsRig(() => wiring?.address())
  const rig = wiringRig({ grants: () => state.grants, root: state.root, authorize: authorize?.(state.grants) })
  wiring = rig.wiring
  await rig.wiring.ready
  return { ...state, ...rig }
}

const STATUS: BrowserOperation = { op: 'browser_status', args: {} }
const NAVIGATE: BrowserOperation = { op: 'browser_navigate', args: { url: 'https://a.example/' } }

describe('browser pipe authority (c1, c5)', () => {
  it.each(['orchestrator', 'worker'] as const)('answers browser_status to a live %s grant, whose chat was given the pipe', async (role) => {
    const rig = await setup()
    const { env } = await rig.live(role, `chat-${role}`)
    expect(env['DM_BROWSER_PIPE']).toBe(rig.wiring.address())
    expect(await call(env, STATUS)).toMatchObject({ ok: true, data: { enabled: true, owner: 'none', tab: null, pendingOrigin: null } })
  })

  it('refuses a planner grant (no browser.drive) as unauthorized, dispatching nothing; its chat gets no pipe', async () => {
    const rig = await setup()
    const { env } = await rig.live('planner', 'chat-planner')
    expect(env['DM_BROWSER_PIPE']).toBeUndefined()
    const planned = { ...env, DM_BROWSER_PIPE: rig.wiring.address() }
    expect(await call(planned, NAVIGATE)).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(rig.views).toHaveLength(0)
    expect(rig.wiring.ownership.owner('chat-planner')).toBe('none')
  })

  it('refuses a real planner grant through the real verifyChatGrant even when authorize lets it in', async () => {
    const rig = await setup((grants) => (token) => grants.authorizeNaming(token))
    const { env, grantId } = await rig.live('planner', 'chat-planner')
    const workspace = rig.pool.get(rig.repo)
    const verify = vi.spyOn(workspace, 'call')
    expect(await call({ ...env, DM_BROWSER_PIPE: rig.wiring.address() }, NAVIGATE)).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(verify).toHaveBeenCalledWith('verifyChatGrant', grantId, expect.any(String), 'browser.drive')
    expect(rig.views).toHaveLength(0)
    expect(rig.wiring.ownership.owner('chat-planner')).toBe('none')
  })

  it('refuses a revoked grant as unauthorized', async () => {
    const rig = await setup()
    const { env, grantId } = await rig.live('worker', 'chat-worker')
    await rig.grants.revokeChatGrant(grantId)
    expect(await call(env, STATUS)).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  })
})

describe('browser pipe ops on the main window (Fix 46)', () => {
  it('builds the host with no window: ops answer no_tab, and the first tab after a window appears attaches to it', async () => {
    const rig = await setup()
    const { env } = await rig.live('worker', 'chat-w')
    await rig.wiring.sites.add(realpathSync.native(rig.repo), 'https://a.example')
    expect(await call(env, NAVIGATE)).toMatchObject({ ok: false, error: { code: 'no_tab' } })
    expect(rig.views).toHaveLength(0)
    const first = fakeWindow()
    rig.windows.push(first.window)
    expect(await call(env, NAVIGATE)).toMatchObject({ ok: true, data: { tab: { loading: false } } })
    expect(rig.views[0].webContents.loadURL).toHaveBeenCalledWith('https://a.example/')
    expect(first.window.contentView.addChildView).toHaveBeenCalledWith(rig.views[0])
    first.close()
    expect(rig.views[0].webContents.close).toHaveBeenCalledOnce()
    const second = fakeWindow()
    rig.windows.splice(0, 1, second.window)
    expect(await call(env, NAVIGATE)).toMatchObject({ ok: true })
    expect(second.window.contentView.addChildView).toHaveBeenCalledWith(rig.views[1])
  })

  it("never reports the Sign-in tab in status", async () => {
    const rig = await setup()
    rig.windows.push(fakeWindow().window)
    const { env } = await rig.live('worker', 'chat-s')
    await rig.wiring.host.openSignIn({ folder: realpathSync.native(rig.repo), chatId: 'chat-s' }, 'https://login.example/')
    expect(await call(env, STATUS)).toMatchObject({ ok: true, data: { tab: null, pendingOrigin: null } })
  })
})

describe('browser frame gate through the hardened session (R19-3)', () => {
  it('cancels mainFrame and subFrame requests to an unlisted origin, and to a removed site', async () => {
    const rig = await setup()
    rig.windows.push(fakeWindow().window)
    const folder = realpathSync.native(rig.repo)
    await rig.wiring.sites.add(folder, 'https://a.example')
    const { id } = rig.wiring.host.ensureAgentTab({ folder, chatId: 'chat-f' }).contents
    const onBeforeRequest = [...rig.beforeRequests.values()][0]
    const request = (url: string, resourceType: string) => new Promise((resolve) => onBeforeRequest({ url, resourceType, webContentsId: id, frame: null }, resolve))
    expect(await request('https://b.example/', 'mainFrame')).toEqual({ cancel: true })
    expect(await request('https://b.example/', 'subFrame')).toEqual({ cancel: true })
    expect(await request('https://a.example/', 'mainFrame')).toEqual({})
    await rig.wiring.sites.remove(folder, 'https://a.example')
    expect(await request('https://a.example/', 'mainFrame')).toEqual({ cancel: true })
  })
})

describe('browser disposal (c3, R19-8)', () => {
  it('chat deletion closes its views; dispose closes the pipe and every view', async () => {
    const rig = await setup()
    rig.windows.push(fakeWindow().window)
    const folder = realpathSync.native(rig.repo)
    rig.wiring.host.ensureAgentTab({ folder, chatId: 'gone' })
    rig.wiring.host.ensureAgentTab({ folder, chatId: 'kept' })
    rig.wiring.host.disposeChat({ folder, chatId: 'gone' })
    expect(rig.views[0].webContents.close).toHaveBeenCalledOnce()
    expect(rig.views[1].webContents.close).not.toHaveBeenCalled()
    const { env } = await rig.live('worker', 'chat-d')
    await rig.wiring.dispose()
    expect(rig.views[1].webContents.close).toHaveBeenCalledOnce()
    expect(await call(env, STATUS)).toMatchObject({ ok: false, error: { code: 'desktop_unavailable' } })
  })
})

describe('browser panel IPC through the wiring', () => {
  it("Stop on the panel detaches the agent tab's debugger and stops its load in the same tick", async () => {
    const rig = await setup()
    rig.windows.push(fakeWindow().window)
    const request = { folder: rig.repo, chatId: 'chat-panel' }
    rig.wiring.host.ensureAgentTab(request)
    const listeners = new Map<string, (event: unknown, request: unknown) => unknown>()
    rig.wiring.registerIpc({ handle: (channel, listener) => void listeners.set(channel, listener as (event: unknown, request: unknown) => unknown) })
    expect([...listeners.keys()]).toContain('browser:stopAgent')
    const answered = listeners.get('browser:stopAgent')!({}, request)
    expect(rig.views[0].webContents.debugger.detach).toHaveBeenCalledOnce()
    expect(rig.views[0].webContents.stop).toHaveBeenCalledOnce()
    expect(await answered).toEqual({ ok: true, data: null })
    expect(rig.wiring.ownership.owner('chat-panel')).toBe('stopped')
    expect(await listeners.get('browser:stopAgent')!({}, { ...request, folder: join(rig.root, 'elsewhere') })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  })
})
