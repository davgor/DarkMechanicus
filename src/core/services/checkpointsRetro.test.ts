import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { GateCondition } from '../../shared/domain/views'
import type { SprintRetroInput } from '../../shared/domain/retro'
import { makeBundle, sid, tid } from '../../test/bundles'
import { acceptTickets, errorOf, seedRun, type SeededRun } from '../../test/checkpointSeed'
import { SIMPLE_RETRO } from '../../test/retro'
import { createTestCtx, withRole, type TestCtx } from '../../test/testContext'
import { advanceSprint, approveCheckpoint, getCheckpoint } from './checkpoints'
import { submitSprintReport } from './reports'

/** Sprint 1 = {DM-1, DM-2, DM-3}, sprint 2 = {DM-4, DM-5}; DM-3 and DM-5 are the sprints' acceptance nodes. */
function plan(): PlanBundle {
  const bundle = makeBundle([[1, 2, 3], [4, 5]])
  bundle.tickets = bundle.tickets.map((ticket) =>
    ticket.id === tid(3) || ticket.id === tid(5) ? { ...ticket, kind: 'acceptance' as const } : ticket
  )
  return bundle
}

function setup(activeSprint = 1): { ctx: TestCtx; run: SeededRun } {
  const ctx = createTestCtx()
  return { ctx, run: seedRun(ctx, { bundle: plan(), activeSprint }) }
}

function report(ctx: TestCtx, run: SeededRun, retro?: SprintRetroInput | null, sprint = 1) {
  return submitSprintReport(ctx, {
    runId: run.runId,
    sprintId: sid(sprint),
    report: { summary: 'Sprint finished.', ...(retro === undefined ? {} : { retro }) }
  })
}

function retroGate(ctx: TestCtx, run: SeededRun): GateCondition | undefined {
  return getCheckpoint(ctx, { runId: run.runId }).conditions.find((item) => item.id === 'retro')
}

/** Everything else the sprint needs is done: its tickets and its acceptance node (with a verified increment). */
function finishSprint(ctx: TestCtx, run: SeededRun): void {
  acceptTickets(ctx, run, [1, 2, 3])
}

describe('retro gate on a sprint with an acceptance node: where it sits and when it is unmet', () => {
  it('sits after the node gates and before the exit criteria', () => {
    const { ctx, run } = setup()
    expect(getCheckpoint(ctx, { runId: run.runId }).conditions.map((item) => item.id)).toEqual([
      'report_submitted',
      'no_active_leases',
      'required_accepted',
      'acceptance_accepted',
      'increment_merged',
      'retro',
      'exit_criteria',
      'plan_current',
      'approval'
    ])
  })

  it('is unmet before any report is submitted', () => {
    const { ctx, run } = setup()
    expect(retroGate(ctx, run)).toEqual({
      id: 'retro',
      label: 'Sprint retro included',
      met: false,
      detail: 'No Sprint 1 report yet, so no retro'
    })
  })

  it('stays unmet for a report without a retro, says what to add, and holds the sprint back though everything else is met', () => {
    const { ctx, run } = setup()
    finishSprint(ctx, run)
    report(ctx, run)
    expect(retroGate(ctx, run)).toMatchObject({ met: false, detail: expect.stringContaining('The Sprint 1 report has no retro') })
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect(view.conditions.filter((item) => !item.met && item.id !== 'approval').map((item) => item.id)).toEqual(['retro'])
    expect([view.gatesMet, view.canAdvance]).toEqual([false, false])
  })

  it('treats a null retro like a missing one', () => {
    const { ctx, run } = setup()
    report(ctx, run, null)
    expect(retroGate(ctx, run)).toMatchObject({ met: false, detail: expect.stringContaining('has no retro') })
  })

  it('stays unmet for a retro with nothing in it, since that says nothing about the sprint', () => {
    const { ctx, run } = setup()
    report(ctx, run, {})
    expect(retroGate(ctx, run)).toMatchObject({ met: false, detail: "The Sprint 1 report's retro is empty" })
  })

})

describe('retro gate on a sprint with an acceptance node: when it is met and what it holds back', () => {
  it('is met once a report with a retro is submitted, and then the sprint can be approved and advanced', () => {
    const { ctx, run } = setup()
    finishSprint(ctx, run)
    report(ctx, run, SIMPLE_RETRO)
    expect(retroGate(ctx, run)).toEqual({
      id: 'retro',
      label: 'Sprint retro included',
      met: true,
      detail: 'The Sprint 1 report includes a retro'
    })
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect(view.gatesMet).toBe(true)
    approveCheckpoint(withRole(ctx, 'desktop'), { runId: run.runId, reportId: view.report?.id ?? '' })
    expect(advanceSprint(ctx, { runId: run.runId })).toMatchObject({ outcome: 'advanced' })
  })

  it('refuses to approve a report without a retro, naming the gate', () => {
    const { ctx, run } = setup()
    finishSprint(ctx, run)
    const view = report(ctx, run)
    const error = errorOf(() => approveCheckpoint(withRole(ctx, 'desktop'), { runId: run.runId, reportId: view.id }))
    expect(error.code).toBe('gate_blocked')
    expect(error.message).toContain('has no retro')
  })

  it('is unmet again when a later revision leaves the retro out, and an approval of the earlier one does not carry over', () => {
    const { ctx, run } = setup()
    finishSprint(ctx, run)
    const first = report(ctx, run, SIMPLE_RETRO)
    approveCheckpoint(withRole(ctx, 'desktop'), { runId: run.runId, reportId: first.id })
    report(ctx, run)
    expect(retroGate(ctx, run)).toMatchObject({ met: false })
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect([view.gatesMet, view.canAdvance, view.approval]).toEqual([false, false, null])
    expect(errorOf(() => advanceSprint(ctx, { runId: run.runId })).code).toBe('gate_blocked')
    report(ctx, run, SIMPLE_RETRO)
    expect(retroGate(ctx, run)).toMatchObject({ met: true })
  })

})

describe('retro gate on the final sprint', () => {
  it('applies to the final sprint too, ahead of the epic outcome', () => {
    const { ctx, run } = setup(2)
    expect(getCheckpoint(ctx, { runId: run.runId }).conditions.map((item) => item.id)).toEqual([
      'report_submitted',
      'no_active_leases',
      'required_accepted',
      'acceptance_accepted',
      'increment_merged',
      'retro',
      'exit_criteria',
      'epic_outcome',
      'plan_current',
      'approval'
    ])
    report(ctx, run, SIMPLE_RETRO, 2)
    expect(retroGate(ctx, run)).toMatchObject({ met: true, detail: 'The Sprint 2 report includes a retro' })
  })
})

describe('retro gate on other plans', () => {
  it('is absent for a plan with no acceptance nodes, so a report without a retro still passes', () => {
    const ctx = createTestCtx()
    const run = seedRun(ctx, { bundle: makeBundle([[1, 2], [3]]) })
    acceptTickets(ctx, run, [1, 2])
    report(ctx, run)
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect(view.conditions.map((item) => item.id)).toEqual([
      'report_submitted',
      'no_active_leases',
      'required_accepted',
      'exit_criteria',
      'plan_current',
      'approval'
    ])
    expect(view.gatesMet).toBe(true)
  })

  it('applies only to the sprints that have a node when a plan mixes old and new sprints', () => {
    const bundle = plan()
    bundle.tickets = bundle.tickets.map((ticket) => (ticket.id === tid(3) ? { ...ticket, kind: 'work' as const } : ticket))
    const ctx = createTestCtx()
    const first = seedRun(ctx, { bundle })
    expect(retroGate(ctx, first)).toBeUndefined()
    const second = seedRun(ctx, { bundle, activeSprint: 2 })
    expect(retroGate(ctx, second)).toMatchObject({ met: false })
  })
})
