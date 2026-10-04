/**
 * Approve with redraft at the service: one person's approval covers the retro and the redraft. It saves the
 * draft, adopts the saved revision, recomputes the gates on it, approves the current report and advances, in that
 * order. The save commits on its own; adopting, recomputing, approving and advancing run in one transaction, so a
 * refusal at any of them leaves the run as it was and the saved revision in place.
 */
import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { SprintRetroInput } from '../../shared/domain/retro'
import type { SprintReportView } from '../../shared/domain/views'
import { makeBundle, sid, tid } from '../../test/bundles'
import { acceptTickets, errorOf, eventLog, runRow, seedAttempt, seedRun, type SeededRun } from '../../test/checkpointSeed'
import { createTestCtx, withRole, type TestCtx } from '../../test/testContext'
import { approveWithRedraft } from './approveRedraft'
import { updatePlanDraft } from './drafts'
import { completeSavedRevision, loadRevisionBundle } from './plans'
import { redraftNextSprint } from './redraft'
import { submitSprintReport } from './reports'

const RETRO: SprintRetroInput = {
  leftovers: [{ ticket: 'DM-2', reason: 'Waiting on a signing identity' }],
  discoveries: [{ title: 'Cache the parser output', body: 'Every run reparses the same files.', ticket: 'DM-1' }]
}

interface Fixture {
  ctx: TestCtx
  desktop: TestCtx
  run: SeededRun
  report: SprintReportView
  draftRevision: number
  discoveryId: string
}

interface SetupOptions {
  /** Default: sprint 1 = DM-1, DM-2, DM-3 (DM-3 requires DM-2), sprint 2 = DM-4. */
  bundle?: PlanBundle
  /** Tickets accepted before the report (default: DM-1). */
  accepted?: number[]
}

/** The run waits at its first checkpoint with DM-2 a leftover in the retro, and the next sprint is redrafted. */
function redrafted(options: SetupOptions = {}): Fixture {
  const ctx = createTestCtx()
  const run = seedRun(ctx, { bundle: options.bundle ?? makeBundle([[1, 2, 3], [4]], [[2, 3]]) })
  acceptTickets(ctx, run, options.accepted ?? [1])
  const report = submitSprintReport(ctx, { runId: run.runId, sprintId: sid(1), report: { summary: 'Sprint 1 is over.', retro: RETRO } })
  const redraft = redraftNextSprint(ctx, { runId: run.runId })
  return {
    ctx,
    desktop: withRole(ctx, 'desktop'),
    run,
    report,
    draftRevision: redraft.draftRevision,
    discoveryId: redraft.added[0]?.ticketId ?? ''
  }
}

/** The finalizer's part of a save: every pending revision becomes saved, as a successful flush does. */
function finalizer(ctx: TestCtx): () => void {
  return () => {
    for (const row of ctx.db.all<{ id: string }>("SELECT id FROM plan_revisions WHERE state = 'pending' ORDER BY number")) {
      completeSavedRevision(ctx, row.id)
    }
  }
}

function currentRevisionId(ctx: TestCtx, epicId: string): string | null {
  return ctx.db.get<{ id: string | null }>('SELECT current_revision_id AS id FROM epics WHERE id = ?', epicId)?.id ?? null
}

const STEP_EVENTS = ['plan.save_requested', 'plan.saved', 'run.revision_adopted', 'checkpoint.approved', 'checkpoint.advanced']

describe('approveWithRedraft: the steps, in order', () => {
  it('saves the draft, adopts it, approves the current report and advances', () => {
    const fixture = redrafted()
    fixture.ctx.clock.advanceSeconds(30)
    const result = approveWithRedraft(fixture.desktop, { runId: fixture.run.runId, expectedDraftRevision: fixture.draftRevision }, finalizer(fixture.ctx))
    const saved = currentRevisionId(fixture.ctx, fixture.run.epicId) ?? ''
    expect(saved).not.toBe(fixture.run.revisionId)
    expect(result).toEqual({
      save: { status: 'saved', revisionId: saved, revisionNumber: 2 },
      adoption: { revisionId: saved, kept: [tid(1)], superseded: [], freshBudget: [] },
      approval: { id: expect.stringMatching(/^ap_/), runId: fixture.run.runId, sprintId: sid(1), reportId: fixture.report.id, issuedAt: '2026-01-01T00:00:30.000Z' },
      advance: { outcome: 'advanced', activeSprintId: sid(2) }
    })
    expect(eventLog(fixture.ctx).map((event) => event.kind).filter((kind) => STEP_EVENTS.includes(kind))).toEqual(STEP_EVENTS)
    expect(runRow(fixture.ctx, fixture.run.runId)).toMatchObject({ state: 'running', revision_id: saved, active_sprint_id: sid(2) })
  })

  it('binds the grant to the adopted revision and the report it approves, and consumes it advancing', () => {
    const fixture = redrafted()
    const result = approveWithRedraft(fixture.desktop, { runId: fixture.run.runId, expectedDraftRevision: fixture.draftRevision }, finalizer(fixture.ctx))
    const grants = fixture.ctx.db.all('SELECT id, revision_id, sprint_id, report_id, report_hash, consumed_at FROM approvals')
    expect(grants).toEqual([
      {
        id: result.approval.id,
        revision_id: result.save.revisionId,
        sprint_id: sid(1),
        report_id: fixture.report.id,
        report_hash: fixture.report.contentHash,
        consumed_at: expect.any(String)
      }
    ])
    expect(fixture.ctx.db.all('SELECT approval_id, report_id, outcome FROM checkpoints')).toEqual([
      { approval_id: result.approval.id, report_id: fixture.report.id, outcome: 'advanced' }
    ])
  })

  it('leaves the next sprint holding the moved leftover, what requires it, and the discovery', () => {
    const fixture = redrafted()
    const result = approveWithRedraft(fixture.desktop, { runId: fixture.run.runId, expectedDraftRevision: fixture.draftRevision }, finalizer(fixture.ctx))
    const bundle = loadRevisionBundle(fixture.ctx, result.save.revisionId)
    expect(bundle.sprints.map((sprint) => sprint.ticketIds)).toEqual([[tid(1)], [tid(4), tid(2), tid(3), fixture.discoveryId]])
  })
})

describe('approveWithRedraft on the final sprint, and with nothing to adopt', () => {
  it('moves into the sprint the redraft added after the final one instead of completing the epic', () => {
    const fixture = redrafted({ bundle: makeBundle([[1, 2]]) })
    const result = approveWithRedraft(fixture.desktop, { runId: fixture.run.runId, expectedDraftRevision: fixture.draftRevision }, finalizer(fixture.ctx))
    const next = loadRevisionBundle(fixture.ctx, result.save.revisionId).sprints.find((sprint) => sprint.ordinal === 2)
    expect(result.advance).toEqual({ outcome: 'advanced', activeSprintId: next?.id })
    expect(next?.ticketIds).toEqual(expect.arrayContaining([tid(2), fixture.discoveryId]))
    expect(runRow(fixture.ctx, fixture.run.runId)).toMatchObject({ state: 'running', active_sprint_id: next?.id })
    expect(fixture.ctx.db.get('SELECT status FROM epics WHERE id = ?', fixture.run.epicId)).toEqual({ status: 'in_progress' })
  })

  it('skips adoption when the draft matches the saved plan the run already executes', () => {
    const ctx = createTestCtx()
    const run = seedRun(ctx)
    acceptTickets(ctx, run, [1, 2])
    const report = submitSprintReport(ctx, { runId: run.runId, sprintId: sid(1), report: { summary: 'Done.', retro: { wentWell: ['All of it'] } } })
    const redraft = redraftNextSprint(ctx, { runId: run.runId })
    expect(redraft.changed).toBe(false)
    const result = approveWithRedraft(withRole(ctx, 'desktop'), { runId: run.runId, expectedDraftRevision: redraft.draftRevision }, finalizer(ctx))
    expect(result).toMatchObject({
      save: { status: 'unchanged', revisionId: run.revisionId, revisionNumber: 1 },
      adoption: null,
      approval: { reportId: report.id },
      advance: { outcome: 'advanced', activeSprintId: sid(2) }
    })
  })
})

interface Snapshot {
  revisions: { number: number; state: string }[]
  current: string | null
  run: { state: string; revision_id: string; active_sprint_id: string | null } | undefined
  approvals: number
  checkpoints: number
  adoptions: number
}

/** What the steps leave behind: the epic's revisions, the run, grants, checkpoint decisions and adoptions. */
function snapshot(fixture: Fixture): Snapshot {
  const run = runRow(fixture.ctx, fixture.run.runId)
  return {
    revisions: fixture.ctx.db.all('SELECT number, state FROM plan_revisions ORDER BY number'),
    current: currentRevisionId(fixture.ctx, fixture.run.epicId),
    run: run === undefined ? undefined : { state: run.state, revision_id: run.revision_id, active_sprint_id: run.active_sprint_id },
    approvals: fixture.ctx.db.all('SELECT id FROM approvals').length,
    checkpoints: fixture.ctx.db.all('SELECT id FROM checkpoints').length,
    adoptions: eventLog(fixture.ctx).filter((event) => event.kind === 'run.revision_adopted').length
  }
}

function attempt(fixture: Fixture, input: { expectedDraftRevision?: number; reportId?: string } = {}, flush?: () => void) {
  const request = { runId: fixture.run.runId, expectedDraftRevision: fixture.draftRevision, ...input }
  return errorOf(() => approveWithRedraft(fixture.desktop, request, flush ?? finalizer(fixture.ctx)))
}

const UNTOUCHED_RUN = { state: 'awaiting_checkpoint', active_sprint_id: sid(1) }

describe('approveWithRedraft refused at the save', () => {
  it('saves nothing for a stale draft revision, a report that is not the latest, or a run that is not at its checkpoint', () => {
    const fixture = redrafted()
    const before = snapshot(fixture)
    const stale = attempt(fixture, { expectedDraftRevision: fixture.draftRevision - 1 })
    expect(stale).toMatchObject({ code: 'conflict', details: { step: 'save', stepNumber: 1, adoptionNeeded: false } })
    expect(stale.message).toMatch(/^Approve with redraft stopped at step 1 of 5 \(save\): The draft changed/)
    expect(attempt(fixture, { reportId: 'rp_00000000000000000000000000' })).toMatchObject({ code: 'conflict', details: { step: 'save' } })
    fixture.ctx.db.run("UPDATE runs SET state = 'paused'")
    expect(attempt(fixture)).toMatchObject({ code: 'run_not_active', details: { step: 'save' } })
    expect(snapshot(fixture)).toEqual({ ...before, run: { ...before.run, state: 'paused' } })
  })

  it('stops when the save is still pending after the flush, and says to flush and adopt', () => {
    const fixture = redrafted()
    const refused = attempt(fixture, {}, () => undefined)
    expect(refused).toMatchObject({ code: 'save_pending', details: { step: 'save', savedRevisionId: null, adoptionNeeded: false } })
    expect(refused.message).toContain('Revision 2 is still being saved')
    expect(refused.message).toContain('flush portable state, then adopt it and approve')
    expect(snapshot(fixture)).toMatchObject({ revisions: [{ number: 1, state: 'saved' }, { number: 2, state: 'pending' }], approvals: 0, adoptions: 0 })
    expect(snapshot(fixture).run).toMatchObject({ ...UNTOUCHED_RUN, revision_id: fixture.run.revisionId })
  })
})

/** Asserts the state a refusal after the save leaves: the revision saved and current, the run untouched. */
function expectSavedButNotAdopted(fixture: Fixture, refused: ReturnType<typeof attempt>, step: string): void {
  const saved = currentRevisionId(fixture.ctx, fixture.run.epicId)
  expect(refused.details).toMatchObject({ step, savedRevisionId: saved, savedRevisionNumber: 2, adoptionNeeded: true })
  expect(refused.message).toContain('The draft is saved as revision 2, but Run #1 still executes revision 1: adoption is still needed.')
  expect(snapshot(fixture)).toMatchObject({
    revisions: [{ number: 1, state: 'saved' }, { number: 2, state: 'saved' }],
    run: { ...UNTOUCHED_RUN, revision_id: fixture.run.revisionId },
    approvals: 0,
    checkpoints: 0,
    adoptions: 0
  })
}

describe('approveWithRedraft refused after the save', () => {
  it('names adopt when adoption refuses, and approves and advances nothing', () => {
    const fixture = redrafted()
    seedAttempt(fixture.ctx, fixture.run, { ticket: 4, state: 'running' })
    const refused = attempt(fixture)
    expect(refused).toMatchObject({ code: 'conflict' })
    expect(refused.message).toMatch(/^Approve with redraft stopped at step 2 of 5 \(adopt\): Finish or reconcile the open attempts/)
    expectSavedButNotAdopted(fixture, refused, 'adopt')
  })

  it('names recompute when the gates on the adopted revision are unmet, and undoes the adoption', () => {
    const fixture = redrafted({ accepted: [] })
    const refused = attempt(fixture)
    expect(refused).toMatchObject({ code: 'gate_blocked' })
    expect(refused.message).toMatch(/^Approve with redraft stopped at step 3 of 5 \(recompute\): Sprint 1 can't advance yet: DM-1 not started\./)
    expectSavedButNotAdopted(fixture, refused, 'recompute')
  })

  it.each([
    ['approve', 'approvals'],
    ['advance', 'checkpoints']
  ])('names %s when that step fails, and undoes everything after the save', (step, table) => {
    const fixture = redrafted()
    fixture.ctx.db.exec(`CREATE TRIGGER refuse BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    const refused = attempt(fixture)
    expect(refused).toMatchObject({ code: 'internal' })
    expect(refused.message).toContain(`(${step}): disk full.`)
    expectSavedButNotAdopted(fixture, refused, step)
  })
})

describe('approveWithRedraft on a sprint with an acceptance node', () => {
  it('recomputes on the adopted membership: the moved leftover no longer blocks, but the node still has to run', () => {
    const bundle = makeBundle([[1, 2, 3], [4, 5]])
    bundle.tickets = bundle.tickets.map((ticket) => (ticket.id === tid(3) || ticket.id === tid(5) ? { ...ticket, kind: 'acceptance' as const } : ticket))
    const fixture = redrafted({ bundle })
    const refused = attempt(fixture)
    expect(refused.message).toMatch(/\(recompute\): Sprint 1 can't advance yet: DM-3 not started; /)
    expect(refused.message).not.toContain('DM-2')
    expectSavedButNotAdopted(fixture, refused, 'recompute')
  })
})

describe('approveWithRedraft and a report the adopted revision makes stale', () => {
  it('names recompute and asks for a new report revision when the draft changed the sprint beyond its leftovers', () => {
    const fixture = redrafted()
    const ops = [{ op: 'update_sprint' as const, sprint: sid(1), patch: { exitCriteria: ['The parser ships'] } }]
    const edited = updatePlanDraft(fixture.ctx, { epicId: fixture.run.epicId, ops, expectedDraftRevision: fixture.draftRevision })
    const refused = attempt(fixture, { expectedDraftRevision: edited.draftRevision })
    expect(refused.message).toContain('(recompute)')
    expect(refused.message).toContain('changed the sprint beyond removing leftovers (its exit criteria changed): submit a new report revision')
    expectSavedButNotAdopted(fixture, refused, 'recompute')
  })
})

describe('who may approve with redraft', () => {
  it.each(['orchestrator', 'planner', 'worker', 'reviewer'] as const)('refuses a %s session before saving anything', (role) => {
    const fixture = redrafted()
    const before = snapshot(fixture)
    const agent = withRole(fixture.ctx, role, { allowSave: true })
    const request = { runId: fixture.run.runId, expectedDraftRevision: fixture.draftRevision }
    expect(errorOf(() => approveWithRedraft(agent, request, finalizer(fixture.ctx))).code).toBe('unauthorized')
    expect(snapshot(fixture)).toEqual(before)
  })
})
