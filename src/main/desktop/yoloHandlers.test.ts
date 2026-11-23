import { testWorkspace } from './__mocks__/projectWorkspaceFixture'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createYoloDesktopRuntime } from '../../core/services/yoloFence'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { createChatGrants, type ChatGrants } from '../agents/chatGrants'
import { registerYoloIpc } from './ipc'
import { createYoloHandlers } from './yoloHandlers'

let harness: Harness
let grants: ChatGrants
let invoke: (...args: unknown[]) => unknown
let grantId: string
let decisions: string[]
const disposers: (() => Promise<void>)[] = []
beforeEach(async () => {
  harness = createHarness()
  const workspace = harness.open('desktop')
  const client = testWorkspace(workspace)
  await workspace.initializeRepository({ name: 'Native IPC fixture' })
  const runtime = createYoloDesktopRuntime(join(harness.homeDir, 'desktop.json'))
  await runtime.ready
  disposers.push(runtime.dispose)
  grants = createChatGrants({ workspaceFor: () => client, cliFor: () => ({ command: 'node', args: [], env: {} }), minutes: 60, log: () => {}, desktopFence: runtime.fence })
  const issued = await grants.issueChatCli(harness.root, { role: 'worker', allowSave: false, label: 'Existing active worker' })
  grantId = issued.grantId
  await grants.bindChatGrant(grantId, { folder: harness.root, chatId: 'chat', generation: 'start' })
  decisions = []
  const handlers = createYoloHandlers({ registry: { resolve: (folder) => folder === harness.root ? folder : null }, grants, confirm: async (detail) => { decisions.push(detail); return false } })
  const ipc: Pick<IpcMain, 'handle'> = { handle: (_channel, listener) => { invoke = (...args) => listener({} as IpcMainInvokeEvent, ...args) } }
  registerYoloIpc(ipc, handlers)
})
afterEach(async () => {
  grants.dispose()
  for (const dispose of disposers.splice(0)) await dispose()
  harness.cleanup()
})

it('ignores renderer affirmative arguments and obtains a fresh native decision for the selected live grant', async () => {
  expect(await invoke(harness.root, grantId, 'enable', true)).toMatchObject({ live: true, expiresAt: null, audit: [{ result: 'refused' }] })
  expect(decisions).toHaveLength(1)
  expect(decisions[0]).toContain('Existing active worker')
  expect(decisions[0]).toContain(grantId)
})

it('refuses untracked folders and malformed affirmation payloads before native consent', async () => {
  await expect(invoke('/not-tracked', grantId, 'enable')).rejects.toMatchObject({ code: 'unauthorized' })
  await expect(invoke(harness.root, grantId, { action: 'enable', approved: true })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(decisions).toEqual([])
  expect(await invoke(harness.root, grantId, 'inspect')).toMatchObject({ expiresAt: null })
})

it('initializes the desktop fence and healthy chat services without opening a failing tracked folder', async () => {
  const opened: string[] = []
  const workspace = harness.open('desktop')
  const client = testWorkspace(workspace)
  const runtime = createYoloDesktopRuntime(join(harness.homeDir, 'next-desktop.json'))
  await runtime.ready
  disposers.push(runtime.dispose)
  const fence = runtime.fence
  const next = createChatGrants({ workspaceFor: (folder) => {
    opened.push(folder)
    if (folder === '/broken-database') throw new Error('Unsupported schema in an unrelated tracked folder')
    return client
  }, cliFor: () => ({ command: 'node', args: [], env: {} }), minutes: 60, log: () => {}, desktopFence: fence })
  expect(opened).toEqual([])
  const healthy = await next.issueChatCli(harness.root, { role: 'worker', allowSave: false, label: 'Healthy chat' })
  await next.bindChatGrant(healthy.grantId, { folder: harness.root, chatId: 'healthy', generation: 'healthy-start' })
  expect(await next.yolo(harness.root, healthy.grantId, 'inspect', async () => false)).toMatchObject({ live: true, expiresAt: null })
  await expect(next.yolo('/broken-database', grantId, 'enable', async () => true)).rejects.toThrow('Unsupported schema')
  next.dispose()
})
