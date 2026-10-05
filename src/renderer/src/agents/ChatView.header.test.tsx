// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { chatRecord } from '../__mocks__/fixtures'
import { CHAT, mountChatView, REF, transcript } from '../__mocks__/chatViewKit'
import { settle } from '../__mocks__/settle'

afterEach(cleanup)

const modelPicker = (): HTMLSelectElement => screen.getByRole('combobox', { name: 'Model' })

describe('ChatView header', () => {
  it('names the chat with its agent, role and whether it may save plans', async () => {
    await mountChatView([])
    expect(screen.getByRole('heading', { level: 1, name: 'Fix the build' })).toBeTruthy()
    const facts = within(screen.getByRole('list', { name: 'Chat details' }))
    expect(facts.getByText('Claude Code')).toBeTruthy()
    expect(facts.getByText('Orchestrator')).toBeTruthy()
    expect(facts.getByText('Allowed to save plans')).toBeTruthy()
  })

  it('says a worker, or a planner that was not allowed to, does not save plans', async () => {
    await mountChatView([], { chat: chatRecord({ ...CHAT, role: 'worker', allowSave: false }) })
    expect(screen.getByText('Worker')).toBeTruthy()
    expect(screen.getByText('Does not save plans')).toBeTruthy()
  })

  it('shows the turn running next to the title', async () => {
    const { dm } = await mountChatView([])
    expect(screen.queryByText('Answering')).toBeNull()
    act(() => dm.chats.emit({ type: 'turn', chatId: 'chat_1', running: true }))
    expect(screen.getByText('Answering')).toBeTruthy()
    act(() => dm.chats.finishTurn('chat_1'))
    expect(screen.queryByText('Answering')).toBeNull()
  })
})

describe('ChatView model picker', () => {
  it('offers the agent’s models with the chat’s own selected', async () => {
    await mountChatView([])
    expect(modelPicker().value).toBe('opus')
    expect([...modelPicker().options].map((option) => option.text)).toEqual(['Opus', 'Sonnet'])
  })

  it('calls chats:setModel, keeps the new choice and shows the model change as a notice', async () => {
    const { dm } = await mountChatView([])
    fireEvent.change(modelPicker(), { target: { value: 'sonnet' } })
    await settle()
    expect(dm.chats.callsOf('setModel')).toEqual([[{ ...REF, model: 'sonnet' }]])
    expect(modelPicker().value).toBe('sonnet')
    expect(transcript().getByText('Model changed from Opus to Sonnet. It takes effect from the next turn.')).toBeTruthy()
  })

  it('can be switched while a turn runs, since it applies from the next one', async () => {
    const { dm } = await mountChatView([], { running: true })
    expect(modelPicker().disabled).toBe(false)
    fireEvent.change(modelPicker(), { target: { value: 'sonnet' } })
    await settle()
    expect(dm.chats.callsOf('setModel')).toHaveLength(1)
  })

  it('says why a switch failed and goes back to the model the chat runs on', async () => {
    const { dm } = await mountChatView([])
    dm.chats.failures.setModel = { code: 'internal', message: 'The agent refused the model.' }
    fireEvent.change(modelPicker(), { target: { value: 'sonnet' } })
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('The agent refused the model.')
    expect(modelPicker().value).toBe('opus')
  })

  it('has no control to change the agent: it is text, and the model is the only choice', async () => {
    await mountChatView([])
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
    expect(screen.queryByRole('combobox', { name: /agent/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /agent|change|switch/i })).toBeNull()
    expect(within(screen.getByRole('list', { name: 'Chat details' })).getByText('Claude Code').closest('select, button, input')).toBeNull()
  })

  it('shows a chat on the default model as such, without letting that be picked again', async () => {
    await mountChatView([], { chat: chatRecord({ ...CHAT, model: null }) })
    expect(modelPicker().value).toBe('')
    const placeholder = [...modelPicker().options].find((option) => option.value === '')
    expect(placeholder?.text).toBe('Default model')
    expect(placeholder?.disabled).toBe(true)
  })

  it('shows the model as text when the agent’s models cannot be listed', async () => {
    await mountChatView([], { modelsFail: { code: 'internal', message: 'No list.' } })
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(within(screen.getByRole('list', { name: 'Chat details' })).getByText('opus')).toBeTruthy()
  })
})
