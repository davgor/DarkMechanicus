// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatComposer } from './ChatComposer'

const LINE_PX = 20

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function mount(patch: Partial<ComponentProps<typeof ChatComposer>> = {}) {
  const send = vi.fn(async (_text: string) => true)
  const stop = vi.fn()
  const props: ComponentProps<typeof ChatComposer> = {
    id: 'composer', label: 'Message Magos', placeholder: 'Message Magos…', agent: 'Magos · Skitarii', context: 'Agent GUI', queued: 0,
    maxLength: 20_000, disabled: false, acting: false, busy: false, error: null, send, stop, ...patch
  }
  const view = render(<div className="agent-chat"><ChatComposer {...props} /></div>)
  const input = screen.getByRole('textbox', { name: 'Message Magos' }) as HTMLTextAreaElement
  return { ...view, props, send, stop, input, rerender: (next: Partial<typeof props>) => view.rerender(<div className="agent-chat"><ChatComposer {...props} {...next} /></div>) }
}

/** jsdom lays nothing out: the text area is as tall as its lines, and the chat pane as tall as `paneHeight`. */
function stubLayout(paneHeight: number): void {
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLTextAreaElement) {
    return this.value.split('\n').length * LINE_PX
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('agent-chat') ? paneHeight : 0
  })
}

it('starts at one line, grows to two with Shift+Enter, sends the two lines once on Enter and clears after success', async () => {
  stubLayout(1_000)
  const { input, send } = mount()
  expect(input.getAttribute('rows')).toBe('1')
  fireEvent.change(input, { target: { value: 'First line' } })
  expect(input.style.height).toBe(`${LINE_PX}px`)
  expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true)
  fireEvent.change(input, { target: { value: 'First line\nSecond line' } })
  expect(input.style.height).toBe(`${2 * LINE_PX}px`)
  expect(send).not.toHaveBeenCalled()
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
  expect(send.mock.calls).toEqual([['First line\nSecond line']])
  expect(input.value).toBe('')
  expect(input.style.height).toBe(`${LINE_PX}px`)
})

it('never sends from an IME composition, a blank draft or a failed send, and keeps the draft on failure', async () => {
  const { input, send } = mount()
  fireEvent.change(input, { target: { value: 'にほんご' } })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(send).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '   ' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(send).not.toHaveBeenCalled()
  send.mockResolvedValueOnce(false)
  fireEvent.change(input, { target: { value: 'Keep me' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
  expect(send.mock.calls).toEqual([['Keep me']])
  expect(input.value).toBe('Keep me')
})

it('keeps text typed while a send was in flight and sends once for a double Enter', async () => {
  // The renderer's lib (ES2022) has no Promise.withResolvers.
  let resolve: (taken: boolean) => void = () => undefined
  const { input, send } = mount()
  send.mockImplementationOnce(() => new Promise<boolean>((settle) => { resolve = settle }))
  fireEvent.change(input, { target: { value: 'First' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.change(input, { target: { value: 'Next' } })
  await act(async () => { resolve(true) })
  expect(send).toHaveBeenCalledTimes(1)
  expect(input.value).toBe('Next')
})

it('shows a round Send while idle and a square Stop while busy, and Stop calls stop', () => {
  const view = mount()
  const sendButton = screen.getByRole('button', { name: 'Send' })
  expect(sendButton.className).toBe('chat-composer-send')
  expect(sendButton).toHaveProperty('disabled', true)
  expect(sendButton.getAttribute('title')).toBe('Enter to send · Shift+Enter for a new line')
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  view.rerender({ busy: true, queued: 2 })
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  const stopButton = screen.getByRole('button', { name: 'Stop' })
  expect(stopButton.className).toBe('chat-composer-stop')
  fireEvent.click(stopButton)
  expect(view.stop).toHaveBeenCalledTimes(1)
  view.rerender({ busy: true, acting: true })
  expect(screen.getByRole('button', { name: 'Stop' })).toHaveProperty('disabled', true)
})

it('still sends on Enter while busy, so a message queues behind the running turn', async () => {
  const { input, send } = mount({ busy: true })
  fireEvent.change(input, { target: { value: 'Steer' } })
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
  expect(send.mock.calls).toEqual([['Steer']])
})

it('shows the agent, context and queue chips, with no queue chip at zero and no context chip without one', () => {
  const view = mount({ queued: 2 })
  expect(screen.getByLabelText('Agent: Magos · Skitarii').textContent).toBe('Magos · Skitarii')
  expect(screen.getByLabelText('Context: Agent GUI').textContent).toBe('Agent GUI')
  expect(screen.getByLabelText('Queued messages').textContent).toBe('2 queued')
  view.rerender({ queued: 0, context: null })
  expect(screen.queryByLabelText('Queued messages')).toBeNull()
  expect(screen.queryByLabelText(/^Context:/)).toBeNull()
})

it('uses the placeholder it is given and says the keys as the text area description, not as visible text', () => {
  const view = mount()
  expect(view.input.placeholder).toBe('Message Magos…')
  view.rerender({ placeholder: 'Reply to Magos…' })
  expect(view.input.placeholder).toBe('Reply to Magos…')
  const described = document.getElementById(view.input.getAttribute('aria-describedby') ?? '')
  expect(described?.className).toBe('sr-only')
  expect(described?.textContent).toBe('Enter to send · Shift+Enter for a new line')
  view.rerender({ note: 'Your message goes through Magos.' })
  expect(described?.textContent).toBe('Your message goes through Magos. Enter to send · Shift+Enter for a new line')
})

it('grows with the line count up to 40% of the chat pane, then scrolls inside the cap', () => {
  stubLayout(500)
  const { input } = mount()
  fireEvent.change(input, { target: { value: 'a\nb\nc' } })
  expect(input.style.height).toBe(`${3 * LINE_PX}px`)
  expect(input.style.overflowY).toBe('hidden')
  fireEvent.change(input, { target: { value: Array.from({ length: 30 }, (_, line) => `line ${line}`).join('\n') } })
  expect(input.style.height).toBe('200px')
  expect(input.style.overflowY).toBe('auto')
})

it('recomputes the cap when the chat pane resizes', () => {
  let resized: ResizeObserverCallback = () => undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resized = callback }
    observe(): void {}
    disconnect(): void {}
  })
  let pane = 500
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLTextAreaElement) {
    return this.value.split('\n').length * LINE_PX
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('agent-chat') ? pane : 0
  })
  const { input } = mount()
  fireEvent.change(input, { target: { value: Array.from({ length: 30 }, () => 'x').join('\n') } })
  expect(input.style.height).toBe('200px')
  pane = 1_000
  act(() => resized([], {} as ResizeObserver))
  expect(input.style.height).toBe('400px')
  vi.unstubAllGlobals()
})

it('honours maxLength on the text area and refuses to send an over-long draft', () => {
  const { input, send } = mount({ maxLength: 5 })
  expect(input.getAttribute('maxlength')).toBe('5')
  fireEvent.change(input, { target: { value: 'too long' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(send).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true)
})

it('disables the text area while the agent is not ready and shows a send error', () => {
  mount({ disabled: true, error: 'Session is unavailable.' })
  expect(screen.getByRole('textbox')).toHaveProperty('disabled', true)
  expect(screen.getByRole('alert').textContent).toBe('Session is unavailable.')
})

it('renders the leading and trailing slots around the chips and nothing of its own there', () => {
  const view = mount()
  const row = view.container.querySelector('.chat-composer-row')!
  expect([...row.children].map((child) => child.className)).toEqual(['chat-composer-chip', 'chat-composer-chip', 'chat-composer-spacer', 'chat-composer-send'])
  view.rerender({ leading: <button type="button">Attach</button>, trailing: <span>Model</span> })
  const names = [...row.children].map((child) => child.textContent)
  expect(names[0]).toBe('Attach')
  expect(names.at(-2)).toBe('Model')
  expect(view.container.querySelector('form')?.className).toBe('chat-composer glass')
})

it('puts image chips above the text, takes paste and drop on the card, and sends images alone as empty text', async () => {
  const intake = { onPaste: vi.fn(), onDrop: vi.fn(), onDragOver: vi.fn() }
  const attachments = { chips: <ul aria-label="Attached images" />, count: 0, staging: false, intake }
  const view = mount({ attachments })
  const form = view.container.querySelector('form')!
  expect(form.firstElementChild?.getAttribute('aria-label')).toBe('Attached images')
  fireEvent.paste(view.input)
  fireEvent.drop(view.input)
  expect([intake.onPaste.mock.calls.length, intake.onDrop.mock.calls.length]).toEqual([1, 1])
  fireEvent.change(view.input, { target: { value: '   ' } })
  expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true)
  view.rerender({ attachments: { ...attachments, count: 1, staging: true } })
  expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true)
  view.rerender({ attachments: { ...attachments, count: 1 } })
  await act(async () => { fireEvent.keyDown(view.input, { key: 'Enter' }) })
  expect(view.send.mock.calls).toEqual([['']])
  expect(view.input.value).toBe('')
})
