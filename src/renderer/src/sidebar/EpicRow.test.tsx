// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { epicSummary, runSummary } from '../__mocks__/fixtures'
import type { EpicSummaryView } from '../../../shared/domain/views'
import { EpicRow } from './EpicRow'

afterEach(cleanup)

function renderRow(epic: EpicSummaryView, selected = false): string[] {
  const opened: string[] = []
  render(<EpicRow epic={epic} selected={selected} onOpen={(id) => opened.push(id)} />)
  return opened
}

const toneOf = (text: string): string | undefined =>
  screen.getByText(text).closest('.epic-status')?.className

describe('EpicRow content', () => {
  it('shows the title and a status line', () => {
    renderRow(epicSummary({ title: 'Packaging spike' }))
    expect(screen.getByText('Packaging spike')).toBeTruthy()
    expect(screen.getByText('Not started')).toBeTruthy()
  })

  it('shows a running epic with its sprint and a running dot', () => {
    renderRow(epicSummary({ status: 'in_progress', run: runSummary() }))
    expect(toneOf('Running · Sprint 2/3')).toBe('epic-status epic-status-running')
  })

  it('shows an epic awaiting a checkpoint as needing attention, in words', () => {
    renderRow(epicSummary({ status: 'in_progress', run: runSummary({ state: 'awaiting_checkpoint' }) }))
    expect(toneOf('Awaiting checkpoint')).toBe('epic-status epic-status-attention')
  })

  it('draws the status dot decoratively', () => {
    renderRow(epicSummary())
    expect(document.querySelector('.epic-status-dot')?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('EpicRow interaction', () => {
  it('opens the epic when clicked', () => {
    const opened = renderRow(epicSummary({ id: 'ep_x' }))
    fireEvent.click(screen.getByRole('button'))
    expect(opened).toEqual(['ep_x'])
  })

  it('highlights the selected row', () => {
    renderRow(epicSummary(), true)
    const row = screen.getByRole('button')
    expect(row.getAttribute('aria-current')).toBe('true')
    expect(row.className).toBe('epic-row is-selected')
  })

  it('leaves other rows plain', () => {
    renderRow(epicSummary(), false)
    const row = screen.getByRole('button')
    expect(row.getAttribute('aria-current')).toBeNull()
    expect(row.className).toBe('epic-row')
  })
})

describe('EpicRow badges', () => {
  it('shows a draft badge', () => {
    renderRow(epicSummary({ hasDraft: true }))
    expect(screen.getByText('draft').className).toBe('badge badge-draft')
  })

  it('shows save pending and conflict badges with explanatory titles', () => {
    renderRow(epicSummary({ pendingSave: true, conflict: 'Changed on disk' }))
    expect(screen.getByText('save pending').className).toBe('badge badge-save-pending')
    expect(screen.getByText('conflict').getAttribute('title')).toBe('Changed on disk')
  })

  it('shows no badges for a clean epic', () => {
    renderRow(epicSummary())
    expect(document.querySelector('.badge')).toBeNull()
  })
})
