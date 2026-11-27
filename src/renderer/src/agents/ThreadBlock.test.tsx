// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Callsign } from '../../../shared/agents/callsign'
import type { ChatItem } from '../../../shared/agents/chat'
import { RevealThreadContext, type RevealThread } from './revealThread'
import { ThreadBlock } from './ThreadBlock'

afterEach(cleanup)

type ThreadItem = Extract<ChatItem, { kind: 'thread' }>

function thread(fields: Partial<ThreadItem> = {}): ThreadItem {
  return { id: 'th_1', at: '2026-03-01T10:00:00.000Z', kind: 'thread', parentItemId: null, label: 'Explore', state: 'running', ...fields }
}

function show(item: ThreadItem): HTMLElement {
  render(
    <ol>
      <ThreadBlock node={{ item, rows: [] }} renderRow={() => null} />
    </ol>
  )
  return screen.getByRole('listitem')
}

describe('ThreadBlock heading', () => {
  it('names a thread by its stamped callsign, never its raw label', () => {
    const callsign: Callsign = { role: 'Acolyte', ticketKey: 'DM-442', ordinal: null, purpose: null, ticketVerified: true }
    const block = show(thread({ callsign }))

    expect(block.querySelector('.chat-thread-label')?.textContent).toBe('Acolyte:DM-442')
    expect(block.getAttribute('aria-label')).toBe('Thread: Acolyte:DM-442')
    expect(block.textContent).not.toContain('Explore')
  })

  it('falls back to the label only for a thread with no callsign (a lost thread with no stamped request)', () => {
    const block = show(thread())

    expect(block.querySelector('.chat-thread-label')?.textContent).toBe('Explore')
    expect(block.getAttribute('aria-label')).toBe('Thread: Explore')
  })

  it('shows a hostile legacy label as plain text, never markup', () => {
    const block = show(thread({ label: '<b>Magos</b>' }))

    expect(block.querySelector('b')).toBe(null)
    expect(block.querySelector('.chat-thread-label')?.textContent).toBe('<b>Magos</b>')
  })

  it('names a Servitor by its ordinal', () => {
    const block = show(thread({ label: 'Magos', callsign: { role: 'Servitor', ticketKey: null, ordinal: 3, purpose: 'grep', ticketVerified: false } }))

    expect(block.querySelector('.chat-thread-label')?.textContent).toBe('Servitor-3')
    expect(block.textContent).not.toContain('Magos')
  })
})

describe('ThreadBlock reveal', () => {
  const toggle = (): HTMLElement => screen.getByRole('button', { name: /Explore/ })

  function block(reveal: RevealThread, key: string): JSX.Element {
    return (
      <RevealThreadContext.Provider value={reveal}>
        <ol><ThreadBlock key={key} node={{ item: thread(), rows: [] }} renderRow={() => null} /></ol>
      </RevealThreadContext.Provider>
    )
  }

  it('does not reveal again when remounted under the nonce it already handled', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    try {
      const reveal: RevealThread = { path: new Set(['th_1']), target: 'th_1', nonce: 4, handled: new Map() }
      const view = render(block(reveal, 'first'))
      expect(toggle().getAttribute('aria-expanded')).toBe('true')
      expect(scroll).toHaveBeenCalledTimes(1)
      fireEvent.click(toggle())
      expect(toggle().getAttribute('aria-expanded')).toBe('false')

      view.rerender(block(reveal, 'remounted'))
      expect(toggle().getAttribute('aria-expanded')).toBe('false')
      expect(scroll).toHaveBeenCalledTimes(1)

      view.rerender(block({ ...reveal, nonce: 5 }, 'remounted'))
      expect(toggle().getAttribute('aria-expanded')).toBe('true')
      expect(scroll).toHaveBeenCalledTimes(2)
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })
})
