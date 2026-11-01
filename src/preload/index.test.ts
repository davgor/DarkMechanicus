/**
 * Preload ↔ main channel contract: every bridged method must invoke a channel the main process
 * registers (with its arguments forwarded to the matching handler), and every subscription must
 * listen on the channel main pushes to. Channel-name drift on either side fails here.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'
import { CHAT_EVENT_CHANNEL } from '../shared/agents/chatApi'
import { AUTO_UPDATE_EVENT_CHANNEL } from '../shared/autoUpdate/types'
import { GIT_PROGRESS_CHANNEL } from '../shared/git/api'
import { GITHUB_ACCOUNT_CHANGED_CHANNEL } from '../shared/github/api'
import { registerChatIpc } from '../main/agents/chatIpc'
import type { ChatHandlers } from '../main/agents/chatHandlers'
import { registerAutoUpdateHandlers } from '../main/autoUpdate'
import { registerDesktopIpc } from '../main/desktop/ipc'
import type { DesktopHandlers } from '../main/desktop/handlers'
import { registerGitIpc } from '../main/git/ipc'
import type { GitHandlers } from '../main/git/handlers'
import { registerGithubIpc } from '../main/github/ipc'
import type { GithubHandlers } from '../main/github/handlers'
import './index'

type Listener = (...args: unknown[]) => unknown
type Api = Record<string, unknown>

const bridge = vi.hoisted(() => ({
  exposed: new Map<string, Record<string, unknown>>(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: Record<string, unknown>) => bridge.exposed.set(key, api)
  },
  ipcRenderer: { invoke: bridge.invoke, on: bridge.on, removeListener: bridge.removeListener },
  app: { getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }))
vi.mock('../main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

/** Channels main registers, mapped to their handler; handler calls are recorded in `handled`. */
const registered = new Map<string, Listener>()
const handled: Array<{ method: string; args: unknown[] }> = []
const fakeEvent = { sender: 'renderer' }

function recordingHandlers<T>(): T {
  return new Proxy({}, {
    get: (_target, method: string) => (...args: unknown[]) => {
      handled.push({ method, args })
      return `result:${method}`
    }
  }) as T
}

function recorder(routed: boolean): Pick<IpcMain, 'handle'> {
  return {
    handle: (channel, fn) => {
      registered.set(channel, routed ? (fn as Listener) : () => `result:${channel}`)
    }
  }
}

/** Every [path, function] in an exposed API, descending into nested API objects (dm.chats). */
function methodsOf(api: Api, prefix: string): Array<[string, Listener]> {
  return Object.entries(api).flatMap(([name, value]): Array<[string, Listener]> => {
    if (typeof value === 'function') return [[`${prefix}.${name}`, value as Listener]]
    return methodsOf(value as Api, `${prefix}.${name}`)
  })
}

const isSubscription = (path: string): boolean => /\.on[A-Z]\w*$/.test(path)

beforeAll(() => {
  registerGitIpc(recorder(true), recordingHandlers<GitHandlers>())
  registerGithubIpc(recorder(true), recordingHandlers<GithubHandlers>())
  registerDesktopIpc(recorder(true), recordingHandlers<DesktopHandlers>())
  registerChatIpc(recorder(true), recordingHandlers<ChatHandlers>())
  registerAutoUpdateHandlers(recorder(false))
  // Registered inline in src/main/index.ts (app bootstrap, not importable without launching the app).
  registered.set('app:getVersion', () => 'result:app:getVersion')
  bridge.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const handler = registered.get(channel)
    if (!handler) throw new Error(`No main handler registered for ${channel}`)
    return handler(fakeEvent, ...args)
  })
})

describe('preload bridge', () => {
  it('exposes exactly the five world APIs', () => {
    expect([...bridge.exposed.keys()].sort()).toEqual(['appInfo', 'autoUpdate', 'dm', 'git', 'github'])
  })

  it('invokes only channels main registers and forwards every argument to the handler', async () => {
    const invoked = new Set<string>()
    const methods = [...bridge.exposed].flatMap(([key, api]) => methodsOf(api, key))
    for (const [path, method] of methods.filter(([p]) => !isSubscription(p))) {
      bridge.invoke.mockClear()
      handled.length = 0
      const args = Array.from({ length: method.length }, (_, i) => `${path}#${i}`)
      const result = await method(...args)
      expect(bridge.invoke, path).toHaveBeenCalledTimes(1)
      const [channel, ...sent] = bridge.invoke.mock.calls[0] as [string, ...unknown[]]
      expect(registered.has(channel), `${path} → ${channel}`).toBe(true)
      expect(sent, path).toEqual(args)
      if (handled.length > 0) {
        expect(handled, path).toEqual([{ method: expect.any(String), args }])
        expect(result, path).toBe(`result:${handled[0].method}`)
      }
      invoked.add(channel)
    }
    expect([...registered.keys()].filter((channel) => !invoked.has(channel))).toEqual([])
  })
})

describe('preload bridge subscriptions', () => {
  it('subscribes each on* method to its push channel and unsubscribes the same handler', () => {
    const expected: Record<string, string> = {
      'autoUpdate.onEvent': AUTO_UPDATE_EVENT_CHANNEL,
      'dm.chats.onEvent': CHAT_EVENT_CHANNEL,
      'dm.onAgentDownloadProgress': 'agents:downloadProgress',
      'git.onProgress': GIT_PROGRESS_CHANNEL,
      'github.onAccountChanged': GITHUB_ACCOUNT_CHANGED_CHANNEL
    }
    const methods = [...bridge.exposed].flatMap(([key, api]) => methodsOf(api, key))
    const subscriptions = methods.filter(([path]) => isSubscription(path))
    expect(subscriptions.map(([path]) => path).sort()).toEqual(Object.keys(expected).sort())
    for (const [path, subscribe] of subscriptions) {
      bridge.on.mockClear()
      bridge.removeListener.mockClear()
      const listener = vi.fn()
      const unsubscribe = subscribe(listener) as () => void
      expect(bridge.on, path).toHaveBeenCalledTimes(1)
      const [channel, handler] = bridge.on.mock.calls[0] as [string, Listener]
      expect(channel, path).toBe(expected[path])
      handler(fakeEvent, { payload: path })
      expect(listener, path).toHaveBeenCalledWith({ payload: path })
      expect(listener.mock.calls[0], path).toHaveLength(1)
      expect(bridge.removeListener, path).not.toHaveBeenCalled()
      unsubscribe()
      expect(bridge.removeListener, path).toHaveBeenCalledWith(expected[path], handler)
    }
  })
})
