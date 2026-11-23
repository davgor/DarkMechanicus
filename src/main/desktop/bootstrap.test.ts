import type { IpcMain } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../../shared/agents/chat'
import type { CommandResult, FolderPickResult } from '../../shared/desktop/api'
import { ATTACHMENT_SCHEME } from '../../shared/desktop/attachmentUrl'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { createForge, updateForge } from './forgeManifest'
import { pngBytes } from '../../test/images'
import type { WorkspaceRequest, WorkspaceResponse } from './workspaceClient'

const desktop = vi.hoisted(() => ({
  appPath: '',
  home: '',
  userData: '',
  fork: vi.fn(),
  getFocusedWindow: vi.fn(),
  showOpenDialog: vi.fn(),
  registerProtocol: vi.fn(),
  writeClipboard: vi.fn(),
  openExternal: vi.fn(),
  send: vi.fn(),
  closedWindowSend: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: (kind: 'home' | 'userData') => desktop[kind],
    getAppPath: () => desktop.appPath,
    getVersion: () => '1.0.0-test',
    isPackaged: false
  },
  BrowserWindow: {
    getFocusedWindow: desktop.getFocusedWindow,
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: desktop.send } },
      { isDestroyed: () => true, webContents: { isDestroyed: () => true, send: desktop.closedWindowSend } }
    ]
  },
  clipboard: { writeText: desktop.writeClipboard },
  dialog: { showOpenDialog: desktop.showOpenDialog },
  net: { fetch: () => { throw new Error('Unexpected network operation') } },
  powerSaveBlocker: { start: () => { throw new Error('Unexpected terminal start') }, stop: () => undefined },
  protocol: { handle: desktop.registerProtocol },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: desktop.openExternal },
  utilityProcess: { fork: desktop.fork }
}))

vi.mock('../logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))

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

async function bridgeFixture() {
  vi.resetModules()
  const scratch = scratchDir('dm-bridge-')
  cleanups.push(scratch.cleanup)
  const userData = join(scratch.path, 'user-data')
  const appPath = join(scratch.path, 'app')
  mkdirSync(userData)
  Object.assign(desktop, { home: scratch.path, userData, appPath })
  vi.stubEnv('DARKMECHANICUS_HOME', join(scratch.path, 'state'))
  const { serveWorkspaceOwner } = await import('./workspaceOwnerRuntime')
  const owners: InProcessUtility[] = []
  desktop.fork.mockImplementation((_file: string, [generation, pid, home, version]: string[]) => {
    const child = new InProcessUtility()
    serveWorkspaceOwner({ generation: Number(generation), ownerPid: Number(pid), home, version }, {
      on(_event, listener) { child.messages.on('request', listener); return this as Electron.ParentPort },
      postMessage(response: WorkspaceResponse) { child.emit('message', structuredClone(response)) }
    })
    owners.push(child)
    return child
  })
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const { startDesktopBridge } = await import('./bootstrap')
  const bridge = startDesktopBridge([], { handle: (channel, listener) => { handlers.set(channel, listener) } })
  let closed = false
  const finish = async () => {
    if (closed) return
    await bridge.chats.dispose()
    await bridge.close()
    closed = true
  }
  cleanups.push(finish)
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const handle = handlers.get(channel)
    if (!handle) throw new Error('Unregistered IPC ' + channel)
    return await handle({} as Electron.IpcMainInvokeEvent, ...args) as T
  }
  return {
    root: scratch.path, owners, invoke, bridge, finish,
    command: <T>(folder: string, name: string, input?: unknown) => data(invoke<CommandResult<T>>('dm:command', folder, name, input)),
    attach: async (url: string) => {
      const handler = desktop.registerProtocol.mock.calls.find(([scheme]) => scheme === ATTACHMENT_SCHEME)?.[1] as
        ((request: Request) => Promise<Response>) | undefined
      if (!handler) throw new Error('The attachment protocol was not registered')
      return handler(new Request(url))
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
  return owner.requests.map(request => request.type === 'close' ? 'close' :
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
  expect(postedNames(f.owners[0]!)).toEqual(['initializeRepository', 'uploadAttachment', 'attachment', 'heartbeat', 'close'])
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
  expect(operations.filter(name => name === 'retireTooling')).toHaveLength(2)
})

function forgeMember(root: string) {
  const world = join(root, 'world')
  const member = join(world, 'Software')
  mkdirSync(join(member, '.darkmechanicus'), { recursive: true })
  gitIn(world, 'init', '-b', 'main')
  gitIn(world, 'remote', 'add', 'origin', 'https://github.com/example/tickets.git')
  createForge(world, 'example')
  updateForge(world, manifest => { manifest.projects.push({ folder: 'Software', repository: 'https://github.com/example/software.git' }) })
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
  expect(postedNames(f.owners[0]!)).toEqual(['reconcileMember'])
  expect(desktop.closedWindowSend).not.toHaveBeenCalled()

  expect(await f.invoke('dm:untrackFolder', world)).toEqual([])
  expect(await f.invoke('forge:memberStatus', world, member)).toEqual({ readiness: 'removed', syncing: false, error: null })
  expect(f.owners[0]?.killed).toBe(true)
})
