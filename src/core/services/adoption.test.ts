import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import { makeBundle, sid, tid } from '../../test/bundles'
import {
  acceptTickets,
  errorOf,
  eventLog,
  outboxEntries,
  runRow,
  seedAttempt,
  seedRevision,
  seedRun,
  ticketStatusOf,
  type SeededRun,
  type SeedRunOptions
} from '../../test/checkpointSeed'
import { createTestCtx, withRole, type TestCtx } from '../../test/testContext'
import { adoptRevision } from './adoption'
import { advanceSprint, approveCheckpoint, getCheckpoint } from './checkpoints'
import { submitSprintReport } from './reports'

/** Sprint 1 = {DM-1, DM-2} accepted, sprint 2 = {DM-3}; the run waits at its first checkpoint. */
function atCheckpoint(options: SeedRunOptions = {}): { ctx: TestCtx; run: SeededRun } {
  const ctx = createTestCtx()
  const run = seedRun(ctx, { state: 'awaiting_checkpoint', ...options })
  acceptTickets(ctx, run, [1, 2])
  return { ctx, run }
}

function retitle(bundle: PlanBundle, ticketNumber: number): PlanBundle {
  return {
    ...bundle,
    tickets: bundle.tickets.map((ticket) =>
      ticket.id === tid(ticketNumber) ? { ...ticket, title: `${ticket.title} (revised)` } : ticket
    )
  }
}

function supersededAt(ctx: TestCtx, ticketNumber: number): (string | null)[] {
  return ctx.db
    .all<{ superseded_at: string | null }>('SELECT superseded_at FROM attempts WHERE ticket_id = ? ORDER BY number', tid(ticketNumber))
    .map((row) => row.superseded_at)
}

describe('adoptRevision reconciliation', () => {
  it('keeps unchanged acceptances and supersedes changed tickets', () => {
    const { ctx, run } = atCheckpoint()
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted', superseded: true })
    const revisionId = seedRevision(ctx, run.epicId, retitle(run.bundle, 2))
    ctx.clock.advanceSeconds(60)
    const now = '2026-01-01T00:01:00.000Z'
    const result = adoptRevision(ctx, { runId: run.runId, revisionId })
    expect(result).toEqual({ runId: run.runId, kept: [tid(1)], superseded: [tid(2)], activeSprintId: sid(1) })
    expect([supersededAt(ctx, 1), supersededAt(ctx, 2)]).toEqual([[null], [now]])
    expect(runRow(ctx, run.runId)).toMatchObject({ revision_id: revisionId, active_sprint_id: sid(1), revision: 2, updated_at: now })
    expect([ticketStatusOf(ctx, 1), ticketStatusOf(ctx, 2)]).toEqual(['completed', 'in_progress'])
    expect(eventLog(ctx)).toEqual([
      {
        kind: 'run.revision_adopted',
        epicId: run.epicId,
        runId: run.runId,
        ticketId: null,
        payload: { from: run.revisionId, to: revisionId, kept: [tid(1)], superseded: [tid(2)] }
      }
    ])
    expect(outboxEntries(ctx).map((entry) => [entry.kind, entry.epic_id])).toEqual([
      ['run_history', run.epicId],
      ['epic_state', run.epicId]
    ])
  })

  it('keeps changed tickets that are explicitly carried forward', () => {
    const { ctx, run } = atCheckpoint()
    const revisionId = seedRevision(ctx, run.epicId, retitle(run.bundle, 2))
    const result = adoptRevision(ctx, { runId: run.runId, revisionId, carryForward: [tid(2)] })
    expect([result.kept, result.superseded]).toEqual([[tid(1), tid(2)], []])
    expect([supersededAt(ctx, 2), ticketStatusOf(ctx, 2)]).toEqual([[null], 'completed'])
    expect(outboxEntries(ctx).map((entry) => entry.kind)).toEqual(['run_history'])
  })

  it('supersedes acceptances of tickets the new revision removed, even when listed for carry-forward', () => {
    const { ctx, run } = atCheckpoint()
    const revisionId = seedRevision(ctx, run.epicId, makeBundle([[1], [3]]))
    const result = adoptRevision(ctx, { runId: run.runId, revisionId, carryForward: [tid(2)] })
    expect([result.kept, result.superseded]).toEqual([[tid(1)], [tid(2)]])
    expect([supersededAt(ctx, 2)[0] === null, ticketStatusOf(ctx, 2)]).toEqual([false, 'completed'])
  })
})

describe('adoptRevision active sprint', () => {
  it('keeps the active sprint when its id survives', () => {
    const { ctx, run } = atCheckpoint({ activeSprint: 2 })
    const revisionId = seedRevision(ctx, run.epicId, makeBundle([[1, 2], [3], [4]]))
    expect(adoptRevision(ctx, { runId: run.runId, revisionId }).activeSprintId).toBe(sid(2))
  })

  it('falls back to the sprint with the same ordinal, then to the last sprint', () => {
    const { ctx, run } = atCheckpoint({ activeSprint: 2 })
    const renamed = makeBundle([[1, 2], [3]])
    renamed.sprints = renamed.sprints.map((sprint) => ({ ...sprint, id: sid(sprint.ordinal + 10) }))
    const second = seedRevision(ctx, run.epicId, renamed)
    expect(adoptRevision(ctx, { runId: run.runId, revisionId: second }).activeSprintId).toBe(sid(12))
    const merged = seedRevision(ctx, run.epicId, makeBundle([[1, 2, 3]]))
    expect(adoptRevision(ctx, { runId: run.runId, revisionId: merged }).activeSprintId).toBe(sid(1))
  })
})

describe('adoptRevision guards', () => {
  it('only adopts at a checkpoint or while paused', () => {
    const { ctx, run } = atCheckpoint({ state: 'running' })
    const revisionId = seedRevision(ctx, run.epicId, retitle(run.bundle, 3))
    expect(errorOf(() => adoptRevision(ctx, { runId: run.runId, revisionId }))).toMatchObject({
      code: 'run_not_active',
      message: 'Adopt a new revision at a checkpoint or while paused.'
    })
    const paused = seedRun(ctx, { state: 'paused' })
    const next = seedRevision(ctx, paused.epicId, retitle(paused.bundle, 3))
    expect(adoptRevision(ctx, { runId: paused.runId, revisionId: next }).activeSprintId).toBe(sid(1))
  })

  it('refuses while attempts are open', () => {
    const { ctx, run } = atCheckpoint()
    const open = seedAttempt(ctx, run, { ticket: 3, state: 'submitted' })
    const revisionId = seedRevision(ctx, run.epicId, retitle(run.bundle, 3))
    const result = errorOf(() => adoptRevision(ctx, { runId: run.runId, revisionId }))
    expect(result).toMatchObject({ code: 'conflict', details: { openAttempts: [open] } })
    expect(runRow(ctx, run.runId)?.revision_id).toBe(run.revisionId)
  })

  it("only adopts the epic's current saved revision, and only a different one", () => {
    const { ctx, run } = atCheckpoint()
    const sameRevision = errorOf(() => adoptRevision(ctx, { runId: run.runId, revisionId: run.revisionId }))
    expect(sameRevision).toMatchObject({ code: 'conflict', message: 'The run already executes this revision.' })
    const older = seedRevision(ctx, run.epicId, retitle(run.bundle, 3))
    seedRevision(ctx, run.epicId, retitle(run.bundle, 1))
    const stale = errorOf(() => adoptRevision(ctx, { runId: run.runId, revisionId: older }))
    expect(stale).toMatchObject({ code: 'conflict', message: "Only the epic's current saved revision can be adopted." })
    const pending = seedRevision(ctx, run.epicId, retitle(run.bundle, 2), { state: 'pending' })
    const unsaved = errorOf(() => adoptRevision(ctx, { runId: run.runId, revisionId: pending }))
    expect(unsaved).toMatchObject({ code: 'conflict', message: `Revision ${pending} is not saved yet.` })
  })

  it('requires ownership, the run.adopt capability, an unchanged branch, and an existing run', () => {
    const { ctx, run } = atCheckpoint({ ownerMachineId: 'mc_0000000000000000000000other' })
    const revisionId = seedRevision(ctx, run.epicId, retitle(run.bundle, 3))
    expect(errorOf(() => adoptRevision(ctx, { runId: run.runId, revisionId })).code).toBe('run_not_owned')
    expect(errorOf(() => adoptRevision(withRole(ctx, 'planner'), { runId: run.runId, revisionId })).code).toBe('unauthorized')
    const moved: TestCtx = {
      ...ctx,
      assertBranch: () => {
        throw Object.assign(new Error('branch moved'), { code: 'branch_changed' })
      }
    }
    expect(errorOf(() => adoptRevision(moved, { runId: run.runId, revisionId })).code).toBe('branch_changed')
    expect(errorOf(() => adoptRevision(ctx, { runId: 'rn_00000000000000000000000404', revisionId })).code).toBe('not_found')
  })
})

describe('adoptRevision and checkpoint approvals', () => {
  it('invalidates grants bound to the previously pinned revision', () => {
    const agent = createTestCtx()
    const desktop = withRole(agent, 'desktop')
    const run = seedRun(agent)
    acceptTickets(agent, run, [1, 2])
    const report = submitSprintReport(agent, { runId: run.runId, sprintId: sid(1), report: { summary: 'Done' } })
    approveCheckpoint(desktop, { runId: run.runId, reportId: report.id })
    const revisionId = seedRevision(agent, run.epicId, retitle(run.bundle, 3))
    adoptRevision(agent, { runId: run.runId, revisionId })
    expect(getCheckpoint(agent, { runId: run.runId })).toMatchObject({ gatesMet: true, approval: null, canAdvance: false })
    expect(errorOf(() => advanceSprint(agent, { runId: run.runId })).code).toBe('approval_required')
    approveCheckpoint(desktop, { runId: run.runId, reportId: report.id })
    expect(advanceSprint(agent, { runId: run.runId }).activeSprintId).toBe(sid(2))
  })
})
