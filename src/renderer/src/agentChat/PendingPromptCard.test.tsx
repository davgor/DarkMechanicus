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
type QuestionPrompt = Extract<PendingPrompt, { kind: 'question' }>
const question: QuestionPrompt = {
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

const multi: QuestionPrompt = {
  id: 'multi-1', kind: 'question', title: 'Which checks should run?', detail: '', threadId: null, attributed: false, callsign: null,
  arbitration: { state: 'off', reason: null }, multi: true, progress: { index: 1, total: 2 },
  options: [
    { id: 'A', label: 'Lint', description: 'ESLint over the tree' }, { id: 'B', label: 'Typecheck' },
    { id: 'C', label: 'Unit tests' }, { id: 'D', label: 'Build' }
  ]
}
const checkbox = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name}`) }) as HTMLInputElement
const submitButton = () => screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement

it('renders a multi question as labelled checkboxes in a fieldset with its question as the legend', async () => {
  await mount(multi)
  const card = screen.getByRole('alertdialog', { name: 'Which checks should run?' })
  expect(card.classList.contains('glass-strong')).toBe(true)
  const group = within(card).getByRole('group', { name: 'Which checks should run?' })
  expect(group.tagName).toBe('FIELDSET')
  expect(within(group).getAllByRole('checkbox').map((box) => box.closest('label')?.textContent))
    .toEqual(['LintESLint over the tree', 'Typecheck', 'Unit tests', 'Build'])
  expect(within(group).getAllByRole('checkbox').every((box) => !(box as HTMLInputElement).checked)).toBe(true)
  expect(within(card).queryByRole('textbox')).toBeNull()
  expect(screen.getByText('0 selected')).toBeTruthy()
  expect(submitButton().disabled).toBe(true)
})

it('counts checked options, enables Submit, and keeps zero selected disabled', async () => {
  const { api } = await mount(multi)
  fireEvent.click(checkbox('Unit tests'))
  fireEvent.click(checkbox('Lint'))
  expect(checkbox('Lint').checked).toBe(true)
  expect(screen.getByText('2 selected')).toBeTruthy()
  expect(submitButton().disabled).toBe(false)
  fireEvent.click(checkbox('Lint'))
  fireEvent.click(checkbox('Unit tests'))
  expect(screen.getByText('0 selected')).toBeTruthy()
  expect(submitButton().disabled).toBe(true)
  fireEvent.submit(submitButton().closest('form') as HTMLFormElement)
  await settle()
  expect(api.callsOf('answer')).toEqual([])
})

it('submits once with the checked ids in option order and disables the card while pending', async () => {
  const { api } = await mount(multi)
  fireEvent.click(checkbox('Unit tests'))
  fireEvent.click(checkbox('Lint'))
  const hold = api.hold('answer')
  fireEvent.click(submitButton())
  fireEvent.click(submitButton())
  expect(api.callsOf('answer')).toEqual([[{ ...ref, promptId: 'multi-1', optionIds: ['A', 'C'] }]])
  const card = screen.getByRole('alertdialog')
  expect(card.getAttribute('aria-busy')).toBe('true')
  expect(within(card).getByRole('group')).toHaveProperty('disabled', true)
  for (const box of within(card).getAllByRole('checkbox')) expect(box.matches(':disabled')).toBe(true)
  expect(submitButton().matches(':disabled')).toBe(true)
  await act(async () => { hold.resolve(); await settle() })
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(screen.getByText('Answer sent.')).toBeTruthy()
})

it('includes nonblank Other text as the text option in option order', async () => {
  const { api } = await mount({ ...multi, options: [...multi.options.slice(0, 2), { id: 'text', label: 'Other' }, ...multi.options.slice(2)] })
  const other = screen.getByRole('textbox', { name: 'Other' })
  fireEvent.change(other, { target: { value: '   ' } })
  expect(submitButton().disabled).toBe(true)
  fireEvent.change(other, { target: { value: ' Smoke run ' } })
  expect(screen.getByText('1 selected')).toBeTruthy()
  fireEvent.click(checkbox('Build'))
  fireEvent.click(checkbox('Lint'))
  fireEvent.click(submitButton())
  await settle()
  expect(api.callsOf('answer')).toEqual([[{ ...ref, promptId: 'multi-1', optionIds: ['A', 'text', 'D'], text: ' Smoke run ' }]])
})

it('keeps the selection and shows the error inline when the answer fails', async () => {
  const { api } = await mount(multi)
  fireEvent.click(checkbox('Lint'))
  fireEvent.click(checkbox('Unit tests'))
  api.failures.answer = { code: 'operation_unavailable', message: 'The CLI is busy' }
  fireEvent.click(submitButton())
  await settle()
  expect(screen.getByRole('alert').textContent).toBe('The CLI is busy')
  expect([checkbox('Lint').checked, checkbox('Typecheck').checked, checkbox('Unit tests').checked]).toEqual([true, false, true])
  expect(screen.getByText('2 selected')).toBeTruthy()
  expect(submitButton().disabled).toBe(false)
  delete api.failures.answer
  fireEvent.click(submitButton())
  await settle()
  expect(api.callsOf('answer')).toEqual([
    [{ ...ref, promptId: 'multi-1', optionIds: ['A', 'C'] }], [{ ...ref, promptId: 'multi-1', optionIds: ['A', 'C'] }]
  ])
})

it('keeps one-click answers for a single question and shows its progress', async () => {
  const { api } = await mount({ ...question, progress: { index: 2, total: 3 } })
  expect(screen.getByText('Question 2 of 3').closest('.agent-prompt-submit')).toBeNull()
  expect(screen.queryByRole('checkbox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Small' }))
  await settle()
  expect(api.callsOf('answer')).toEqual([[{ ...ref, promptId: 'question', optionId: 'option_0' }]])
})

it('shows the next question of an ask as a new step with nothing checked', async () => {
  const { emit } = await mount(multi)
  // A multi question's progress shares the Submit row, so the docked card's height goes to its options.
  expect([...submitButton().parentElement!.children].map((child) => child.textContent)).toEqual(['Question 1 of 2', '0 selected', 'Submit'])
  fireEvent.click(checkbox('Lint'))
  fireEvent.click(checkbox('Build'))
  emit({ ...multi, id: 'multi-2', title: 'Which targets?', progress: { index: 2, total: 2 } })
  expect(screen.getByRole('alertdialog', { name: 'Which targets?' })).toBeTruthy()
  expect(screen.getByText('Question 2 of 2')).toBeTruthy()
  expect(screen.queryByText('Question 1 of 2')).toBeNull()
  expect(screen.getAllByRole('checkbox').some((box) => (box as HTMLInputElement).checked)).toBe(false)
  expect(screen.getByText('0 selected')).toBeTruthy()
  expect(submitButton().disabled).toBe(true)
})
