import { describe, expect, it } from 'vitest'
import { epicSummary, runSummary } from '../__mocks__/fixtures'
import type { EpicSummaryView } from '../../../shared/domain/views'
import type { EpicStatusLine } from './epicStatusLine'
import { epicBadges, epicStatusLine, formatShortDate } from './epicStatusLine'

const running = (patch: Parameters<typeof runSummary>[0]): Partial<EpicSummaryView> => ({
  status: 'in_progress',
  run: runSummary(patch)
})

const CASES: [string, Partial<EpicSummaryView>, EpicStatusLine][] = [
  [
    'running in a sprint',
    running({ state: 'running', activeSprintOrdinal: 2, sprintCount: 3 }),
    { text: 'Running · Sprint 2/3', tone: 'running' }
  ],
  [
    'running before a sprint is active',
    running({ state: 'running', activeSprintOrdinal: null, sprintCount: 3 }),
    { text: 'Running', tone: 'running' }
  ],
  [
    'running with no sprints',
    running({ state: 'running', activeSprintOrdinal: 1, sprintCount: 0 }),
    { text: 'Running', tone: 'running' }
  ],
  [
    'awaiting a checkpoint',
    running({ state: 'awaiting_checkpoint' }),
    { text: 'Awaiting checkpoint', tone: 'attention' }
  ],
  ['paused', running({ state: 'paused' }), { text: 'Paused', tone: 'paused' }],
  ['queued', running({ state: 'queued' }), { text: 'Queued', tone: 'queued' }],
  ['a failed run', running({ state: 'failed' }), { text: 'Run failed', tone: 'failed' }],
  ['a canceled run', running({ state: 'canceled' }), { text: 'Run canceled', tone: 'idle' }],
  [
    'a never-saved draft',
    { currentRevisionId: null, currentRevisionNumber: null, hasDraft: true },
    { text: 'Draft · not saved', tone: 'draft' }
  ],
  ['a saved backlog epic', {}, { text: 'Not started', tone: 'idle' }],
  ['an in-progress epic without a run', { status: 'in_progress' }, { text: 'In progress', tone: 'idle' }],
  [
    'a finished run on an open epic',
    running({ state: 'completed' }),
    { text: 'In progress', tone: 'idle' }
  ]
]

describe('epicStatusLine', () => {
  it.each(CASES)('describes %s', (_name, patch, expected) => {
    expect(epicStatusLine(epicSummary(patch))).toEqual(expected)
  })
})

describe('epicStatusLine for completed epics', () => {
  it('shows the completion date', () => {
    const epic = epicSummary({ status: 'completed', completedAt: '2026-03-15T12:00:00.000Z' })
    expect(epicStatusLine(epic)).toEqual({ text: 'Completed Mar 15, 2026', tone: 'completed' })
  })

  it('omits the date when none is recorded', () => {
    const epic = epicSummary({ status: 'completed', completedAt: null })
    expect(epicStatusLine(epic)).toEqual({ text: 'Completed', tone: 'completed' })
  })

  it('prefers completion over a leftover run', () => {
    const epic = epicSummary({ ...running({ state: 'running' }), status: 'completed' })
    expect(epicStatusLine(epic).tone).toBe('completed')
  })
})

describe('formatShortDate', () => {
  it('formats a date with month name, day and year', () => {
    expect(formatShortDate('2026-09-30T12:00:00.000Z')).toBe('Sep 30, 2026')
  })

  it('does not pad the day', () => {
    expect(formatShortDate('2026-01-05T12:00:00.000Z')).toBe('Jan 5, 2026')
  })

  it('covers the last month of the year', () => {
    expect(formatShortDate('2026-12-31T12:00:00.000Z')).toBe('Dec 31, 2026')
  })

  it('returns unparseable input unchanged', () => {
    expect(formatShortDate('not a date')).toBe('not a date')
  })
})

describe('epicBadges', () => {
  it('has no badges for a clean epic', () => {
    expect(epicBadges(epicSummary())).toEqual([])
  })

  it('flags an unsaved draft', () => {
    expect(epicBadges(epicSummary({ hasDraft: true }))).toEqual([
      { kind: 'draft', label: 'draft', title: 'Has unsaved draft changes' }
    ])
  })

  it('flags a save that is waiting to be written to the repository', () => {
    expect(epicBadges(epicSummary({ pendingSave: true })).map((badge) => badge.label)).toEqual([
      'save pending'
    ])
  })

  it('flags a conflict and carries its message', () => {
    expect(epicBadges(epicSummary({ conflict: 'Changed on disk' }))).toEqual([
      { kind: 'conflict', label: 'conflict', title: 'Changed on disk' }
    ])
  })

  it('lists draft, save pending and conflict in that order', () => {
    const epic = epicSummary({ hasDraft: true, pendingSave: true, conflict: 'x' })
    expect(epicBadges(epic).map((badge) => badge.kind)).toEqual(['draft', 'save-pending', 'conflict'])
  })
})
