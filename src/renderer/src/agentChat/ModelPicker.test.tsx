// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentChatModelChoice, AgentChatSnapshot } from '../../../shared/agents/agentChat'
import { chatModelOptions, type ChatModelOption } from '../../../shared/agents/models'
import type { CommandResult } from '../../../shared/desktop/api'
import { FakeAgentChat } from '../__mocks__/fakeAgentChat'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { AgentChat } from './AgentChat'
import { ModelPicker } from './ModelPicker'
import hostCatalog from '../../../main/agentChat/__fixtures__/omp/models.json'

/** The Windows host's catalog (omp 18.20.2): anthropic ×21 and openai-codex ×8. */
const CATALOG = chatModelOptions(hostCatalog)
const ref = { folder: null, chatId: 'fixture-chat' }
const OPUS_HIGH: AgentChatSnapshot = {
  items: [], status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [], model: 'anthropic/claude-opus-5-5', thinking: 'high'
}

afterEach(cleanup)

async function mount({ status = 'idle', skitarii = true }: { status?: AgentChatSnapshot['status']; skitarii?: boolean } = {}) {
  const api = new FakeAgentChat()
  api.snapshotResult = { ok: true, data: { ...OPUS_HIGH, status } }
  api.modelsResult = { ok: true, data: CATALOG }
  render(<AgentChat {...ref} agentLabel="Magos" agentChip="Magos · Skitarii" api={api} scheduler={new ManualScheduler()} skitarii={skitarii} />)
  await settle()
  return api
}

const chip = (): HTMLButtonElement => screen.getByRole('button', { name: /^Model: / })
const chipText = (): string | null | undefined => chip().querySelector('.model-picker-label')?.textContent
const menu = (): HTMLElement => screen.getByRole('menu', { name: 'Model and effort' })
const nameOf = (item: Element): string | null | undefined => item.querySelector('.model-picker-name')?.textContent ?? item.textContent
const names = (group: string): (string | null | undefined)[] =>
  within(within(menu()).getByRole('group', { name: group })).getAllByRole('menuitemradio').map(nameOf)
const model = (name: string): HTMLElement =>
  within(menu()).getAllByRole('menuitemradio').find((item) => item.querySelector('.model-picker-name')?.textContent === name)!
const efforts = (): { label: string | null; checked: string | null }[] =>
  within(within(menu()).getByRole('group', { name: 'Effort' })).getAllByRole('menuitemradio')
    .map((item) => ({ label: item.textContent, checked: item.getAttribute('aria-checked') }))
const effort = (label: string): HTMLElement => within(within(menu()).getByRole('group', { name: 'Effort' })).getByRole('menuitemradio', { name: label })

it('shows the latest model of each line under Claude and Codex, the rest behind More models, and the current one checked', async () => {
  const api = await mount()
  expect(api.callsOf('models')).toEqual([[ref]])
  expect(chipText()).toBe('Opus 5.5 · High')
  expect(chip().closest('.chat-composer-row')?.lastElementChild?.getAttribute('aria-label')).toBe('Send')
  fireEvent.click(chip())
  expect(chip().getAttribute('aria-expanded')).toBe('true')
  expect(names('Claude')).toEqual(['Fable 5.2', 'Haiku 5.5', 'Mythos 5.2', 'Opus 5.5', 'Sonnet 5.5'])
  expect(names('Codex')).toEqual(['GPT-6 Astra', 'GPT-6 Luna', 'GPT-6.1 Sol', 'GPT-6.1 Terra'])
  expect(model('Opus 5.5').getAttribute('aria-checked')).toBe('true')
  expect(model('Opus 5.5').textContent).toContain('1M')
  expect(model('Opus 5.5').textContent).toContain('reads images')
  expect(model('GPT-6.1 Sol').textContent).toContain('500K')
  expect(within(menu()).queryByRole('group', { name: 'More Claude' })).toBe(null)

  const more = within(menu()).getByRole('menuitem', { name: 'More models' })
  expect(more.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(more)
  expect(more.getAttribute('aria-expanded')).toBe('true')
  expect(names('More Claude')).toContain('Opus 4.5')
  expect(names('More Claude')).not.toContain('Opus 5.5')
  expect(names('More Codex')).toEqual(['GPT-5.6 Luna', 'GPT-6 Sol', 'GPT-5.6 Sol', 'GPT-5.6 Terra'])
  expect(names('More Claude').length + names('More Codex').length + 9).toBe(CATALOG.length)
})

it('switches across providers with one setModel call, spinning while it runs and showing the new label after', async () => {
  const api = await mount()
  fireEvent.click(chip())
  fireEvent.click(model('GPT-6.1 Sol'))
  expect(api.callsOf('setModel')).toEqual([])
  expect(model('GPT-6.1 Sol').getAttribute('aria-checked')).toBe('true')
  expect(efforts().map((entry) => entry.label)).toEqual(['Low', 'Medium', 'High', 'XHigh', 'Max'])
  expect(effort('High').getAttribute('aria-checked')).toBe('true')
  expect(document.activeElement).toBe(effort('High'))

  const hold = api.hold('setModel')
  fireEvent.click(effort('Medium'))
  expect(api.callsOf('setModel')).toEqual([[{ ...ref, provider: 'openai-codex', modelId: 'gpt-6.1-sol', effort: 'medium' }]])
  expect(screen.queryByRole('menu')).toBe(null)
  expect(document.activeElement).toBe(chip())
  expect(chip().getAttribute('aria-busy')).toBe('true')
  expect(chip().querySelector('.model-picker-spinner')).not.toBe(null)
  expect(chipText()).toBe('GPT-6.1 Sol · Medium')

  await act(async () => { hold.resolve() })
  await settle()
  expect(chip().getAttribute('aria-busy')).toBe('false')
  expect(chip().querySelector('.model-picker-spinner')).toBe(null)
  expect(chipText()).toBe('GPT-6.1 Sol · Medium')
  expect(api.callsOf('setModel')).toHaveLength(1)
  fireEvent.click(chip())
  expect(model('GPT-6.1 Sol').getAttribute('aria-checked')).toBe('true')
  expect(effort('Medium').getAttribute('aria-checked')).toBe('true')
})

it('lists only the chosen model’s efforts, keeping the current effort when it takes it', async () => {
  await mount()
  fireEvent.click(chip())
  expect(efforts()).toEqual(['Low', 'Medium', 'High', 'XHigh', 'Max'].map((label) => ({ label, checked: String(label === 'High') })))
  fireEvent.click(within(menu()).getByRole('menuitem', { name: 'More models' }))
  fireEvent.click(model('Sonnet 4.6'))
  expect(efforts()).toEqual(['Low', 'Medium', 'High'].map((label) => ({ label, checked: String(label === 'High') })))
  fireEvent.click(model('Haiku 4.5'))
  expect(efforts().map((entry) => entry.label)).toEqual(['Minimal', 'Low', 'Medium', 'High', 'XHigh'])
})

it('says a switch applies to the next response while the agent is busy, and shows it queued until the turn ends', async () => {
  const api = await mount({ status: 'busy' })
  expect(chip().getAttribute('title')).toBe('Applies to next response')
  fireEvent.click(chip())
  expect(within(menu()).getByText('Applies to next response')).toBeTruthy()
  fireEvent.click(model('GPT-6.1 Sol'))
  fireEvent.click(effort('Medium'))
  await settle()
  expect(api.callsOf('setModel')).toHaveLength(1)
  expect(chipText()).toBe('GPT-6.1 Sol · Medium')
  expect(within(chip()).getByText('queued')).toBeTruthy()
  fireEvent.click(chip())
  expect(within(menu()).getByText('Queued · applies to next response')).toBeTruthy()
  // Escape closes the menu only: it never reaches the chat's own Escape, which stops the running turn.
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(api.callsOf('interrupt')).toEqual([])

  act(() => api.emit({ ...ref, type: 'status', status: 'idle' }))
  expect(within(chip()).queryByText('queued')).toBe(null)
})

it('reverts the chip and shows the error inline when the switch fails', async () => {
  const api = await mount()
  api.failures.setModel = { code: 'invalid_request', message: 'The catalog does not list that model.' }
  fireEvent.click(chip())
  fireEvent.click(model('GPT-6.1 Terra'))
  fireEvent.click(effort('Low'))
  expect(chipText()).toBe('GPT-6.1 Terra · Low')
  await settle()
  expect(screen.getByRole('alert').textContent).toBe('The catalog does not list that model.')
  expect(chipText()).toBe('Opus 5.5 · High')
  expect(chip().getAttribute('aria-busy')).toBe('false')
})

it('opens from the keyboard, moves with the arrows, filters as the person types and returns focus on Escape', async () => {
  const api = await mount()
  chip().focus()
  fireEvent.keyDown(chip(), { key: 'ArrowDown' })
  expect(document.activeElement).toBe(model('Opus 5.5'))
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(model('Sonnet 5.5'))
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
  expect(document.activeElement).toBe(model('Opus 5.5'))
  fireEvent.keyDown(document.activeElement!, { key: 'Home' })
  expect(document.activeElement).toBe(model('Fable 5.2'))
  fireEvent.keyDown(document.activeElement!, { key: 'End' })
  expect(document.activeElement).toBe(effort('Max'))

  for (const key of 'sol') fireEvent.keyDown(document.activeElement!, { key })
  expect(within(menu()).getByText('Filter: sol')).toBeTruthy()
  expect(within(menu()).getAllByRole('menuitemradio').filter((item) => item.hasAttribute('data-model')).map(nameOf))
    .toEqual(['GPT-6.1 Sol', 'GPT-6 Sol', 'GPT-5.6 Sol'])
  expect(document.activeElement).toBe(model('GPT-6.1 Sol'))
  fireEvent.keyDown(document.activeElement!, { key: 'Backspace' })
  expect(within(menu()).getByText('Filter: so')).toBeTruthy()

  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBe(null)
  expect(document.activeElement).toBe(chip())
  expect(api.callsOf('setModel')).toEqual([])
})

it('gives a Claude chat no model chip and reads no catalog for it', async () => {
  const api = await mount({ skitarii: false })
  expect(screen.queryByRole('button', { name: /^Model: / })).toBe(null)
  expect(document.querySelector('.model-picker')).toBe(null)
  expect(api.callsOf('models')).toEqual([])
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
})

it('bounds the menu to the room above the chip inside the stage that scrolls it, within 160–600 px', async () => {
  // jsdom lays nothing out: the epic stage starts 165 px down, and the picker sits at `pickerTop`.
  let pickerTop = 680
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.classList.contains('preview-stage') ? 165 : this.classList.contains('model-picker') ? pickerTop : 0
    return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  })
  const api = new FakeAgentChat()
  api.snapshotResult = { ok: true, data: OPUS_HIGH }
  api.modelsResult = { ok: true, data: CATALOG }
  // jsdom does not expand the `overflow` shorthand; the epic stage's `overflow: auto` computes to this in Chromium.
  render(<div className="preview-stage" style={{ overflowY: 'auto' }}>
    <AgentChat {...ref} agentLabel="Magos" api={api} scheduler={new ManualScheduler()} skitarii />
  </div>)
  await settle()
  fireEvent.click(chip())
  expect(menu().style.maxHeight).toBe(`${680 - 165 - 18}px`)
  fireEvent.click(chip())
  pickerTop = 2_000
  fireEvent.click(chip())
  expect(menu().style.maxHeight).toBe('600px')
  fireEvent.click(chip())
  pickerTop = 200
  fireEvent.click(chip())
  expect(menu().style.maxHeight).toBe('160px')
  spy.mockRestore()
})

/** A small hand-made catalog for the picker on its own, as New chat, Start run and the Lexmechanic card mount it. */
const option = (fields: Pick<ChatModelOption, 'id' | 'name'> & Partial<ChatModelOption>): ChatModelOption => ({
  provider: 'anthropic', line: fields.id, revision: null, efforts: [], images: false, contextWindow: null, reasoning: false, inputCost: null, ...fields
})
const OPUS = option({ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', line: 'opus', revision: '5.5', efforts: ['low', 'medium', 'high'], contextWindow: 200_000 })
const OLD_OPUS = option({ id: 'claude-opus-4-5', name: 'Claude Opus 4.5', line: 'opus', revision: '4.5', efforts: ['low', 'medium', 'high'] })
const SMALL = option({ id: 'claude-small-1', name: 'Claude Small 1', line: 'small', revision: '1', efforts: ['minimal', 'low', 'turbo'] })
const PLAIN = option({ provider: 'openrouter', id: 'plain', name: 'Plain', efforts: ['turbo'] })
type Load = () => Promise<CommandResult<ChatModelOption[]>>
type Choose = (choice: AgentChatModelChoice) => Promise<CommandResult<unknown>>

function picker({ load, choose = vi.fn<Choose>(async () => ({ ok: true, data: null })), onDefault, model = null, thinking = null }: {
  load: Load; choose?: Choose; onDefault?: () => void; model?: string | null; thinking?: AgentChatSnapshot['thinking']
}) {
  render(<ModelPicker state={{ model, thinking, status: 'idle' }} load={load} choose={choose} {...(onDefault === undefined ? {} : { onDefault })} />)
  return choose
}
const ready = (...options: ChatModelOption[]): Load => async () => ({ ok: true, data: options })
const defaultItem = (): HTMLElement => within(within(menu()).getByRole('group', { name: 'Default' })).getByRole('menuitemradio')

it('names the model by its id before the catalog arrives, and reads the catalog again on Retry or reopening after a failure', async () => {
  const load = vi.fn<Load>()
    .mockResolvedValueOnce({ ok: false, error: { code: 'desktop_unavailable', message: 'OMP is not running.' } })
    .mockRejectedValueOnce(new Error('The pipe closed.'))
    .mockRejectedValueOnce('down')
    .mockResolvedValueOnce({ ok: true, data: [PLAIN] })
  picker({ load, model: 'openrouter/plain', thinking: 'high' })
  expect(chipText()).toBe('plain · High')
  await settle()
  fireEvent.click(chip())
  expect(within(menu()).getByText('Loading models…')).toBeTruthy()
  await settle()
  expect(within(menu()).getByRole('alert').textContent).toBe('The pipe closed.')
  fireEvent.click(within(menu()).getByRole('menuitem', { name: 'Retry' }))
  await settle()
  expect(within(menu()).getByRole('alert').textContent).toBe('The models could not be read.')
  fireEvent.click(within(menu()).getByRole('menuitem', { name: 'Retry' }))
  await settle()
  expect(load).toHaveBeenCalledTimes(4)
  expect(model('Plain').querySelector('.model-picker-context')).toBe(null)
  expect(chipText()).toBe('Plain · High')
  // The menu checks the chat's model as it opens, so one opened before the catalog arrived checks it on reopening.
  fireEvent.click(chip())
  fireEvent.click(chip())
  expect(model('Plain').getAttribute('aria-checked')).toBe('true')
})

it('says when the catalog holds no model, and names a chat with no model and no Default plainly', async () => {
  picker({ load: ready() })
  await settle()
  expect(chipText()).toBe('Model')
  fireEvent.click(chip())
  expect(within(menu()).getByText('No models are available.')).toBeTruthy()
})

it('offers Default first and checked while no model is chosen, hides it while filtering and starts on it when chosen', async () => {
  const onDefault = vi.fn()
  const choose = picker({ load: ready(OPUS, PLAIN), onDefault })
  await settle()
  expect(chipText()).toBe('Default')
  fireEvent.click(chip())
  expect(defaultItem().getAttribute('aria-checked')).toBe('true')
  expect(model('Opus 5.5').textContent).toContain('200K')
  for (const key of 'zz') fireEvent.keyDown(menu(), { key })
  expect(within(menu()).queryByRole('group', { name: 'Default' })).toBe(null)
  expect(within(menu()).getByText('No model matches “zz”.')).toBeTruthy()
  fireEvent.keyDown(menu(), { key: 'Backspace' })
  fireEvent.keyDown(menu(), { key: 'Backspace' })
  // Backspace on an empty filter, Space and a modifier chord are not the menu's keys.
  for (const key of [{ key: 'Backspace' }, { key: ' ' }, { key: 'k', ctrlKey: true }]) {
    expect(fireEvent.keyDown(menu(), key)).toBe(true)
  }
  fireEvent.click(model('Opus 5.5'))
  expect(defaultItem().getAttribute('aria-checked')).toBe('false')
  expect(within(menu()).getByRole('group', { name: 'Effort' }).textContent).toContain('Effort for Opus 5.5: choose one to switch')
  expect(effort('Medium').getAttribute('aria-checked')).toBe('true')
  fireEvent.click(defaultItem())
  expect(onDefault).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('menu')).toBe(null)
  expect(document.activeElement).toBe(chip())
  expect(choose).not.toHaveBeenCalled()
})

it('opens More on a current model that is not featured, switches a model without efforts at once, and leaves the current choice alone', async () => {
  const choose = picker({ load: ready(OPUS, OLD_OPUS, SMALL, PLAIN), model: 'anthropic/claude-opus-4-5', thinking: 'high' })
  await settle()
  fireEvent.click(chip())
  expect(within(menu()).getByRole('menuitem', { name: 'More models' }).getAttribute('aria-expanded')).toBe('true')
  expect(model('Opus 4.5').getAttribute('aria-checked')).toBe('true')
  expect(within(menu()).getByRole('group', { name: 'Effort' }).textContent).toContain('Effort')
  fireEvent.click(effort('High'))
  expect(screen.queryByRole('menu')).toBe(null)
  expect(choose).not.toHaveBeenCalled()

  fireEvent.click(chip())
  // A model whose efforts hold neither the chat's nor Medium starts on its lowest; one with none a switch can name has no Effort.
  fireEvent.click(model('Small 1'))
  expect(efforts()).toEqual([{ label: 'Minimal', checked: 'true' }, { label: 'Low', checked: 'false' }])
  fireEvent.click(model('Plain'))
  expect(choose).toHaveBeenCalledWith({ provider: 'openrouter', modelId: 'plain' })
  expect(screen.queryByRole('menu')).toBe(null)
  await settle()
})

it('shows a thrown switch failure and ignores another choice while one is still running', async () => {
  let fail: (cause: unknown) => void = () => undefined
  const choose = vi.fn<Choose>(() => new Promise((_resolve, reject) => { fail = reject }))
  picker({ load: ready(OPUS, SMALL), choose, model: 'anthropic/claude-opus-5-5', thinking: 'high' })
  await settle()
  fireEvent.click(chip())
  fireEvent.click(model('Small 1'))
  fireEvent.click(effort('Low'))
  expect(chipText()).toBe('Small 1 · Low')
  fireEvent.click(chip())
  fireEvent.click(effort('Medium'))
  expect(choose).toHaveBeenCalledTimes(1)
  await act(async () => { fail(new Error('The switch timed out.')) })
  await settle()
  expect(screen.getByRole('alert').textContent).toBe('The switch timed out.')
  expect(chipText()).toBe('Opus 5.5 · High')

  fireEvent.click(chip())
  fireEvent.click(effort('Low'))
  await act(async () => { fail('lost') })
  await settle()
  expect(screen.getByRole('alert').textContent).toBe('The model could not be switched.')
})

it('closes on a press outside the picker or Tab, not on a press inside, and on Escape at the chip', async () => {
  picker({ load: ready(OPUS), model: 'anthropic/claude-opus-5-5', thinking: 'high' })
  await settle()
  fireEvent.keyDown(chip(), { key: 'Enter' })
  expect(screen.queryByRole('menu')).toBe(null)
  fireEvent.keyDown(chip(), { key: 'ArrowUp' })
  fireEvent.mouseDown(menu())
  expect(screen.queryByRole('menu')).not.toBe(null)
  fireEvent.mouseDown(document.body)
  expect(screen.queryByRole('menu')).toBe(null)

  fireEvent.click(chip())
  fireEvent.keyDown(chip(), { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBe(null)
  expect(document.activeElement).toBe(chip())

  fireEvent.click(chip())
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
  expect(screen.queryByRole('menu')).toBe(null)
})
