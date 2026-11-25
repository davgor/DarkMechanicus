/**
 * The `settings:*Notifications` channels: exactly two, both registered through the sender guard, each forwarding only
 * its payload to the real settings store on a temp app database and answering `{ ok, data }` or `{ ok: false, error }`,
 * so a declined confirmation reaches the renderer as `cancelled` and a refused shape as `invalid_input`. An untrusted
 * sender never reaches the store.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../../core/db/database'
import type { CommandResult } from '../../shared/desktop/api'
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '../../shared/desktop/notificationSettings'
import { guardIpc } from '../ipcGuard'
import { openAppDatabase } from './appDatabase'
import { createAppSettings, type AppSettings } from './appSettings'
import { createSettingsHandlers, registerSettingsIpc } from './settingsIpc'

type Listener = Parameters<IpcMain['handle']>[1]
const APP_URL = 'http://localhost:5173'
const frame = (url: string, parent: object | null = null) => ({ url, parent, detached: false, isDestroyed: () => false })
const TRUSTED = { sender: {}, senderFrame: frame(`${APP_URL}/`) } as unknown as IpcMainInvokeEvent
const FOREIGN = { sender: {}, senderFrame: frame('https://example.com/') } as unknown as IpcMainInvokeEvent
const CHANNELS = ['settings:getNotifications', 'settings:setNotifications']

/** Arbitration off with one always-ask entry, so turning it on or removing the entry is a loosening change. */
const RESTRICTIVE: NotificationSettings = {
  ...DEFAULT_NOTIFICATION_SETTINGS,
  arbitration: { enabled: false, alwaysAsk: ['bash:rm'], autoHandleNotes: '' }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function openDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'dm-settingsipc-test-'))
  const db = openAppDatabase(dir)
  cleanups.push(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  db.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', 'notificationSettings', JSON.stringify(RESTRICTIVE))
  return db
}

function rig(options: { confirm?: boolean; settings?: AppSettings } = {}) {
  const confirm = vi.fn(async (_summary: string) => options.confirm ?? false)
  const settings = options.settings ?? createAppSettings({ db: openDb(), confirm, logger: { warn: vi.fn() } })
  const onUnexpectedError = vi.fn()
  const listeners = new Map<string, Listener>()
  const unguarded: string[] = []
  const refused: string[] = []
  const guarded = guardIpc({
    handle: (channel, listener) => {
      if (listeners.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
      listeners.set(channel, listener)
    }
  }, { appUrl: APP_URL, onRefused: (channel) => { refused.push(channel) } })
  const stub: Pick<IpcMain, 'handle'> = {
    handle: (channel, listener) => {
      unguarded.push(channel)
      guarded.handle(channel, listener)
    }
  }
  registerSettingsIpc(stub, createSettingsHandlers({ settings, onUnexpectedError }))
  const invoke = async (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) =>
    (await listeners.get(channel)!(event, ...args)) as CommandResult<NotificationSettings>
  return { settings, confirm, onUnexpectedError, listeners, unguarded, refused, invoke }
}

describe('settings IPC registration', () => {
  it('registers exactly the two settings channels, each once, through the guard', () => {
    const { listeners, unguarded } = rig()
    expect([...listeners.keys()].sort()).toEqual(CHANNELS)
    expect(unguarded.sort()).toEqual(CHANNELS)
  })

  it('refuses an untrusted sender on both channels before the settings are reached', async () => {
    const { settings, confirm, invoke, refused } = rig({ confirm: true })
    const read = vi.spyOn(settings, 'notifications')
    for (const channel of CHANNELS) {
      expect(await invoke(channel, FOREIGN, DEFAULT_NOTIFICATION_SETTINGS)).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    }
    expect(refused).toEqual(CHANNELS)
    expect(read).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('settings IPC answers', () => {
  it('reads the settings main holds as ok, ignoring any payload', async () => {
    const { invoke } = rig()
    expect(await invoke('settings:getNotifications', TRUSTED, DEFAULT_NOTIFICATION_SETTINGS)).toEqual({ ok: true, data: RESTRICTIVE })
  })

  it('answers a saved value as ok with the saved settings, forwarding only the first payload', async () => {
    const { settings, confirm, invoke } = rig()
    const next = { ...RESTRICTIVE, sound: false }
    expect(await invoke('settings:setNotifications', TRUSTED, next, DEFAULT_NOTIFICATION_SETTINGS)).toEqual({ ok: true, data: next })
    expect(settings.notifications()).toEqual(next)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('answers a declined loosening change as error.code cancelled, with nothing changed', async () => {
    const { settings, confirm, invoke, onUnexpectedError } = rig({ confirm: false })
    const result = await invoke('settings:setNotifications', TRUSTED, DEFAULT_NOTIFICATION_SETTINGS)
    expect(result).toEqual({ ok: false, error: { code: 'cancelled', message: 'The change was not confirmed.' } })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(settings.notifications()).toEqual(RESTRICTIVE)
    expect(onUnexpectedError).not.toHaveBeenCalled()
  })

  it('answers an invalid shape as error.code invalid_input, never confirmed', async () => {
    const { settings, confirm, invoke, onUnexpectedError } = rig({ confirm: true })
    const result = await invoke('settings:setNotifications', TRUSTED, { ...RESTRICTIVE, extra: true })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(confirm).not.toHaveBeenCalled()
    expect(settings.notifications()).toEqual(RESTRICTIVE)
    expect(onUnexpectedError).not.toHaveBeenCalled()
  })

  it('answers an unexpected failure as internal and reports it', async () => {
    const failure = new Error('disk gone')
    const broken: AppSettings = {
      notifications: () => { throw failure },
      setNotifications: async () => { throw failure },
      onChange: () => () => {}
    }
    const { invoke, onUnexpectedError } = rig({ settings: broken })
    expect(await invoke('settings:getNotifications', TRUSTED)).toEqual({ ok: false, error: { code: 'internal', message: 'disk gone' } })
    expect(await invoke('settings:setNotifications', TRUSTED, RESTRICTIVE)).toEqual({ ok: false, error: { code: 'internal', message: 'disk gone' } })
    expect(onUnexpectedError.mock.calls).toEqual([[failure], [failure]])
  })
})
