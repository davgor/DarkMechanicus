/**
 * How a later plan revision changed a sprint a report was written for: its exit criteria and its required
 * tickets, with the retro's leftovers (and the tickets that require them) allowed to leave.
 */
import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import { makeBundle, makeTicket, sid, tid } from '../../test/bundles'
import { sprintScopeChanges } from './sprintScope'

/** Sprint 1: DM-1..DM-4 (DM-3 requires DM-2, DM-4 requires DM-3). Sprint 2: DM-5. */
function before(): PlanBundle {
  return makeBundle([[1, 2, 3, 4], [5]], [[2, 3], [3, 4]])
}

/** The same tickets, laid out as `first` in sprint 1 and `second` in sprint 2. */
function layout(first: number[], second: number[]): PlanBundle {
  const bundle = before()
  const ids = [first.map(tid), second.map(tid)]
  return { ...bundle, sprints: bundle.sprints.map((sprint, index) => ({ ...sprint, ticketIds: ids[index] ?? [] })) }
}

function withExitCriterion(bundle: PlanBundle): PlanBundle {
  return {
    ...bundle,
    sprints: bundle.sprints.map((sprint) =>
      sprint.ordinal === 1 ? { ...sprint, exitCriteria: [{ id: 'x1', text: 'The parser ships' }] } : sprint
    )
  }
}

function withOptional(bundle: PlanBundle, ticket: number): PlanBundle {
  return { ...bundle, tickets: bundle.tickets.map((item) => (item.id === tid(ticket) ? { ...item, optional: true } : item)) }
}

function changes(after: PlanBundle, leftovers: number[] = [2]): string[] {
  return sprintScopeChanges({ before: before(), after, sprintId: sid(1), leftovers: leftovers.map(tid) })
}

describe('sprintScopeChanges: what removing leftovers allows', () => {
  it('finds nothing when the sprint is unchanged', () => {
    expect(changes(before())).toEqual([])
  })

  it('finds nothing when only a leftover and the tickets that require it, directly or not, left the sprint', () => {
    expect(changes(layout([1], [5, 2, 3, 4]))).toEqual([])
    expect(changes(layout([1, 2], [5, 3, 4]), [3])).toEqual([])
  })

  it('does not count a prerequisite of a leftover as one', () => {
    expect(changes(layout([1, 4], [5, 2, 3]), [3])).toEqual(['it no longer requires DM-2'])
  })

  it('ignores optional tickets coming and going, and edits to a ticket that stays', () => {
    const after = layout([1, 2, 3, 4, 9], [5])
    after.tickets = [
      ...after.tickets.map((ticket) => (ticket.id === tid(1) ? { ...ticket, title: 'Retitled' } : ticket)),
      makeTicket(9, { optional: true })
    ]
    expect(changes(after)).toEqual([])
    expect(sprintScopeChanges({ before: after, after: before(), sprintId: sid(1), leftovers: [] })).toEqual([])
  })
})

describe('sprintScopeChanges: what goes beyond removing leftovers', () => {
  it('names a required ticket that left the sprint without being a leftover or requiring one', () => {
    expect(changes(layout([2, 3, 4], [5, 1]))).toEqual(['it no longer requires DM-1'])
  })

  it('names a required ticket that joined the sprint, or that stopped being optional', () => {
    expect(changes(layout([1, 2, 3, 4, 5], []))).toEqual(['it now requires DM-5'])
    const optional = withOptional(before(), 1)
    expect(sprintScopeChanges({ before: optional, after: before(), sprintId: sid(1), leftovers: [] })).toEqual([
      'it now requires DM-1'
    ])
    expect(sprintScopeChanges({ before: before(), after: optional, sprintId: sid(1), leftovers: [] })).toEqual([
      'it no longer requires DM-1'
    ])
  })

  it('names changed exit criteria', () => {
    expect(changes(withExitCriterion(before()))).toEqual(['its exit criteria changed'])
  })

  it('names every change at once, in a fixed order, with keys in sprint order', () => {
    const after = withExitCriterion(layout([3, 4, 5], [1, 2]))
    expect(changes(after, [])).toEqual(['its exit criteria changed', 'it now requires DM-5', 'it no longer requires DM-1, DM-2'])
  })
})
