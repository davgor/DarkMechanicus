import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { DesktopHandlers } from './handlers'
import { registerDesktopIpc } from './ipc'

type Listener = Parameters<IpcMain['handle']>[1]

/** The handlers ignore the event, so an empty stand-in is enough. */
const EVENT = {} as IpcMainInvokeEvent

/** Records handle() registrations like ipcMain does, including refusing a channel registered twice. */
function createFakeIpcMain(): {
  handle(channel: string, listener: Listener): void
  channels(): string[]
  invoke(channel: string, ...args: unknown[]): unknown
} {
  const listeners = new Map<string, Listener>()
  return {
    handle(channel, listener) {
      if (listeners.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      listeners.set(channel, listener)
    },
    channels: () => [...listeners.keys()].sort(),
    invoke: (channel, ...args) => listeners.get(channel)?.(EVENT, ...args)
  }
}

const MCP_VIEW = { command: 'node', args: [], env: {}, json: '{}', note: 'n' }

/** Handlers that log each call as [name, ...args] and return a recognizable value. */
function createRecordingHandlers(): { handlers: DesktopHandlers; calls: unknown[][] } {
  const calls: unknown[][] = []
  const handlers: DesktopHandlers = {
    listFolders: async () => {
      calls.push(['listFolders'])
      return []
    },
    pickFolder: async () => {
      calls.push(['pickFolder'])
      return { folder: null, added: false }
    },
    untrackFolder: async (path) => {
      calls.push(['untrackFolder', path])
      return []
    },
    command: async (folder, name, input) => {
      calls.push(['command', folder, name, input])
      return { ok: true, data: 'command-result' }
    },
    getMcpConfig: async (folder) => {
      calls.push(['getMcpConfig', folder])
      return MCP_VIEW
    },
    installSkills: async (folder) => {
      calls.push(['installSkills', folder])
      return { written: ['a'] }
    },
    connectClaudeCode: async (folder, request) => {
      calls.push(['connectClaudeCode', folder, request])
      return { outcome: 'created' }
    },
    copyText: async (text) => {
      calls.push(['copyText', text])
    },
    openExternal: async (url) => {
      calls.push(['openExternal', url])
      return true
    }
  }
  return { handlers, calls }
}

const EXPECTED_CHANNELS = [
  'dm:command',
  'dm:connectClaudeCode',
  'dm:copyText',
  'dm:getMcpConfig',
  'dm:installSkills',
  'dm:listFolders',
  'dm:openExternal',
  'dm:pickFolder',
  'dm:untrackFolder'
]

describe('registerDesktopIpc registration', () => {
  it('registers exactly the dm channels, each once', () => {
    const ipc = createFakeIpcMain()

    registerDesktopIpc(ipc, createRecordingHandlers().handlers)

    expect(ipc.channels()).toEqual(EXPECTED_CHANNELS)
  })

  it('passes missing arguments through as undefined for the handler to reject', async () => {
    const ipc = createFakeIpcMain()
    const { handlers, calls } = createRecordingHandlers()
    registerDesktopIpc(ipc, handlers)

    await ipc.invoke('dm:command')
    await ipc.invoke('dm:untrackFolder')
    await ipc.invoke('dm:connectClaudeCode', '/repos/a')

    expect(calls).toEqual([
      ['command', undefined, undefined, undefined],
      ['untrackFolder', undefined],
      ['connectClaudeCode', '/repos/a', undefined]
    ])
  })
})

describe('registerDesktopIpc forwarding', () => {
  it('forwards each channel to its handler with only the payload arguments', async () => {
    const ipc = createFakeIpcMain()
    const { handlers, calls } = createRecordingHandlers()
    registerDesktopIpc(ipc, handlers)

    await ipc.invoke('dm:listFolders', 'stray')
    await ipc.invoke('dm:pickFolder', 'stray')
    await ipc.invoke('dm:untrackFolder', '/repos/a', 'stray')
    await ipc.invoke('dm:command', '/repos/a', 'getEpic', { epicId: 'e' }, 'stray')
    await ipc.invoke('dm:getMcpConfig', '/repos/a', 'stray')
    await ipc.invoke('dm:installSkills', '/repos/a', 'stray')
    await ipc.invoke('dm:connectClaudeCode', '/repos/a', { role: 'planner' }, 'stray')
    await ipc.invoke('dm:copyText', 'text', 'stray')
    await ipc.invoke('dm:openExternal', 'https://example.com', 'stray')

    expect(calls).toEqual([
      ['listFolders'],
      ['pickFolder'],
      ['untrackFolder', '/repos/a'],
      ['command', '/repos/a', 'getEpic', { epicId: 'e' }],
      ['getMcpConfig', '/repos/a'],
      ['installSkills', '/repos/a'],
      ['connectClaudeCode', '/repos/a', { role: 'planner' }],
      ['copyText', 'text'],
      ['openExternal', 'https://example.com']
    ])
  })

  it('returns whatever the handler resolves with', async () => {
    const ipc = createFakeIpcMain()
    registerDesktopIpc(ipc, createRecordingHandlers().handlers)

    expect(await ipc.invoke('dm:listFolders')).toEqual([])
    expect(await ipc.invoke('dm:pickFolder')).toEqual({ folder: null, added: false })
    expect(await ipc.invoke('dm:untrackFolder', 'p')).toEqual([])
    expect(await ipc.invoke('dm:command', 'f', 'n', 'i')).toEqual({ ok: true, data: 'command-result' })
    expect(await ipc.invoke('dm:getMcpConfig', 'f')).toEqual(MCP_VIEW)
    expect(await ipc.invoke('dm:installSkills', 'f')).toEqual({ written: ['a'] })
    expect(await ipc.invoke('dm:connectClaudeCode', 'f', 'r')).toEqual({ outcome: 'created' })
    expect(await ipc.invoke('dm:copyText', 't')).toBeUndefined()
    expect(await ipc.invoke('dm:openExternal', 'u')).toBe(true)
  })
})

describe('preload bridge', () => {
  it('invokes exactly the channels the main process registers', () => {
    const ipc = createFakeIpcMain()
    registerDesktopIpc(ipc, createRecordingHandlers().handlers)
    const preload = readFileSync(fileURLToPath(new URL('../../preload/index.ts', import.meta.url)), 'utf8')

    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\(\s*'(dm:[A-Za-z]+)'/g)]
      .map((match) => match[1])
      .sort()

    expect(invoked).toEqual(ipc.channels())
  })
})
