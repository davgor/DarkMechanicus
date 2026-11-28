// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { PendingPrompt } from '../../../shared/agents/agentChat'
import type { BrowserState } from '../../../shared/browser/browserApi'
import { deferred } from '../__mocks__/deferred'
import { FakeAgentChat } from '../__mocks__/fakeAgentChat'
import { FakeBrowser } from '../__mocks__/fakeBrowser'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { AgentChat } from '../agentChat/AgentChat'
import { browserScenarios, type BrowserScenarioName } from './__mocks__/browserScenario'

const ref = { folder: null, chatId: 'origin-chat' }
const approval: PendingPrompt = {
  id: 'approval', kind: 'approval', title: 'Run command', detail: '', threadId: null, attributed: false, callsign: null,
  arbitration: { state: 'off', reason: null }, tool: { name: 'Bash', input: { command: 'npm test' } },
  options: [{ id: 'allow_once', label: 'Allow once' }, { id: 'deny', label: 'Deny' }]
}
afterEach(cleanup)

/** The scenario as main pushes it for this test's chat. */
const pushed = (scenario: BrowserScenarioName): BrowserState => ({ ...browserScenarios[scenario], ...ref })

async function mount(scenario: BrowserScenarioName = 'browser-origin', pending: PendingPrompt | null = null) {
  const chat = new FakeAgentChat()
  const browser = new FakeBrowser()
  browser.current = pushed(scenario)
  chat.snapshotResult = { ok: true, data: { items: [], status: 'idle', pending, queued: 0, surface: 'gui', todos: [] } }
  render(<AgentChat {...ref} agentLabel="Magos" api={chat} scheduler={new ManualScheduler()} browser={browser} />)
  await settle()
  const emit = (state: BrowserState): void => act(() => browser.emit(state))
  return { chat, browser, emit }
}

const card = (): HTMLElement => screen.getByRole('alertdialog', { name: /^http/ })
const heading = (): string | null => within(card()).getByRole('heading').textContent

it.each<[BrowserScenarioName, string, string]>([
  ['browser-origin', 'https://api.github.com', 'Acolyte:DM-442 wants to open https://api.github.com'],
  ['browser-origin-page', 'http://127.0.0.1:5173', 'This page wants to open http://127.0.0.1:5173'],
  ['browser-origin-person', 'https://example.com', 'You asked to open https://example.com']
])('%s: names who asked and the origin, labelled by the origin', async (scenario, origin, text) => {
  await mount(scenario)
  expect(screen.getByRole('alertdialog', { name: origin })).toBe(card())
  expect(heading()).toBe(text)
  expect(within(card()).getAllByRole('button').map((button) => button.textContent)).toEqual(['Allow once', 'Always allow', 'Deny'])
})

it('shows the origin parsed into scheme, host and port, never as a link', async () => {
  await mount('browser-origin-page')
  expect(within(card()).getByText('Scheme: http · Host: 127.0.0.1 · Port: 5173')).toBeTruthy()
  expect(card().querySelector('a')).toBeNull()
  expect(within(card()).queryByRole('link')).toBeNull()
})

it('reads the scheme’s port when the origin names none, and an unnamed agent as "An agent"', async () => {
  const { emit } = await mount('browser-agent')
  emit({ ...pushed('browser-origin'), ownerLabel: null })
  expect(heading()).toBe('An agent wants to open https://api.github.com')
  expect(within(card()).getByText('Scheme: https · Host: api.github.com · Port: 443')).toBeTruthy()
})

it.each([['Allow once', 'once'], ['Always allow', 'always'], ['Deny', 'deny']] as const)(
  '%s sends decideOrigin with %s and clears the card', async (label, decision) => {
    const { browser } = await mount()
    fireEvent.click(within(card()).getByRole('button', { name: label }))
    await settle()
    expect(browser.callsOf('decideOrigin')).toEqual([[{ ...ref, promptId: 'origin-agent', decision }]])
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.queryByText(/no longer pending|Couldn't save/)).toBeNull()
  })

it('disables every button while the answer is in flight and sends one answer', async () => {
  const { browser } = await mount()
  const hold = deferred()
  const decide = browser.decideOrigin.bind(browser)
  browser.decideOrigin = async (request) => {
    await hold.promise
    return decide(request)
  }
  fireEvent.click(within(card()).getByRole('button', { name: 'Allow once' }))
  fireEvent.click(within(card()).getByRole('button', { name: 'Deny' }))
  for (const button of within(card()).getAllByRole('button')) expect(button).toHaveProperty('disabled', true)
  expect(card().getAttribute('aria-busy')).toBe('true')
  await act(async () => { hold.resolve(); await settle() })
  expect(browser.callsOf('decideOrigin')).toEqual([[{ ...ref, promptId: 'origin-agent', decision: 'once' }]])
  expect(screen.queryByRole('alertdialog')).toBeNull()
})

it('never takes focus from the composer when a site prompt arrives', async () => {
  const { emit } = await mount('browser-agent')
  expect(screen.queryByRole('alertdialog')).toBeNull()
  const composer = screen.getByRole('textbox', { name: 'Message Magos' })
  composer.focus()
  fireEvent.change(composer, { target: { value: 'Still typing' } })
  emit(pushed('browser-origin'))
  expect(card()).toBeTruthy()
  expect(document.activeElement).toBe(composer)
})

it('clears a stale card and leaves an inline notice', async () => {
  const { browser } = await mount()
  browser.failures.decideOrigin = { code: 'stale_prompt', message: 'That site prompt was already answered or replaced.' }
  fireEvent.click(within(card()).getByRole('button', { name: 'Deny' }))
  await settle()
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(screen.getByText('This site prompt is no longer pending.').getAttribute('role')).toBe('status')
})

it('hides the card once main clears the pending origin, and a new prompt replaces an old notice', async () => {
  const { browser, emit } = await mount()
  emit(pushed('browser-agent'))
  expect(screen.queryByRole('alertdialog')).toBeNull()
  emit(pushed('browser-origin'))
  browser.failures.decideOrigin = { code: 'stale_prompt', message: 'gone' }
  fireEvent.click(within(card()).getByRole('button', { name: 'Allow once' }))
  await settle()
  expect(screen.getByText('This site prompt is no longer pending.')).toBeTruthy()
  emit(pushed('browser-origin-page'))
  expect(heading()).toBe('This page wants to open http://127.0.0.1:5173')
  expect(screen.queryByText('This site prompt is no longer pending.')).toBeNull()
})

it('says so when Always allow could not save the site: the card is gone and the notice names the origin', async () => {
  const { browser, emit } = await mount()
  browser.failures.decideOrigin = { code: 'capacity_exceeded', message: 'A folder can always allow at most 200 sites.' }
  fireEvent.click(within(card()).getByRole('button', { name: 'Always allow' }))
  await settle()
  // Main cleared the prompt before the save failed and pushes it gone.
  emit(pushed('browser-agent'))
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(screen.getByRole('alert').textContent)
    .toBe("Couldn't save https://api.github.com to Always allow, so the page did not open: A folder can always allow at most 200 sites.")
})

it('keeps the card with its error when Allow once or Deny fails otherwise, and lets the person answer again', async () => {
  const { browser } = await mount()
  browser.failures.decideOrigin = { code: 'operation_unavailable', message: 'The browser is not running.' }
  fireEvent.click(within(card()).getByRole('button', { name: 'Allow once' }))
  await settle()
  expect(within(card()).getByRole('alert').textContent).toBe('The browser is not running.')
  for (const button of within(card()).getAllByRole('button')) expect(button).toHaveProperty('disabled', false)
  delete browser.failures.decideOrigin
  fireEvent.click(within(card()).getByRole('button', { name: 'Deny' }))
  await settle()
  expect(screen.queryByRole('alertdialog')).toBeNull()
})

it('docks below an agent approval card when both wait', async () => {
  await mount('browser-origin', approval)
  const cards = screen.getAllByRole('alertdialog')
  expect(cards.map((node) => node.getAttribute('aria-label'))).toEqual(['The agent wants to run: npm test', 'https://api.github.com'])
})

it('shows no site card for a chat mounted without a browser', async () => {
  const chat = new FakeAgentChat()
  chat.snapshotResult = { ok: true, data: { items: [], status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [] } }
  render(<AgentChat {...ref} agentLabel="Magos" api={chat} scheduler={new ManualScheduler()} />)
  await settle()
  expect(screen.queryByRole('alertdialog')).toBeNull()
})
