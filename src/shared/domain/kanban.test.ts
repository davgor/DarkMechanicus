import { describe, expect, it } from 'vitest'
import { KANBAN_ATTEMPT_STATES, KANBAN_LANE_LABELS, KANBAN_LANES, KANBAN_OPEN_ATTEMPT_STATES } from './kanban'

describe('kanban lanes', () => {
  it('orders the lanes from backlog to done, each with its label', () => {
    expect(KANBAN_LANES.map((lane) => [lane, KANBAN_LANE_LABELS[lane]])).toEqual([
      ['backlog', 'Backlog'],
      ['in_progress', 'In progress'],
      ['ready_for_review', 'Ready for review'],
      ['done', 'Done']
    ])
  })
})

describe('kanban attempt states', () => {
  it('has no canceled state, and only claimed, running and submitted attempts are open', () => {
    expect(KANBAN_ATTEMPT_STATES).toEqual(['claimed', 'running', 'submitted', 'accepted', 'rejected', 'failed', 'lease_expired'])
    expect(KANBAN_OPEN_ATTEMPT_STATES).toEqual(['claimed', 'running', 'submitted'])
  })
})
