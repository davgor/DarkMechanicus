// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RailCard, RightRail } from './RightRail'
import type { RailTab } from './RightRail'

const tabs: RailTab[] = [
  { id: 'files', label: 'Files', icon: 'file', content: 'File list' },
  { id: 'agents', label: 'Agents', icon: 'branch', badge: { text: '2', tone: 'attention' }, content: <RailCard id="todos" title="To-dos" count={0}>Task list</RailCard> }
]
let stored: Map<string, string>

beforeEach(() => {
  stored = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value) }
  })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount(storageKey = 'dm.testRail.one'): ReturnType<typeof render> {
  return render(<RightRail label="Agent rail" storageKey={storageKey} tabs={tabs} />)
}
const rail = (): HTMLElement => screen.getByRole('complementary', { name: 'Agent rail' })

// The rail owns no epic/chat identifiers; consumers supply their own storage namespaces.
describe('RightRail', () => {
  it('orders supplied tabs and connects the selected tab to its panel without placeholders', () => {
    mount()
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agents2', 'Files'])
    expect(screen.queryByRole('tab', { name: 'Browser' })).toBeNull()
    const agents = screen.getByRole('tab', { name: 'Agents 2' })
    expect(agents.getAttribute('aria-selected')).toBe('true')
    expect(agents.getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel').id)
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))
    expect(screen.getByRole('tabpanel').textContent).toBe('File list')
  })

  it('collapses to badge buttons and expands on the chosen tab', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Agent rail' }))
    expect(rail().dataset.collapsed).toBe('true')
    expect(screen.getByRole('button', { name: 'Expand Agent rail' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: 'Agents: 2' }).textContent).toBe('2')
    fireEvent.click(screen.getByRole('button', { name: 'Files' }))
    expect(rail().dataset.collapsed).toBe('false')
    expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Agent rail' }))
    fireEvent.click(screen.getByRole('button', { name: 'Agents: 2' }))
    expect(screen.getByRole('tab', { name: 'Agents 2' }).getAttribute('aria-selected')).toBe('true')
  })

})

describe('RightRail storage validation', () => {
  it('remembers collapse and tab state without leaking to another key, including in-place key changes', () => {
    const first = mount()
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Agent rail' }))
    first.unmount()
    const same = mount()
    expect(rail().dataset.collapsed).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Expand Agent rail' }))
    expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true')
    same.rerender(<RightRail label="Agent rail" storageKey="dm.testRail.other" tabs={tabs} />)
    expect(rail().dataset.collapsed).toBe('false')
    expect(screen.getByRole('tab', { name: 'Agents 2' }).getAttribute('aria-selected')).toBe('true')
    same.unmount()
    mount()
    expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true')
  })

  it.each([
    '{"collapsed":"yes"}', 'invalid json', 'null', '[]',
    '{"collapsed":false,"tab":"unknown","cards":{}}',
    '{"collapsed":false,"tab":"files","cards":[]}',
    '{"collapsed":false,"tab":"files","cards":{"todos":"no"}}',
    '{"collapsed":false,"tab":"files","cards":{},"extra":true}'
  ])('discards corrupt or non-strict stored state: %s', (value) => {
    stored.set('dm.testRail.one', value)
    mount()
    expect(rail().dataset.collapsed).toBe('false')
    expect(screen.getByRole('tab', { name: 'Agents 2' }).getAttribute('aria-selected')).toBe('true')
  })

})

describe('RightRail responsive defaults', () => {
  it('starts collapsed below 1100px only when valid memory is absent', () => {
    const media = vi.fn((query: string) => ({ matches: query === '(max-width: 1099px)' }))
    vi.stubGlobal('matchMedia', media)
    const first = mount()
    expect(rail().dataset.collapsed).toBe('true')
    expect(media).toHaveBeenCalledWith('(max-width: 1099px)')
    fireEvent.click(screen.getByRole('button', { name: 'Expand Agent rail' }))
    first.unmount()
    mount()
    expect(rail().dataset.collapsed).toBe('false')
  })

  it('defaults to expanded if matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    mount()
    expect(rail().dataset.collapsed).toBe('false')
  })

})

describe('RightRail cards', () => {
  it('remembers card state per rail key and treats prototype-like card ids as ordinary ids', () => {
    const first = mount()
    const card = screen.getByRole('button', { name: 'To-dos 0' })
    expect(card.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(card)
    expect(screen.getByText('Task list').hidden).toBe(true)
    first.unmount()
    const same = mount()
    expect(screen.getByRole('button', { name: 'To-dos 0' }).getAttribute('aria-expanded')).toBe('false')
    same.unmount()
    const other = mount('dm.testRail.other')
    expect(screen.getByRole('button', { name: 'To-dos 0' }).getAttribute('aria-expanded')).toBe('true')
    other.rerender(<RightRail label="Agent rail" storageKey="dm.testRail.other" tabs={[{ ...tabs[1], content: <RailCard id="constructor" title="Changes">Files changed</RailCard> }]} />)
    const changes = screen.getByRole('button', { name: 'Changes' })
    expect(changes.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(changes)
    expect(changes.getAttribute('aria-expanded')).toBe('false')
  })

})

describe('RightRail tab selection', () => {
  it('falls back to the first supplied tab if the remembered tab is absent', () => {
    stored.set('dm.testRail.one', JSON.stringify({ collapsed: false, tab: 'browser', cards: {} }))
    mount()
    expect(screen.getByRole('tab', { name: 'Agents 2' }).getAttribute('aria-selected')).toBe('true')
  })

  it('supports keyboard tab navigation', () => {
    mount()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Agents 2' }), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Files' }))
    expect(screen.getByRole('tabpanel').textContent).toBe('File list')
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Agents 2' }))
  })

})
