import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import { makeBundle, makeTicket, sid, tid } from '../../test/bundles'
import { acceptanceNodeOf, acceptanceTitle, implicitPrerequisitesOf, isAcceptanceTicket } from './acceptance'

/**
 * Sprint 1: work 1, optional work 2, acceptance 3, work 4. Sprint 2: work 5 and acceptance 6.
 * Sprint 3: work 7 only (no acceptance node).
 */
function acceptanceBundle(): PlanBundle {
  const bundle = makeBundle([[1, 2, 3, 4], [5, 6], [7]])
  bundle.tickets = bundle.tickets.map((ticket) => {
    if (ticket.id === tid(2)) {
      return { ...ticket, optional: true }
    }
    return ticket.id === tid(3) || ticket.id === tid(6) ? { ...ticket, kind: 'acceptance' as const } : ticket
  })
  return bundle
}

describe('isAcceptanceTicket', () => {
  it('is true only for a ticket whose kind is acceptance', () => {
    expect(isAcceptanceTicket(makeTicket(1, { kind: 'acceptance' }))).toBe(true)
  })

  it('treats a ticket with no kind, and one whose kind is work, as work', () => {
    expect(isAcceptanceTicket(makeTicket(1))).toBe(false)
    expect(isAcceptanceTicket(makeTicket(1, { kind: 'work' }))).toBe(false)
  })
})

describe('acceptanceNodeOf', () => {
  it('returns the acceptance node a sprint lists', () => {
    const bundle = acceptanceBundle()
    expect(acceptanceNodeOf(bundle, sid(1))?.id).toBe(tid(3))
    expect(acceptanceNodeOf(bundle, sid(2))?.id).toBe(tid(6))
  })

  it('returns undefined for a sprint without a node and for an unknown sprint', () => {
    const bundle = acceptanceBundle()
    expect(acceptanceNodeOf(bundle, sid(3))).toBeUndefined()
    expect(acceptanceNodeOf(bundle, sid(99))).toBeUndefined()
  })

  it('returns the first node in sprint order when a malformed sprint lists two', () => {
    const bundle = acceptanceBundle()
    bundle.tickets = bundle.tickets.map((ticket) => (ticket.id === tid(4) ? { ...ticket, kind: 'acceptance' as const } : ticket))
    expect(acceptanceNodeOf(bundle, sid(1))?.id).toBe(tid(3))
  })

  it('ignores a sprint entry that names no ticket', () => {
    const bundle = acceptanceBundle()
    bundle.sprints[2].ticketIds = ['tk_missing', tid(7)]
    expect(acceptanceNodeOf(bundle, sid(3))).toBeUndefined()
  })
})

describe('implicitPrerequisitesOf', () => {
  it('lists the required work tickets of the node sprint, in sprint order', () => {
    expect(implicitPrerequisitesOf(acceptanceBundle(), tid(3))).toEqual([tid(1), tid(4)])
  })

  it('leaves out optional tickets, other sprints and the node itself', () => {
    const bundle = acceptanceBundle()
    expect(implicitPrerequisitesOf(bundle, tid(6))).toEqual([tid(5)])
    expect(implicitPrerequisitesOf(bundle, tid(3))).not.toContain(tid(2))
    expect(implicitPrerequisitesOf(bundle, tid(3))).not.toContain(tid(3))
  })

  it('leaves out another acceptance node of the same sprint', () => {
    const bundle = acceptanceBundle()
    bundle.tickets = bundle.tickets.map((ticket) => (ticket.id === tid(4) ? { ...ticket, kind: 'acceptance' as const } : ticket))
    expect(implicitPrerequisitesOf(bundle, tid(3))).toEqual([tid(1)])
  })

  it('is empty for a work ticket, an unknown ticket and a ticket in no sprint', () => {
    const bundle = acceptanceBundle()
    expect(implicitPrerequisitesOf(bundle, tid(1))).toEqual([])
    expect(implicitPrerequisitesOf(bundle, 'tk_missing')).toEqual([])
    bundle.sprints[0].ticketIds = bundle.sprints[0].ticketIds.filter((id) => id !== tid(3))
    expect(implicitPrerequisitesOf(bundle, tid(3))).toEqual([])
  })
})

describe('acceptanceTitle', () => {
  it('names the node after its sprint ordinal', () => {
    expect(acceptanceTitle(1)).toBe('Sprint 1 acceptance')
    expect(acceptanceTitle(12)).toBe('Sprint 12 acceptance')
  })
})
