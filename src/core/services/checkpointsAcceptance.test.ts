import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { GateCondition } from '../../shared/domain/views'
import { makeBundle, sid, tid } from '../../test/bundles'
import {
  acceptTickets,
  errorOf,
  seedAttempt,
  seedRun,
  type SeededRun,
  type SeedRunOptions
} from '../../test/checkpointSeed'
import { createTestCtx, withRole, type TestCtx } from '../../test/testContext'
import { advanceSprint, approveCheckpoint, getCheckpoint } from './checkpoints'
import { submitSprintReport } from './reports'

/** Sprint 1 = {DM-1, DM-2, DM-3}, sprint 2 = {DM-4, DM-5}; DM-3 and DM-5 are the sprints' acceptance nodes. */
function plan(patch: { optionalNode?: boolean } = {}): PlanBundle {
  const bundle = makeBundle([[1, 2, 3], [4, 5]])
  bundle.tickets = bundle.tickets.map((ticket) =>
    ticket.id === tid(3) || ticket.id === tid(5)
      ? { ...ticket, kind: 'acceptance' as const, optional: patch.optionalNode === true && ticket.id === tid(3) }
      : ticket
  )
  return bundle
}

function setup(options: SeedRunOptions = {}): { ctx: TestCtx; run: SeededRun } {
  const ctx = createTestCtx()
  return { ctx, run: seedRun(ctx, { bundle: plan(), ...options }) }
}

function report(ctx: TestCtx, run: SeededRun, sprint = 1) {
  return submitSprintReport(ctx, { runId: run.runId, sprintId: sid(sprint), report: { summary: 'Sprint finished.' } })
}

function acceptanceGate(ctx: TestCtx, run: SeededRun): GateCondition | undefined {
  return getCheckpoint(ctx, { runId: run.runId }).conditions.find((item) => item.id === 'acceptance_accepted')
}

describe('acceptance_accepted gate', () => {
  it('is unmet until the sprint acceptance node is accepted, and says which ticket is missing', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    report(ctx, run)
    expect(acceptanceGate(ctx, run)).toEqual({
      id: 'acceptance_accepted',
      label: 'Sprint acceptance accepted',
      met: false,
      detail: 'DM-3 not started'
    })
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect([view.gatesMet, view.canAdvance]).toEqual([false, false])
  })

  it('is met once the node has an accepted attempt', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2, 3])
    report(ctx, run)
    expect(acceptanceGate(ctx, run)).toEqual({
      id: 'acceptance_accepted',
      label: 'Sprint acceptance accepted',
      met: true,
      detail: 'DM-3 accepted'
    })
    expect(getCheckpoint(ctx, { runId: run.runId }).gatesMet).toBe(true)
  })

  it('leaves the required-ticket gate to the work tickets, so the node is reported once', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    const conditions = getCheckpoint(ctx, { runId: run.runId }).conditions
    expect(conditions.find((item) => item.id === 'required_accepted')).toMatchObject({
      met: true,
      detail: '2 of 2 required tickets accepted'
    })
    // The node is named by its own two gates, never by the required-ticket gate.
    expect(conditions.filter((item) => item.detail.includes('DM-3')).map((item) => item.id)).toEqual([
      'acceptance_accepted',
      'increment_merged'
    ])
  })
})

describe('acceptance_accepted gate: what it says', () => {
  it('sits right after the required-ticket gate, followed by the increment gate', () => {
    const { ctx, run } = setup()
    expect(getCheckpoint(ctx, { runId: run.runId }).conditions.map((item) => item.id)).toEqual([
      'report_submitted',
      'no_active_leases',
      'required_accepted',
      'acceptance_accepted',
      'increment_merged',
      'exit_criteria',
      'approval'
    ])
  })

  it('says why the node does not count yet', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    seedAttempt(ctx, run, { ticket: 3, state: 'submitted' })
    expect(acceptanceGate(ctx, run)?.detail).toBe('DM-3 is awaiting review')
    seedAttempt(ctx, run, { ticket: 3, state: 'rejected' })
    expect(acceptanceGate(ctx, run)?.detail).toBe('DM-3 was rejected after 2 attempts')
  })

  it('does not count an acceptance that an adopted revision superseded', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted', superseded: true })
    expect(acceptanceGate(ctx, run)).toMatchObject({
      met: false,
      detail: 'DM-3 changed in an adopted revision and needs new work'
    })
  })

  it('counts a later acceptance after an earlier failed attempt', () => {
    const { ctx, run } = setup()
    seedAttempt(ctx, run, { ticket: 3, state: 'failed' })
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted' })
    expect(acceptanceGate(ctx, run)).toMatchObject({ met: true, detail: 'DM-3 accepted' })
  })
})

describe('acceptance_accepted gate on other plans', () => {
  it('is absent for a sprint with no acceptance node, leaving the gates as before', () => {
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
      'approval'
    ])
    expect(view.gatesMet).toBe(true)
  })

  it('applies only to a sprint that has a node when a plan mixes old and new sprints', () => {
    const bundle = plan()
    bundle.tickets = bundle.tickets.map((ticket) => (ticket.id === tid(3) ? { ...ticket, kind: 'work' as const } : ticket))
    const ctx = createTestCtx()
    const first = seedRun(ctx, { bundle })
    expect(acceptanceGate(ctx, first)).toBeUndefined()
    const second = seedRun(ctx, { bundle, activeSprint: 2 })
    expect(acceptanceGate(ctx, second)).toMatchObject({ met: false, detail: 'DM-5 not started' })
  })

  it('is required even when the node is optional, which the required-ticket gate skips', () => {
    const ctx = createTestCtx()
    const run = seedRun(ctx, { bundle: plan({ optionalNode: true }) })
    acceptTickets(ctx, run, [1, 2])
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect(view.conditions.find((item) => item.id === 'required_accepted')?.met).toBe(true)
    expect(acceptanceGate(ctx, run)).toMatchObject({ met: false, detail: 'DM-3 not started' })
  })
})

describe('acceptance_accepted gate on the final sprint', () => {
  it('checks the final sprint node and leaves earlier nodes to the required-ticket gate', () => {
    const { ctx, run } = setup({ activeSprint: 2 })
    acceptTickets(ctx, run, [1, 2, 4])
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect(view.conditions.map((item) => item.id)).toEqual([
      'report_submitted',
      'no_active_leases',
      'required_accepted',
      'acceptance_accepted',
      'increment_merged',
      'exit_criteria',
      'epic_outcome',
      'approval'
    ])
    expect(acceptanceGate(ctx, run)).toMatchObject({ met: false, detail: 'DM-5 not started' })
    expect(view.conditions.find((item) => item.id === 'required_accepted')?.detail).toBe('DM-3 not started')
  })

  it('is met when the final sprint node is accepted', () => {
    const { ctx, run } = setup({ activeSprint: 2 })
    acceptTickets(ctx, run, [1, 2, 3, 4, 5])
    expect(acceptanceGate(ctx, run)).toMatchObject({ met: true, detail: 'DM-5 accepted' })
    const required = getCheckpoint(ctx, { runId: run.runId }).conditions.find((item) => item.id === 'required_accepted')
    expect(required).toMatchObject({ met: true, detail: '4 of 4 required tickets accepted' })
  })
})

describe('a checkpoint cannot be passed without the acceptance node', () => {
  it('refuses approval and advance with the missing node named', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    const submitted = report(ctx, run)
    const message =
      "Sprint 1 can't advance yet: DM-3 not started; No sprint increment named yet: submit DM-3 with increment { branch, commit }"
    const approval = errorOf(() => approveCheckpoint(withRole(ctx, 'desktop'), { runId: run.runId, reportId: submitted.id }))
    expect(approval).toMatchObject({ code: 'gate_blocked', message })
    const advance = errorOf(() => advanceSprint(ctx, { runId: run.runId }))
    expect(advance).toMatchObject({ code: 'gate_blocked', message })
    const unmet = (advance.details as { conditions: GateCondition[] }).conditions.filter((item) => !item.met)
    expect(unmet.map((item) => item.id)).toEqual(['acceptance_accepted', 'increment_merged'])
  })

  it('lets the person approve once the node is accepted', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2, 3])
    const submitted = report(ctx, run)
    const desktop = withRole(ctx, 'desktop')
    expect(approveCheckpoint(desktop, { runId: run.runId, reportId: submitted.id }).sprintId).toBe(sid(1))
    expect(advanceSprint(ctx, { runId: run.runId })).toMatchObject({ outcome: 'advanced', activeSprintId: sid(2) })
  })
})
