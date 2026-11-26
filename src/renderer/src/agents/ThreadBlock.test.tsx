// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Callsign } from '../../../shared/agents/callsign'
import type { ChatItem } from '../../../shared/agents/chat'
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

  it('falls back to the label only for a thread stored before callsigns', () => {
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
