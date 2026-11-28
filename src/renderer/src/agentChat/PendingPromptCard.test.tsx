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

const form: QuestionPrompt = {
  id: 'form-1', kind: 'question', title: 'Answer 3 questions', detail: '', threadId: null, attributed: false, callsign: null,
  arbitration: { state: 'off', reason: null }, options: [],
  form: { fields: [
    { id: 'letters', title: 'Which letters?', multi: true, text: 'none', options: [
      { id: 'A', label: 'Alpha', preselected: true }, { id: 'B', label: 'Bravo', description: 'Second letter' },
      { id: 'C', label: 'Charlie', preselected: true }, { id: 'D', label: 'Delta' }
    ] },
    { id: 'region', title: 'Which region?', multi: false, text: 'other', options: [
      { id: 'X', label: 'EU', preselected: true }, { id: 'Y', label: 'US' }, { id: 'Z', label: 'APAC' }
    ] },
    { id: 'note', title: 'Anything else?', multi: false, text: 'only', options: [] }
  ] }
}
/** A form field's group by its question; an optional field's legend adds " (optional)". */
const group = (name: string) => screen.getByRole('group', { name: (accessible) => accessible.replace(/\s*\(optional\)$/, '') === name })
const checkedIn = (name: string) => [...group(name).querySelectorAll<HTMLInputElement>('input:checked')]
  .map((input) => input.closest('label')?.querySelector('.agent-prompt-check-label')?.textContent)
const control = (field: string, role: 'checkbox' | 'radio', name: string) =>
  within(group(field)).getByRole(role, { name: new RegExp(`^${name}`) }) as HTMLInputElement

it('shows every question of a form at once, each a fieldset with its legend, the defaults checked and Submit enabled', async () => {
  await mount(form)
  const card = screen.getByRole('alertdialog', { name: 'Answer 3 questions' })
  expect(card.classList.contains('glass-strong')).toBe(true)
  expect(within(card).getByRole('heading').textContent).toBe('Answer 3 questions')
  expect(within(card).getAllByRole('group').map((fieldset) => [fieldset.tagName, fieldset.querySelector('legend')?.textContent]))
    .toEqual([['FIELDSET', 'Which letters? (optional)'], ['FIELDSET', 'Which region?'], ['FIELDSET', 'Anything else? (optional)']])
  expect(within(group('Which letters?')).getAllByRole('checkbox')).toHaveLength(4)
  expect(checkedIn('Which letters?')).toEqual(['Alpha', 'Charlie'])
  expect(within(group('Which region?')).getAllByRole('radio').map((radio) => radio.closest('label')?.textContent)).toEqual(['EU', 'US', 'APAC', 'Other'])
  expect(checkedIn('Which region?')).toEqual(['EU'])
  expect((within(group('Anything else?')).getByRole('textbox', { name: 'Anything else?' }) as HTMLTextAreaElement).value).toBe('')
  expect(screen.getByText('3 of 3 answered')).toBeTruthy()
  expect(within(card).getAllByRole('button').map((button) => button.textContent)).toEqual(['Submit'])
  expect(submitButton().disabled).toBe(false)
  expect(screen.queryByText(/Question \d of \d/)).toBeNull()
})

it('toggles checkboxes on the box and on the label, switches radios, and sends every field once with one Submit', async () => {
  const { api } = await mount(form)
  fireEvent.click(control('Which letters?', 'checkbox', 'Charlie'))
  fireEvent.click(within(group('Which letters?')).getByText('Bravo'))
  expect(checkedIn('Which letters?')).toEqual(['Alpha', 'Bravo'])
  fireEvent.click(control('Which region?', 'radio', 'US'))
  expect(checkedIn('Which region?')).toEqual(['US'])
  fireEvent.change(screen.getByRole('textbox', { name: 'Anything else?' }), { target: { value: 'note' } })
  fireEvent.click(submitButton())
  fireEvent.click(submitButton())
  await settle()
  expect(api.callsOf('answer')).toEqual([[{ ...ref, promptId: 'form-1', fields: [
    { fieldId: 'letters', optionIds: ['A', 'B'] }, { fieldId: 'region', optionIds: ['Y'] }, { fieldId: 'note', optionIds: [], text: 'note' }
  ] }]])
  expect(screen.getByText('Answer sent.')).toBeTruthy()
})

it('sends the untouched defaults, keeping a text field default by leaving its text out', async () => {
  const withDefault = { ...form, form: { fields: [...form.form!.fields.slice(0, 2), { ...form.form!.fields[2], defaultText: 'No' }] } }
  const { api } = await mount(withDefault)
  expect((screen.getByRole('textbox', { name: 'Anything else?' }) as HTMLTextAreaElement).value).toBe('No')
  fireEvent.click(submitButton())
  await settle()
  expect(api.callsOf('answer')).toEqual([[{ ...ref, promptId: 'form-1', fields: [
    { fieldId: 'letters', optionIds: ['A', 'C'] }, { fieldId: 'region', optionIds: ['X'] }, { fieldId: 'note', optionIds: [] }
  ] }]])
})

it('waits for an answer to every required field: an empty required group, no radio, or Other without text keep Submit disabled', async () => {
  const required = { ...form, form: { fields: [{ ...form.form!.fields[0], required: true }, ...form.form!.fields.slice(1)] } }
  const { api } = await mount(required)
  expect(group('Which letters?').querySelector('legend')?.textContent).toBe('Which letters?')
  fireEvent.click(control('Which letters?', 'checkbox', 'Alpha'))
  fireEvent.click(control('Which letters?', 'checkbox', 'Charlie'))
  expect(screen.getByText('2 of 3 answered')).toBeTruthy()
  expect(submitButton().disabled).toBe(true)
  fireEvent.click(control('Which letters?', 'checkbox', 'Delta'))
  fireEvent.click(control('Which region?', 'radio', 'Other'))
  expect(checkedIn('Which region?')).toEqual(['Other'])
  expect(submitButton().disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: 'Other answer' }), { target: { value: '  ' } })
  expect(submitButton().disabled).toBe(true)
  fireEvent.submit(submitButton().closest('form') as HTMLFormElement)
  await settle()
  expect(api.callsOf('answer')).toEqual([])
})

it('sends an optional checkbox group empty once every box is unticked, and an optional single choice with no pick', async () => {
  const region = { ...form.form!.fields[1], required: false, options: form.form!.fields[1].options.map(({ id, label }) => ({ id, label })) }
  const { api } = await mount({ ...form, form: { fields: [form.form!.fields[0], region, form.form!.fields[2]] } })
  expect(group('Which region?').querySelector('legend')?.textContent).toBe('Which region? (optional)')
  fireEvent.click(control('Which letters?', 'checkbox', 'Alpha'))
  fireEvent.click(control('Which letters?', 'checkbox', 'Charlie'))
  expect(checkedIn('Which letters?')).toEqual([])
  expect(screen.getByText('3 of 3 answered')).toBeTruthy()
  expect(submitButton().disabled).toBe(false)
  fireEvent.click(submitButton())
  await settle()
  expect(api.callsOf('answer')).toEqual([[{ ...ref, promptId: 'form-1', fields: [
    { fieldId: 'letters', optionIds: [] }, { fieldId: 'region', optionIds: [] }, { fieldId: 'note', optionIds: [] }
  ] }]])
})

it('keeps a required text field from going blank', async () => {
  const note = { ...form.form!.fields[2], required: true, defaultText: 'No' }
  await mount({ ...form, form: { fields: [...form.form!.fields.slice(0, 2), note] } })
  expect(group('Anything else?').querySelector('legend')?.textContent).toBe('Anything else?')
  expect(submitButton().disabled).toBe(false)
  fireEvent.change(screen.getByRole('textbox', { name: 'Anything else?' }), { target: { value: '  ' } })
  expect(screen.getByText('2 of 3 answered')).toBeTruthy()
  expect(submitButton().disabled).toBe(true)
})

it('keeps Submit disabled until a single choice without a default gets its pick', async () => {
  const region = form.form!.fields[1]
  await mount({ ...form, form: { fields: [{ ...region, options: region.options.map(({ id, label }) => ({ id, label })) }] } })
  expect(checkedIn('Which region?')).toEqual([])
  expect(screen.getByText('0 of 1 answered')).toBeTruthy()
  expect(submitButton().disabled).toBe(true)
  fireEvent.click(control('Which region?', 'radio', 'APAC'))
  expect(submitButton().disabled).toBe(false)
})

it('sends Other text in place of a radio pick, and beside checked options in a checkbox group', async () => {
  const withOther = { ...form, form: { fields: [{ ...form.form!.fields[0], text: 'other' as const }, ...form.form!.fields.slice(1)] } }
  const { api } = await mount(withOther)
  fireEvent.change(within(group('Which letters?')).getByRole('textbox', { name: 'Other' }), { target: { value: ' Echo ' } })
  fireEvent.change(within(group('Which region?')).getByRole('textbox', { name: 'Other answer' }), { target: { value: 'Mars' } })
  // Typing the other answer picks Other.
  expect(checkedIn('Which region?')).toEqual(['Other'])
  fireEvent.click(submitButton())
  await settle()
  expect(api.callsOf('answer')).toEqual([[{ ...ref, promptId: 'form-1', fields: [
    { fieldId: 'letters', optionIds: ['A', 'C'], text: ' Echo ' }, { fieldId: 'region', optionIds: [], text: 'Mars' }, { fieldId: 'note', optionIds: [] }
  ] }]])
})

it('disables every control while the answer is in flight', async () => {
  const { api } = await mount(form)
  const hold = api.hold('answer')
  fireEvent.click(submitButton())
  const card = screen.getByRole('alertdialog')
  expect(card.getAttribute('aria-busy')).toBe('true')
  const inputs = [...card.querySelectorAll('input, textarea')]
  // Four checkboxes, four radios (Other among them), Other's answer and the text field.
  expect(inputs).toHaveLength(10)
  for (const input of inputs) expect(input.matches(':disabled')).toBe(true)
  expect(submitButton().disabled).toBe(true)
  await act(async () => { hold.resolve(); await settle() })
  expect(api.callsOf('answer')).toHaveLength(1)
})

it('keeps every selection and text and shows the error inline when the answer fails, then resends the same fields', async () => {
  const { api } = await mount(form)
  fireEvent.click(control('Which letters?', 'checkbox', 'Delta'))
  fireEvent.click(control('Which region?', 'radio', 'APAC'))
  fireEvent.change(screen.getByRole('textbox', { name: 'Anything else?' }), { target: { value: 'kept' } })
  api.failures.answer = { code: 'invalid_input', message: 'The answer does not fit the form' }
  fireEvent.click(submitButton())
  await settle()
  expect(screen.getByRole('alert').textContent).toBe('The answer does not fit the form')
  expect(checkedIn('Which letters?')).toEqual(['Alpha', 'Charlie', 'Delta'])
  expect(checkedIn('Which region?')).toEqual(['APAC'])
  expect((screen.getByRole('textbox', { name: 'Anything else?' }) as HTMLTextAreaElement).value).toBe('kept')
  expect(submitButton().disabled).toBe(false)
  delete api.failures.answer
  fireEvent.click(submitButton())
  await settle()
  const fields = [{ fieldId: 'letters', optionIds: ['A', 'C', 'D'] }, { fieldId: 'region', optionIds: ['Z'] }, { fieldId: 'note', optionIds: [], text: 'kept' }]
  expect(api.callsOf('answer')).toEqual([[{ ...ref, promptId: 'form-1', fields }], [{ ...ref, promptId: 'form-1', fields }]])
})

it('keeps the drafts while the same prompt updates and resets them only for a new prompt id', async () => {
  const { emit } = await mount(form)
  fireEvent.click(control('Which letters?', 'checkbox', 'Delta'))
  emit({ ...form, arbitration: { state: 'escalated', reason: 'Pick the regions yourself.' } })
  expect(checkedIn('Which letters?')).toEqual(['Alpha', 'Charlie', 'Delta'])
  emit({ ...form, id: 'form-2' })
  expect(checkedIn('Which letters?')).toEqual(['Alpha', 'Charlie'])
})

it('heads a one-question form with its legend alone', async () => {
  await mount({ ...form, title: 'Which region?', form: { fields: [form.form!.fields[1]] } })
  const card = screen.getByRole('alertdialog', { name: 'Which region?' })
  expect(within(card).queryByRole('heading')).toBeNull()
  expect(within(card).getByRole('group', { name: 'Which region?' })).toBeTruthy()
})
