/**
 * The `plan_current` gate: a checkpoint is approved only while the run executes the epic's saved plan and the
 * epic's draft holds no unsaved changes. A draft opened without changes does not count.
 */
import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { GateCondition, SprintReportView } from '../../shared/domain/views'
import { makeBundle, sid, tid } from '../../test/bundles'
import { acceptTickets, errorOf, seedRevision, seedRun, type SeededRun } from '../../test/checkpointSeed'
import { createTestCtx, withRole, type TestCtx } from '../../test/testContext'
import { adoptRevision } from './adoption'
import { advanceSprint, approveCheckpoint, authorizeAutoContinue, getCheckpoint } from './checkpoints'
import { discardPlanDraft, openDraft, updatePlanDraft } from './drafts'
import { submitSprintReport } from './reports'

interface Fixture {
  ctx: TestCtx
  desktop: TestCtx
  run: SeededRun
  report: SprintReportView
}

/** Sprint 1 of 2 finished: DM-1 and DM-2 accepted, report submitted, run awaiting its checkpoint. */
function finishedSprint(bundle: PlanBundle = makeBundle([[1, 2], [3]])): Fixture {
  const ctx = createTestCtx()
  const run = seedRun(ctx, { bundle })
  acceptTickets(ctx, run, [1, 2])
  const report = submitSprintReport(ctx, { runId: run.runId, sprintId: sid(1), report: { summary: 'Sprint 1 finished.' } })
  return { ctx, desktop: withRole(ctx, 'desktop'), run, report }
}

function planGate(ctx: TestCtx, run: SeededRun): GateCondition | undefined {
  return getCheckpoint(ctx, { runId: run.runId }).conditions.find((item) => item.id === 'plan_current')
}

function retitle(fixture: Fixture, ticket: number): number {
  const ops = [{ op: 'update_ticket' as const, ticket: tid(ticket), patch: { title: 'Retitled in the draft' } }]
  return updatePlanDraft(fixture.ctx, { epicId: fixture.run.epicId, ops }).draftRevision
}

const MET = {
  id: 'plan_current',
  label: 'Run executes the current plan',
  met: true,
  detail: 'The run executes revision 1, the saved plan, and no draft holds unsaved changes'
}

describe('plan_current when the plan is current', () => {
  it('is met, and sits after the exit criteria, right before the approval', () => {
    const { ctx, run } = finishedSprint()
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect(view.conditions.map((item) => item.id)).toEqual([
      'report_submitted',
      'no_active_leases',
      'required_accepted',
      'exit_criteria',
      'plan_current',
      'approval'
    ])
    expect(planGate(ctx, run)).toEqual(MET)
    expect(view.gatesMet).toBe(true)
  })

  it('stays met for a draft opened without changes, so the checkpoint can be approved', () => {
    const fixture = finishedSprint()
    openDraft(fixture.ctx, { epicId: fixture.run.epicId })
    expect(planGate(fixture.ctx, fixture.run)).toEqual(MET)
    expect(approveCheckpoint(fixture.desktop, { runId: fixture.run.runId, reportId: fixture.report.id }).reportId).toBe(fixture.report.id)
  })
})

describe('plan_current with an unsaved draft', () => {
  it('blocks approval and says to save and adopt, or discard', () => {
    const fixture = finishedSprint()
    const draftRevision = retitle(fixture, 3)
    const detail = `The draft (revision ${draftRevision}) has changes the saved plan lacks: save it and adopt the new revision, or discard the draft`
    expect(planGate(fixture.ctx, fixture.run)).toEqual({ ...MET, met: false, detail })
    const refused = errorOf(() => approveCheckpoint(fixture.desktop, { runId: fixture.run.runId, reportId: fixture.report.id }))
    expect(refused).toMatchObject({ code: 'gate_blocked', message: `Sprint 1 can't advance yet: ${detail}` })
    expect(fixture.ctx.db.all('SELECT id FROM approvals')).toEqual([])
  })

  it('is met again once the draft is discarded', () => {
    const fixture = finishedSprint()
    retitle(fixture, 3)
    discardPlanDraft(fixture.ctx, { epicId: fixture.run.epicId })
    expect(planGate(fixture.ctx, fixture.run)).toEqual(MET)
  })

  it('also holds back an authorized automatic continuation', () => {
    const bundle = makeBundle([[1, 2], [3]])
    bundle.sprints = bundle.sprints.map((sprint) => ({ ...sprint, checkpoint: { mode: 'auto' } }))
    const fixture = finishedSprint(bundle)
    authorizeAutoContinue(fixture.desktop, { runId: fixture.run.runId, enabled: true })
    retitle(fixture, 3)
    expect(errorOf(() => advanceSprint(fixture.ctx, { runId: fixture.run.runId })).code).toBe('gate_blocked')
  })
})

describe('plan_current with a saved revision the run has not adopted', () => {
  it('blocks approval and says to adopt it; adopting clears it', () => {
    const fixture = finishedSprint()
    const revisionId = seedRevision(fixture.ctx, fixture.run.epicId, makeBundle([[1, 2], [3, 4]]))
    const detail = 'Saved revision 2 is newer than revision 1, which the run executes: adopt it'
    expect(planGate(fixture.ctx, fixture.run)).toEqual({ ...MET, met: false, detail })
    expect(errorOf(() => approveCheckpoint(fixture.desktop, { runId: fixture.run.runId, reportId: fixture.report.id })).code).toBe(
      'gate_blocked'
    )
    adoptRevision(fixture.ctx, { runId: fixture.run.runId, revisionId })
    expect(planGate(fixture.ctx, fixture.run)).toEqual({
      ...MET,
      detail: 'The run executes revision 2, the saved plan, and no draft holds unsaved changes'
    })
  })

  it('names both problems when both are there', () => {
    const fixture = finishedSprint()
    seedRevision(fixture.ctx, fixture.run.epicId, makeBundle([[1, 2], [3, 4]]))
    const draftRevision = retitle(fixture, 3)
    expect(planGate(fixture.ctx, fixture.run)?.detail).toBe(
      `The draft (revision ${draftRevision}) has changes the saved plan lacks: save it and adopt the new revision, or discard the draft; ` +
        'Saved revision 2 is newer than revision 1, which the run executes: adopt it'
    )
  })
})
