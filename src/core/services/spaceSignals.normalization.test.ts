/**
 * DM-174 c4: S, A and C read from real records normalize to the contract-defined result (docs/space-grading.md, "When
 * each component is missing") for inherited versus ticket ratings, zero scope, changed scope, no handoffs and
 * unavailable observations, graded by the reference grader.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SpaceSignalsView } from '../../shared/domain/spaceSignals'
import { graded, type SignalsWorld, signalsWorld } from '../../test/spaceSignalsWorld'
import { recordHumanFeedback } from './humanFeedback'

let w: SignalsWorld
let legacyId: string

/**
 * Sprint rating 4 shared, ticket `rated` rated 1; rated, plain and bare (no criteria) accepted; then `later` removed and
 * `newbie` added; `waiting` claimed only; `legacy` submitted with its handoff checks unavailable.
 */
beforeEach(async () => {
  w = await signalsWorld({
    rated: { title: 'Rated', acceptanceCriteria: ['Works'] },
    plain: { title: 'Plain', acceptanceCriteria: ['Works'] },
    bare: { title: 'No criteria' },
    waiting: { title: 'Claimed, not handed off', acceptanceCriteria: ['Works'] },
    legacy: { title: 'Submitted before checks existed', acceptanceCriteria: ['Works'] },
    later: { title: 'Never dispatched', acceptanceCriteria: ['Works'] },
    extra: { title: 'Optional', acceptanceCriteria: ['Nice'], optional: true }
  })
  const desktop = w.desktop.ctx()
  recordHumanFeedback(desktop, { target: { epicId: w.epicId, sprintId: w.sprintId }, feedback: { kind: 'rating', value: 4, sharedWithTickets: true }, person: 'Dana' })
  recordHumanFeedback(desktop, { target: { epicId: w.epicId, ticketId: w.ticket.rated ?? '' }, feedback: { kind: 'rating', value: 1 }, person: 'Dana' })
  for (const ref of ['rated', 'plain', 'bare']) {
    const claimed = await w.claim(ref)
    await w.submit(ref, claimed)
    await w.accept(claimed)
  }
  await w.replan([
    { op: 'remove_ticket', ticket: w.ticket.later ?? '' },
    { op: 'add_ticket', ref: 'newbie', sprint: w.sprintId, ticket: { title: 'Authorized after dispatch', acceptanceCriteria: ['Works'] } }
  ])
  await w.claim('waiting')
  const legacy = await w.claim('legacy')
  await w.submit('legacy', legacy)
  legacyId = legacy.id
  // A submission stored before handoff checks existed, or whose checks this machine has not imported yet.
  w.orchestrator.ctx().db.run("DELETE FROM metric_observations WHERE attempt_id = ? AND metric = 'handoff_check'", legacy.id)
})

afterEach(() => w.close())

const ticket = (ref: string): SpaceSignalsView => w.signals({ level: 'ticket', id: w.ticket[ref] ?? '' })

describe('S normalization: inherited versus ticket ratings (DM-174 c4)', () => {
  it('scores a ticket’s own rating 1 as 0, overriding the shared sprint rating, not inherited', () => {
    expect(graded(ticket('rated'), 'S')).toMatchObject({ state: 'observed', score: 0, inherited: false })
  })

  it('scores a ticket without its own rating from the shared sprint rating 4 as 75, labeled inherited', () => {
    expect(graded(ticket('plain'), 'S')).toMatchObject({ state: 'observed', score: 75, inherited: true })
  })

  it('scores the sprint’s own rating as 75, not inherited', () => {
    expect(graded(w.signals({ level: 'sprint', id: w.sprintId }), 'S')).toMatchObject({ state: 'observed', score: 75, inherited: false })
  })

  it('scores a run of one sprint from its shared rating as inherited context 75', () => {
    expect(graded(w.signals({ level: 'run', id: w.runId }), 'S')).toMatchObject({ state: 'observed', score: 75, inherited: true })
  })

  it('reads S missing (no_rating) for unrated tickets and the run once the sprint rating is no longer shared', () => {
    recordHumanFeedback(w.desktop.ctx(), { target: { epicId: w.epicId, sprintId: w.sprintId }, feedback: { kind: 'rating', value: 4, sharedWithTickets: false }, person: 'Dana' })
    expect(graded(ticket('plain'), 'S')).toMatchObject({ state: 'missing', score: null, missingReason: 'no_rating' })
    expect(graded(w.signals({ level: 'run', id: w.runId }), 'S')).toMatchObject({ state: 'missing', score: null, missingReason: 'no_rating' })
    expect(graded(ticket('rated'), 'S')).toMatchObject({ state: 'observed', score: 0 })
  })
})

describe('A normalization: zero, changed and unfrozen scope (DM-174 c4)', () => {
  it('reads a ticket committing no criteria as missing (zero_scope), never 100', () => {
    expect(graded(ticket('bare'), 'A')).toMatchObject({ state: 'missing', score: null, missingReason: 'zero_scope' })
  })

  it('reads a ticket never dispatched as missing (scope_not_frozen)', () => {
    expect(graded(ticket('newbie'), 'A')).toMatchObject({ state: 'missing', score: null, missingReason: 'scope_not_frozen' })
  })

  it('scores changed scope against the frozen six: 3 delivered of 6 is 50; the removed ticket stays, the added one is outside', () => {
    const sprint = w.signals({ level: 'sprint', id: w.sprintId })
    expect(sprint.A.input).toMatchObject({ committed: 6, delivered: 3, removed: 1, added: 1 })
    expect(sprint.A.removed.map((item) => item.id)).toEqual([w.ticket.later])
    expect(sprint.A.added.map((item) => item.id)).toEqual([w.ticket.newbie])
    expect(graded(sprint, 'A')).toMatchObject({ state: 'observed', score: 50 })
  })

  it('reads a sprint whose only work is optional as missing (zero_scope)', async () => {
    const other = await signalsWorld({ one: { title: 'Optional one', optional: true }, two: { title: 'Optional two', optional: true } })
    try {
      await other.claim('one')
      const sprint = other.signals({ level: 'sprint', id: other.sprintId })
      expect(sprint.A.input.committed).toBe(0)
      expect(graded(sprint, 'A')).toMatchObject({ state: 'missing', missingReason: 'zero_scope' })
    } finally {
      other.close()
    }
  })
})

describe('C normalization: no handoffs and unavailable observations (DM-174 c4)', () => {
  it('reads a claimed ticket with nothing handed off as missing (no_handoffs)', () => {
    const view = ticket('waiting')
    expect(view.C.submissions).toBe(0)
    expect(graded(view, 'C')).toMatchObject({ state: 'missing', score: null, missingReason: 'no_handoffs' })
  })

  it('reads a ticket never dispatched as missing (no_handoffs)', () => {
    expect(graded(ticket('newbie'), 'C')).toMatchObject({ state: 'missing', missingReason: 'no_handoffs' })
  })

  it('reads a submission whose checks are unavailable as not reported, never guessed from the rest', () => {
    const view = ticket('legacy')
    expect(view.C.input.handoffChecks).toBeNull()
    expect(view.C.unchecked.map((item) => [item.attemptId, item.reason])).toEqual([[legacyId, 'not_recorded']])
    expect(graded(view, 'C')).toMatchObject({ state: 'missing', score: null, missingReason: 'not_reported' })
  })

  it('reads the sprint holding an unchecked submission as not reported, naming it, though other submissions passed', () => {
    const sprint = w.signals({ level: 'sprint', id: w.sprintId })
    expect(sprint.C.submissions).toBe(4)
    expect(sprint.C.uncheckedSubmissions).toEqual([legacyId])
    expect(graded(sprint, 'C')).toMatchObject({ state: 'missing', missingReason: 'not_reported' })
  })

  it('scores a complete handoff 100', () => {
    expect(graded(ticket('plain'), 'C')).toMatchObject({ state: 'observed', score: 100 })
  })
})
