import { describe, expect, it } from 'vitest'
import { createChatHandlers } from './chatHandlers'
import { createChatRecords } from './chatRecords'
import { connectedAgents, memoryChatFs, memoryChatStore, REPO } from './__mocks__/chatFixtures'
import type { ChatPushEvent } from '../../shared/agents/chatApi'
import type { TerminalStart } from '../terminals/terminalSessions'

function rig(paste: () => Promise<TerminalStart>) {
  const store = memoryChatStore(memoryChatFs())
  const records = createChatRecords({ store, agentFor: connectedAgents() })
  const events: ChatPushEvent[] = []
  const errors: unknown[] = []
  const unavailable = (): never => { throw new Error('Not used by prompt submission') }
  const handlers = createChatHandlers({
    registry: { resolve: (path) => path === REPO ? REPO : null },
    agents: { get: connectedAgents() },
    chats: records,
    terminals: { start: unavailable, paste },
    runs: { getEpic: unavailable, queueRun: unavailable },
    transfers: { getEpic: unavailable, getTransfer: unavailable },
    kanban: { play: unavailable, kickBack: unavailable, branch: unavailable },
    push: (event) => events.push(event),
    onUnexpectedError: (error) => errors.push(error)
  })
  const chat = records.createChat({ folder: REPO, agent: 'claude', role: 'planner' })
  return { store, records, events, errors, handlers, chat, request: { folder: REPO, chatId: chat.id, text: 'Explain the failing build' } }
}

describe('app-owned prompt naming boundary', () => {
  it('lets a manual rename win while starting the terminal is still in flight', async () => {
    let finish: (result: TerminalStart) => void = () => {}
    const state = rig(() => new Promise((resolve) => { finish = resolve }))
    const sending = state.handlers.submitPrompt(state.request)
    state.records.renameChat(state.chat, 'My investigation')
    finish({ state: 'running', pid: 42 })
    expect(await sending).toEqual({ ok: true, data: { problem: null } })
    expect(state.store.getChat(state.chat)?.title).toBe('My investigation')
    expect(state.events).toEqual([])
  })

  it('does not name a prompt the terminal refuses, and leaves eligibility for a later accepted submission', async () => {
    let result: TerminalStart = { state: 'signed_out', message: 'Sign in first.' }
    const state = rig(async () => result)
    expect(await state.handlers.submitPrompt(state.request)).toEqual({ ok: true, data: { problem: 'Sign in first.' } })
    expect(state.store.getChat(state.chat)?.title).toBe('New chat')
    result = { state: 'running', pid: 42 }
    await state.handlers.submitPrompt(state.request)
    expect(state.store.getChat(state.chat)?.title).toBe('Explain the failing build')
  })

  it('does not turn an already queued prompt into a failed send when naming cannot be persisted', async () => {
    const state = rig(async () => ({ state: 'running', pid: 42 }))
    state.records.nameFromQuestion = () => { throw new Error('Disk full') }
    expect(await state.handlers.submitPrompt(state.request)).toEqual({ ok: true, data: { problem: null } })
    expect(state.errors).toEqual([new Error('Disk full')])
  })
})
