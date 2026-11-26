/**
 * `notifications:raise`: registered through the sender guard, it refuses an untracked folder, a malformed id and an
 * extra key, and builds a valid raise's text from the epic title main reads itself, once per run (`<kind>:<runId>`).
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../../shared/desktop/api'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../shared/desktop/notificationSettings'
import type { EpicDetailView } from '../../shared/domain/views'
import { guardIpc } from '../ipcGuard'
import type { ProjectWorkspace } from '../desktop/workspaceClient'
import { createNotifier, type NotificationEvent } from './notifier'
import { createNotifyHandlers, registerNotifyIpc } from './notifyIpc'

type Listener = Parameters<IpcMain['handle']>[1]
const APP_URL = 'http://localhost:5173'
const frame = (url: string) => ({ url, parent: null, detached: false, isDestroyed: () => false })
const TRUSTED = { sender: {}, senderFrame: frame(`${APP_URL}/`) } as unknown as IpcMainInvokeEvent
const FOREIGN = { sender: {}, senderFrame: frame('https://example.com/') } as unknown as IpcMainInvokeEvent

const FOLDER = 'C:\\work\\repo'
const EPIC = 'ep_01j0000000000000000000000e'
const RUN = 'rn_01j0000000000000000000000r'
const OTHER_RUN = 'rn_01j0000000000000000000000s'

function rig() {
  const getEpic = vi.fn(async () => ({ id: EPIC, title: 'Agent chats in the epic' }) as EpicDetailView)
  const workspace = { getEpic } as unknown as ProjectWorkspace
  const get = vi.fn((_folder: string) => workspace)
  const events: NotificationEvent[] = []
  const handlers = createNotifyHandlers({
    // Only the canonical path of the one tracked folder resolves; a differently spelled path resolves to it.
    registry: { resolve: path => path.toLowerCase() === FOLDER.toLowerCase() ? FOLDER : null },
    workspaces: { get },
    notify: event => { events.push(event) }
  })
  const listeners = new Map<string, Listener>()
  registerNotifyIpc(guardIpc({ handle: (channel, listener) => void listeners.set(channel, listener) }, { appUrl: APP_URL }), handlers)
  const raise = async (request: unknown, event = TRUSTED) => (await listeners.get('notifications:raise')!(event, request)) as CommandResult<null>
  return { getEpic, get, events, listeners, raise }
}

const valid = { folder: FOLDER, kind: 'checkpoint_ready', epicId: EPIC, runId: RUN }

describe('notifications:raise', () => {
  it('registers exactly the raise channel, through the sender guard', async () => {
    const state = rig()
    expect([...state.listeners.keys()]).toEqual(['notifications:raise'])
    await expect(state.raise(valid, FOREIGN)).resolves.toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(state.events).toEqual([])
  })

  it('refuses an untracked folder as unauthorized, reading no workspace', async () => {
    const state = rig()
    await expect(state.raise({ ...valid, folder: 'C:\\elsewhere' })).resolves.toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(state.get).not.toHaveBeenCalled()
    expect(state.events).toEqual([])
  })

  it.each([
    ['a bad epic id', { ...valid, epicId: 'ep_1' }],
    ['a bad run id', { ...valid, runId: 'rn_../../x' }],
    ['an unknown kind', { ...valid, kind: 'approval_needed' }],
    ['an extra key', { ...valid, title: 'Renderer text' }],
    ['renderer text in place of ids', { ...valid, body: 'Click me' }],
    ['no folder', { kind: 'run_failed', epicId: EPIC, runId: RUN }],
    ['a non-object', 'checkpoint_ready']
  ])('refuses %s as invalid_input before reading anything', async (_name, request) => {
    const state = rig()
    await expect(state.raise(request)).resolves.toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(state.get).not.toHaveBeenCalled()
    expect(state.events).toEqual([])
  })
})

describe('notifications:raise: a valid request', () => {
  it('a checkpoint reads the epic title from the tracked folder and lands on its checkpoint', async () => {
    const state = rig()
    await expect(state.raise({ ...valid, folder: FOLDER.toUpperCase() })).resolves.toEqual({ ok: true, data: null })
    expect(state.get).toHaveBeenCalledExactlyOnceWith(FOLDER)
    expect(state.getEpic).toHaveBeenCalledExactlyOnceWith({ epicId: EPIC })
    expect(state.events).toEqual([{
      kind: 'checkpoint_ready', key: `checkpoint_ready:${RUN}`, title: 'Checkpoint ready: Agent chats in the epic',
      body: 'A sprint checkpoint waits for your review.', target: { kind: 'checkpoint', folder: FOLDER, epicId: EPIC }
    }])
  })

  it('a failed run lands on the epic', async () => {
    const state = rig()
    await expect(state.raise({ ...valid, kind: 'run_failed' })).resolves.toEqual({ ok: true, data: null })
    expect(state.events).toEqual([{
      kind: 'run_failed', key: `run_failed:${RUN}`, title: 'Run failed: Agent chats in the epic',
      body: 'Open the epic to see what failed.', target: { kind: 'epic', folder: FOLDER, epicId: EPIC }
    }])
  })

  it('a failing epic read answers its error and notifies nothing', async () => {
    const state = rig()
    state.getEpic.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'DomainError' }))
    const onUnexpectedError = vi.fn()
    const handlers = createNotifyHandlers({ registry: { resolve: () => FOLDER }, workspaces: { get: state.get }, notify: vi.fn(), onUnexpectedError })
    await expect(handlers.raise(valid)).resolves.toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(onUnexpectedError).toHaveBeenCalledOnce()
  })
})

describe('notifications:raise through the notifier', () => {
  it('shows one notification per runId, however often the renderer reports it', async () => {
    const shown: Array<{ title: string; body: string }> = []
    class FakeNotification {
      static isSupported(): boolean { return true }
      constructor(readonly options: { title: string; body: string; silent: boolean }) { shown.push({ title: options.title, body: options.body }) }
      on(): this { return this }
      show(): void {}
    }
    const notifier = createNotifier({
      Notification: FakeNotification, windows: () => [], settings: () => DEFAULT_NOTIFICATION_SETTINGS, push: vi.fn(),
      logger: { info: vi.fn() }, now: () => 1_000_000
    })
    const state = rig()
    const handlers = createNotifyHandlers({ registry: { resolve: () => FOLDER }, workspaces: { get: state.get }, notify: event => notifier.notify(event) })
    for (const runId of [RUN, RUN, OTHER_RUN, RUN]) await expect(handlers.raise({ ...valid, runId })).resolves.toEqual({ ok: true, data: null })
    expect(shown).toEqual([
      { title: 'Checkpoint ready: Agent chats in the epic', body: 'A sprint checkpoint waits for your review.' },
      { title: 'Checkpoint ready: Agent chats in the epic', body: 'A sprint checkpoint waits for your review.' }
    ])
    // A failure of the same run is a different event: it shows once too.
    await handlers.raise({ ...valid, kind: 'run_failed' })
    await handlers.raise({ ...valid, kind: 'run_failed' })
    expect(shown).toHaveLength(3)
    notifier.dispose()
  })
})
