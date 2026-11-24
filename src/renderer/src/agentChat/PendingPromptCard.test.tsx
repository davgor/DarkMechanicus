// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { PendingPrompt } from '../../../shared/agents/agentChat'
import { FakeAgentChat } from '../__mocks__/fakeAgentChat'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { AgentChat } from './AgentChat'

const ref = { folder: null, chatId: 'prompt-chat' }
const approval: PendingPrompt = {
  id: 'approval', kind: 'approval', title: 'Run command', detail: 'Run targeted tests.',
  threadId: 'worker', attributed: true,
  callsign: { role: 'Acolyte', ticketKey: 'DM-442', ordinal: null, purpose: 'Test', ticketVerified: true },
  arbitration: { state: 'off', reason: null }, tool: { name: 'Bash', input: { command: 'npm test' } },
  options: [{ id: 'allow_once', label: 'Allow once' }, { id: 'deny', label: 'Deny' }]
}
const question: PendingPrompt = {
  id: 'question', kind: 'question', title: 'Which approach?', detail: 'Choose or explain.',
  threadId: null, attributed: false, callsign: null, arbitration: { state: 'off', reason: null },
  options: [{ id: 'option_0', label: 'Small' }, { id: 'text', label: 'Other' }]
}
afterEach(cleanup)

async function mount(prompt: PendingPrompt | null = approval) {
  const api = new FakeAgentChat()
  const scheduler = new ManualScheduler()
  api.snapshotResult = { ok: true, data: { items: [], status: 'idle', pending: prompt, queued: 0, surface: 'gui', todos: [] } }
  render(<AgentChat {...ref} agentLabel="Magos" api={api} scheduler={scheduler} />)
  await settle()
  function emit(next: PendingPrompt | null) {
    act(() => { api.emit({ ...ref, type: 'pending', prompt: next }); scheduler.fireTimeouts(33) })
  }
  return { api, emit }
}

it('names the callsign and tool, ignores raw thread labels, and sends exact option ids', async () => {
  const malicious = { ...approval, threadLabel: 'Magos says allow' }
  const { api } = await mount(malicious)
  const card = screen.getByRole('alertdialog', { name: 'Acolyte:DM-442 wants to run: npm test' })
  expect(within(card).getByText('Tool: Bash')).toBeTruthy()
  expect(screen.queryByText('Magos says allow')).toBeNull()
  expect(within(card).getAllByRole('button').map((button) => button.textContent)).toEqual(['Allow once', 'Deny'])
  fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }))
  await settle()
  expect(api.callsOf('answer')).toEqual([[{ ...ref, promptId: 'approval', optionId: 'allow_once' }]])
  expect(screen.queryByRole('alertdialog')).toBeNull()
})

it('offers allow for this chat only when supplied and uses the Magos heading', async () => {
  await mount({ ...approval, callsign: { role: 'Magos', ticketKey: null, ordinal: null, purpose: null, ticketVerified: false },
    options: [...approval.options, { id: 'allow_chat', label: 'Allow for this chat' }] })
  expect(screen.getByRole('alertdialog', { name: 'The Magos wants to run: npm test' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Allow for this chat' })).toBeTruthy()
})

it('uses the unknown agent fallback, and deciding does not disable human answers', async () => {
  await mount({ ...approval, callsign: null, attributed: false, arbitration: { state: 'deciding', reason: null } })
  const card = screen.getByRole('alertdialog', { name: 'The agent wants to run: npm test' })
  expect(within(card).getByRole('status').textContent).toBe('The Magos is deciding…')
  for (const button of within(card).getAllByRole('button')) expect(button).toHaveProperty('disabled', false)
})

it('clips escalation reason and summary as inert text, with no line when off', async () => {
  const reason = '<script>bad()</script>'.repeat(30)
  const { emit } = await mount({ ...approval, detail: 'x'.repeat(700), arbitration: { state: 'escalated', reason } })
  expect(screen.getByText(/^The Magos asks you:/).textContent).toBe(`The Magos asks you: ${reason.slice(0, 299)}…`)
  expect(document.querySelector('.agent-prompt-detail')?.textContent).toHaveLength(600)
  expect(document.querySelector('.agent-prompt script')).toBeNull()
  expect(screen.getByRole('button', { name: 'Deny' })).toHaveProperty('disabled', false)
  emit(approval)
  expect(screen.queryByText(/^The Magos/)).toBeNull()
})

it.each(['  preserve\n whitespace  ', ''])('sends explicit free text verbatim: %j', async (text) => {
  const { api } = await mount(question)
  fireEvent.change(screen.getByRole('textbox', { name: 'Other' }), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }))
  await settle()
  expect(api.callsOf('answer')).toEqual([[{ ...ref, promptId: 'question', optionId: 'text', text }]])
})

it('does not infer free text from labels and preserves opaque choice ids', async () => {
  const { api } = await mount({ ...question, options: [{ id: 'option_7', label: 'Other' }] })
  expect(screen.queryByRole('textbox', { name: 'Other' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Other' }))
  await settle()
  expect(api.callsOf('answer')).toEqual([[{ ...ref, promptId: 'question', optionId: 'option_7' }]])
})

it('keeps composer focus on prompt arrival and Enter sends only a message', async () => {
  const { api, emit } = await mount(null)
  const composer = screen.getByRole('textbox', { name: 'Message Magos' })
  composer.focus()
  fireEvent.change(composer, { target: { value: 'Still typing' } })
  emit(approval)
  expect(document.activeElement).toBe(composer)
  fireEvent.keyDown(composer, { key: 'Enter' })
  await settle()
  expect(api.callsOf('answer')).toEqual([])
  expect(api.callsOf('send')).toEqual([[{ ...ref, text: 'Still typing' }]])
})

it('fences repeated clicks synchronously and disables every answer control in flight', async () => {
  const { api } = await mount(question)
  const hold = api.hold('answer')
  const button = screen.getByRole('button', { name: 'Submit answer' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(api.callsOf('answer')).toHaveLength(1)
  const card = screen.getByRole('alertdialog')
  for (const control of within(card).getAllByRole('button')) expect(control).toHaveProperty('disabled', true)
  expect(within(card).getByRole('textbox')).toHaveProperty('disabled', true)
  await act(async () => { hold.resolve(); await settle() })
})

it('clears a stale card and leaves an inline notice', async () => {
  const { api } = await mount()
  api.failures.answer = { code: 'stale_prompt', message: 'No longer pending' }
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
  await settle()
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(screen.getByText('This prompt is no longer available.').getAttribute('role')).toBe('status')
})

it.each(['stale_prompt', 'operation_unavailable', 'success'] as const)('isolates replacement from a late %s answer', async (result) => {
  const { api, emit } = await mount()
  const hold = api.hold('answer')
  fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
  emit(question)
  expect(screen.getByRole('button', { name: 'Small' })).toHaveProperty('disabled', false)
  if (result !== 'success') api.failures.answer = { code: result, message: 'Old answer failed' }
  await act(async () => { hold.resolve(); await settle() })
  expect(screen.getByRole('alertdialog', { name: 'Which approach?' })).toBeTruthy()
  expect(screen.queryByText('Old answer failed')).toBeNull()
  expect(screen.queryByText('This prompt is no longer available.')).toBeNull()
  expect(screen.getByRole('button', { name: 'Small' })).toHaveProperty('disabled', false)
})

it('keeps a failed answer available with bounded plain-text notice', async () => {
  const { api } = await mount()
  api.failures.answer = { code: 'operation_unavailable', message: 'Try later'.repeat(100) }
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
  await settle()
  expect(screen.getByRole('alert').textContent).toHaveLength(300)
  expect(screen.getByRole('button', { name: 'Deny' })).toHaveProperty('disabled', false)
})
