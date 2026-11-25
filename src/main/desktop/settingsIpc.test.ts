/**
 * The `settings:*Notifications` channels: exactly two, both registered through the sender guard, each forwarding only
 * its payload to the handlers; an untrusted sender never reaches them.
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '../../shared/desktop/notificationSettings'
import { guardIpc } from '../ipcGuard'
import type { AppSettings } from './appSettings'
import { createSettingsHandlers, registerSettingsIpc } from './settingsIpc'

type Listener = Parameters<IpcMain['handle']>[1]
const APP_URL = 'http://localhost:5173'
const frame = (url: string, parent: object | null = null) => ({ url, parent, detached: false, isDestroyed: () => false })
const TRUSTED = { sender: {}, senderFrame: frame(`${APP_URL}/`) } as unknown as IpcMainInvokeEvent
const FOREIGN = { sender: {}, senderFrame: frame('https://example.com/') } as unknown as IpcMainInvokeEvent

function rig() {
  const settings = {
    notifications: vi.fn(() => DEFAULT_NOTIFICATION_SETTINGS),
    setNotifications: vi.fn(async (next: unknown) => next as NotificationSettings),
    onChange: vi.fn(() => () => {})
  } satisfies AppSettings
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
  registerSettingsIpc(stub, createSettingsHandlers(settings))
  const invoke = async (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) => listeners.get(channel)!(event, ...args)
  return { settings, listeners, unguarded, refused, invoke }
}

describe('settings IPC', () => {
  it('registers exactly the two settings channels, each once, through the guard', () => {
    const { listeners, unguarded } = rig()
    expect([...listeners.keys()].sort()).toEqual(['settings:getNotifications', 'settings:setNotifications'])
    expect(unguarded.sort()).toEqual(['settings:getNotifications', 'settings:setNotifications'])
  })

  it('reads the settings main holds, ignoring any payload', async () => {
    const { settings, invoke } = rig()
    await expect(invoke('settings:getNotifications', TRUSTED, { arbitration: { enabled: false } })).resolves.toEqual(DEFAULT_NOTIFICATION_SETTINGS)
    expect(settings.notifications).toHaveBeenCalledTimes(1)
  })

  it('forwards only the first payload to setNotifications', async () => {
    const { settings, invoke } = rig()
    const next = { ...DEFAULT_NOTIFICATION_SETTINGS, sound: false }
    await expect(invoke('settings:setNotifications', TRUSTED, next, 'extra')).resolves.toEqual(next)
    expect(settings.setNotifications.mock.calls).toEqual([[next]])
  })

  it('refuses an untrusted sender on both channels before the settings are reached', async () => {
    const { settings, invoke, refused } = rig()
    for (const channel of ['settings:getNotifications', 'settings:setNotifications']) {
      await expect(invoke(channel, FOREIGN, DEFAULT_NOTIFICATION_SETTINGS)).resolves.toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    }
    expect(refused).toEqual(['settings:getNotifications', 'settings:setNotifications'])
    expect(settings.notifications).not.toHaveBeenCalled()
    expect(settings.setNotifications).not.toHaveBeenCalled()
  })
})
