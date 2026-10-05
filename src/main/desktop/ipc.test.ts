import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AgentAuthHandlers } from './agentAuth'
import type { AgentHandlers } from './agentHandlers'
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
const REMOVAL_PLAN = { remove: ['board/x.md'], kept: [], editByHand: [] }
const REMOVAL_RESULT = { removed: ['board/x.md'], removedFolders: ['board'], kept: [], editByHand: [] }

/** The agent handlers, logging like the others. */
function createRecordingAgentHandlers(calls: unknown[][]): AgentHandlers & AgentAuthHandlers {
  return {
    listAgents: async () => {
      calls.push(['listAgents'])
      return []
    },
    findAgent: async (kind) => {
      calls.push(['findAgent', kind])
      return { outcome: 'cancelled' }
    },
    removeAgent: async (kind) => {
      calls.push(['removeAgent', kind])
      return []
    },
    downloadAgent: async (kind) => {
      calls.push(['downloadAgent', kind])
      return { outcome: 'cancelled' }
    },
    agentStatus: async (kind) => {
      calls.push(['agentStatus', kind])
      return { state: 'unknown', reason: 'Not connected yet.' }
    },
    signInAgent: async (kind) => {
      calls.push(['signInAgent', kind])
      return { outcome: 'started' }
    }
  }
}

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
    previewBoardRemoval: async (folder) => {
      calls.push(['previewBoardRemoval', folder])
      return REMOVAL_PLAN
    },
    removeBoardFiles: async (folder, paths) => {
      calls.push(['removeBoardFiles', folder, paths])
      return REMOVAL_RESULT
    },
    copyText: async (text) => {
      calls.push(['copyText', text])
    },
    openExternal: async (url) => {
      calls.push(['openExternal', url])
      return true
    },
    ...createRecordingAgentHandlers(calls)
  }
  return { handlers, calls }
}

const EXPECTED_CHANNELS = [
  'agents:download',
  'agents:find',
  'agents:list',
  'agents:remove',
  'agents:signIn',
  'agents:status',
  'dm:command',
  'dm:connectClaudeCode',
  'dm:copyText',
  'dm:getMcpConfig',
  'dm:installSkills',
  'dm:listFolders',
  'dm:openExternal',
  'dm:pickFolder',
  'dm:previewBoardRemoval',
  'dm:removeBoardFiles',
  'dm:untrackFolder'
]

describe('registerDesktopIpc registration', () => {
  it('registers exactly the dm and agents channels, each once', () => {
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
    await ipc.invoke('dm:removeBoardFiles', '/repos/a')

    expect(calls).toEqual([
      ['command', undefined, undefined, undefined],
      ['untrackFolder', undefined],
      ['connectClaudeCode', '/repos/a', undefined],
      ['removeBoardFiles', '/repos/a', undefined]
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
    await ipc.invoke('dm:previewBoardRemoval', '/repos/a', 'stray')
    await ipc.invoke('dm:removeBoardFiles', '/repos/a', ['board/x.md'], 'stray')
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
      ['previewBoardRemoval', '/repos/a'],
      ['removeBoardFiles', '/repos/a', ['board/x.md']],
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
    expect(await ipc.invoke('dm:previewBoardRemoval', 'f')).toEqual(REMOVAL_PLAN)
    expect(await ipc.invoke('dm:removeBoardFiles', 'f', ['p'])).toEqual(REMOVAL_RESULT)
    expect(await ipc.invoke('dm:copyText', 't')).toBeUndefined()
    expect(await ipc.invoke('dm:openExternal', 'u')).toBe(true)
  })
})

describe('agent channels', () => {
  it('forward the kind to their handler and return what it resolves with', async () => {
    const ipc = createFakeIpcMain()
    const { handlers, calls } = createRecordingHandlers()
    registerDesktopIpc(ipc, handlers)

    expect(await ipc.invoke('agents:list', 'stray')).toEqual([])
    expect(await ipc.invoke('agents:find', 'claude', 'stray')).toEqual({ outcome: 'cancelled' })
    expect(await ipc.invoke('agents:remove', 'codex', 'stray')).toEqual([])
    expect(await ipc.invoke('agents:download', 'cursor', 'stray')).toEqual({ outcome: 'cancelled' })

    expect(calls).toEqual([
      ['listAgents'],
      ['findAgent', 'claude'],
      ['removeAgent', 'codex'],
      ['downloadAgent', 'cursor']
    ])
  })
})

describe('agent channels never carry an executable path', () => {
  it('forward only the kind, dropping any path or options the renderer adds', async () => {
    const ipc = createFakeIpcMain()
    const { handlers, calls } = createRecordingHandlers()
    registerDesktopIpc(ipc, handlers)

    await ipc.invoke('agents:find', 'claude', 'C:\\evil.exe', { executablePath: '/bin/sh' })
    await ipc.invoke('agents:remove', 'codex', '/bin/sh', { executablePath: '/bin/sh' })
    await ipc.invoke('agents:download', 'cursor', 'https://evil.example/install.sh', { command: 'calc' })

    expect(calls).toEqual([
      ['findAgent', 'claude'],
      ['removeAgent', 'codex'],
      ['downloadAgent', 'cursor']
    ])
  })

  it('status and sign-in forward only the kind, dropping any path, key or other option the renderer adds', async () => {
    const ipc = createFakeIpcMain()
    const { handlers, calls } = createRecordingHandlers()
    registerDesktopIpc(ipc, handlers)

    await ipc.invoke('agents:status', 'claude', 'C:\\evil.exe', { executablePath: '/bin/sh' })
    await ipc.invoke('agents:signIn', 'codex', 'sk-secret', { apiKey: 'sk-secret', password: 'hunter2' })

    expect(calls).toEqual([
      ['agentStatus', 'claude'],
      ['signInAgent', 'codex']
    ])
  })

  it('hands a payload that carries a credential to the handler untouched, for it to reject', async () => {
    const ipc = createFakeIpcMain()
    const { handlers, calls } = createRecordingHandlers()
    registerDesktopIpc(ipc, handlers)

    await ipc.invoke('agents:signIn', { kind: 'claude', apiKey: 'sk-secret' })

    expect(calls).toEqual([['signInAgent', { kind: 'claude', apiKey: 'sk-secret' }]])
  })

  it('hands a non-kind payload to the handler untouched, for it to reject', async () => {
    const ipc = createFakeIpcMain()
    const { handlers, calls } = createRecordingHandlers()
    registerDesktopIpc(ipc, handlers)

    await ipc.invoke('agents:find', { kind: 'claude', executablePath: '/bin/sh' })
    await ipc.invoke('agents:download', { kind: 'claude', url: 'https://evil.example/install.sh' })

    expect(calls).toEqual([
      ['findAgent', { kind: 'claude', executablePath: '/bin/sh' }],
      ['downloadAgent', { kind: 'claude', url: 'https://evil.example/install.sh' }]
    ])
  })
})

describe('preload bridge', () => {
  it('invokes exactly the channels the main process registers', () => {
    const ipc = createFakeIpcMain()
    registerDesktopIpc(ipc, createRecordingHandlers().handlers)
    const preload = readFileSync(fileURLToPath(new URL('../../preload/index.ts', import.meta.url)), 'utf8')

    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\(\s*'((?:dm|agents):[A-Za-z]+)'/g)]
      .map((match) => match[1])
      .sort()

    expect(invoked).toEqual(ipc.channels())
  })

  it('sends the agent channels nothing but the kind', () => {
    const preload = readFileSync(fileURLToPath(new URL('../../preload/index.ts', import.meta.url)), 'utf8')

    expect(preload).toContain("listAgents: () => ipcRenderer.invoke('agents:list')")
    expect(preload).toContain("findAgent: (kind) => ipcRenderer.invoke('agents:find', kind)")
    expect(preload).toContain("removeAgent: (kind) => ipcRenderer.invoke('agents:remove', kind)")
    expect(preload).toContain("agentStatus: (kind) => ipcRenderer.invoke('agents:status', kind)")
    expect(preload).toContain("signInAgent: (kind) => ipcRenderer.invoke('agents:signIn', kind)")
    expect(preload).toContain("downloadAgent: (kind) => ipcRenderer.invoke('agents:download', kind)")
  })

  it('subscribes to download progress on the channel main sends it on, and can unsubscribe', () => {
    const preload = readFileSync(fileURLToPath(new URL('../../preload/index.ts', import.meta.url)), 'utf8')
    const bootstrap = readFileSync(fileURLToPath(new URL('./bootstrap.ts', import.meta.url)), 'utf8')

    expect(preload).toContain("ipcRenderer.on('agents:downloadProgress', handler)")
    expect(preload).toContain("ipcRenderer.removeListener('agents:downloadProgress', handler)")
    expect(bootstrap).toContain("webContents.send('agents:downloadProgress', progress)")
  })
})
