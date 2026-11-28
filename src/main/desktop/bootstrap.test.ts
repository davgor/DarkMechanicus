import type { IpcMain } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../../shared/agents/chat'
import type { CommandResult, FolderPickResult } from '../../shared/desktop/api'
import { ATTACHMENT_SCHEME } from '../../shared/desktop/attachmentUrl'
import type { ForgeSetupConversationStatus, ForgeSetupProjectView } from '../../shared/desktop/forgeSetup'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { seedForgeFixture } from '../../test/forgeFixture'
import { pngBytes } from '../../test/images'
import type * as SessionsModule from '../agentChat/agentChatSessions'
import type { AgentChatSessions, AgentChatSessionsDeps } from '../agentChat/agentChatSessions'
import { FakePtyHost } from '../terminals/__mocks__/fakePtyHost'
import { windowsCommandLine } from '../terminals/windowsCommandLine'
import type { WorkspaceRequest, WorkspaceResponse } from './workspaceClient'

const desktop = vi.hoisted(() => ({
  appPath: '',
  home: '',
  userData: '',
  fork: vi.fn(),
  getFocusedWindow: vi.fn(),
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
  registerProtocol: vi.fn(),
  writeClipboard: vi.fn(),
  openExternal: vi.fn(),
  startPty: vi.fn(),
  keepAwake: vi.fn<() => number>(() => { throw new Error('Unexpected terminal start') }),
  send: vi.fn(),
  closedWindowSend: vi.fn(),
  version: '1.0.0-test',
  setBeforeInstall: vi.fn<(hook: () => void) => void>(),
  packaged: vi.fn(() => false),
  encryption: vi.fn(() => false)
}))

vi.mock('electron', () => ({
  app: {
    getPath: (kind: 'home' | 'userData') => desktop[kind],
    getAppPath: () => desktop.appPath,
    getVersion: () => desktop.version,
    get isPackaged() { return desktop.packaged() }
  },
  BrowserWindow: {
    getFocusedWindow: desktop.getFocusedWindow,
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: desktop.send } },
      { isDestroyed: () => true, webContents: { isDestroyed: () => true, send: desktop.closedWindowSend } }
    ]
  },
  clipboard: { writeText: desktop.writeClipboard },
  dialog: { showOpenDialog: desktop.showOpenDialog, showMessageBox: desktop.showMessageBox },
  net: { fetch: () => { throw new Error('Unexpected network operation') } },
  // The bridge creates the OS notifier; these tests raise no notification, so the class is never constructed.
  Notification: class { static isSupported(): boolean { return false } },
  powerSaveBlocker: { start: desktop.keepAwake, stop: () => undefined },
  protocol: { handle: desktop.registerProtocol },
  safeStorage: {
    isEncryptionAvailable: desktop.encryption,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    decryptString: (data: Buffer) => data.toString('utf8')
  },
  shell: { openExternal: desktop.openExternal },
  utilityProcess: { fork: desktop.fork }
}))

vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../autoUpdate', () => ({ setBeforeInstall: desktop.setBeforeInstall }))
vi.mock('../terminals/ptyHost', () => ({ createNodePtyHost: desktop.startPty }))

// The first import of the bridge transforms its whole module graph (seconds on a busy host). Paying it here, before any
// test, keeps it out of the first test's budget; each fixture still re-evaluates fresh modules after `vi.resetModules()`.
await import('./workspaceOwnerRuntime')
await import('./bootstrap')

class InProcessUtility extends EventEmitter {
  readonly messages = new EventEmitter()
  readonly requests: WorkspaceRequest[] = []
  killed = false

  postMessage(request: WorkspaceRequest): void {
    this.requests.push(request)
    this.messages.emit('request', { data: structuredClone(request) })
  }

  kill(): boolean {
    this.killed = true
    this.emit('exit', 0)
    return true
  }
}

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  try {
    while (cleanups.length) await cleanups.pop()?.()
  } finally {
    vi.unstubAllEnvs()
    vi.useRealTimers()
    vi.resetAllMocks()
  }
})

/** A scratch home with an empty `user-data`, or the same home again when the app restarts over it. */
function bridgeHome(home?: string): string {
  if (home !== undefined) return home
  const scratch = scratchDir('dm-bridge-')
  cleanups.push(scratch.cleanup)
  mkdirSync(join(scratch.path, 'user-data'))
  return scratch.path
}

async function bridgeFixture(options: { home?: string; version?: string; seed?: (userData: string) => void } = {}) {
  vi.resetModules()
  const root = bridgeHome(options.home)
  const userData = join(root, 'user-data')
  const appPath = join(root, 'app')
  options.seed?.(userData)
  Object.assign(desktop, { home: root, userData, appPath, version: options.version ?? '1.0.0-test' })
  vi.stubEnv('DARKMECHANICUS_HOME', join(root, 'state'))
  const { serveWorkspaceOwner } = await import('./workspaceOwnerRuntime')
  const owners: InProcessUtility[] = []
  desktop.fork.mockImplementation((_file: string, [generation, pid, home, version, packaged]: string[]) => {
    const child = new InProcessUtility()
    serveWorkspaceOwner({ generation: Number(generation), ownerPid: Number(pid), home, version, packaged: packaged === 'packaged' }, {
      on(_event, listener) { child.messages.on('request', listener); return this as Electron.ParentPort },
      postMessage(response: WorkspaceResponse) { child.emit('message', structuredClone(response)) }
    })
    owners.push(child)
    return child
  })
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const { startDesktopBridge } = await import('./bootstrap')
  // The bridge registers its protocols synchronously: those after this mark are its own, never another test's bridge's.
  const registered = desktop.registerProtocol.mock.calls.length
  const bridge = startDesktopBridge([], { handle: (channel, listener) => { handlers.set(channel, listener) } })
  const attachmentHandler = desktop.registerProtocol.mock.calls.slice(registered).find(([scheme]) => scheme === ATTACHMENT_SCHEME)?.[1] as ((request: Request) => Promise<Response>) | undefined
  let closed = false
  const finish = async () => {
    if (closed) return
    await bridge.chats.dispose()
    await bridge.close()
    closed = true
  }
  cleanups.push(finish)
  async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const handle = handlers.get(channel)
    if (!handle) throw new Error('Unregistered IPC ' + channel)
    return await handle({} as Electron.IpcMainInvokeEvent, ...args) as T
  }
  function command<T>(folder: string, name: string, input?: unknown): Promise<T> {
    return data(invoke<CommandResult<T>>('dm:command', folder, name, input))
  }
  return {
    root, owners, invoke, bridge, finish, command,
    attach: async (url: string) => {
      if (!attachmentHandler) throw new Error('The attachment protocol was not registered')
      return attachmentHandler(new Request(url))
    }
  }
}

async function data<T>(result: Promise<CommandResult<T>>): Promise<T> {
  const received = await result
  if (!received.ok) throw new Error(received.error.message)
  return received.data
}

async function track(fixture: Awaited<ReturnType<typeof bridgeFixture>>, name: string) {
  const path = join(fixture.root, name)
  mkdirSync(path)
  desktop.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] })
  const result = await fixture.invoke<FolderPickResult>('dm:pickFolder')
  expect(result).toMatchObject({ added: true, folder: { path } })
  if (result.folder === null) throw new Error('Folder picker returned no folder')
  return result.folder
}

function postedNames(owner: InProcessUtility): string[] {
  return owner.requests.map(request => request.type === 'close' ? 'close' : request.type === 'sync' ? 'sync:' + request.mode :
    request.work.kind === 'heartbeat' ? 'heartbeat' : request.work.name)
}

it('admits a desktop owner only for project work, serves its image, and retires it before finishing shutdown', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const f = await bridgeFixture()
  desktop.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
  expect(await f.invoke('dm:pickFolder')).toEqual({ folder: null, added: false })
  expect(desktop.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Choose a repository folder' }))

  const active = await track(f, 'active')
  const focused = { isDestroyed: () => false }
  desktop.getFocusedWindow.mockReturnValue(focused)
  const lazy = await track(f, 'lazy')
  expect(desktop.showOpenDialog).toHaveBeenLastCalledWith(focused, expect.anything())
  expect(f.owners).toHaveLength(0)
  await f.command(active.path, 'initializeRepository', { name: 'Active project' })
  expect(f.owners).toHaveLength(1)
  expect(existsSync(join(lazy.path, '.darkmechanicus'))).toBe(false)

  const bytes = pngBytes(8, 6)
  const image = await f.command<{ id: string }>(active.path, 'uploadAttachment', { data: bytes.toString('base64') })
  const url = `${ATTACHMENT_SCHEME}://${active.attachmentKey}/${image.id}`
  const response = await f.attach(url)
  expect(response.headers.get('content-type')).toBe('image/png')
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
  expect(f.bridge.chats.busy()).toBe(false)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(f.owners).toHaveLength(1)
  expect(existsSync(join(lazy.path, '.darkmechanicus'))).toBe(false)

  await f.finish()
  expect(f.owners[0]?.killed).toBe(true)
  const posted = postedNames(f.owners[0]!)
  // The owner opens without reconciling; its open-time reconcile runs once on the sync lane, and the 15 s heartbeat skips its own.
  expect(posted.filter(name => !name.startsWith('sync:'))).toEqual(['initializeRepository', 'uploadAttachment', 'attachment', 'heartbeat', 'close'])
  expect(posted.filter(name => name.startsWith('sync:'))).toEqual(['sync:heartbeat'])
})

it('makes an untracked attachment key unusable without opening a replacement owner', async () => {
  const f = await bridgeFixture()
  const folder = await track(f, 'project')
  await f.command(folder.path, 'initializeRepository', { name: 'Project' })
  const image = await f.command<{ id: string }>(folder.path, 'uploadAttachment', { data: pngBytes(5, 3).toString('base64') })
  const url = `${ATTACHMENT_SCHEME}://${folder.attachmentKey}/${image.id}`
  expect((await f.attach(url)).status).toBe(200)
  expect(await f.invoke('dm:untrackFolder', folder.path)).toEqual([])
  expect(f.owners[0]?.killed).toBe(true)
  expect((await f.attach(url)).status).toBe(404)
  expect(f.owners).toHaveLength(1)
  expect(await f.invoke('dm:command', folder.path, 'getProject')).toMatchObject({
    ok: false, error: { code: 'unauthorized' }
  })
})

it('provisions and retires an OMP mailbox in the same project utility as desktop commands', async () => {
  const f = await bridgeFixture()
  const { openAppDatabase } = await import('./appDatabase')
  const { createAgentRegistry } = await import('./agentRegistry')
  const db = openAppDatabase(desktop.userData)
  try { createAgentRegistry({ db }).upsert({ kind: 'omp', executablePath: process.execPath, version: null, connectedVia: 'found' }) }
  finally { db.close() }
  const folder = await track(f, 'chat-project')
  await f.command(folder.path, 'initializeRepository', { name: 'Chats' })
  const chat = await data(f.invoke<CommandResult<ChatRecord>>('chats:create', { folder: folder.path, agent: 'omp', role: 'worker', title: 'Mailbox test' }))
  expect(chat.endpointId).toEqual(expect.any(String))
  const ref = { folder: folder.path, chatId: chat.id }
  await data(f.invoke<CommandResult<unknown>>('chatMail:state', ref))
  await data(f.invoke<CommandResult<null>>('chats:delete', ref))
  expect(await data(f.invoke<CommandResult<ChatRecord[]>>('chats:list', folder.path))).toEqual([])
  const lazy = await track(f, 'uninitialized')
  const global = await data(f.invoke<CommandResult<ChatRecord>>('chats:create', { folder: null, agent: 'omp', title: 'Project-less chat' }))
  await data(f.invoke<CommandResult<null>>('chats:delete', { folder: null, chatId: global.id }))
  expect(existsSync(join(lazy.path, '.darkmechanicus'))).toBe(false)
  expect(f.owners).toHaveLength(1)
  const operations = postedNames(f.owners[0]!)
  expect(operations).toEqual(expect.arrayContaining(['provisionMailboxes', 'mailState', 'deleteMailbox']))
  expect(operations).not.toContain('retireTooling')
})

function forgeMember(root: string) {
  const world = join(root, 'world')
  const member = join(world, 'Software')
  mkdirSync(join(member, '.darkmechanicus'), { recursive: true })
  gitIn(world, 'init', '-b', 'main')
  gitIn(world, 'remote', 'add', 'origin', 'https://github.com/example/tickets.git')
  seedForgeFixture(world, 'example', [{ folder: 'Software', repository: 'https://github.com/example/software.git' }])
  writeFileSync(join(member, '.darkmechanicus', 'project.json'), JSON.stringify({
    format: 'darkmechanicus.project',
    formatVersion: 1,
    projectId: 'pj_00000000000000000000000001',
    name: 'Software',
    keyPrefix: 'DM',
    createdAt: '2026-01-01T00:00:00.000Z'
  }))
  return { world, member }
}

function nextWindowEvent(): Promise<string> {
  return new Promise(resolve => desktop.send.mockImplementationOnce((channel: string) => resolve(channel)))
}

async function trackForgeFixture(f: Awaited<ReturnType<typeof bridgeFixture>>) {
  const paths = forgeMember(f.root)
  desktop.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [paths.world] })
  expect(await f.invoke('dm:pickFolder', 'forge-world')).toMatchObject({ added: true, folder: { path: paths.world } })
  return paths
}

it('broadcasts local Forge readiness only to live windows and removes the member when the world is untracked', async () => {
  const f = await bridgeFixture()
  const { world, member } = forgeMember(f.root)
  desktop.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [world] })
  expect(await f.invoke('dm:pickFolder', 'forge-world')).toMatchObject({ added: true, folder: { path: world } })
  expect(f.owners).toHaveLength(0)

  const validated = nextWindowEvent()
  expect(await f.invoke('forge:memberStatus', world, member)).toMatchObject({ readiness: 'preparing' })
  expect(await validated).toBe('forge:foldersChanged')
  const prepared = nextWindowEvent()
  expect(await f.invoke('forge:memberStatus', world, member)).toMatchObject({ readiness: 'preparing' })
  expect(await prepared).toBe('forge:foldersChanged')
  expect(await f.invoke('forge:memberStatus', world, member)).toMatchObject({ readiness: 'ready', error: null })
  expect(f.owners).toHaveLength(1)
  // The readiness read runs on the owner before the member's import, which runs on the lane; it is also the open-time import.
  expect(postedNames(f.owners[0]!)).toEqual(['hasValidatedCache', 'sync:member'])
  expect(desktop.closedWindowSend).not.toHaveBeenCalled()

  expect(await f.invoke('dm:untrackFolder', world)).toEqual([])
  expect(await f.invoke('forge:memberStatus', world, member)).toEqual({ readiness: 'removed', syncing: false, error: null })
  expect(f.owners[0]?.killed).toBe(true)
})

it('opens setup through the actual desktop bridge with offline descriptors and no connected agent', async () => {
  const f = await bridgeFixture()
  const { world, member } = await trackForgeFixture(f)
  expect(await f.invoke('forgeSetup:recipebook')).toMatchObject({ value: {
    recipes: expect.arrayContaining([expect.objectContaining({ id: 'boosterseat-react' }), expect.objectContaining({ id: 'boosterseat-electron' })])
  } })
  expect(await f.invoke('forgeSetup:recipebook', world)).toBeNull()
  expect(await f.invoke<ForgeSetupProjectView>('forgeSetup:project', member)).toMatchObject({
    member, state: 'missing', onboarding: null
  })
  expect(await f.invoke<ForgeSetupConversationStatus>('forgeSetup:prepare', member)).toMatchObject({
    state: 'needs-attention', chatId: null, message: expect.stringContaining('connected agent')
  })
  expect(await f.invoke<ForgeSetupProjectView>('forgeSetup:project', member)).toMatchObject({
    state: 'needs-discovery', value: { value: { detection: { status: 'unavailable', reason: 'source-unavailable' } } },
    onboarding: { state: 'needs-attention', chatId: null }
  })
  expect(f.owners).toHaveLength(0)
  expect(desktop.startPty).not.toHaveBeenCalled()
  await f.invoke('dm:untrackFolder', world)
  await expect(f.invoke('forgeSetup:project', member)).rejects.toThrow()
})

async function connectSetupAgents() {
  const { openAppDatabase } = await import('./appDatabase')
  const { createAgentRegistry } = await import('./agentRegistry')
  const db = openAppDatabase(desktop.userData)
  try {
    const registry = createAgentRegistry({ db })
    const cli = { executablePath: process.execPath }
    const world = registry.addCustom({ ...cli, id: 'cu_01m65kwqqeyajbj5bnq81gngrb', displayName: 'World test agent', args: ['--world-only'] })
    const member = registry.addCustom({ ...cli, id: 'cu_01m65kwqqeyajbj5bnq81gngrc', displayName: 'Member test agent', args: ['--member-workflow', '{folder}'] })
    return { world, member }
  } finally { db.close() }
}

it('dispatches the configured member host ahead of the world default from the bootstrap-managed directory', async () => {
  const f = await bridgeFixture()
  const paths = await trackForgeFixture(f)
  const agents = await connectSetupAgents()
  const host = new FakePtyHost()
  desktop.keepAwake.mockReturnValue(12)
  desktop.startPty.mockResolvedValue(host)
  try {
    expect(await f.invoke('agents:setFolderDefault', { folder: paths.world, agentId: agents.world.id })).toBe(agents.world.id)
    expect(await f.invoke('agents:setFolderDefault', { folder: paths.member, agentId: agents.member.id })).toBe(agents.member.id)
    const receipt = await f.invoke<ForgeSetupConversationStatus>('forgeSetup:prepare', paths.member)
    expect(receipt).toMatchObject({ state: 'preparing', chatId: expect.any(String) })
    expect(host.spawns).toHaveLength(1)
    const launch = host.last().spec
    expect(launch.cwd).toMatch(new RegExp('onboarding[\\\\/]'))
    const expectedArgs = ['--member-workflow', launch.cwd]
    expect(launch.args).toEqual(process.platform === 'win32' ? windowsCommandLine(expectedArgs) : expectedArgs)
    expect(Boolean(launch.env.DM_SESSION_TOKEN)).toBe(true)
    const chats = await data(f.invoke<CommandResult<ChatRecord[]>>('chats:list', paths.member))
    expect(chats).toEqual([expect.objectContaining({
      id: receipt.chatId, folder: paths.member, agent: agents.member.id, role: 'planner', allowSave: true,
      forgeSetup: expect.objectContaining({ mode: 'onboarding' }),
      firstPrompt: expect.stringContaining('Do not run installers or setup steps')
    })])
    expect(postedNames(f.owners[0]!)).toEqual(expect.arrayContaining(['getProject', 'issueChatGrant', 'bindYoloGrant']))
    expect(desktop.send).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ type: 'chats_changed', chatId: receipt.chatId }))
  } finally {
    for (const session of host.spawns) if (!session.exited) session.exit()
  }
})

it('registers the Restart now hook, which writes the marker beside the chat store', async () => {
  await bridgeFixture({ version: '0.83.0' })
  const file = join(desktop.userData, 'agents', 'restart-resume.json')
  expect(existsSync(file)).toBe(false)
  const hook = desktop.setBeforeInstall.mock.calls.at(-1)?.[0]
  hook?.()
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ fromVersion: '0.83.0', writtenAt: expect.any(String), chats: [] })
})

it('a start after an update consumes the marker and skips a chat of an untracked folder without throwing', async () => {
  await bridgeFixture({ version: '0.84.0', seed: userData => {
    mkdirSync(join(userData, 'agents'))
    writeFileSync(join(userData, 'agents', 'restart-resume.json'), JSON.stringify({
      fromVersion: '0.83.0', writtenAt: new Date().toISOString(), chats: [{ folder: join(userData, 'gone'), chatId: 'magos-1' }]
    }))
  } })
  expect(existsSync(join(desktop.userData, 'agents', 'restart-resume.json'))).toBe(false)
  const { logger } = await import('../logger')
  await vi.waitFor(() => expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('Restart resume skipped chat magos-1: its folder is no longer tracked.'))
})

/** Leaves an open learning integration this machine owns in the project's database, as an interrupted approval does. */
function seedPendingLearningIntegration(folder: string): void {
  const local = join(folder, '.darkmechanicus', 'local')
  const machine: unknown = JSON.parse(readFileSync(join(local, 'machine.json'), 'utf8'))
  if (typeof machine !== 'object' || machine === null || !('machineId' in machine) || typeof machine.machineId !== 'string') throw new Error('No machine record')
  const db = new DatabaseSync(join(local, 'state.sqlite'), { enableForeignKeyConstraints: false })
  try {
    db.prepare(`INSERT INTO learning_integrations (id, card_id, attempt_id, state, manifest_json, manifest_hash, failure_json, revision, created_at, updated_at, owner_machine_id)
      VALUES ('li-pending', 'kc-missing', 'ka-missing', 'prepared', '{}', 'sha256:0', NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`).run(machine.machineId)
  } finally {
    db.close()
  }
}

it('recovers learning approvals at startup only in the set-up folder with one pending, opening no other owner (DM-983)', async () => {
  const first = await bridgeFixture()
  const folders = []
  for (const name of ['idle-a', 'pending', 'idle-b']) {
    const folder = await track(first, name)
    await first.command(folder.path, 'initializeRepository', { name })
    folders.push(folder)
  }
  const lazy = await track(first, 'lazy')
  await first.finish()
  seedPendingLearningIntegration(folders[1]!.path)

  const restarted = await bridgeFixture({ home: first.root })
  await vi.waitFor(() => expect(restarted.owners.flatMap(postedNames)).toContain('pendingLearningApprovals'))
  expect(restarted.owners).toHaveLength(1)
  const paths = new Set(restarted.owners[0]!.requests.flatMap(request => request.type === 'close' ? [] : [request.path]))
  expect([...paths]).toEqual([realpathSync.native(folders[1]!.path)])
  // Like every owner it opens without reconciling and runs its open-time reconcile once on the sync lane; the only
  // project work startup recovery posts is the pending-approvals read.
  await vi.waitFor(() => expect(postedNames(restarted.owners[0]!).filter(name => name.startsWith('sync:'))).toEqual(['sync:heartbeat']))
  expect(postedNames(restarted.owners[0]!).filter(name => !name.startsWith('sync:'))).toEqual(['pendingLearningApprovals'])
  expect(existsSync(join(lazy.path, '.darkmechanicus'))).toBe(false)
  expect(restarted.bridge.chats.busy()).toBe(false)
})

it('untracking releases the GUI chats before forgetting the folder, and removing an agent ends its GUI chats', async () => {
  const calls: string[] = []
  // The real GUI manager, observed at the two calls the bridge must make into it.
  vi.doMock('../agentChat/agentChatSessions', async (importOriginal) => {
    const actual = await importOriginal<typeof SessionsModule>()
    return { ...actual, createAgentChatSessions: (deps: AgentChatSessionsDeps): AgentChatSessions => {
      const sessions = actual.createAgentChatSessions(deps)
      return { ...sessions,
        releaseFolder: (folder, forget, related) => {
          calls.push('release ' + folder)
          return sessions.releaseFolder(folder, () => { calls.push('forget'); return forget() }, related)
        },
        endAgent: (id) => { calls.push('endAgent ' + id); return sessions.endAgent(id) }
      }
    } }
  })
  cleanups.push(() => { vi.doUnmock('../agentChat/agentChatSessions') })
  const f = await bridgeFixture()
  const { openAppDatabase } = await import('./appDatabase')
  const { createAgentRegistry } = await import('./agentRegistry')
  const db = openAppDatabase(desktop.userData)
  try { createAgentRegistry({ db }).upsert({ kind: 'omp', executablePath: process.execPath, version: null, connectedVia: 'found' }) }
  finally { db.close() }
  const folder = await track(f, 'released')
  const kept = await track(f, 'kept')

  expect(await f.invoke('dm:untrackFolder', folder.path)).toMatchObject([{ path: kept.path }])
  // The GUI release wraps `forget`: the folder is still tracked when its chats are stopped, and forgotten only after.
  expect(calls).toEqual(['release ' + folder.path, 'forget'])
  expect(await f.invoke('dm:listFolders')).toMatchObject([{ path: kept.path }])

  expect(await f.invoke('agents:remove', 'omp')).toEqual([])
  expect(calls).toEqual(['release ' + folder.path, 'forget', 'endAgent omp'])
})
