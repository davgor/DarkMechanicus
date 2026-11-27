/**
 * Agent-chat pushes reach every renderer view through one IPC listener, so many open GUI chats never pass the
 * emitter's listener limit. The IPC renderer here is a real Node emitter with the default limit of 10.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { ipcRenderer } from 'electron'
import { AGENT_CHAT_CHANNELS, type AgentChatApi, type AgentChatEvent } from '../shared/agents/agentChat'
import './index'

const exposed = vi.hoisted(() => new Map<string, Record<string, unknown>>())

vi.mock('electron', async () => {
  // The hoisted mock factory runs before module imports bind, so it loads the emitter itself.
  const { EventEmitter } = await import('node:events')
  return {
    contextBridge: { exposeInMainWorld: (key: string, api: Record<string, unknown>) => exposed.set(key, api) },
    ipcRenderer: Object.assign(new EventEmitter(), { invoke: vi.fn() })
  }
})

afterEach(() => vi.restoreAllMocks())

it('holds one IPC listener for every view of 10 GUI chats and the attention view, without a MaxListeners warning', () => {
  const warn = vi.spyOn(process, 'emitWarning')
  const { agentChat } = exposed.get('dm') as { agentChat: AgentChatApi }
  // The pre-fix worst case for 10 chats: one per row, three more for the selected chat, the lead feed and attention.
  const received = Array.from({ length: 15 }, () => [] as AgentChatEvent[])
  const stops = received.map((events) => agentChat.onEvent((event) => events.push(event)))
  expect(ipcRenderer.listenerCount(AGENT_CHAT_CHANNELS.event)).toBe(1)
  const event: AgentChatEvent = { type: 'status', folder: null, chatId: 'chat_1', status: 'idle' }
  ipcRenderer.emit(AGENT_CHAT_CHANNELS.event, {}, event)
  ipcRenderer.emit(AGENT_CHAT_CHANNELS.event, {}, { type: 'not-an-event' })
  for (const events of received) expect(events).toEqual([event])
  stops[0]()
  stops[0]()
  ipcRenderer.emit(AGENT_CHAT_CHANNELS.event, {}, event)
  expect(received[0]).toHaveLength(1)
  expect(received[1]).toHaveLength(2)
  for (const stop of stops.slice(1)) stop()
  expect(ipcRenderer.listenerCount(AGENT_CHAT_CHANNELS.event)).toBe(0)
  expect(warn).not.toHaveBeenCalled()
})
