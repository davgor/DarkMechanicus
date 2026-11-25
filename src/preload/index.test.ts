/**
 * Preload ↔ main channel contract: every bridged method must invoke a channel the main process
 * registers (with its arguments forwarded to the matching handler), and every subscription must
 * listen on the channel main pushes to. Channel-name drift on either side fails here.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'
import { CHAT_EVENT_CHANNEL, CHAT_MAIL_EVENT_CHANNEL } from '../shared/agents/chatApi'
import { AGENT_CHAT_CHANNELS, type AgentChatApi } from '../shared/agents/agentChat'
import { AUTO_UPDATE_EVENT_CHANNEL } from '../shared/autoUpdate/types'
import { GIT_PROGRESS_CHANNEL } from '../shared/git/api'
import { GITHUB_ACCOUNT_CHANGED_CHANNEL } from '../shared/github/api'
import { startForge } from '../main/desktop/forgeService'
import { registerTelegramIpc } from '../main/telegram'
import { registerChatIpc, registerChatMailIpc } from '../main/agents/chatIpc'
import type { ChatHandlers } from '../main/agents/chatHandlers'
import type { ChatMailHandlers } from '../main/agents/agentMailDesktop'
import { registerAutoUpdateHandlers } from '../main/autoUpdate'
import { registerDesktopIpc, registerKnowledgeIpc, registerYoloIpc } from '../main/desktop/ipc'
import type { YoloHandlers } from '../main/desktop/yoloHandlers'
import { registerCrossRepoCorrectionIpc, type CrossRepoCorrectionHandlers } from '../main/desktop/crossRepoCorrections'
import type { DesktopHandlers } from '../main/desktop/handlers'
import type { KnowledgeHandlers } from '../main/desktop/knowledgeHandlers'
import { registerSourceCheckoutIpc, type SourceCheckoutHandlers } from '../main/desktop/sourceCheckoutIpc'
import { registerSettingsIpc, type SettingsHandlers } from '../main/desktop/settingsIpc'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../shared/desktop/notificationSettings'
import { registerGitIpc } from '../main/git/ipc'
import type { GitHandlers } from '../main/git/handlers'
import { registerGithubIpc } from '../main/github/ipc'
import type { GithubHandlers } from '../main/github/handlers'
import { registerTerminalIpc } from '../main/terminals/terminalHandlers'
import type { TerminalHandlers } from '../main/terminals/terminalHandlers'
import './index'

type Listener = (...args: unknown[]) => unknown
type Api = Record<string, unknown>

const bridge = vi.hoisted(() => ({
  exposed: new Map<string, Record<string, unknown>>(),
  calls: [] as Array<[string, ...unknown[]]>,
  listeners: new Map<string, Set<Listener>>()
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: Record<string, unknown>) => bridge.exposed.set(key, api)
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      bridge.calls.push([channel, ...args])
      const handler = registered.get(channel)
      if (!handler) throw new Error('Unregistered channel ' + channel)
      return handler(fakeEvent, ...args)
    },
    on: (channel: string, listener: Listener) => {
      const listeners = bridge.listeners.get(channel) ?? new Set<Listener>()
      listeners.add(listener)
      bridge.listeners.set(channel, listeners)
    },
    removeListener: (channel: string, listener: Listener) => bridge.listeners.get(channel)?.delete(listener)
  },
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

/** The one method whose wire payload is not its argument list: attach sends one request object, as main's strict schema wants. */
const wireArgs: Record<string, (args: unknown[]) => unknown[]> = {
  'dm.terminals.attach': ([folder, chatId]) => [{ folder, chatId }]
}

async function recordForgeChannels(): Promise<void> {
  const deps = recordingHandlers<Parameters<typeof startForge>[1]>()
  const setup = recordingHandlers<NonNullable<typeof deps.setup>>()
  const forge = startForge(recorder(false), {
    ...deps, registry: { ...deps.registry, list: () => [] },
    provisioning: {
      journal: 'forge-provisioning-fixture.json',
      publisher: recordingHandlers(),
      discover: async () => { throw new Error('This fixture only records Forge IPC registration.') }
    },
    setup: {
      file: 'forge-onboarding-fixture.json', scratch: 'forge-onboarding-fixture',
      preferred: setup.preferred, agent: setup.agent, getStandards: setup.getStandards, getChat: setup.getChat,
      findChat: setup.findChat, createChat: setup.createChat, start: setup.start, hasInput: setup.hasInput,
      running: setup.running, announce: setup.announce
    }
  })
  await forge.stop()
  await forge.ready
}

beforeAll(async () => {
  await recordForgeChannels()
  registerGitIpc(recorder(true), recordingHandlers<GitHandlers>())
  registerGithubIpc(recorder(true), recordingHandlers<GithubHandlers>())
  registerDesktopIpc(recorder(true), recordingHandlers<DesktopHandlers>())
  registerYoloIpc(recorder(true), recordingHandlers<YoloHandlers>())
  registerSourceCheckoutIpc(recorder(true), recordingHandlers<SourceCheckoutHandlers>())
  registerSettingsIpc(recorder(true), recordingHandlers<SettingsHandlers>())
  registerCrossRepoCorrectionIpc(recorder(true), recordingHandlers<CrossRepoCorrectionHandlers>())
  registerKnowledgeIpc(recorder(true), recordingHandlers<KnowledgeHandlers>())
  registerChatIpc(recorder(true), recordingHandlers<ChatHandlers>())
  registerChatMailIpc(recorder(true), recordingHandlers<ChatMailHandlers>())
  registerTelegramIpc(recorder(false), () => ({}), async () => 'code', () => {})
  registerAutoUpdateHandlers(recorder(false))
  // Terminal handlers take the sender's frame, not the event, so these are checked by channel and payload only.
  registerTerminalIpc(recorder(false), recordingHandlers<TerminalHandlers>())
  // Registered inline in src/main/index.ts (app bootstrap, not importable without launching the app).
  registered.set('app:getVersion', () => 'result:app:getVersion')

})

describe('preload bridge', () => {
  it('exposes exactly the five world APIs', () => {
    expect([...bridge.exposed.keys()].sort()).toEqual(['appInfo', 'autoUpdate', 'dm', 'git', 'github'])
  })

  it('invokes only channels main registers and forwards every argument to the handler', async () => {
    const invoked = new Set<string>()
    const methods = [...bridge.exposed].flatMap(([key, api]) => methodsOf(api, key))
    for (const [path, method] of methods.filter(([p]) => !isSubscription(p))) {
      bridge.calls.length = 0
      handled.length = 0
      const args = Array.from({ length: method.length }, (_, i) => `${path}#${i}`)
      // DM-770 adds the contract before the agent-chat main handlers land.
      if (path.startsWith('dm.agentChat.')) {
        const channel = AGENT_CHAT_CHANNELS[path.slice('dm.agentChat.'.length) as Exclude<keyof typeof AGENT_CHAT_CHANNELS, 'event'>]
        await expect(method(...args)).rejects.toThrow(`Unregistered channel ${channel}`)
        expect(bridge.calls, path).toEqual([[channel, ...args]])
        continue
      }
      const result = await method(...args)
      expect(bridge.calls, path).toHaveLength(1)
      const [channel, ...sent] = bridge.calls[0] as [string, ...unknown[]]
      expect(registered.has(channel), `${path} → ${channel}`).toBe(true)
      expect(sent, path).toEqual(wireArgs[path]?.(args) ?? args)
      if (handled.length > 0) {
        expect(handled, path).toEqual([{ method: expect.any(String), args }])
        expect(result, path).toBe(`result:${handled[0].method}`)
      }
      invoked.add(channel)
    }
    expect([...registered.keys()].filter((channel) => !invoked.has(channel))).toEqual([])
  })

  it('exposes board conversation send and state through their guarded chat channels', async () => {
    const dm = bridge.exposed.get('dm') as { chats: Record<string, Listener> }
    const send = { folder: '/repo', target: { epicId: 'ep_1' }, body: 'Can you help?' }
    const state = { folder: '/repo', target: { epicId: 'ep_1' }, messageIds: ['cm_1'] }

    bridge.calls.length = 0
    await dm.chats.sendConversationMessage(send)
    await dm.chats.conversationState(state)

    expect(bridge.calls).toEqual([['chats:sendConversationMessage', send], ['chats:conversationState', state]])
  })

  it('exposes Start planner through its guarded chat channel, forwarding only the request', async () => {
    const dm = bridge.exposed.get('dm') as { chats: Record<string, Listener> }
    const request = { folder: '/repo', epicId: 'ep_1' }

    bridge.calls.length = 0
    await dm.chats.startPlanner(request)

    expect(bridge.calls).toEqual([['chats:startPlanner', request]])
    expect(registered.has('chats:startPlanner')).toBe(true)
  })

  it('exposes the notification settings through exactly their two settings channels', async () => {
    const dm = bridge.exposed.get('dm') as { settings: Record<string, Listener> }
    const next = { ...DEFAULT_NOTIFICATION_SETTINGS, sound: false }

    expect(Object.keys(dm.settings).sort()).toEqual(['getNotifications', 'setNotifications'])
    bridge.calls.length = 0
    handled.length = 0
    await expect(dm.settings.getNotifications()).resolves.toBe('result:getNotifications')
    await expect(dm.settings.setNotifications(next)).resolves.toBe('result:setNotifications')

    expect(bridge.calls).toEqual([['settings:getNotifications'], ['settings:setNotifications', next]])
    expect(handled).toEqual([{ method: 'getNotifications', args: [] }, { method: 'setNotifications', args: [next] }])
  })
})

describe('preload bridge subscriptions', () => {
  it('subscribes each on* method to its push channel and unsubscribes the same handler', () => {
    const expected: Record<string, string> = {
      'autoUpdate.onEvent': AUTO_UPDATE_EVENT_CHANNEL,
      'dm.chats.onEvent': CHAT_EVENT_CHANNEL,
      'dm.chats.mail.onEvent': CHAT_MAIL_EVENT_CHANNEL,
      'dm.agentChat.onEvent': AGENT_CHAT_CHANNELS.event,
      'dm.onAgentDownloadProgress': 'agents:downloadProgress',
      'dm.onFoldersChanged': 'forge:foldersChanged',
      'git.onProgress': GIT_PROGRESS_CHANNEL,
      'github.onAccountChanged': GITHUB_ACCOUNT_CHANGED_CHANNEL
    }
    const methods = [...bridge.exposed].flatMap(([key, api]) => methodsOf(api, key))
    const subscriptions = methods.filter(([path]) => isSubscription(path))
    expect(subscriptions.map(([path]) => path).sort()).toEqual(Object.keys(expected).sort())
    for (const [path, subscribe] of subscriptions) {
      const received: unknown[][] = []
      const unsubscribe = subscribe((...args: unknown[]) => received.push(args)) as () => void
      const listeners = bridge.listeners.get(expected[path])
      expect(listeners?.size, path).toBe(1)
      const payload = path === 'dm.agentChat.onEvent' ? { type: 'status', folder: null, chatId: 'chat_1', status: 'idle' } : { payload: path }
      for (const listener of listeners ?? []) listener(fakeEvent, payload)
      // Folder changes invalidate the registry without forwarding any payload.
      const expectedArgs = path === 'dm.onFoldersChanged' ? [] : [payload]
      expect(received, path).toEqual([expectedArgs])
      unsubscribe()
      expect(listeners?.size, path).toBe(0)
    }
  })

  it('drops invalid GUI pushes, including malformed to-do lists, and forwards valid events', () => {
    const dm = bridge.exposed.get('dm') as { agentChat: AgentChatApi }
    const received: unknown[] = []
    const unsubscribe = dm.agentChat.onEvent(event => received.push(event))
    const listeners = bridge.listeners.get(AGENT_CHAT_CHANNELS.event)
    const valid = { type: 'todos', folder: null, chatId: 'chat_1', threadId: null, phases: [] }
    const invalid = [
      null, { type: 'unknown' }, { ...valid, extra: true },
      { ...valid, phases: Array(21).fill({ name: 'phase', tasks: [] }) },
      { ...valid, phases: [{ name: 'phase', tasks: [{ id: null, content: 'Task', status: 'unknown' }] }] }
    ]
    for (const event of [...invalid, valid]) for (const listener of listeners ?? []) listener(fakeEvent, event)
    expect(received).toEqual([valid])
    unsubscribe()
    expect(listeners?.size).toBe(0)
  })
})
