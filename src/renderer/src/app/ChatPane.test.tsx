// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../shared/agents/chat'
import { AppHarness } from '../__mocks__/appHarness'
import { FakeTerminals } from '../__mocks__/fakeTerminals'
import { agentView, chatRecord, folderView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'

let h: AppHarness
let terminals: FakeTerminals
beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  terminals = new FakeTerminals()
  h.dm.terminals = terminals
  h.dm.folders = [folderView({ path: '/a', name: 'alpha' })]
  h.dm.agents = [agentView({ kind: 'claude' }), agentView({ kind: 'codex' })]
  h.dm.agentStatuses.claude = { state: 'signed_in', reason: '' }
  h.dm.agentStatuses.codex = { state: 'signed_in', reason: '' }
})
afterEach(cleanup)

async function open(folder: string | null, surface?: ChatRecord['surface'], agent = 'claude'): Promise<ChatRecord> {
  const chat = chatRecord({ id: 'chat_surface', title: 'Surface journey', folder, agent, surface, sessionId: 'same-session' })
  h.dm.chats.chats = [chat]
  h.mount()
  await settle()
  const agents = within(screen.getByRole('region', { name: 'Agents' }))
  fireEvent.click(agents.getByRole('button', { name: `Chats of ${agent === 'claude' ? 'Claude Code' : 'Codex'}` }))
  await settle()
  fireEvent.click(agents.getByRole('button', { name: /^Surface journey/ }))
  await settle()
  return chat
}

async function pushSurface(chat: ChatRecord, surface: 'gui' | 'terminal'): Promise<void> {
  await act(async () => {
    h.dm.chats.chats = [{ ...chat, surface }]
    h.dm.chats.emit({ type: 'chats_changed', folder: chat.folder, chatId: chat.id })
  })
  await settle()
}

for (const folder of ['/a', null]) {
  describe(`ChatPane in ${folder ?? 'no project'}`, () => {
    it('opens GUI with the real composer and no terminal attach', async () => {
      await open(folder, 'gui')
      expect(screen.getByRole('textbox', { name: 'Message Claude Code' })).toBeTruthy()
      expect(terminals.calls).toEqual([])
    })

    it.each(['terminal', undefined] as const)('keeps %s records in the terminal', async surface => {
      await open(folder, surface)
      expect(screen.getByTestId('terminal-host')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'GUI' })).toBeTruthy()
      expect(terminals.calls).toEqual([[folder, 'chat_surface']])
    })

    it('switches both ways only after the updated record push, without changing the session', async () => {
      const chat = await open(folder, 'terminal')
      fireEvent.click(screen.getByRole('button', { name: 'GUI' }))
      await settle()
      expect(h.dm.agentChat.callsOf('setSurface')).toEqual([[{ folder, chatId: chat.id, surface: 'gui' }]])
      expect(screen.queryByRole('textbox', { name: 'Message Claude Code' })).toBeNull()
      await pushSurface(chat, 'gui')
      expect(screen.getByRole('textbox', { name: 'Message Claude Code' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
      await settle()
      expect(screen.getByRole('textbox', { name: 'Message Claude Code' })).toBeTruthy()
      expect(h.dm.agentChat.callsOf('setSurface')[1]).toEqual([{ folder, chatId: chat.id, surface: 'terminal' }])
      await pushSurface(chat, 'terminal')
      expect(screen.getByTestId('terminal-host')).toBeTruthy()
      expect(h.dm.chats.chats[0].sessionId).toBe('same-session')
    })

    it.each(['busy', 'unsupported_capability'] as const)('keeps terminal and GUI panes on a %s refusal', async code => {
      const chat = await open(folder, 'terminal')
      h.dm.agentChat.failures.setSurface = { code, message: `Cannot switch: ${code}.` }
      fireEvent.click(screen.getByRole('button', { name: 'GUI' }))
      await settle()
      expect(screen.getByRole('alert').textContent).toContain(code)
      expect(screen.getByTestId('terminal-host')).toBeTruthy()
      await pushSurface(chat, 'gui')
      fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
      await settle()
      expect(screen.getByRole('alert').textContent).toContain(code)
      expect(screen.getByRole('textbox', { name: 'Message Claude Code' })).toBeTruthy()
      expect((screen.getByRole('textbox', { name: 'Message Claude Code' }) as HTMLTextAreaElement).disabled).toBe(false)
      expect(screen.getByText('idle', { selector: '.agent-chat-status' })).toBeTruthy()
    })

    it('does not offer GUI for unsupported agent kinds', async () => {
      await open(folder, 'terminal', 'codex')
      expect(screen.getByTestId('terminal-host')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'GUI' })).toBeNull()
    })
  })
}
