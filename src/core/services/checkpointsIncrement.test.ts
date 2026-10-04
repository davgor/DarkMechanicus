/** The `increment_merged` gate: it reads the verdict stored with the acceptance node's standing submission. */
import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { GateCondition } from '../../shared/domain/views'
import { makeBundle, sid, tid } from '../../test/bundles'
import {
  acceptTickets,
  errorOf,
  incrementVerdict,
  seedAttempt,
  seedRun,
  type SeededRun,
  type SeedRunOptions
} from '../../test/checkpointSeed'
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

function setup(options: SeedRunOptions = {}): { ctx: TestCtx; run: SeededRun } {
  const ctx = createTestCtx()
  return { ctx, run: seedRun(ctx, { bundle: plan(), ...options }) }
}

function incrementGate(ctx: TestCtx, run: SeededRun): GateCondition | undefined {
  return getCheckpoint(ctx, { runId: run.runId }).conditions.find((item) => item.id === 'increment_merged')
}

function report(ctx: TestCtx, run: SeededRun) {
  return submitSprintReport(ctx, { runId: run.runId, sprintId: sid(1), report: { summary: 'Sprint finished.', retro: SIMPLE_RETRO } })
}

describe('increment_merged gate: when the acceptance node has no verified increment', () => {
  it('is unmet until the node names an increment, and tells the worker how to name one', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted' })
    expect(incrementGate(ctx, run)).toEqual({
      id: 'increment_merged',
      label: 'Sprint increment merged',
      met: false,
      detail: 'No sprint increment named yet: submit DM-3 with increment { branch, commit }'
    })
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect(view.conditions.find((item) => item.id === 'acceptance_accepted')?.met).toBe(true)
    expect([view.gatesMet, view.canAdvance]).toEqual([false, false])
  })

  it('is unmet while the node has not been submitted at all', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    expect(incrementGate(ctx, run)).toMatchObject({ met: false, detail: expect.stringContaining('No sprint increment named yet') })
  })

  it('is unmet when verification failed, and carries every reason', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    const increment = incrementVerdict({
      commit: 'd'.repeat(40),
      passed: false,
      reasons: ['Commit ddddddd has 2 parents (a merge commit).', 'The sprint was merged rather than squashed.']
    })
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted', increment })
    expect(incrementGate(ctx, run)).toMatchObject({
      met: false,
      detail:
        'Increment ddddddd failed verification: Commit ddddddd has 2 parents (a merge commit). The sprint was merged rather than squashed.'
    })
  })

  it('does not count an increment named by an attempt that was rejected', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    seedAttempt(ctx, run, { ticket: 3, state: 'rejected', increment: {} })
    expect(incrementGate(ctx, run)?.met).toBe(false)
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted' })
    expect(incrementGate(ctx, run)).toMatchObject({ met: false, detail: expect.stringContaining('No sprint increment named yet') })
  })

  it('does not count an increment on an acceptance an adopted revision superseded', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted', superseded: true, increment: {} })
    expect(incrementGate(ctx, run)?.met).toBe(false)
  })
})

describe('increment_merged gate: when the increment verified', () => {
  it('is met by the accepted node, and says which commit landed on which branch', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2, 3])
    report(ctx, run)
    expect(incrementGate(ctx, run)).toEqual({
      id: 'increment_merged',
      label: 'Sprint increment merged',
      met: true,
      detail: 'Increment ccccccc on epic/x is one squashed commit on the epic branch'
    })
    expect(getCheckpoint(ctx, { runId: run.runId }).gatesMet).toBe(true)
  })

  it('is met by a submission still awaiting review, leaving acceptance to its own gate', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    seedAttempt(ctx, run, { ticket: 3, state: 'submitted', increment: {} })
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect(view.conditions.find((item) => item.id === 'increment_merged')?.met).toBe(true)
    expect(view.conditions.find((item) => item.id === 'acceptance_accepted')?.met).toBe(false)
  })

  it('counts a later accepted attempt after an earlier one whose increment failed', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    seedAttempt(ctx, run, { ticket: 3, state: 'rejected', increment: { passed: false, reasons: ['not squashed'] } })
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted', increment: { commit: 'e'.repeat(40) } })
    expect(incrementGate(ctx, run)).toMatchObject({ met: true, detail: expect.stringContaining('eeeeeee') })
  })
})

describe('increment_merged gate: where it sits and which sprints have it', () => {
  it('sits right after acceptance_accepted', () => {
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

  it('is absent for a sprint with no acceptance node', () => {
    const ctx = createTestCtx()
    const run = seedRun(ctx, { bundle: makeBundle([[1, 2], [3]]) })
    expect(getCheckpoint(ctx, { runId: run.runId }).conditions.map((item) => item.id)).not.toContain('increment_merged')
  })

  it('checks the final sprint node too, after the epic outcome rules', () => {
    const { ctx, run } = setup({ activeSprint: 2 })
    acceptTickets(ctx, run, [1, 2, 3, 4])
    seedAttempt(ctx, run, { ticket: 5, state: 'accepted' })
    expect(incrementGate(ctx, run)).toMatchObject({ met: false, detail: expect.stringContaining('submit DM-5') })
    seedAttempt(ctx, run, { ticket: 5, state: 'accepted', superseded: false, increment: {} })
    expect(incrementGate(ctx, run)?.met).toBe(true)
  })
})

describe('a checkpoint cannot be passed without a verified increment', () => {
  it('refuses approval and advance, naming the missing increment', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted' })
    const submitted = report(ctx, run)
    const message = "Sprint 1 can't advance yet: No sprint increment named yet: submit DM-3 with increment { branch, commit }"
    expect(errorOf(() => approveCheckpoint(withRole(ctx, 'desktop'), { runId: run.runId, reportId: submitted.id }))).toMatchObject({
      code: 'gate_blocked',
      message
    })
    const advance = errorOf(() => advanceSprint(ctx, { runId: run.runId }))
    expect(advance).toMatchObject({ code: 'gate_blocked', message })
    const unmet = (advance.details as { conditions: GateCondition[] }).conditions.filter((item) => !item.met)
    expect(unmet.map((item) => item.id)).toEqual(['increment_merged'])
  })

  it('lets the person approve once the increment verified', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2, 3])
    const submitted = report(ctx, run)
    expect(approveCheckpoint(withRole(ctx, 'desktop'), { runId: run.runId, reportId: submitted.id }).sprintId).toBe(sid(1))
    expect(advanceSprint(ctx, { runId: run.runId })).toMatchObject({ outcome: 'advanced', activeSprintId: sid(2) })
  })
})
