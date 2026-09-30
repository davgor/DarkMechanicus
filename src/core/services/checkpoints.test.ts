import { describe, expect, it } from 'vitest'
import type { SprintReportInput } from '../../shared/domain/api'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { GateCondition, GateConditionId } from '../../shared/domain/views'
import { makeBundle, sid, tid } from '../../test/bundles'
import {
  acceptTickets,
  errorOf,
  seedAttempt,
  seedRun,
  setRunState,
  type SeededRun,
  type SeedRunOptions
} from '../../test/checkpointSeed'
import { createTestCtx, withRole, type TestCtx } from '../../test/testContext'
import { getCheckpoint } from './checkpoints'
import { submitSprintReport } from './reports'

function setup(options: SeedRunOptions = {}): { ctx: TestCtx; run: SeededRun } {
  const ctx = createTestCtx()
  return { ctx, run: seedRun(ctx, options) }
}

function report(ctx: TestCtx, run: SeededRun, content: Partial<SprintReportInput> = {}, sprint = 1) {
  return submitSprintReport(ctx, {
    runId: run.runId,
    sprintId: sid(sprint),
    report: { summary: 'Sprint finished.', ...content }
  })
}

function gate(ctx: TestCtx, run: SeededRun, id: GateConditionId): GateCondition | undefined {
  return getCheckpoint(ctx, { runId: run.runId }).conditions.find((condition) => condition.id === id)
}

function withSprintOne(bundle: PlanBundle, patch: Partial<PlanBundle['sprints'][number]>): PlanBundle {
  return { ...bundle, sprints: bundle.sprints.map((sprint) => (sprint.ordinal === 1 ? { ...sprint, ...patch } : sprint)) }
}

describe('getCheckpoint view', () => {
  it('shows every gate met for a finished sprint that waits for a person', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    const submitted = report(ctx, run)
    expect(getCheckpoint(ctx, { runId: run.runId })).toEqual({
      runId: run.runId,
      sprintId: sid(1),
      sprintOrdinal: 1,
      sprintCount: 2,
      isFinalSprint: false,
      policy: 'human',
      autoContinueAuthorized: false,
      report: submitted,
      conditions: [
        { id: 'report_submitted', label: 'Sprint report submitted', met: true, detail: 'Required by checkpoint policy' },
        { id: 'no_active_leases', label: 'No worker still holds a lease', met: true, detail: 'All claims released or expired' },
        { id: 'required_accepted', label: 'Every required ticket accepted', met: true, detail: '2 of 2 required tickets accepted' },
        { id: 'exit_criteria', label: 'Exit criteria reported met', met: true, detail: 'This sprint has no exit criteria' },
        { id: 'approval', label: 'Advance authorized', met: false, detail: 'A person must approve this checkpoint in the desktop app' }
      ],
      gatesMet: true,
      canAdvance: false,
      approval: null
    })
  })

})

describe('getCheckpoint without a report or on the final sprint', () => {
  it('explains a missing report', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect(view.conditions[0]).toEqual({
      id: 'report_submitted',
      label: 'Sprint report submitted',
      met: false,
      detail: 'No report for Sprint 1 yet'
    })
    expect([view.report, view.gatesMet, view.canAdvance]).toEqual([null, false, false])
  })

  it('adds the epic outcome gate on the final sprint only', () => {
    const { ctx, run } = setup({ activeSprint: 2 })
    acceptTickets(ctx, run, [3])
    report(ctx, run, {}, 2)
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect([view.sprintId, view.sprintOrdinal, view.isFinalSprint, view.gatesMet]).toEqual([sid(2), 2, true, false])
    expect(view.conditions.map((condition) => condition.id)).toEqual([
      'report_submitted',
      'no_active_leases',
      'required_accepted',
      'exit_criteria',
      'epic_outcome',
      'approval'
    ])
  })
})

describe('getCheckpoint access', () => {
  it('is readable by every role and fails for runs without an active sprint', () => {
    const { ctx, run } = setup()
    expect(getCheckpoint(withRole(ctx, 'worker'), { runId: run.runId }).sprintId).toBe(sid(1))
    const idle = seedRun(ctx, { state: 'queued', activeSprint: null })
    const result = errorOf(() => getCheckpoint(ctx, { runId: idle.runId }))
    expect(result).toMatchObject({ code: 'run_not_active', message: 'Run #1 has no active sprint.' })
  })

  it('requires read access and an existing run', () => {
    const { ctx, run } = setup()
    const blind = createTestCtx({ db: ctx.db, capabilities: [] })
    expect(errorOf(() => getCheckpoint(blind, { runId: run.runId })).code).toBe('unauthorized')
    expect(errorOf(() => getCheckpoint(ctx, { runId: 'rn_00000000000000000000000404' })).code).toBe('not_found')
  })
})

describe('no_active_leases gate', () => {
  it('names open attempts of the active sprint and ignores later sprints', () => {
    const { ctx, run } = setup()
    seedAttempt(ctx, run, { ticket: 1, state: 'running' })
    seedAttempt(ctx, run, { ticket: 2, state: 'claimed' })
    seedAttempt(ctx, run, { ticket: 3, state: 'claimed' })
    expect(gate(ctx, run, 'no_active_leases')).toEqual({
      id: 'no_active_leases',
      label: 'No worker still holds a lease',
      met: false,
      detail: 'DM-1 is still running; DM-2 is claimed'
    })
  })

  it('treats submissions as open and finished attempts as released', () => {
    const { ctx, run } = setup()
    seedAttempt(ctx, run, { ticket: 1, state: 'submitted' })
    for (const state of ['failed', 'rejected', 'canceled', 'lease_expired', 'accepted'] as const) {
      seedAttempt(ctx, run, { ticket: 2, state })
    }
    expect(gate(ctx, run, 'no_active_leases')).toMatchObject({ met: false, detail: 'DM-1 is awaiting review' })
    const clear = seedRun(ctx)
    seedAttempt(ctx, clear, { ticket: 1, state: 'lease_expired' })
    expect(gate(ctx, clear, 'no_active_leases')).toMatchObject({ met: true, detail: 'All claims released or expired' })
  })
})

describe('required_accepted gate', () => {
  it('blocks on a failed required ticket and names unstarted ones', () => {
    const { ctx, run } = setup()
    seedAttempt(ctx, run, { ticket: 1, state: 'failed' })
    seedAttempt(ctx, run, { ticket: 1, state: 'failed' })
    expect(gate(ctx, run, 'required_accepted')).toEqual({
      id: 'required_accepted',
      label: 'Every required ticket accepted',
      met: false,
      detail: 'DM-1 failed after 2 attempts; DM-2 not started'
    })
  })

  it('describes the latest attempt of every ticket that is not accepted in this run', () => {
    const { ctx, run } = setup({ bundle: makeBundle([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]) })
    const states = ['failed', 'rejected', 'canceled', 'lease_expired', 'claimed', 'submitted'] as const
    states.forEach((state, index) => seedAttempt(ctx, run, { ticket: index + 1, state }))
    seedAttempt(ctx, run, { ticket: 7, state: 'accepted', superseded: true })
    seedAttempt(ctx, run, { ticket: 8, state: 'failed' })
    seedAttempt(ctx, run, { ticket: 8, state: 'running' })
    seedAttempt(ctx, run, { ticket: 9, state: 'lease_expired', reconciled: true })
    seedAttempt(ctx, run, { ticket: 10, state: 'submitted', reconciled: true })
    expect(gate(ctx, run, 'required_accepted')?.detail.split('; ')).toEqual([
      'DM-1 failed after 1 attempt',
      'DM-2 was rejected after 1 attempt',
      'DM-3 was canceled',
      'DM-4 needs reconciliation after its lease expired',
      'DM-5 is claimed',
      'DM-6 is awaiting review',
      'DM-7 changed in an adopted revision and needs new work',
      'DM-8 is still running',
      'DM-9 was abandoned after its lease expired',
      'DM-10 is awaiting review'
    ])
  })

  it('counts an acceptance after earlier failures and ignores optional tickets', () => {
    const base = makeBundle([[1, 2], [3]])
    const bundle = { ...base, tickets: base.tickets.map((ticket) => ({ ...ticket, optional: ticket.id === tid(2) })) }
    const { ctx, run } = setup({ bundle })
    seedAttempt(ctx, run, { ticket: 1, state: 'failed' })
    seedAttempt(ctx, run, { ticket: 1, state: 'accepted' })
    expect(gate(ctx, run, 'required_accepted')).toMatchObject({ met: true, detail: '1 of 1 required tickets accepted' })
  })
})

describe('exit_criteria gate', () => {
  const criteria = [
    { id: 'x1', text: 'Driver loads on Windows' },
    { id: 'x2', text: 'Driver loads on macOS' },
    { id: 'x3', text: 'Docs updated' }
  ]

  it('names unmet and unreported exit criteria', () => {
    const { ctx, run } = setup({ bundle: withSprintOne(makeBundle([[1], [2]]), { exitCriteria: criteria }) })
    expect(gate(ctx, run, 'exit_criteria')?.detail).toBe(
      'x1 "Driver loads on Windows" not reported; x2 "Driver loads on macOS" not reported; x3 "Docs updated" not reported'
    )
    report(ctx, run, {
      exitCriteria: [
        { criterionId: 'x1', met: true, note: '' },
        { criterionId: 'x2', met: false, note: 'macOS unverified' },
        { criterionId: 'x3', met: true, note: '' },
        { criterionId: 'x3', met: false, note: '' }
      ]
    })
    expect(gate(ctx, run, 'exit_criteria')).toEqual({
      id: 'exit_criteria',
      label: 'Exit criteria reported met',
      met: false,
      detail: 'x2 "Driver loads on macOS" not met: macOS unverified; x3 "Docs updated" not met'
    })
  })

  it('is met when every exit criterion is reported met', () => {
    const { ctx, run } = setup({ bundle: withSprintOne(makeBundle([[1], [2]]), { exitCriteria: criteria }) })
    report(ctx, run, { exitCriteria: criteria.map((criterion) => ({ criterionId: criterion.id, met: true, note: '' })) })
    expect(gate(ctx, run, 'exit_criteria')).toMatchObject({ met: true, detail: '3 of 3 exit criteria reported met' })
  })
})

describe('epic_outcome gate', () => {
  const successCriteria = [
    { id: 's1', text: 'Everything works' },
    { id: 's2', text: 'Docs published' }
  ]

  function finalRun(criteria = successCriteria): { ctx: TestCtx; run: SeededRun } {
    const base = makeBundle([[1], [2]])
    return setup({ bundle: { ...base, epic: { ...base.epic, successCriteria: criteria } }, activeSprint: 2 })
  }

  it('requires the outcome and names unmet success criteria', () => {
    const { ctx, run } = finalRun()
    report(ctx, run, {}, 2)
    expect(gate(ctx, run, 'epic_outcome')).toEqual({
      id: 'epic_outcome',
      label: 'Epic success criteria met',
      met: false,
      detail: 'The final sprint report must include the epic outcome'
    })
    const outcome = { summary: 'Shipped', successCriteria: [{ criterionId: 's1', met: true, note: '' }] }
    report(ctx, run, { epicOutcome: outcome }, 2)
    expect(gate(ctx, run, 'epic_outcome')).toMatchObject({ met: false, detail: 's2 "Docs published" not reported' })
  })

  it('is met when every success criterion is met, or with an outcome for an epic without criteria', () => {
    const { ctx, run } = finalRun()
    const met = successCriteria.map((criterion) => ({ criterionId: criterion.id, met: true, note: 'verified' }))
    report(ctx, run, { epicOutcome: { summary: 'Shipped', successCriteria: met } }, 2)
    expect(gate(ctx, run, 'epic_outcome')).toMatchObject({ met: true, detail: '2 of 2 success criteria met' })
    const bare = finalRun([])
    report(bare.ctx, bare.run, { epicOutcome: { summary: 'Shipped', successCriteria: [] } }, 2)
    expect(gate(bare.ctx, bare.run, 'epic_outcome')).toMatchObject({ met: true, detail: 'Epic outcome recorded' })
  })
})

describe('authorization condition', () => {
  const autoBundle = withSprintOne(makeBundle([[1], [2]]), { checkpoint: { mode: 'auto' } })

  it('explains an automatic policy that the person has not authorized', () => {
    const { ctx, run } = setup({ bundle: autoBundle })
    acceptTickets(ctx, run, [1])
    report(ctx, run)
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect([view.policy, view.autoContinueAuthorized, view.gatesMet, view.canAdvance]).toEqual(['auto', false, true, false])
    expect(view.conditions.at(-1)).toEqual({
      id: 'approval',
      label: 'Advance authorized',
      met: false,
      detail: 'Automatic continuation requested by the plan but not authorized for this run'
    })
  })

  it('lets an authorized automatic policy advance once the run awaits its checkpoint', () => {
    const { ctx, run } = setup({ bundle: autoBundle, autoContinue: true })
    acceptTickets(ctx, run, [1])
    report(ctx, run)
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect(view.conditions.at(-1)).toMatchObject({ met: true, detail: 'Automatic continuation authorized for this run' })
    expect([view.autoContinueAuthorized, view.canAdvance]).toEqual([true, true])
    setRunState(ctx, run.runId, 'running')
    expect(getCheckpoint(ctx, { runId: run.runId }).canAdvance).toBe(false)
  })

  it('ignores the auto-continue flag for a human-gated sprint', () => {
    const { ctx, run } = setup({ autoContinue: true })
    acceptTickets(ctx, run, [1, 2])
    report(ctx, run)
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect([view.policy, view.autoContinueAuthorized, view.canAdvance]).toEqual(['human', true, false])
    expect(view.conditions.at(-1)?.met).toBe(false)
  })
})
