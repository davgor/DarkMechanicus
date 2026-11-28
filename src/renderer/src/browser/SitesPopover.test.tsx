// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { browserSetViewSchema } from '../../../shared/browser/browserApi'
import { FakeBrowser } from '../__mocks__/fakeBrowser'
import { settle } from '../__mocks__/settle'
import { BrowserPanel } from './BrowserPanel'
import { browserScenarios, browserSites } from './__mocks__/browserScenario'

const FOLDER = 'C:/work/fixture-repo'
const PAGE = { x: 10, y: 20, width: 400, height: 300 }
let browser: FakeBrowser

beforeEach(() => {
  browser = new FakeBrowser()
  browser.siteList = [...browserSites]
  vi.stubGlobal('ResizeObserver', class {
    observe() { /* placement also polls */ }
    disconnect() { /* nothing to release */ }
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const rect = this.classList.contains('bp-content') ? PAGE : { x: 0, y: 0, width: 0, height: 0 }
    return { ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => rect } as DOMRect
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount(): Promise<void> {
  browser.current = { ...browserScenarios['browser-agent'], folder: FOLDER }
  render(<BrowserPanel folder={FOLDER} chatId="fixture-chat" api={browser} />)
  await waitFor(() => expect(screen.getByRole('status', { name: 'Browser owner' }).textContent).not.toBe('Loading…'))
}

const trigger = (): HTMLElement => screen.getByRole('button', { name: 'Sites' })
const popover = (): HTMLElement => screen.getByRole('dialog', { name: 'Always-allowed sites' })
const listed = (): string[] => within(popover()).queryAllByRole('listitem').map((row) => row.firstElementChild?.textContent ?? '')
const lastBounds = (): unknown => browserSetViewSchema.parse(browser.callsOf('setView').at(-1)?.[0]).bounds

async function open(): Promise<void> {
  fireEvent.click(trigger())
  await settle()
}

it('lists the folder’s always-allowed origins as plain text, each with Remove', async () => {
  await mount()
  expect(trigger().getAttribute('aria-expanded')).toBe('false')
  await open()
  expect(trigger().getAttribute('aria-expanded')).toBe('true')
  expect(browser.callsOf('sites')).toEqual([[{ folder: FOLDER }]])
  expect(listed()).toEqual(browserSites)
  expect(popover().querySelector('a')).toBeNull()
  for (const origin of browserSites) expect(within(popover()).getByRole('button', { name: `Remove ${origin}` })).toBeTruthy()
})

it('removes one site, and the removal holds when the list is read again', async () => {
  await mount()
  await open()
  fireEvent.click(within(popover()).getByRole('button', { name: 'Remove https://github.com' }))
  await settle()
  expect(browser.callsOf('removeSite')).toEqual([[{ folder: FOLDER, origin: 'https://github.com' }]])
  expect(listed()).toEqual(['https://docs.example.com', 'http://127.0.0.1:4173'])
  fireEvent.click(trigger())
  expect(screen.queryByRole('dialog')).toBeNull()
  await open()
  expect(browser.callsOf('sites')).toHaveLength(2)
  expect(listed()).toEqual(['https://docs.example.com', 'http://127.0.0.1:4173'])
})

it('keeps the site and shows the error when Remove fails', async () => {
  await mount()
  await open()
  browser.failures.removeSite = { code: 'operation_unavailable', message: 'The site list could not be saved.' }
  fireEvent.click(within(popover()).getByRole('button', { name: 'Remove https://github.com' }))
  await settle()
  expect(within(popover()).getByRole('alert').textContent).toBe('The site list could not be saved.')
  expect(listed()).toEqual(browserSites)
})

it('says so when no site is always allowed, and shows a failed read', async () => {
  browser.siteList = []
  await mount()
  await open()
  expect(within(popover()).getByText('No sites are always allowed yet. Choose Always allow on a site prompt to add one.')).toBeTruthy()
  fireEvent.click(trigger())
  browser.failures.sites = { code: 'operation_unavailable', message: 'The site list could not be read.' }
  await open()
  expect(within(popover()).getByRole('alert').textContent).toBe('The site list could not be read.')
})

it('hides the native view while open, since the popover drops over the page, and places it again on Escape', async () => {
  await mount()
  expect(lastBounds()).toEqual(PAGE)
  await open()
  expect(lastBounds()).toBeNull()
  expect(screen.getByRole('region', { name: 'Browser page' }).textContent).toBe('Browser hidden while a dialog is open')
  act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger())
  expect(lastBounds()).toEqual(PAGE)
})

it('closes on a press outside it, and not on one inside', async () => {
  await mount()
  await open()
  fireEvent.mouseDown(popover())
  expect(popover()).toBeTruthy()
  fireEvent.mouseDown(document.body)
  expect(screen.queryByRole('dialog')).toBeNull()
})
