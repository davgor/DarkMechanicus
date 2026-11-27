/**
 * The `agentChat:*` channels: exactly the contract's, every one behind the sender guard, each payload validated by the
 * strict schemas and its folder resolved through the registry before the session manager is reached; the push sends
 * only validated events.
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_CHAT_CHANNELS, type AgentChatEvent } from '../../shared/agents/agentChat'
import type { CommandResult } from '../../shared/desktop/api'
import type { ChatWindow } from '../agents/chatIpc'
import { guardIpc } from '../ipcGuard'
import { createAgentChatHandlers, createAgentChatPush, registerAgentChatIpc } from './agentChatIpc'
import type { AgentChatSessions } from './agentChatSessions'
import type { OmpModels } from './ompModels'

type Listener = Parameters<IpcMain['handle']>[1]
const APP_URL = 'http://localhost:5173'
const REPO = '/work/repo'
/** Contract channels whose main handlers land later: stageImage with the image store, attachEvidence with evidence. */
const NOT_YET_HANDLED: readonly string[] = [AGENT_CHAT_CHANNELS.stageImage, AGENT_CHAT_CHANNELS.attachEvidence]
const INVOKED = Object.values(AGENT_CHAT_CHANNELS).filter(channel => channel !== AGENT_CHAT_CHANNELS.event && !NOT_YET_HANDLED.includes(channel)).sort()
const frame = (url: string, parent: object | null = null) => ({ url, parent, detached: false, isDestroyed: () => false })
const TRUSTED = { sender: {}, senderFrame: frame(`${APP_URL}/`) } as unknown as IpcMainInvokeEvent
const SNAPSHOT = { items: [], status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [] } as const

/** A valid request for each invoked channel. */
const REQUESTS: Record<string, Record<string, unknown>> = {
  [AGENT_CHAT_CHANNELS.start]: { folder: REPO, chatId: 'chat_1' },
  [AGENT_CHAT_CHANNELS.send]: { folder: REPO, chatId: 'chat_1', text: 'Hello' },
  [AGENT_CHAT_CHANNELS.interrupt]: { folder: REPO, chatId: 'chat_1' },
  [AGENT_CHAT_CHANNELS.answer]: { folder: REPO, chatId: 'chat_1', promptId: 'p1', optionId: 'allow_once' },
  [AGENT_CHAT_CHANNELS.setSurface]: { folder: REPO, chatId: 'chat_1', surface: 'gui' },
  [AGENT_CHAT_CHANNELS.snapshot]: { folder: REPO, chatId: 'chat_1' },
  [AGENT_CHAT_CHANNELS.attention]: { folder: REPO },
  [AGENT_CHAT_CHANNELS.models]: { folder: REPO, chatId: 'chat_1' },
  [AGENT_CHAT_CHANNELS.setModel]: { folder: REPO, chatId: 'chat_1', provider: 'openai-codex', modelId: 'gpt-6-sol' }
}

function rig() {
  const calls: unknown[][] = []
  const record = (name: string, result: unknown) => vi.fn(async (...args: unknown[]) => { calls.push([name, ...args]); return result })
  const sessions = {
    start: record('start', SNAPSHOT), send: record('send', undefined), interrupt: record('interrupt', undefined),
    answer: record('answer', undefined), setSurface: record('setSurface', SNAPSHOT), snapshot: vi.fn((...args: unknown[]) => { calls.push(['snapshot', ...args]); return SNAPSHOT }),
    attention: vi.fn((...args: unknown[]) => { calls.push(['attention', ...args]); return [] }), setModel: record('setModel', SNAPSHOT)
  } as unknown as AgentChatSessions
  const confirmTerminalStop = vi.fn(async () => false)
  const listeners = new Map<string, Listener>()
  const refused: string[] = []
  const guarded = guardIpc({
    handle: (channel, listener) => {
      if (listeners.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
      listeners.set(channel, listener)
    }
  }, { appUrl: APP_URL, onRefused: channel => { refused.push(channel) } })
  const models = { chatModels: record('chatModels', []), catalogModels: record('catalogModels', []) } as unknown as OmpModels
  const handlers = createAgentChatHandlers({ registry: { resolve: path => (path === REPO ? REPO : null) }, sessions, confirmTerminalStop, models })
  registerAgentChatIpc(guarded, handlers, event => event.sender)
  const invoke = async (channel: string, request: unknown, event = TRUSTED) => (await listeners.get(channel)!(event, request)) as CommandResult<unknown>
  return { calls, sessions, confirmTerminalStop, listeners, refused, invoke }
}

const codeOf = (result: CommandResult<unknown>) => (result.ok ? 'ok' : result.error.code)

describe('agent chat IPC registration', () => {
  it('registers exactly the invoked agentChat channels, each once, and no chats:* name', () => {
    const channels = [...rig().listeners.keys()].sort()
    expect(channels).toEqual(INVOKED)
    expect(channels.every(channel => channel.startsWith('agentChat:'))).toBe(true)
  })

  it('answers each channel for the app page and reaches the session manager with the resolved chat or folder', async () => {
    const state = rig()
    for (const channel of INVOKED) expect(codeOf(await state.invoke(channel, REQUESTS[channel]))).toBe('ok')
    // `INVOKED` is sorted by channel name, so the manager is reached in that order.
    const ref = { folder: REPO, id: 'chat_1' }
    expect(state.calls.map(call => [call[0], call[1]])).toEqual([
      ['answer', ref], ['attention', REPO], ['interrupt', ref], ['chatModels', ref], ['send', ref], ['setModel', ref], ['setSurface', ref], ['snapshot', ref], ['start', ref]
    ])
  })

  it('registers agentChat:attention behind the guard and answers the folder’s items or a project-less list', async () => {
    const state = rig()
    expect(state.listeners.has(AGENT_CHAT_CHANNELS.attention)).toBe(true)
    const item = { chatId: 'chat_1', promptId: 'p1', kind: 'approval', threadId: null, callsign: null, arbitration: 'escalated', title: 'Run', shown: true }
    vi.mocked(state.sessions.attention).mockReturnValueOnce([item as never])
    expect(await state.invoke(AGENT_CHAT_CHANNELS.attention, { folder: REPO })).toEqual({ ok: true, data: [item] })
    expect(await state.invoke(AGENT_CHAT_CHANNELS.attention, { folder: null })).toEqual({ ok: true, data: [] })
    // The one-shot return stands in for the recording implementation, so the mock's own calls are the record.
    expect(vi.mocked(state.sessions.attention).mock.calls).toEqual([[REPO], [null]])
    const untrusted = { sender: {}, senderFrame: frame('https://example.com/') } as unknown as IpcMainInvokeEvent
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.attention, { folder: REPO }, untrusted))).toBe('unauthorized')
    expect(state.refused).toEqual([AGENT_CHAT_CHANNELS.attention])
  })

  it('refuses agentChat:attention for an unknown folder before reaching the session manager', async () => {
    const state = rig()
    for (const folder of ['/elsewhere', '/work/repo/../other']) {
      expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.attention, { folder }))).toBe('unauthorized')
    }
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.attention, { folder: REPO, chatId: 'chat_1' }))).toBe('invalid_input')
    expect(state.calls).toEqual([])
  })
})

describe('agent chat models IPC', () => {
  it('serves agentChat:models for a chat or, before one starts, an agent, passing only refresh', async () => {
    const state = rig()
    expect(await state.invoke(AGENT_CHAT_CHANNELS.models, { folder: null, chatId: 'chat_1', refresh: true })).toEqual({ ok: true, data: [] })
    expect(await state.invoke(AGENT_CHAT_CHANNELS.models, { folder: REPO, agentId: 'omp' })).toEqual({ ok: true, data: [] })
    expect(state.calls).toEqual([['chatModels', { folder: null, id: 'chat_1' }, { refresh: true }], ['catalogModels', 'omp', { refresh: false }]])
  })

  it('refuses an agentChat:models request naming both a chat and an agent, neither, or an untracked folder', async () => {
    const state = rig()
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.models, { folder: REPO, chatId: 'chat_1', agentId: 'omp' }))).toBe('invalid_input')
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.models, { folder: REPO }))).toBe('invalid_input')
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.models, { folder: REPO, agentId: '../omp' }))).toBe('invalid_input')
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.models, { folder: '/elsewhere', agentId: 'omp' }))).toBe('unauthorized')
    expect(state.calls).toEqual([])
  })
})

describe('agent chat setModel IPC', () => {
  it('passes the chat, the choice and a loader of the chat’s own catalog to the session manager', async () => {
    const state = rig()
    expect(await state.invoke(AGENT_CHAT_CHANNELS.setModel, { folder: REPO, chatId: 'chat_1', provider: 'openai-codex', modelId: 'gpt-6-sol', effort: 'medium' })).toEqual({ ok: true, data: SNAPSHOT })
    expect(await state.invoke(AGENT_CHAT_CHANNELS.setModel, { folder: null, chatId: 'chat_1', provider: 'anthropic', modelId: 'claude-opus-5-5' })).toEqual({ ok: true, data: SNAPSHOT })
    const [first, second] = state.calls
    expect(first.slice(0, 3)).toEqual(['setModel', { folder: REPO, id: 'chat_1' }, { provider: 'openai-codex', modelId: 'gpt-6-sol', effort: 'medium' }])
    expect(second.slice(0, 3)).toEqual(['setModel', { folder: null, id: 'chat_1' }, { provider: 'anthropic', modelId: 'claude-opus-5-5' }])
    // The loader is the chat's catalog, asked only when the session manager calls it.
    expect(state.calls).toHaveLength(2)
    await (first[3] as () => Promise<unknown>)()
    expect(state.calls.at(-1)).toEqual(['chatModels', { folder: REPO, id: 'chat_1' }])
  })

  it('refuses an unknown effort, a missing model, an extra field or an untracked folder before reaching the session manager', async () => {
    const state = rig(), base = { folder: REPO, chatId: 'chat_1', provider: 'openai-codex', modelId: 'gpt-6-sol' }
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.setModel, { ...base, effort: 'turbo' }))).toBe('invalid_input')
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.setModel, { ...base, modelId: '' }))).toBe('invalid_input')
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.setModel, { ...base, executable: 'omp.exe' }))).toBe('invalid_input')
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.setModel, { ...base, folder: '/elsewhere' }))).toBe('unauthorized')
    expect(state.calls).toEqual([])
  })
})

describe('agent chat IPC behind the sender guard', () => {
  for (const [label, event] of [
    ['another page', { sender: {}, senderFrame: frame('https://example.com/') }],
    ['a subframe of the app page', { sender: {}, senderFrame: frame(`${APP_URL}/`, {}) }],
    ['no frame', { sender: {}, senderFrame: null }]
  ] as const) it(`answers unauthorized to ${label} and never reaches a handler`, async () => {
    const state = rig()
    for (const channel of INVOKED) expect(codeOf(await state.invoke(channel, REQUESTS[channel], event as unknown as IpcMainInvokeEvent))).toBe('unauthorized')
    expect(state.calls).toEqual([])
    expect(state.confirmTerminalStop).not.toHaveBeenCalled()
    expect(state.refused.sort()).toEqual(INVOKED)
  })
})

describe('agent chat IPC requests a renderer cannot shape', () => {
  it('refuses unknown keys on every channel, including launch fields and a confirmation', async () => {
    const state = rig()
    for (const channel of INVOKED) {
      for (const extra of [{ executable: '/bin/sh' }, { args: ['-c'] }, { cwd: '/' }, { env: { A: '1' } }, { confirmed: true }, { force: true }]) {
        expect(codeOf(await state.invoke(channel, { ...REQUESTS[channel], ...extra }))).toBe('invalid_input')
      }
    }
    expect(state.calls).toEqual([])
    expect(state.confirmTerminalStop).not.toHaveBeenCalled()
  })

  it('refuses a missing or malformed payload', async () => {
    const state = rig()
    for (const channel of INVOKED) {
      expect(codeOf(await state.invoke(channel, undefined))).toBe('invalid_input')
      expect(codeOf(await state.invoke(channel, { ...REQUESTS[channel], chatId: '../escape' }))).toBe('invalid_input')
    }
    expect(state.calls).toEqual([])
  })

  it('refuses a folder outside the registry before reaching the session manager', async () => {
    const state = rig()
    for (const channel of INVOKED) expect(codeOf(await state.invoke(channel, { ...REQUESTS[channel], folder: '/elsewhere' }))).toBe('unauthorized')
    expect(state.calls).toEqual([])
  })

  it('passes a project-less chat with a null folder', async () => {
    const state = rig()
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.snapshot, { folder: null, chatId: 'chat_1' }))).toBe('ok')
    expect(state.calls).toEqual([['snapshot', { folder: null, id: 'chat_1' }]])
  })

  it('passes setSurface the Main-owned confirmation for this request’s sender only', async () => {
    const state = rig()
    const sender = { id: 'requesting window' }
    await state.invoke(AGENT_CHAT_CHANNELS.setSurface, REQUESTS[AGENT_CHAT_CHANNELS.setSurface], { ...TRUSTED, sender } as unknown as IpcMainInvokeEvent)
    const confirm = state.calls[0][3] as (chat: unknown) => Promise<boolean>
    expect(state.calls[0].slice(0, 3)).toEqual(['setSurface', { folder: REPO, id: 'chat_1' }, 'gui'])
    await confirm({ id: 'chat_1' })
    expect(state.confirmTerminalStop).toHaveBeenCalledExactlyOnceWith(sender, { id: 'chat_1' })
  })

  it('answers a GUI start refused for a live terminal as busy_elsewhere', async () => {
    const state = rig()
    vi.mocked(state.sessions.start).mockResolvedValueOnce({ code: 'busy_elsewhere' })
    expect(codeOf(await state.invoke(AGENT_CHAT_CHANNELS.start, REQUESTS[AGENT_CHAT_CHANNELS.start]))).toBe('busy_elsewhere')
  })
})

describe('agent chat push', () => {
  function window(): ChatWindow & { sent: unknown[][] } {
    const sent: unknown[][] = []
    return { sent, isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, ...args) => { sent.push([channel, ...args]) } } }
  }

  it('sends validated events on agentChat:event and drops anything else', () => {
    const open = window()
    const push = createAgentChatPush(() => [open])
    const event: AgentChatEvent = { type: 'status', folder: REPO, chatId: 'chat_1', status: 'idle' }
    push(event)
    push({ ...event, raw: '{"type":"system"}' } as unknown as AgentChatEvent)
    push({ type: 'line', folder: REPO, chatId: 'chat_1', text: 'raw CLI line' } as unknown as AgentChatEvent)
    expect(open.sent).toEqual([[AGENT_CHAT_CHANNELS.event, event]])
  })
})
