// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EPIC_A, EPIC_B, EPIC_C, epicSummary, localNoonIso, runSummary } from '../__mocks__/fixtures'
import type { EpicListState } from '../app/useEpicLists'
import { EpicBuckets } from './EpicBuckets'

afterEach(cleanup)

const ready = (epics: ReturnType<typeof epicSummary>[]): EpicListState => ({ status: 'ready', epics, error: null })

function renderBuckets(list: EpicListState): string[] {
  const opened: string[] = []
  render(<EpicBuckets list={list} onOpenEpic={(id) => opened.push(id)} />)
  return opened
}

const mixed = ready([
  epicSummary({ id: EPIC_A, title: 'Running one', status: 'in_progress', run: runSummary(), hasDraft: true }),
  epicSummary({ id: EPIC_B, title: 'Waiting one', status: 'backlog', ticketCount: 1, sprintCount: 1 }),
  epicSummary({ id: EPIC_C, title: 'Done one', status: 'completed', completedAt: localNoonIso(2026, 3, 15) })
])

describe('EpicBuckets states', () => {
  it('shows a loading note before the first response', () => {
    renderBuckets({ status: 'loading', epics: [], error: null })
    expect(screen.getByText('Loading epics…')).toBeTruthy()
  })

  it('explains how to create the first epic when there are none', () => {
    renderBuckets(ready([]))
    expect(screen.getByRole('heading', { name: 'No epics yet' })).toBeTruthy()
    expect(screen.getByText(/Use New epic to create one here/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says when the last refresh failed but keeps the epics', () => {
    renderBuckets({ ...mixed, status: 'error', error: 'database is locked' })
    expect(screen.getByText('Could not refresh epics: database is locked')).toBeTruthy()
    expect(screen.getByText('Running one')).toBeTruthy()
  })
})

describe('EpicBuckets sections', () => {
  it('lists In progress, Backlog and Completed in order with counts', () => {
    renderBuckets(mixed)
    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(headings).toEqual(['In progress1', 'Backlog1', 'Completed1'])
  })

  it('shows None for an empty bucket', () => {
    renderBuckets(ready([epicSummary({ status: 'backlog' })]))
    const inProgress = screen.getByRole('region', { name: 'In progress' })
    expect(within(inProgress).getByText('None')).toBeTruthy()
  })

  it('shows each epic with its status, badges and size', () => {
    renderBuckets(mixed)
    const running = screen.getByRole('button', { name: /Running one/ })
    expect(within(running).getByText('Running · Sprint 2/3')).toBeTruthy()
    expect(within(running).getByText('draft')).toBeTruthy()
    expect(within(running).getByText('4 tickets · 2 sprints')).toBeTruthy()
    expect(within(screen.getByRole('button', { name: /Waiting one/ })).getByText('1 ticket · 1 sprint')).toBeTruthy()
    expect(within(screen.getByRole('button', { name: /Done one/ })).getByText('Completed Mar 15, 2026')).toBeTruthy()
  })

  it('opens an epic when its card is pressed', () => {
    const opened = renderBuckets(mixed)
    fireEvent.click(screen.getByRole('button', { name: /Waiting one/ }))
    expect(opened).toEqual([EPIC_B])
  })
})
