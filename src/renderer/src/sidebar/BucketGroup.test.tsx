// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EPIC_A, EPIC_B, epicSummary } from '../__mocks__/fixtures'
import type { EpicSummaryView } from '../../../shared/domain/views'
import { BucketGroup } from './BucketGroup'
import { groupEpics } from './buckets'
import type { Bucket } from './buckets'

afterEach(cleanup)

const epics = [
  epicSummary({ id: EPIC_A, title: 'First', status: 'backlog' }),
  epicSummary({ id: EPIC_B, title: 'Second', status: 'backlog', createdAt: '2026-02-01T00:00:00.000Z' })
]

function bucketOf(list: EpicSummaryView[], id: Bucket['id']): Bucket {
  const found = groupEpics(list).find((bucket) => bucket.id === id)
  if (found === undefined) throw new Error(`no ${id} bucket`)
  return found
}

interface Calls {
  toggles: number
  opened: string[]
}

function renderGroup(bucket: Bucket, expanded: boolean, selectedEpicId: string | null = null): Calls {
  const calls: Calls = { toggles: 0, opened: [] }
  render(
    <BucketGroup
      bucket={bucket}
      expanded={expanded}
      selectedEpicId={selectedEpicId}
      onToggle={() => {
        calls.toggles += 1
      }}
      onOpenEpic={(id) => calls.opened.push(id)}
    />
  )
  return calls
}

const backlog = bucketOf(epics, 'backlog')
const header = (): HTMLElement => screen.getByRole('button', { name: 'Backlog, 2 epics' })

describe('BucketGroup header', () => {
  it('shows the bucket label and count, and names both for assistive tech', () => {
    renderGroup(backlog, true)
    expect(header().querySelector('.bucket-label')?.textContent).toBe('Backlog')
    expect(header().querySelector('.count-badge')?.textContent).toBe('2')
  })

  it('reports whether it is expanded', () => {
    renderGroup(backlog, true)
    expect(header().getAttribute('aria-expanded')).toBe('true')
    cleanup()
    renderGroup(backlog, false)
    expect(header().getAttribute('aria-expanded')).toBe('false')
  })

  it('asks to toggle when clicked', () => {
    const calls = renderGroup(backlog, true)
    fireEvent.click(header())
    expect(calls.toggles).toBe(1)
  })

  it('shows zero counts and the singular for one epic', () => {
    renderGroup(bucketOf([], 'in_progress'), true)
    expect(screen.getByRole('button', { name: 'In progress, 0 epics' })).toBeTruthy()
    cleanup()
    renderGroup(bucketOf([epicSummary({ status: 'backlog' })], 'backlog'), true)
    expect(screen.getByRole('button', { name: 'Backlog, 1 epic' })).toBeTruthy()
  })
})

describe('BucketGroup rows', () => {
  it('lists the epics in order when expanded', () => {
    renderGroup(backlog, true)
    const titles = screen.getAllByRole('listitem').map((item) => item.querySelector('.epic-row-title')?.textContent)
    expect(titles).toEqual(['First', 'Second'])
  })

  it('hides the epics when collapsed', () => {
    renderGroup(backlog, false)
    expect(screen.queryByText('First')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('opens an epic from its row', () => {
    const calls = renderGroup(backlog, true)
    fireEvent.click(screen.getByRole('button', { name: /Second/ }))
    expect(calls.opened).toEqual([EPIC_B])
  })

  it('highlights only the selected epic', () => {
    renderGroup(backlog, true, EPIC_B)
    expect(screen.getByRole('button', { name: /Second/ }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: /First/ }).getAttribute('aria-current')).toBeNull()
  })
})
