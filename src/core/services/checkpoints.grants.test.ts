import { describe, expect, it } from 'vitest'
import type { SprintReportInput } from '../../shared/domain/api'
import type { SprintReportView } from '../../shared/domain/views'
import { makeBundle, sid } from '../../test/bundles'
import {
  acceptTickets,
  errorOf,
  eventLog,
  outboxEntries,
  runRow,
  seedAttempt,
  seedRevision,
  seedRun,
  type SeededRun,
  type SeedRunOptions
} from '../../test/checkpointSeed'
import { createTestCtx, withRole, type TestCtx } from '../../test/testContext'
import { advanceSprint, approveCheckpoint, authorizeAutoContinue, getCheckpoint, grantRetry } from './checkpoints'
import { submitSprintReport } from './reports'

interface Fixture {
  agent: TestCtx
  desktop: TestCtx
  run: SeededRun
  report: SprintReportView
}

function report(ctx: TestCtx, run: SeededRun, content: Partial<SprintReportInput> = {}, sprint = 1): SprintReportView {
  return submitSprintReport(ctx, {
    runId: run.runId,
    sprintId: sid(sprint),
    report: { summary: `Sprint ${sprint} finished.`, ...content }
  })
}

/** Sprint 1 of 2 finished: DM-1 and DM-2 accepted, report submitted, run awaiting its checkpoint. */
function finishedSprint(options: SeedRunOptions = {}): Fixture {
  const agent = createTestCtx()
  const run = seedRun(agent, options)
  acceptTickets(agent, run, [1, 2])
  return { agent, desktop: withRole(agent, 'desktop'), run, report: report(agent, run) }
}

interface ApprovalRow {
  id: string
  project_id: string
  epic_id: string
  run_id: string
  revision_id: string
  sprint_id: string
  report_id: string
  report_hash: string
  action: string
  issued_by: string
  issued_at: string
  consumed_at: string | null
  consumed_by: string | null
}

function approvals(ctx: TestCtx): ApprovalRow[] {
  return ctx.db.all<ApprovalRow>('SELECT * FROM approvals ORDER BY id')
}

function checkpointRows(ctx: TestCtx): Record<string, unknown>[] {
  return ctx.db.all<Record<string, unknown>>(
    'SELECT sprint_id, report_id, outcome, policy, approval_id, decided_by, decided_at FROM checkpoints ORDER BY id'
  )
}

describe('approveCheckpoint', () => {
  it('issues a one-use grant bound to project, epic, run, revision, sprint, report, and action', () => {
    const { agent, desktop, run, report: submitted } = finishedSprint()
    agent.clock.advanceSeconds(30)
    const approval = approveCheckpoint(desktop, { runId: run.runId, reportId: submitted.id })
    const issuedAt = '2026-01-01T00:00:30.000Z'
    expect(approval).toEqual({ id: expect.stringMatching(/^ap_/), runId: run.runId, sprintId: sid(1), reportId: submitted.id, issuedAt })
    expect(approvals(agent)).toEqual([
      {
        id: approval.id,
        project_id: agent.projectId,
        epic_id: run.epicId,
        run_id: run.runId,
        revision_id: run.revisionId,
        sprint_id: sid(1),
        report_id: submitted.id,
        report_hash: submitted.contentHash,
        action: 'advance_sprint',
        issued_by: desktop.session.id,
        issued_at: issuedAt,
        consumed_at: null,
        consumed_by: null
      }
    ])
    const view = getCheckpoint(agent, { runId: run.runId })
    expect(view.approval).toEqual({ id: approval.id, issuedAt, valid: true })
    expect(view.conditions.at(-1)).toMatchObject({ met: true, detail: 'Approved in the desktop app' })
    expect(view.canAdvance).toBe(true)
    expect(eventLog(agent).at(-1)).toEqual({
      kind: 'checkpoint.approved',
      epicId: run.epicId,
      runId: run.runId,
      ticketId: null,
      payload: { approvalId: approval.id, sprintId: sid(1), reportId: submitted.id }
    })
  })

})

describe('approveCheckpoint refusals', () => {
  it('refuses a report that is no longer the latest revision', () => {
    const { agent, desktop, run, report: first } = finishedSprint()
    const revised = report(agent, run, { summary: 'Revised' })
    const result = errorOf(() => approveCheckpoint(desktop, { runId: run.runId, reportId: first.id }))
    expect(result).toMatchObject({ code: 'conflict', message: 'The report changed; review the latest revision.' })
    expect(result.details).toEqual({ reportId: first.id, latestReportId: revised.id })
    expect(approvals(agent)).toEqual([])
    const unreported = seedRun(agent, { state: 'awaiting_checkpoint' })
    const missing = errorOf(() => approveCheckpoint(desktop, { runId: unreported.runId, reportId: first.id }))
    expect(missing).toMatchObject({ code: 'conflict', details: { reportId: first.id, latestReportId: null } })
  })

  it('refuses while a gate is unmet and explains why', () => {
    const agent = createTestCtx()
    const run = seedRun(agent)
    acceptTickets(agent, run, [2])
    seedAttempt(agent, run, { ticket: 1, state: 'failed' })
    seedAttempt(agent, run, { ticket: 1, state: 'failed' })
    const submitted = report(agent, run)
    const result = errorOf(() => approveCheckpoint(withRole(agent, 'desktop'), { runId: run.runId, reportId: submitted.id }))
    expect(result.code).toBe('gate_blocked')
    expect(result.message).toBe("Sprint 1 can't advance yet: DM-1 failed after 2 attempts")
    expect(result.details).toEqual({ conditions: getCheckpoint(agent, { runId: run.runId }).conditions.slice(0, -1) })
    expect(approvals(agent)).toEqual([])
  })

  it('only approves a run that awaits its checkpoint', () => {
    const agent = createTestCtx()
    const run = seedRun(agent)
    const result = errorOf(() => approveCheckpoint(withRole(agent, 'desktop'), { runId: run.runId, reportId: 'rp_x' }))
    expect(result).toMatchObject({ code: 'run_not_active', message: 'Run #1 is running; only a run awaiting its checkpoint can be approved.' })
  })

})

describe('human-only checkpoint commands', () => {
  it('is reserved to the desktop, like auto-continue and retry grants', () => {
    const { agent, run, report: submitted } = finishedSprint()
    const codes = (['orchestrator', 'planner', 'worker', 'reviewer'] as const).flatMap((role) => {
      const ctx = withRole(agent, role)
      return [
        errorOf(() => approveCheckpoint(ctx, { runId: run.runId, reportId: submitted.id })).code,
        errorOf(() => authorizeAutoContinue(ctx, { runId: run.runId, enabled: true })).code,
        errorOf(() => grantRetry(ctx, { runId: run.runId, ticketId: run.bundle.tickets[0]?.id ?? '' })).code
      ]
    })
    expect(new Set(codes)).toEqual(new Set(['unauthorized']))
    expect(codes).toHaveLength(12)
    expect([approvals(agent).length, runRow(agent, run.runId)?.auto_continue]).toEqual([0, 0])
  })
})

describe('advanceSprint with a human grant', () => {
  it('consumes the exact grant and activates the next sprint', () => {
    const { agent, desktop, run, report: submitted } = finishedSprint()
    const approval = approveCheckpoint(desktop, { runId: run.runId, reportId: submitted.id })
    agent.clock.advanceSeconds(5)
    const result = advanceSprint(agent, { runId: run.runId })
    const now = '2026-01-01T00:00:05.000Z'
    expect(result).toEqual({ runId: run.runId, outcome: 'advanced', activeSprintId: sid(2) })
    expect(runRow(agent, run.runId)).toMatchObject({ state: 'running', active_sprint_id: sid(2), revision: 3, updated_at: now })
    expect(approvals(agent)[0]).toMatchObject({ consumed_at: now, consumed_by: agent.session.id })
    expect(checkpointRows(agent)).toEqual([
      {
        sprint_id: sid(1),
        report_id: submitted.id,
        outcome: 'advanced',
        policy: 'human',
        approval_id: approval.id,
        decided_by: agent.session.id,
        decided_at: now
      }
    ])
    expect(eventLog(agent).at(-1)).toMatchObject({
      kind: 'checkpoint.advanced',
      payload: { fromSprintId: sid(1), toSprintId: sid(2), policy: 'human', approvalId: approval.id }
    })
    expect(outboxEntries(agent)).toEqual([{ kind: 'run_history', epic_id: run.epicId, run_id: run.runId }])
  })

  it('requires a person to approve and records nothing without it', () => {
    const { agent, run } = finishedSprint()
    const result = errorOf(() => advanceSprint(agent, { runId: run.runId }))
    expect(result).toMatchObject({ code: 'approval_required', message: 'A person must approve this checkpoint in the desktop app.' })
    expect(result.details).toEqual({ runId: run.runId, sprintId: sid(1), policy: 'human' })
    expect([checkpointRows(agent), runRow(agent, run.runId)?.state]).toEqual([[], 'awaiting_checkpoint'])
  })

})

describe('advanceSprint refusals', () => {
  it('blocks advancement on a failed required ticket with the reason', () => {
    const agent = createTestCtx()
    const run = seedRun(agent)
    acceptTickets(agent, run, [1])
    seedAttempt(agent, run, { ticket: 2, state: 'failed' })
    report(agent, run)
    const result = errorOf(() => advanceSprint(agent, { runId: run.runId }))
    expect(result).toMatchObject({ code: 'gate_blocked', message: "Sprint 1 can't advance yet: DM-2 failed after 1 attempt" })
    const conditions = (result.details as { conditions: { id: string; met: boolean }[] }).conditions
    expect(conditions.filter((condition) => !condition.met).map((condition) => condition.id)).toEqual(['required_accepted'])
  })

  it('needs a submitted report and a run awaiting its checkpoint', () => {
    const agent = createTestCtx()
    const running = seedRun(agent)
    expect(errorOf(() => advanceSprint(agent, { runId: running.runId }))).toMatchObject({
      code: 'run_not_active',
      message: 'Submit the sprint report before advancing.'
    })
    const paused = seedRun(agent, { state: 'paused' })
    expect(errorOf(() => advanceSprint(agent, { runId: paused.runId }))).toMatchObject({
      code: 'run_not_active',
      message: 'Run #1 is paused; only a run awaiting its checkpoint can advance.'
    })
  })

  it('refuses runs owned by another machine and a moved checkout', () => {
    const foreign = finishedSprint()
    approveCheckpoint(foreign.desktop, { runId: foreign.run.runId, reportId: foreign.report.id })
    foreign.agent.db.run(`UPDATE runs SET owner_machine_id = 'mc_0000000000000000000000other'`)
    expect(errorOf(() => advanceSprint(foreign.agent, { runId: foreign.run.runId }))).toMatchObject({
      code: 'run_not_owned',
      message: 'This run belongs to another machine; take it over first.'
    })
    const moved = finishedSprint()
    const guarded = {
      ...moved.agent,
      assertBranch: () => {
        throw Object.assign(new Error('branch moved'), { code: 'branch_changed' })
      }
    }
    expect(errorOf(() => advanceSprint(guarded, { runId: moved.run.runId })).code).toBe('branch_changed')
    expect(runRow(moved.agent, moved.run.runId)?.state).toBe('awaiting_checkpoint')
  })
})

type BindingField = 'project_id' | 'epic_id' | 'run_id' | 'revision_id' | 'sprint_id' | 'report_id' | 'report_hash' | 'action'

function forgeGrant(fixture: Fixture, field: BindingField): void {
  const binding: Record<BindingField, string> = {
    project_id: fixture.agent.projectId,
    epic_id: fixture.run.epicId,
    run_id: fixture.run.runId,
    revision_id: fixture.run.revisionId,
    sprint_id: sid(1),
    report_id: fixture.report.id,
    report_hash: fixture.report.contentHash,
    action: 'advance_sprint'
  }
  const forged = { ...binding, [field]: `${binding[field]}-forged` }
  fixture.agent.db.run(
    `INSERT INTO approvals (id, project_id, epic_id, run_id, revision_id, sprint_id, report_id, report_hash, action,
       issued_by, issued_at) VALUES ('ap_forged', ?, ?, ?, ?, ?, ?, ?, ?, 'ss_desktop', '2026-01-01T00:00:00.000Z')`,
    forged.project_id,
    forged.epic_id,
    forged.run_id,
    forged.revision_id,
    forged.sprint_id,
    forged.report_id,
    forged.report_hash,
    forged.action
  )
}

describe('grant security', () => {
  it.each<BindingField>(['project_id', 'epic_id', 'run_id', 'revision_id', 'sprint_id', 'report_id', 'report_hash', 'action'])(
    'ignores a grant with a forged %s',
    (field) => {
      const fixture = finishedSprint()
      forgeGrant(fixture, field)
      expect(getCheckpoint(fixture.agent, { runId: fixture.run.runId }).approval).toBeNull()
      expect(errorOf(() => advanceSprint(fixture.agent, { runId: fixture.run.runId })).code).toBe('approval_required')
    }
  )

  it('never replays a consumed grant', () => {
    const { agent, desktop, run, report: submitted } = finishedSprint()
    approveCheckpoint(desktop, { runId: run.runId, reportId: submitted.id })
    advanceSprint(agent, { runId: run.runId })
    expect(errorOf(() => advanceSprint(agent, { runId: run.runId })).code).toBe('run_not_active')
    acceptTickets(agent, run, [3])
    report(agent, run, { epicOutcome: { summary: 'Done', successCriteria: [{ criterionId: 's1', met: true, note: '' }] } }, 2)
    agent.db.run('UPDATE approvals SET sprint_id = ?, report_id = (SELECT id FROM sprint_reports WHERE sprint_id = ?)', sid(2), sid(2))
    agent.db.run('UPDATE approvals SET report_hash = (SELECT content_hash FROM sprint_reports WHERE sprint_id = ?)', sid(2))
    expect(getCheckpoint(agent, { runId: run.runId }).approval).toBeNull()
    expect(errorOf(() => advanceSprint(agent, { runId: run.runId })).code).toBe('approval_required')
  })

})

describe('stale grants and repeated advances', () => {
  it('invalidates a grant when a new report revision arrives', () => {
    const { agent, desktop, run, report: first } = finishedSprint()
    approveCheckpoint(desktop, { runId: run.runId, reportId: first.id })
    const revised = report(agent, run, { summary: 'Revised after approval' })
    expect(getCheckpoint(agent, { runId: run.runId }).approval).toBeNull()
    expect(errorOf(() => advanceSprint(agent, { runId: run.runId })).code).toBe('approval_required')
    approveCheckpoint(desktop, { runId: run.runId, reportId: revised.id })
    expect(advanceSprint(agent, { runId: run.runId }).outcome).toBe('advanced')
  })

  it('returns the original outcome for a repeated idempotency key', () => {
    const { agent, desktop, run, report: submitted } = finishedSprint()
    approveCheckpoint(desktop, { runId: run.runId, reportId: submitted.id })
    const first = advanceSprint(agent, { runId: run.runId, idempotencyKey: 'advance-1' })
    expect(advanceSprint(agent, { runId: run.runId, idempotencyKey: 'advance-1' })).toEqual(first)
    expect(checkpointRows(agent)).toHaveLength(1)
    expect(eventLog(agent).filter((event) => event.kind === 'checkpoint.advanced')).toHaveLength(1)
    expect(runRow(agent, run.runId)?.active_sprint_id).toBe(sid(2))
  })

  it('keeps the pinned policy when a later revision asks for automatic continuation', () => {
    const { agent, desktop, run } = finishedSprint()
    const relaxed = makeBundle([[1, 2], [3]])
    relaxed.sprints = relaxed.sprints.map((sprint) => ({ ...sprint, checkpoint: { mode: 'auto' } }))
    seedRevision(agent, run.epicId, relaxed)
    authorizeAutoContinue(desktop, { runId: run.runId, enabled: true })
    const view = getCheckpoint(agent, { runId: run.runId })
    expect(view.policy).toBe('human')
    expect(view.conditions.at(-1)).toMatchObject({ met: false, detail: 'A person must approve this checkpoint in the desktop app' })
    const refused = errorOf(() => advanceSprint(agent, { runId: run.runId }))
    expect(refused).toMatchObject({ code: 'gate_blocked', message: expect.stringContaining('Saved revision 2 is newer than revision 1') })
  })
})

describe('a grant of a run that ended afterwards', () => {
  it('shows nothing to approve once the approved run is canceled, and neither advances nor approves it again', () => {
    const { agent, desktop, run, report: submitted } = finishedSprint()
    approveCheckpoint(desktop, { runId: run.runId, reportId: submitted.id })
    agent.db.run("UPDATE runs SET state = 'canceled' WHERE id = ?", run.runId)

    const view = getCheckpoint(agent, { runId: run.runId })

    expect(view.runState).toBe('canceled')
    expect(view.conditions.at(-1)).toEqual({ id: 'approval', label: 'Advance authorized', met: false, detail: 'Run #1 is canceled; nothing to approve' })
    expect(view.canAdvance).toBe(false)
    expect(errorOf(() => advanceSprint(agent, { runId: run.runId }))).toMatchObject({ code: 'run_not_active' })
    expect(errorOf(() => approveCheckpoint(desktop, { runId: run.runId, reportId: submitted.id }))).toMatchObject({
      code: 'run_not_active',
      message: 'Run #1 is canceled; only a run awaiting its checkpoint can be approved.'
    })
  })
})
