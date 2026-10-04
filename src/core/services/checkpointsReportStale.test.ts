/**
 * A sprint report is written for the plan revision the run executed then. When the run adopts a revision that
 * changed the sprint's exit criteria or required tickets beyond removing the retro's leftovers, the report is
 * stale: `report_submitted` is unmet until a new report revision arrives. Leftovers moving out never do that.
 */
import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { SprintRetroInput } from '../../shared/domain/retro'
import type { GateCondition, SprintReportView } from '../../shared/domain/views'
import { makeBundle, makeTicket, sid, tid } from '../../test/bundles'
import { acceptTickets, seedRevision, seedRun, type SeededRun } from '../../test/checkpointSeed'
import { createTestCtx, withRole, type TestCtx } from '../../test/testContext'
import { adoptRevision } from './adoption'
import { approveCheckpoint, getCheckpoint } from './checkpoints'
import { submitSprintReport } from './reports'

const RETRO: SprintRetroInput = { leftovers: [{ ticket: 'DM-2', reason: 'Waiting on a signing identity' }] }

/** Sprint 1: DM-1, DM-2, DM-3 (DM-3 requires DM-2). Sprint 2: DM-4. */
function plan(): PlanBundle {
  return makeBundle([[1, 2, 3], [4]], [[2, 3]])
}

/** The plan with sprint 1 holding `first` and sprint 2 holding `second`. */
function layout(first: number[], second: number[], bundle: PlanBundle = plan()): PlanBundle {
  const ids = [first.map(tid), second.map(tid)]
  return { ...bundle, sprints: bundle.sprints.map((sprint, index) => ({ ...sprint, ticketIds: ids[index] ?? [] })) }
}

interface Fixture {
  ctx: TestCtx
  run: SeededRun
  report: SprintReportView
}

/** DM-1 accepted, DM-2 a leftover in the retro, DM-3 waiting on it; the run awaits its checkpoint. */
function reported(): Fixture {
  const ctx = createTestCtx()
  const run = seedRun(ctx, { bundle: plan() })
  acceptTickets(ctx, run, [1])
  const report = submitSprintReport(ctx, { runId: run.runId, sprintId: sid(1), report: { summary: 'Sprint 1 is over.', retro: RETRO } })
  return { ctx, run, report }
}

function adopt(fixture: Fixture, bundle: PlanBundle): void {
  const revisionId = seedRevision(fixture.ctx, fixture.run.epicId, bundle)
  adoptRevision(fixture.ctx, { runId: fixture.run.runId, revisionId })
}

function reportGate(fixture: Fixture): GateCondition | undefined {
  return getCheckpoint(fixture.ctx, { runId: fixture.run.runId }).conditions.find((item) => item.id === 'report_submitted')
}

const CURRENT: GateCondition = { id: 'report_submitted', label: 'Sprint report submitted', met: true, detail: 'Required by checkpoint policy' }

describe('a report after an adopted revision that only moved leftovers out', () => {
  it('stays current, so the checkpoint can be approved on the adopted revision', () => {
    const fixture = reported()
    adopt(fixture, layout([1], [4, 2, 3]))
    expect(reportGate(fixture)).toEqual(CURRENT)
    expect(getCheckpoint(fixture.ctx, { runId: fixture.run.runId }).gatesMet).toBe(true)
    const approval = approveCheckpoint(withRole(fixture.ctx, 'desktop'), { runId: fixture.run.runId, reportId: fixture.report.id })
    const grant = fixture.ctx.db.get<{ revision_id: string }>('SELECT revision_id FROM approvals WHERE id = ?', approval.id)
    expect(grant?.revision_id).not.toBe(fixture.run.revisionId)
  })
})

describe('a report after an adopted revision that changed the sprint beyond its leftovers', () => {
  it('goes stale when the exit criteria changed, and a new report revision makes it current again', () => {
    const fixture = reported()
    const changed = layout([1], [4, 2, 3])
    changed.sprints = changed.sprints.map((sprint) =>
      sprint.ordinal === 1 ? { ...sprint, exitCriteria: [{ id: 'x1', text: 'The parser ships' }] } : sprint
    )
    adopt(fixture, changed)
    expect(reportGate(fixture)).toEqual({
      ...CURRENT,
      met: false,
      detail:
        'The Sprint 1 report (revision 1) was written for plan revision 1, and revision 2 changed the sprint beyond removing leftovers ' +
        '(its exit criteria changed): submit a new report revision'
    })
    submitSprintReport(fixture.ctx, { runId: fixture.run.runId, sprintId: sid(1), report: { summary: 'Rewritten.', retro: RETRO } })
    expect(reportGate(fixture)).toEqual(CURRENT)
  })

  it('goes stale when a required ticket joined the sprint or one that is no leftover left it', () => {
    const joined = reported()
    const added = layout([1, 2, 3, 5], [4])
    added.tickets = [...added.tickets, makeTicket(5)]
    adopt(joined, added)
    expect(reportGate(joined)?.detail).toContain('(it now requires DM-5)')
    const left = reported()
    adopt(left, layout([2, 3], [4, 1]))
    expect(reportGate(left)).toMatchObject({ met: false, detail: expect.stringContaining('(it no longer requires DM-1)') })
  })

  it('treats a report stored before reports recorded their plan revision as current', () => {
    const fixture = reported()
    fixture.ctx.db.run('UPDATE sprint_reports SET revision_id = NULL')
    adopt(fixture, layout([2, 3], [4, 1]))
    expect(reportGate(fixture)).toEqual(CURRENT)
  })
})
