/**
 * DM-178 c1/c2 and the DM-269 fixes to them: run, sprint and epic grades recomputed from the scope's raw measures (never
 * averaged letters), overhead kept in T and K, acceptance and Fireguard tickets never counted as delivered features, and
 * a failed required or integrated outcome capping the level however well the component tickets graded.
 */
import { describe, expect, it } from 'vitest'
import type { SpaceComponent, SpaceGrade } from '../../shared/domain/space'
import type { AggregateGradeView } from '../../shared/domain/spaceGrades'
import { sid, tid } from '../../test/bundles'
import { approveAndAdvance } from './checkpoints'
import { getEpicGrade, getRunGrade, getSprintGrade, getTicketGrade } from './spaceGrades'
import { accept, adopt, deliver, met, MIN, moveToSprint2, nextRun, overhead, reject, report, spaceWorld, unmet, work } from '../../test/spaceWorld'
import { gradeSpace } from '../space/rubric'

const component = (grade: SpaceGrade, name: SpaceComponent) => grade.components.find((entry) => entry.component === name)
const score = (grade: SpaceGrade, name: SpaceComponent): number | null => component(grade, name)?.score ?? null

/** Capped at 59 F by the failed outcome of ticket `n`, which is counted and cited in P. */
function expectCappedBy(view: AggregateGradeView, n: number): void {
  expect(view.grade).toMatchObject({ outcome: 'failed', letter: 'F', score: 59 })
  expect(view.grade.caps.map((cap) => cap.kind)).toEqual(['mandatory_failure'])
  expect(score(view.grade, 'P')).toBe(0)
  expect(component(view.grade, 'P')?.evidence).toContainEqual(expect.objectContaining({ kind: 'ticket', id: tid(n), detail: expect.stringMatching(/^failed \(/) }))
  expect(view.outcomes).toContainEqual(expect.objectContaining({ ticketId: tid(n), counted: true, state: 'failed' }))
}

/** Three feature tickets, the Fireguard ticket and the acceptance node, with 15 minutes of sprint orchestration. */
function measuredSprint() {
  const w = spaceWorld()
  deliver(w, 1, { minutes: 24, tokens: 40_000, productive: 20, corrective: 4 })
  deliver(w, 2, { minutes: 24, tokens: 40_000, productive: 22, corrective: 2 })
  deliver(w, 3, { minutes: 36, tokens: 60_000, productive: 30, corrective: 6 })
  deliver(w, 5, { minutes: 10, tokens: 20_000, productive: 10 })
  overhead(w, 15, 30_000)
  deliver(w, 4, { minutes: 6, tokens: 10_000, productive: 6 })
  return w
}

describe('DM-178 c1: aggregate grades from the scope’s raw measures', () => {
  it('commits only the feature tickets in A and treats the acceptance node and the Fireguard ticket as integrated outcomes', () => {
    const w = measuredSprint()
    const sprint = getSprintGrade(w.ctx, { runId: w.runId, sprintId: w.sprintId })
    expect(sprint.input.components.A).toMatchObject({ committed: 3, delivered: 3 })
    expect(Object.fromEntries(sprint.outcomes.map((outcome) => [outcome.ticketId, outcome.role]))).toEqual({
      [tid(1)]: 'work',
      [tid(2)]: 'work',
      [tid(3)]: 'work',
      [tid(4)]: 'integrated',
      [tid(5)]: 'integrated'
    })
  })

  it('keeps every overhead cost in T and K and compares it with the roll-up of the feature tickets’ budgets', () => {
    const w = measuredSprint()
    const sprint = getSprintGrade(w.ctx, { runId: w.runId, sprintId: w.sprintId })
    // 24 + 24 + 36 feature minutes, 10 Fireguard, 6 acceptance and 15 of orchestration.
    expect(sprint.input.components.T.actual).toEqual({ state: 'observed', value: 115 * MIN })
    expect(sprint.rollups.T.baseline).toMatchObject({ kind: 'rollup', value: 90 * MIN })
    expect(sprint.rollups.T.baseline?.members.map((member) => member.ticketId)).toEqual([tid(1), tid(2), tid(3)])
    expect(sprint.rollups.T.overhead.map((entry) => entry.ticketId)).toEqual([tid(4), tid(5)])
    expect(score(sprint.grade, 'T')).toBe(86.111111)
    expect(sprint.input.components.K.actual).toEqual({ state: 'observed', value: 200_000 })
    expect(sprint.rollups.K.baseline?.value).toBe(150_000)
    expect(score(sprint.grade, 'K')).toBe(83.333333)
  })

  it('grades the sprint from its own totals, not the mean of its ticket grades', () => {
    const w = measuredSprint()
    const sprint = getSprintGrade(w.ctx, { runId: w.runId, sprintId: w.sprintId })
    const tickets = [1, 2, 3].map((n) => getTicketGrade(w.ctx, { runId: w.runId, ticketId: tid(n) }).grade)
    expect(tickets.map((grade) => score(grade, 'T'))).toEqual([100, 100, 90])
    expect(sprint.input.components.C.handoffChecks).toEqual({ passed: 15, failed: 0 })
    expect(sprint.grade).toMatchObject({ score: 91.907407, letter: 'A', status: 'final' })
  })
})

describe('DM-178 c1: overhead scopes and the aggregate baseline rule', () => {
  it('charges overhead recorded for the run to the run grade only, never to the sprint', () => {
    const w = spaceWorld({ overhead: false })
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
    overhead(w, 10, 5_000)
    w.ctx.clock.advanceSeconds(600)
    overhead(w, 5, 2_000, null)
    expect(getSprintGrade(w.ctx, { runId: w.runId, sprintId: w.sprintId }).input.components.T.actual).toEqual({ state: 'observed', value: 30 * MIN })
    expect(getRunGrade(w.ctx, { runId: w.runId }).input.components.T.actual).toEqual({ state: 'observed', value: 35 * MIN })
    expect(getRunGrade(w.ctx, { runId: w.runId }).input.components.K.actual).toEqual({ state: 'observed', value: 37_000 })
  })

  it('refuses a ticket budget offered to a sprint grade and a roll-up offered to a ticket grade (level_mismatch)', () => {
    const w = spaceWorld({ overhead: false })
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
    const sprint = getSprintGrade(w.ctx, { runId: w.runId, sprintId: w.sprintId })
    const ticket = getTicketGrade(w.ctx, { runId: w.runId, ticketId: tid(1) })
    const budget = ticket.input.components.T.baseline
    const rollup = sprint.rollups.T.baseline
    expect(budget.state).toBe('selected')
    expect(rollup).not.toBeNull()
    if (budget.state !== 'selected' || rollup === null) return
    const onSprint = structuredClone(sprint.input)
    onSprint.components.T.baseline = { state: 'selected', baseline: budget.baseline, rejected: [] }
    const onTicket = structuredClone(ticket.input)
    onTicket.components.T.baseline = { state: 'selected', baseline: rollup, rejected: [] }
    expect(component(gradeSpace(onSprint), 'T')?.explanation.baseline?.refusedReason).toBe('level_mismatch')
    expect(component(gradeSpace(onTicket), 'T')?.explanation.baseline?.refusedReason).toBe('level_mismatch')
  })
})

describe('DM-178 c1: roll-ups across tickets and runs', () => {
  it('leaves an unbudgeted feature ticket’s own cost out of a partial roll-up, estimated and provisional', () => {
    const w = spaceWorld({ unbudgeted: [3], overhead: false })
    deliver(w, 1, { minutes: 40, tokens: 40_000, productive: 40 })
    deliver(w, 2, { minutes: 40, tokens: 40_000, productive: 40 })
    deliver(w, 3, { minutes: 24, tokens: 40_000, productive: 24 })
    const sprint = getSprintGrade(w.ctx, { runId: w.runId, sprintId: w.sprintId })
    expect(sprint.rollups.T).toMatchObject({ partial: true, uncovered: [{ runId: w.runId, ticketId: tid(3) }] })
    expect(sprint.rollups.T.baseline?.value).toBe(60 * MIN)
    expect(sprint.input.components.T.actual).toMatchObject({ state: 'estimated', value: 80 * MIN })
    expect(component(sprint.grade, 'T')).toMatchObject({ state: 'estimated', score: 83.333333 })
    expect(sprint.grade.status).toBe('provisional')
    expect(sprint.grade.statusReasons).toContain('estimated_input')
  })

  it('counts a ticket executed in two runs of the epic against its budget once', () => {
    const w = spaceWorld({ overhead: false })
    deliver(w, 1, { minutes: 30, tokens: 50_000, productive: 30 })
    deliver(w, 2, { minutes: 30, tokens: 50_000, productive: 30 })
    work(w, 3, { minutes: 60, tokens: 100_000, productive: 60 })
    nextRun(w)
    deliver(w, 3, { minutes: 60, tokens: 100_000, productive: 60 })
    const epic = getEpicGrade(w.ctx, { epicId: w.epicId })
    expect(epic.rollups.T.baseline?.members.map((member) => member.ticketId)).toEqual([tid(1), tid(2), tid(3)])
    expect(epic.rollups.T.baseline?.value).toBe(90 * MIN)
    expect(epic.input.components.T.actual).toEqual({ state: 'observed', value: 180 * MIN })
    expect(score(epic.grade, 'T')).toBe(50)
  })

  it('reads E, T and K of the epic as missing when one attempt reported no usage (unreported is missing, never zero)', () => {
    const w = spaceWorld({ overhead: false })
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
    deliver(w, 2, { minutes: 20, tokens: 30_000, productive: 20 })
    deliver(w, 3, { minutes: null, tokens: null })
    const epic = getEpicGrade(w.ctx, { epicId: w.epicId })
    expect(epic.input.components.T.unreportedAttempts).toBe(1)
    expect(epic.grade.components.filter((entry) => ['E', 'T', 'K'].includes(entry.component)).map(({ component: name, state, missingReason }) => [name, state, missingReason])).toEqual([
      ['E', 'missing', 'partial_coverage'],
      ['T', 'missing', 'partial_telemetry'],
      ['K', 'missing', 'partial_telemetry']
    ])
    expect(epic.grade.status).toBe('ungraded')
  })
})

describe('DM-178 c2: a failed required or integrated outcome caps its level', () => {
  it('caps the sprint and the epic at 59 F when the acceptance node fails, though every feature ticket grades A', () => {
    const w = spaceWorld()
    for (const n of [1, 2, 3, 5]) deliver(w, n, { minutes: 20, tokens: 30_000, productive: 20 })
    accept(w, work(w, 4, { minutes: 5, tokens: 8_000, productive: 5 }), [unmet('c1', 'the combined build fails end to end')])
    expect([1, 2, 3].map((n) => getTicketGrade(w.ctx, { runId: w.runId, ticketId: tid(n) }).grade.letter)).toEqual(['A', 'A', 'A'])
    const sprint = getSprintGrade(w.ctx, { runId: w.runId, sprintId: w.sprintId })
    expectCappedBy(sprint, 4)
    expect(sprint.grade.uncappedScore).toBe(83.333333)
    expectCappedBy(getEpicGrade(w.ctx, { epicId: w.epicId }), 4)
  })

  it('keeps the cap after later runs that ended without an attempt of the failed ticket', () => {
    const w = spaceWorld()
    for (const n of [1, 2, 3, 5]) deliver(w, n, { minutes: 20, tokens: 30_000, productive: 20 })
    accept(w, work(w, 4, { minutes: 5, tokens: 8_000, productive: 5 }), [unmet('c1')])
    nextRun(w)
    nextRun(w)
    const epic = getEpicGrade(w.ctx, { epicId: w.epicId })
    expectCappedBy(epic, 4)
    expect(epic.outcomes.filter((outcome) => outcome.ticketId === tid(4)).map((outcome) => [outcome.counted, outcome.attemptId === null])).toEqual([
      [true, false],
      [false, true],
      [false, true]
    ])
    expect(epic.measuredRunIds).toHaveLength(1)
    expect(score(epic.grade, 'T')).toBe(100)
  })
})

describe('DM-178 c2: the cap survives later adoptions', () => {
  it('keeps the cap of a ticket that used every try after an adoption marks it optional', () => {
    const w = spaceWorld({ retryLimit: 1, overhead: false })
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
    deliver(w, 2, { minutes: 20, tokens: 30_000, productive: 20 })
    reject(w, work(w, 3, { minutes: 20, tokens: 30_000, productive: 20 }), 'does not work')
    adopt(w, (plan) => ({ ...plan, tickets: plan.tickets.map((ticket) => (ticket.id === tid(3) ? { ...ticket, optional: true } : ticket)) }))
    for (const view of [getSprintGrade(w.ctx, { runId: w.runId, sprintId: w.sprintId }), getRunGrade(w.ctx, { runId: w.runId }), getEpicGrade(w.ctx, { epicId: w.epicId })]) {
      expectCappedBy(view, 3)
      expect(view.outcomes.find((outcome) => outcome.ticketId === tid(3))?.role).toBe('work')
    }
  })

  it('keeps the failure with the sprint that incurred it after an adoption moves the ticket to a later sprint', () => {
    const w = spaceWorld({ retryLimit: 1, overhead: false, secondSprint: true })
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
    deliver(w, 2, { minutes: 20, tokens: 30_000, productive: 20 })
    reject(w, work(w, 3, { minutes: 20, tokens: 30_000, productive: 20 }), 'does not work')
    moveToSprint2(w, tid(3))
    const sprint1 = getSprintGrade(w.ctx, { runId: w.runId, sprintId: sid(1) })
    expectCappedBy(sprint1, 3)
    expect(sprint1.outcomes.find((outcome) => outcome.ticketId === tid(3))).toMatchObject({ movedOut: true, state: 'failed', counted: true })
    expectCappedBy(getRunGrade(w.ctx, { runId: w.runId }), 3)
    expectCappedBy(getEpicGrade(w.ctx, { epicId: w.epicId }), 3)
    expect(getSprintGrade(w.ctx, { runId: w.runId, sprintId: sid(2) }).outcomes.find((outcome) => outcome.ticketId === tid(3))).toMatchObject({ attemptId: null, movedOut: false, counted: false })
  })
})

describe('DM-178 c2: integrated outcomes', () => {
  it('caps the sprint when the Fireguard ticket used every try, without counting it as a feature', () => {
    const w = spaceWorld({ retryLimit: 1 })
    for (const n of [1, 2, 3]) deliver(w, n, { minutes: 20, tokens: 30_000, productive: 20 })
    reject(w, work(w, 5, { minutes: 5, tokens: 5_000, productive: 5 }), 'Fireguard grade below the bar')
    const sprint = getSprintGrade(w.ctx, { runId: w.runId, sprintId: w.sprintId })
    expectCappedBy(sprint, 5)
    expect(sprint.input.components.A.committed).toBe(3)
  })

  it('does not cap a sprint whose acceptance node verified it', () => {
    const w = spaceWorld()
    for (const n of [1, 2, 3, 5]) deliver(w, n, { minutes: 20, tokens: 30_000, productive: 20 })
    accept(w, work(w, 4, { minutes: 5, tokens: 8_000, productive: 5 }), [met('c1')])
    const sprint = getSprintGrade(w.ctx, { runId: w.runId, sprintId: w.sprintId })
    expect(sprint.grade).toMatchObject({ outcome: 'verified', caps: [], score: 100, letter: 'A' })
  })
})

describe('DM-269 fix: a ticket moved to a later sprint after a failed attempt', () => {
  /** Ticket 3 rejected in sprint 1, moved to sprint 2 by an adoption, then accepted there. */
  function movedAndRedone() {
    const w = spaceWorld({ retryLimit: 3, overhead: false, secondSprint: true })
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
    deliver(w, 2, { minutes: 20, tokens: 30_000, productive: 20 })
    const failed = work(w, 3, { minutes: 20, tokens: 30_000, productive: 20 })
    reject(w, failed, 'does not work')
    moveToSprint2(w, tid(3))
    approveAndAdvance(w.desktop, { runId: w.runId, reportId: report(w).id })
    w.ctx.clock.advanceSeconds(60)
    deliver(w, 3, { minutes: 20, tokens: 30_000, productive: 20 })
    return { w, failed }
  }

  it('compares the cost the later sprint carries with the moved ticket’s budget instead of refusing it (invalid_time)', () => {
    const { w } = movedAndRedone()
    const sprint2 = getSprintGrade(w.ctx, { runId: w.runId, sprintId: sid(2) })
    // Both attempts of ticket 3 (the failed one from sprint 1 included) against its one 30-minute budget.
    expect(sprint2.input.components.T.actual).toEqual({ state: 'observed', value: 40 * MIN })
    expect(sprint2.rollups.T.baseline?.value).toBe(30 * MIN)
    expect(component(sprint2.grade, 'T')).toMatchObject({ state: 'observed', score: 83.333333 })
    expect(component(sprint2.grade, 'K')).toMatchObject({ state: 'observed', score: 90 })
    expect(sprint2.grade.statusReasons).not.toContain('required_component_missing')
  })

  it('grades the later sprint final from its measures instead of a provisional 100 A', () => {
    const { w } = movedAndRedone()
    const sprint2 = getSprintGrade(w.ctx, { runId: w.runId, sprintId: sid(2) })
    // P 100, A 50 (ticket 6 not yet delivered), C 100, E 100, T 83.333333, K 90.
    expect(score(sprint2.grade, 'A')).toBe(50)
    expect(sprint2.grade).toMatchObject({ score: 87.222222, letter: 'B', status: 'final', statusReasons: [] })
  })

  it('starts the later sprint’s measured window at the moved ticket’s first dispatch', () => {
    const { w, failed } = movedAndRedone()
    const firstDispatch = w.ctx.db.get<{ created_at: string }>('SELECT created_at FROM attempts WHERE id = ?', failed)?.created_at
    expect(getSprintGrade(w.ctx, { runId: w.runId, sprintId: sid(2) }).input.dispatchedAt).toBe(firstDispatch)
    expect(getSprintGrade(w.ctx, { runId: w.runId, sprintId: sid(1) }).input.dispatchedAt).toBe('2026-11-15T09:01:00.000Z')
  })
})

describe('DM-178 (DM-177 decision): another rejected submission never raises a grade', () => {
  function readingWith(rejected: number) {
    const w = spaceWorld({ overhead: false, retryLimit: 5 })
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
    deliver(w, 2, { minutes: 20, tokens: 30_000, productive: 20 })
    for (let k = 0; k < rejected; k += 1) reject(w, work(w, 3, { minutes: 10, tokens: 10_000, productive: 10 }), 'the review found it broken')
    accept(w, work(w, 3, { minutes: 20, tokens: 30_000, productive: 20 }), [met('c1'), met('c2')])
    return {
      ticket: getTicketGrade(w.ctx, { runId: w.runId, ticketId: tid(3) }).grade,
      sprint: getSprintGrade(w.ctx, { runId: w.runId, sprintId: w.sprintId }).grade,
      run: getRunGrade(w.ctx, { runId: w.runId }).grade
    }
  }

  it('lowers C and the ticket, sprint and run grades with each rejected submission before the accepted one', () => {
    const chain = [0, 1, 2, 3].map(readingWith)
    expect(chain.map((reading) => score(reading.ticket, 'C'))).toEqual([100, 50, 33.333333, 25])
    expect(chain.map((reading) => reading.ticket.score)).toEqual([100, 91.666667, 86.111111, 80.277778])
    expect(chain.map((reading) => reading.sprint.score)).toEqual([100, 95.833333, 93.333333, 91.666667])
    expect(chain.map((reading) => reading.run.score)).toEqual([100, 95.833333, 93.333333, 91.666667])
  })
})
