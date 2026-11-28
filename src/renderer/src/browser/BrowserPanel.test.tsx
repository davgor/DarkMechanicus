// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within, type RenderResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatImageUrl } from '../../../shared/agents/chatImageUrl'
import { browserSetViewSchema, type BrowserState } from '../../../shared/browser/browserApi'
import { FakeAgentChat } from '../__mocks__/fakeAgentChat'
import { FakeBrowser } from '../__mocks__/fakeBrowser'
import { AgentChat } from '../agentChat/AgentChat'
import type { ChatEpic } from '../agentChat/ChatImages'
import { ChatImagesContext, type ChatImagesHandle } from '../agentChat/useChatImages'
import { Lightbox } from '../attachments/Lightbox'
import { Dialog } from '../components/Dialog'
import { RightRail } from '../components/RightRail'
import { BrowserEpicContext } from './BrowserCamera'
import { BrowserPanel, browserRailTab } from './BrowserPanel'
import { browserScenarios, type BrowserScenarioName } from './__mocks__/browserScenario'

const CHAT = 'fixture-chat'
const PRIVATE_LABEL = "Private tab (agents can't see this; sign-ins here don't carry over)"
let browser: FakeBrowser
let box = { x: 10, y: 20, width: 400, height: 300 }
let resized: () => void = () => undefined
let stored: Map<string, string>

beforeEach(() => {
  browser = new FakeBrowser()
  box = { x: 10, y: 20, width: 400, height: 300 }
  stored = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value) }
  })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  vi.stubGlobal('ResizeObserver', class {
    constructor(notify: () => void) { resized = notify }
    observe() { /* the test calls `resized` itself */ }
    disconnect() { resized = () => undefined }
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const rect = this.classList.contains('bp-content') ? box : { x: 0, y: 0, width: 0, height: 0 }
    return { ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => rect } as DOMRect
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount(scenario: BrowserScenarioName = 'browser-agent'): Promise<RenderResult> {
  browser.current = browserScenarios[scenario]
  const view = render(<BrowserPanel folder={null} chatId={CHAT} api={browser} />)
  await waitFor(() => expect(badge()).not.toBe('Loading…'))
  return view
}

const badge = (): string | null => screen.getByRole('status', { name: 'Browser owner' }).textContent
const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement
const setViews = (): unknown[] => browser.callsOf('setView').map(([request]) => browserSetViewSchema.parse(request).bounds)

describe('BrowserPanel chrome', () => {
  it('renders the tab strip, the toolbar and the enable switch for the agent tab', async () => {
    await mount('browser-agent')
    const tabs = screen.getByRole('list', { name: 'Browser tabs' })
    expect(tabs.textContent).toBe('Getting started · Fixture docs')
    expect(screen.queryByText(PRIVATE_LABEL)).toBeNull()
    const toolbar = screen.getByRole('toolbar', { name: 'Browser controls' })
    for (const name of ['Back', 'Forward', 'Reload', 'Private tab']) expect(toolbar.contains(button(name))).toBe(true)
    expect((screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement).value).toBe('http://127.0.0.1:4173/docs/getting-started')
    expect((screen.getByRole('switch', { name: 'Let agents use this browser' }) as HTMLInputElement).checked).toBe(true)
  })

  it.each<[BrowserScenarioName, string]>([
    ['browser-agent', 'Driven by: Acolyte:DM-442'],
    ['browser-person', 'You have control'],
    ['browser-stopped', 'Stopped'],
    ['browser-empty', 'Idle']
  ])('badges %s as "%s"', async (scenario, text) => {
    await mount(scenario)
    expect(badge()).toBe(text)
  })

  it('shows the empty state with no tab yet and greys the history controls', async () => {
    await mount('browser-empty')
    expect(screen.getByRole('region', { name: 'Browser page' }).textContent)
      .toBe('Agents open pages here. You will be asked before any new site loads.')
    expect(button('Back').disabled && button('Forward').disabled && button('Reload').disabled).toBe(true)
    expect((screen.getByRole('switch', { name: 'Let agents use this browser' }) as HTMLInputElement).checked).toBe(false)
  })

  it('labels the private tab apart from the agent tab and closes it', async () => {
    await mount('browser-private')
    expect(screen.getByRole('list', { name: 'Browser tabs' }).textContent).toBe(`Getting started · Fixture docs${PRIVATE_LABEL}`)
    expect(screen.getByText(PRIVATE_LABEL).closest('li')?.getAttribute('aria-current')).toBe('page')
    expect((screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(button('Close private tab'))
    await waitFor(() => expect(browser.callsOf('closeSignIn')).toEqual([[{ folder: null, chatId: CHAT }]]))
  })

  it('follows pushes for its own chat only', async () => {
    await mount('browser-empty')
    act(() => browser.emit({ ...browserScenarios['browser-agent'], chatId: 'other-chat' }))
    expect(badge()).toBe('Idle')
    act(() => browser.emit({ ...browserScenarios['browser-agent'], chatId: CHAT }))
    expect(badge()).toBe('Driven by: Acolyte:DM-442')
  })
})

describe('BrowserPanel ownership controls', () => {
  it.each<[BrowserScenarioName, boolean]>([
    ['browser-agent', true], ['browser-person', false], ['browser-stopped', false], ['browser-empty', false]
  ])('enables Stop agent in %s: %s', async (scenario, enabled) => {
    await mount(scenario)
    expect(button('Stop agent').disabled).toBe(!enabled)
  })

  it('stops the agent that drives', async () => {
    await mount('browser-agent')
    fireEvent.click(button('Stop agent'))
    await waitFor(() => expect(badge()).toBe('Stopped'))
    expect(browser.callsOf('stopAgent')).toEqual([[{ folder: null, chatId: CHAT }]])
    expect(button('Stop agent').disabled).toBe(true)
  })

  it.each<[BrowserScenarioName, string]>([
    ['browser-empty', 'Take control'], ['browser-agent', 'Take control'], ['browser-person', 'Hand back'], ['browser-stopped', 'Hand back']
  ])('labels the toggle in %s "%s"', async (scenario, label) => {
    await mount(scenario)
    expect(screen.queryByRole('button', { name: label === 'Hand back' ? 'Take control' : 'Hand back' })).toBeNull()
    expect(button(label).disabled).toBe(false)
  })

  it('takes control from the agent and hands it back', async () => {
    await mount('browser-agent')
    fireEvent.click(button('Take control'))
    await waitFor(() => expect(badge()).toBe('You have control'))
    expect(browser.callsOf('takeControl')).toEqual([[{ folder: null, chatId: CHAT }]])
    fireEvent.click(button('Hand back'))
    await waitFor(() => expect(badge()).toBe('Driven by: an agent'))
    expect(browser.callsOf('handBack')).toEqual([[{ folder: null, chatId: CHAT }]])
    expect(button('Take control').disabled).toBe(false)
  })

  it('hands a stopped browser back to nobody', async () => {
    await mount('browser-stopped')
    fireEvent.click(button('Hand back'))
    await waitFor(() => expect(badge()).toBe('Idle'))
    expect(button('Take control').disabled).toBe(false)
  })

  it('shows a failed command inline', async () => {
    browser.failures.takeControl = { code: 'desktop_unavailable', message: 'The browser is not ready.' }
    await mount('browser-agent')
    fireEvent.click(button('Take control'))
    expect((await screen.findByRole('alert')).textContent).toBe('The browser is not ready.')
  })
})

describe('BrowserPanel toolbar', () => {
  it('navigates on Enter in the address bar and drops a draft on Escape', async () => {
    await mount('browser-person')
    const address = screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement
    fireEvent.change(address, { target: { value: 'example.org/draft' } })
    fireEvent.keyDown(address, { key: 'Escape' })
    expect(address.value).toBe('http://127.0.0.1:4173/docs/getting-started')
    fireEvent.change(address, { target: { value: '  https://example.org/page  ' } })
    fireEvent.keyDown(address, { key: 'Enter' })
    await waitFor(() => expect(browser.callsOf('navigate')).toEqual([[{ folder: null, chatId: CHAT, url: 'https://example.org/page' }]]))
  })

  it('sends Back, Forward and Reload as they are', async () => {
    await mount('browser-person')
    for (const name of ['Back', 'Forward', 'Reload']) fireEvent.click(button(name))
    await waitFor(() => expect(browser.calls.map((call) => call.method).filter((method) => ['back', 'forward', 'reload'].includes(method)))
      .toEqual(['back', 'forward', 'reload']))
  })

  it('opens a private tab from an inline address field, never window.prompt, and Escape cancels it', async () => {
    const prompt = vi.fn()
    vi.stubGlobal('prompt', prompt)
    await mount('browser-person')
    fireEvent.click(button('Private tab'))
    const field = screen.getByRole('textbox', { name: 'Private tab address' })
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: 'https://example.com/login' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(browser.callsOf('openSignIn')).toEqual([[{ folder: null, chatId: CHAT, url: 'https://example.com/login' }]]))
    expect(screen.queryByRole('textbox', { name: 'Private tab address' })).toBeNull()
    fireEvent.click(button('Private tab'))
    const second = screen.getByRole('textbox', { name: 'Private tab address' })
    fireEvent.change(second, { target: { value: 'https://example.com/other' } })
    fireEvent.keyDown(second, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Private tab address' })).toBeNull()
    expect(button('Private tab')).toBeTruthy()
    expect(browser.callsOf('openSignIn')).toHaveLength(1)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('re-reads the state after the enable switch, since main pushes none for it', async () => {
    await mount('browser-agent')
    const toggle = screen.getByRole('switch', { name: 'Let agents use this browser' }) as HTMLInputElement
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.checked).toBe(false))
    expect(browser.callsOf('setEnabled')).toEqual([[{ enabled: false }]])
    expect(browser.callsOf('state')).toHaveLength(2)
    expect(browser.subscribers()).toBe(1)
  })
})

describe('BrowserPanel view placement', () => {
  it('reports the content bounds on mount and resize, then null on unmount', async () => {
    const view = await mount('browser-agent')
    expect(setViews()).toEqual([{ x: 10, y: 20, width: 400, height: 300 }])
    box = { x: 10, y: 20, width: 520, height: 360 }
    act(() => resized())
    expect(setViews()).toEqual([{ x: 10, y: 20, width: 400, height: 300 }, { x: 10, y: 20, width: 520, height: 360 }])
    view.unmount()
    expect(setViews().at(-1)).toBeNull()
    expect(browser.callsOf('setView').at(-1)).toEqual([{ folder: null, chatId: CHAT, bounds: null }])
  })

  it('re-reads the rect on its poll when the box moves without resizing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await mount('browser-agent')
      box = { x: 60, y: 20, width: 400, height: 300 }
      act(() => { vi.advanceTimersByTime(250) })
      expect(setViews()).toEqual([{ x: 10, y: 20, width: 400, height: 300 }, { x: 60, y: 20, width: 400, height: 300 }])
      act(() => { vi.advanceTimersByTime(1000) })
      expect(setViews()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('hides the view for the chat it leaves and places it for the next', async () => {
    const view = await mount('browser-agent')
    view.rerender(<BrowserPanel folder={null} chatId="next-chat" api={browser} />)
    expect(browser.callsOf('setView').slice(1)).toEqual([
      [{ folder: null, chatId: CHAT, bounds: null }],
      [{ folder: null, chatId: 'next-chat', bounds: { x: 10, y: 20, width: 400, height: 300 } }]
    ])
  })

  it('sends null while the Lightbox is open and restores the bounds when it closes', async () => {
    browser.current = browserScenarios['browser-agent']
    const item = { id: 'img_1', label: 'Screenshot', width: 10, height: 10 }
    const page = (open: boolean): JSX.Element => <>
      <BrowserPanel folder={null} chatId={CHAT} api={browser} />
      {open && <Lightbox items={[item]} index={0} srcOf={() => 'data:,'} broken={new Set()} onBroken={() => undefined}
        onIndex={() => undefined} onClose={() => undefined} />}
    </>
    const view = render(page(false))
    await waitFor(() => expect(badge()).toBe('Driven by: Acolyte:DM-442'))
    view.rerender(page(true))
    expect(setViews()).toEqual([{ x: 10, y: 20, width: 400, height: 300 }, null])
    expect(screen.getByRole('region', { name: 'Browser page' }).textContent).toBe('Browser hidden while a dialog is open')
    view.rerender(page(false))
    expect(setViews()).toEqual([{ x: 10, y: 20, width: 400, height: 300 }, null, { x: 10, y: 20, width: 400, height: 300 }])
    expect(screen.getByRole('region', { name: 'Browser page' }).textContent).toBe('')
  })
})

describe('BrowserPanel under app modals', () => {
  it('hides the view while a Dialog is open', async () => {
    browser.current = browserScenarios['browser-person']
    const page = (open: boolean): JSX.Element => <>
      <BrowserPanel folder={null} chatId={CHAT} api={browser} />
      {open && <Dialog title="Delete chat" onClose={() => undefined} />}
    </>
    const view = render(page(false))
    await waitFor(() => expect(badge()).toBe('You have control'))
    view.rerender(page(true))
    expect(setViews().at(-1)).toBeNull()
    view.rerender(page(false))
    expect(setViews().at(-1)).toEqual({ x: 10, y: 20, width: 400, height: 300 })
  })
})

describe('Browser rail tab', () => {
  const RAIL = 'Epic agents'
  function railWith(state: BrowserState): RenderResult {
    browser.current = state
    vi.stubGlobal('dm', { browser })
    stored.set('dm.browserRail', JSON.stringify({ collapsed: false, tab: 'browser', cards: {} }))
    return render(<RightRail label={RAIL} storageKey="dm.browserRail"
      tabs={[{ id: 'agents', label: 'Agents', icon: 'agent', content: 'Agent tree' }, browserRailTab({ folder: null, folderKey: null, chatId: CHAT })]} />)
  }
  const rail = (): HTMLElement => screen.getByRole('complementary', { name: RAIL })

  it('widens the rail only while Browser is active and hides the view on switching to Agents', async () => {
    railWith(browserScenarios['browser-agent'])
    await waitFor(() => expect(badge()).toBe('Driven by: Acolyte:DM-442'))
    expect(rail().classList.contains('rr-wide')).toBe(true)
    expect(setViews()).toEqual([{ x: 10, y: 20, width: 400, height: 300 }])
    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))
    expect(rail().classList.contains('rr-wide')).toBe(false)
    expect(setViews()).toEqual([{ x: 10, y: 20, width: 400, height: 300 }, null])
    fireEvent.click(screen.getByRole('tab', { name: 'Browser' }))
    expect(rail().classList.contains('rr-wide')).toBe(true)
    expect(setViews().at(-1)).toEqual({ x: 10, y: 20, width: 400, height: 300 })
  })

  it('hides the view when the rail collapses, and the collapsed rail is narrow', async () => {
    railWith(browserScenarios['browser-person'])
    await waitFor(() => expect(badge()).toBe('You have control'))
    fireEvent.click(screen.getByRole('button', { name: `Collapse ${RAIL}` }))
    expect(rail().classList.contains('rr-wide')).toBe(false)
    expect(setViews().at(-1)).toBeNull()
  })
})

describe('BrowserPanel site card for a chat without its GUI column (terminal or thread)', () => {
  it('docks the site card above the page area, never inside it, and places the view over the page area alone', async () => {
    browser.current = browserScenarios['browser-origin']
    render(<BrowserPanel folder={null} chatId={CHAT} api={browser} siteCard />)
    const card = await screen.findByRole('alertdialog', { name: 'https://api.github.com' })
    const page = screen.getByRole('region', { name: 'Browser page' })
    expect(card.textContent).toMatch(/^Acolyte:DM-442 wants to open https:\/\/api\.github\.com/)
    expect(page.contains(card)).toBe(false)
    expect(card.compareDocumentPosition(page) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The view's bounds are the page area's own rect, which the card above it is not part of.
    expect(setViews()).toEqual([box])
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(browser.callsOf('decideOrigin')).toEqual([[{ folder: null, chatId: CHAT, promptId: 'origin-agent', decision: 'deny' }]])
  })

  it('shows no site card without siteCard, where the chat column shows it instead', async () => {
    await mount('browser-origin')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('docks it through the rail tab only when asked', async () => {
    browser.current = browserScenarios['browser-origin']
    vi.stubGlobal('dm', { browser })
    stored.set('dm.siteRail', JSON.stringify({ collapsed: false, tab: 'browser', cards: {} }))
    render(<RightRail label="Epic agents" storageKey="dm.siteRail" tabs={[browserRailTab({ folder: null, folderKey: null, chatId: CHAT, siteCard: true })]} />)
    expect(await screen.findByRole('alertdialog', { name: 'https://api.github.com' })).toBeTruthy()
  })
})

const FOLDER = '/work/repo'
const FOLDER_KEY = 'f00d'
const IMAGE = { id: 'ci_0123456789abcdefghjkmnpqrs', mime: 'image/png' as const, width: 1280, height: 800, bytes: 4096 }
const EPIC: ChatEpic = { epicId: 'ep_1', tickets: [{ id: 'tk_442', key: 'DM-442' }, { id: 'tk_7', key: 'DM-7' }], confirm: vi.fn() }
const camera = (): HTMLButtonElement => button('Capture the agent tab')
const popover = (): HTMLElement => screen.getByRole('dialog', { name: 'Captured page' })

/** The panel in a hand-wrapped chat: `composer` as the chat's images, `epic` as its epic, each optional. */
async function mountCamera(scenario: BrowserScenarioName, { composer, epic }: { composer?: ChatImagesHandle; epic?: ChatEpic } = {}): Promise<{
  agentChat: FakeAgentChat
}> {
  browser.current = browserScenarios[scenario]
  browser.captureResult = { ok: true, data: { image: IMAGE } }
  const agentChat = new FakeAgentChat()
  vi.stubGlobal('dm', { browser, agentChat })
  render(<ChatImagesContext.Provider value={composer ?? null}><BrowserEpicContext.Provider value={epic ?? null}>
    <BrowserPanel folder={FOLDER} folderKey={FOLDER_KEY} chatId={CHAT} api={browser} />
  </BrowserEpicContext.Provider></ChatImagesContext.Provider>)
  await waitFor(() => expect(badge()).not.toBe('Loading…'))
  return { agentChat }
}

async function snap(): Promise<HTMLElement> {
  fireEvent.click(camera())
  return screen.findByRole('dialog', { name: 'Captured page' })
}

describe('BrowserPanel camera popover (DM-873 c2)', () => {
  it('captures the chat, shows the thumbnail and hides the native view while the popover is open', async () => {
    await mountCamera('browser-agent', { composer: { addStaged: vi.fn(() => true) } })
    const shown = await snap()
    expect(browser.callsOf('capture')).toEqual([[{ folder: FOLDER, chatId: CHAT }]])
    expect(within(shown).getByRole('img').getAttribute('src')).toBe(chatImageUrl(FOLDER_KEY, CHAT, IMAGE.id))
    expect(setViews().at(-1)).toBeNull()
    expect(screen.getByRole('region', { name: 'Browser page' }).textContent).toBe('Browser hidden while the capture is open')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Captured page' })).toBeNull()
    expect(setViews().at(-1)).toEqual(box)
    expect(document.activeElement).toBe(camera())
  })

  it('shows a refused capture in the popover with no actions', async () => {
    browser.failures.capture = { code: 'view_hidden', message: 'The screenshot was refused: browser view not visible.' }
    await mountCamera('browser-agent', { composer: { addStaged: vi.fn(() => true) }, epic: EPIC })
    const shown = await snap()
    expect(within(shown).getByRole('alert').textContent).toBe('The screenshot was refused: browser view not visible.')
    expect(within(shown).queryByRole('button')).toBeNull()
  })

  it.each<[BrowserScenarioName, string]>([
    ['browser-empty', 'Capture the agent tab (no page open yet)'],
    ['browser-private', 'The private tab is never captured']
  ])('is off in %s: "%s"', async (scenario, title) => {
    await mountCamera(scenario)
    expect(camera().disabled).toBe(true)
    expect(camera().title).toBe(title)
  })
})

describe('BrowserPanel camera Add to message (DM-873 c2)', () => {
  it('adds the capture through the chat images context and closes; outside an epic only Add shows', async () => {
    const addStaged = vi.fn(() => true)
    await mountCamera('browser-agent', { composer: { addStaged } })
    const shown = await snap()
    expect(within(shown).getAllByRole('button').map((node) => node.textContent)).toEqual(['Add to message'])
    fireEvent.click(within(shown).getByRole('button', { name: 'Add to message' }))
    expect(addStaged).toHaveBeenCalledWith(IMAGE)
    expect(screen.queryByRole('dialog', { name: 'Captured page' })).toBeNull()
  })

  it('keeps the popover open with the reason when the message is already full', async () => {
    await mountCamera('browser-agent', { composer: { addStaged: () => false } })
    fireEvent.click(within(await snap()).getByRole('button', { name: 'Add to message' }))
    expect(within(popover()).getByRole('alert').textContent).toBe('The message already has as many images as it can take.')
  })

  it('turns Add to message off, saying why, when no composer is open for the chat', async () => {
    await mountCamera('browser-agent', { epic: EPIC })
    const shown = await snap()
    const add = within(shown).getByRole('button', { name: 'Add to message' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect(shown.textContent).toContain('No message is open for this chat here. Open its chat to add the capture to a message.')
  })
})

describe('BrowserPanel camera Attach as evidence (DM-873 c2)', () => {
  it("attaches as evidence to the driving agent's bound ticket in an epic, and confirms where", async () => {
    const { agentChat } = await mountCamera('browser-agent', { composer: { addStaged: vi.fn(() => true) }, epic: EPIC })
    const shown = await snap()
    expect(shown.textContent).toContain('Evidence goes to DM-442.')
    fireEvent.click(within(shown).getByRole('button', { name: 'Attach as evidence' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Captured page' })).toBeNull())
    expect(agentChat.callsOf('attachEvidence')).toEqual([[{ folder: FOLDER, chatId: CHAT, imageId: IMAGE.id, epicId: 'ep_1', ticketId: 'tk_442' }]])
    expect(EPIC.confirm).toHaveBeenCalledWith('Attached the capture to DM-442 as evidence.')
  })

  it('attaches to the epic when no bound agent drives the browser, and shows a refused attach inline', async () => {
    const { agentChat } = await mountCamera('browser-person', { epic: EPIC })
    agentChat.attachEvidenceResult = { ok: false, error: { code: 'unauthorized', message: 'This chat is not bound to the epic.' } }
    const shown = await snap()
    expect(shown.textContent).toContain('Evidence goes to the epic.')
    fireEvent.click(within(shown).getByRole('button', { name: 'Attach as evidence' }))
    expect((await within(popover()).findByRole('alert')).textContent).toBe('This chat is not bound to the epic.')
    expect(agentChat.callsOf('attachEvidence')).toEqual([[{ folder: FOLDER, chatId: CHAT, imageId: IMAGE.id, epicId: 'ep_1' }]])
  })
})

describe('BrowserPanel camera in a folder chat (DM-873 c2)', () => {
  it("adds the capture to the chat's own composer as a chip from the chat's rail", async () => {
    stored.set('dm.chatRail.v1:fixture-chat', JSON.stringify({ collapsed: false, tab: 'browser', cards: {} }))
    browser.current = browserScenarios['browser-agent']
    browser.captureResult = { ok: true, data: { image: IMAGE } }
    const agentChat = new FakeAgentChat()
    vi.stubGlobal('dm', { browser, agentChat })
    render(<AgentChat folder={null} folderKey={null} chatId={CHAT} agentLabel="Claude Code" api={agentChat} rail="toggle" />)
    await waitFor(() => expect(badge()).toBe('Driven by: Acolyte:DM-442'))
    fireEvent.click(button('Capture the agent tab'))
    const shown = await screen.findByRole('dialog', { name: 'Captured page' })
    expect(within(shown).queryByRole('button', { name: 'Attach as evidence' })).toBeNull()
    fireEvent.click(within(shown).getByRole('button', { name: 'Add to message' }))
    const chips = screen.getByRole('list', { name: 'Attached images' })
    expect(within(chips).getAllByRole('img').map((node) => node.getAttribute('src'))).toEqual([chatImageUrl(null, CHAT, IMAGE.id)])
  })
})
