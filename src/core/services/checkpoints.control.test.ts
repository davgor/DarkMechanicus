import { describe, expect, it } from 'vitest'
import type { SprintReportInput } from '../../shared/domain/api'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { SprintReportView } from '../../shared/domain/views'
import { makeBundle, sid, tid } from '../../test/bundles'
import {
  acceptTickets,
  errorOf,
  eventLog,
  outboxEntries,
  runRow,
  seedRun,
  type SeededRun,
  type SeedRunOptions
} from '../../test/checkpointSeed'
import { createTestCtx, withRole, type TestCtx } from '../../test/testContext'
import {
  advanceSprint,
  approveAndAdvance,
  approveCheckpoint,
  authorizeAutoContinue,
  getCheckpoint,
  grantRetry
} from './checkpoints'
import { submitSprintReport } from './reports'

function report(ctx: TestCtx, run: SeededRun, content: Partial<SprintReportInput> = {}, sprint = 1): SprintReportView {
  return submitSprintReport(ctx, {
    runId: run.runId,
    sprintId: sid(sprint),
    report: { summary: `Sprint ${sprint} finished.`, ...content }
  })
}

function started(options: SeedRunOptions = {}): { agent: TestCtx; desktop: TestCtx; run: SeededRun } {
  const agent = createTestCtx()
  return { agent, desktop: withRole(agent, 'desktop'), run: seedRun(agent, options) }
}

const OUTCOME = {
  summary: 'The epic shipped.',
  successCriteria: [{ criterionId: 's1', met: true, note: 'verified in CI' }]
}

function epicRow(ctx: TestCtx, epicId: string): Record<string, unknown> | undefined {
  return ctx.db.get<Record<string, unknown>>(
    'SELECT status, completed_at, outcome_json, revision, updated_at FROM epics WHERE id = ?',
    epicId
  )
}

describe('advancing the final sprint', () => {
  it('completes the run and the epic and records the outcome', () => {
    const { agent, desktop, run } = started({ activeSprint: 2 })
    acceptTickets(agent, run, [3])
    const final = report(agent, run, { epicOutcome: OUTCOME }, 2)
    approveCheckpoint(desktop, { runId: run.runId, reportId: final.id })
    agent.clock.advanceSeconds(90)
    const now = '2026-01-01T00:01:30.000Z'
    expect(advanceSprint(agent, { runId: run.runId })).toEqual({ runId: run.runId, outcome: 'completed', activeSprintId: null })
    expect(runRow(agent, run.runId)).toMatchObject({ state: 'completed', active_sprint_id: null, ended_at: now, revision: 3 })
    const epic = epicRow(agent, run.epicId)
    expect(epic).toMatchObject({ status: 'completed', completed_at: now, revision: 2, updated_at: now })
    expect(JSON.parse(String(epic?.['outcome_json']))).toEqual({ ...OUTCOME, recordedAt: now, runId: run.runId })
    expect(eventLog(agent).slice(-2).map((event) => [event.kind, event.payload])).toEqual([
      ['run.completed', { checkpointId: expect.stringMatching(/^ck_/), sprintId: sid(2) }],
      ['epic.completed', { runId: run.runId }]
    ])
    expect(outboxEntries(agent).map((entry) => entry.kind)).toEqual(['run_history', 'epic_state'])
    const checkpoint = agent.db.get<{ outcome: string }>('SELECT outcome FROM checkpoints')
    expect(checkpoint?.outcome).toBe('completed')
  })

  it('keeps the epic open while the final report lacks a met outcome', () => {
    const { agent, run } = started({ activeSprint: 2, autoContinue: true })
    acceptTickets(agent, run, [3])
    report(agent, run, { epicOutcome: { summary: 'Almost', successCriteria: [{ criterionId: 's1', met: false, note: '' }] } }, 2)
    const result = errorOf(() => advanceSprint(agent, { runId: run.runId }))
    expect(result).toMatchObject({ code: 'gate_blocked', message: `Sprint 2 can't advance yet: s1 "Everything works" not met` })
    expect(epicRow(agent, run.epicId)?.['status']).toBe('in_progress')
  })
})

function autoBundle(): PlanBundle {
  const bundle = makeBundle([[1, 2], [3]])
  return { ...bundle, sprints: bundle.sprints.map((sprint) => ({ ...sprint, checkpoint: { mode: 'auto' } })) }
}

describe('automatic continuation', () => {
  it('requires the person to authorize the run first', () => {
    const { agent, run } = started({ bundle: autoBundle() })
    acceptTickets(agent, run, [1, 2])
    report(agent, run)
    const result = errorOf(() => advanceSprint(agent, { runId: run.runId }))
    expect(result).toMatchObject({ code: 'approval_required' })
    expect(result.details).toEqual({ runId: run.runId, sprintId: sid(1), policy: 'auto' })
  })

  it('advances an authorized run without a grant', () => {
    const { agent, desktop, run } = started({ bundle: autoBundle() })
    authorizeAutoContinue(desktop, { runId: run.runId, enabled: true })
    acceptTickets(agent, run, [1, 2])
    report(agent, run)
    expect(advanceSprint(agent, { runId: run.runId }).activeSprintId).toBe(sid(2))
    const row = agent.db.get<{ policy: string; approval_id: string | null }>('SELECT policy, approval_id FROM checkpoints')
    expect(row).toEqual({ policy: 'auto', approval_id: null })
  })

  it('still accepts a person approving an automatic checkpoint that was not authorized', () => {
    const { agent, desktop, run } = started({ bundle: autoBundle() })
    acceptTickets(agent, run, [1, 2])
    const submitted = report(agent, run)
    const approval = approveCheckpoint(desktop, { runId: run.runId, reportId: submitted.id })
    expect(getCheckpoint(agent, { runId: run.runId }).conditions.at(-1)?.detail).toBe('Approved in the desktop app')
    advanceSprint(agent, { runId: run.runId })
    const row = agent.db.get<{ policy: string; approval_id: string | null }>('SELECT policy, approval_id FROM checkpoints')
    expect(row).toEqual({ policy: 'human', approval_id: approval.id })
  })
})

describe('authorizeAutoContinue', () => {
  it('turns the run-local authorization on and off', () => {
    const { agent, desktop, run } = started()
    agent.clock.advanceSeconds(10)
    authorizeAutoContinue(desktop, { runId: run.runId, enabled: true })
    expect(runRow(agent, run.runId)).toMatchObject({ auto_continue: 1, revision: 1, updated_at: '2026-01-01T00:00:10.000Z' })
    authorizeAutoContinue(desktop, { runId: run.runId, enabled: false })
    expect(runRow(agent, run.runId)?.auto_continue).toBe(0)
    expect(eventLog(agent).map((event) => [event.kind, event.runId, event.payload])).toEqual([
      ['run.auto_continue_changed', run.runId, { enabled: true }],
      ['run.auto_continue_changed', run.runId, { enabled: false }]
    ])
    expect(outboxEntries(agent)).toEqual([])
  })

  it('only applies to active runs', () => {
    const { desktop } = started()
    const finished = seedRun(desktop, { state: 'completed' })
    const result = errorOf(() => authorizeAutoContinue(desktop, { runId: finished.runId, enabled: true }))
    expect(result).toMatchObject({ code: 'run_not_active', message: 'Run #1 is completed.' })
    const paused = seedRun(desktop, { state: 'paused' })
    authorizeAutoContinue(desktop, { runId: paused.runId, enabled: true })
    expect(runRow(desktop, paused.runId)?.auto_continue).toBe(1)
  })
})

function extraRetries(ctx: TestCtx, runId: string, ticketId: string): number | undefined {
  return ctx.db.get<{ extra: number }>('SELECT extra FROM retry_grants WHERE run_id = ? AND ticket_id = ?', runId, ticketId)
    ?.extra
}

describe('grantRetry', () => {
  it('allows one more attempt per grant and reopens a run waiting at its checkpoint', () => {
    const { agent, desktop, run } = started({ state: 'awaiting_checkpoint' })
    grantRetry(desktop, { runId: run.runId, ticketId: tid(1) })
    expect(extraRetries(agent, run.runId, tid(1))).toBe(1)
    expect(runRow(agent, run.runId)).toMatchObject({ state: 'running', revision: 2 })
    grantRetry(desktop, { runId: run.runId, ticketId: tid(1) })
    expect(extraRetries(agent, run.runId, tid(1))).toBe(2)
    expect(runRow(agent, run.runId)).toMatchObject({ state: 'running', revision: 2 })
    expect(eventLog(agent).map((event) => [event.kind, event.ticketId, event.payload])).toEqual([
      ['ticket.retry_granted', tid(1), { extra: 1 }],
      ['ticket.retry_granted', tid(1), { extra: 2 }]
    ])
    expect(outboxEntries(agent)).toEqual([{ kind: 'run_history', epic_id: run.epicId, run_id: run.runId }])
  })

  it('leaves a paused run paused', () => {
    const { agent, desktop, run } = started({ state: 'paused' })
    grantRetry(desktop, { runId: run.runId, ticketId: tid(3) })
    expect([runRow(agent, run.runId)?.state, extraRetries(agent, run.runId, tid(3))]).toEqual(['paused', 1])
  })

  it('rejects tickets outside the pinned revision and finished runs', () => {
    const { desktop, run } = started()
    const unknown = errorOf(() => grantRetry(desktop, { runId: run.runId, ticketId: tid(99) }))
    expect(unknown).toMatchObject({ code: 'not_found', message: `Ticket ${tid(99)} is not part of this run's plan revision.` })
    const finished = seedRun(desktop, { state: 'canceled' })
    expect(errorOf(() => grantRetry(desktop, { runId: finished.runId, ticketId: tid(1) })).code).toBe('run_not_active')
  })
})

describe('approveAndAdvance', () => {
  it('issues and consumes a grant in one step', () => {
    const { agent, desktop, run } = started()
    acceptTickets(agent, run, [1, 2])
    const submitted = report(agent, run)
    const result = approveAndAdvance(desktop, { runId: run.runId, reportId: submitted.id, idempotencyKey: 'one-click' })
    expect(result).toEqual({ runId: run.runId, outcome: 'advanced', activeSprintId: sid(2) })
    const grants = agent.db.all<{ id: string; consumed_by: string | null }>('SELECT id, consumed_by FROM approvals')
    expect(grants).toEqual([{ id: expect.stringMatching(/^ap_/), consumed_by: desktop.session.id }])
    expect(approveAndAdvance(desktop, { runId: run.runId, reportId: submitted.id, idempotencyKey: 'one-click' })).toEqual(result)
    expect(agent.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM checkpoints')?.n).toBe(1)
  })

  it('keeps nothing when the advance half fails', () => {
    const { agent, desktop, run } = started()
    acceptTickets(agent, run, [1, 2])
    const submitted = report(agent, run)
    agent.db.run(`UPDATE runs SET owner_machine_id = 'mc_0000000000000000000000other' WHERE id = ?`, run.runId)
    const result = errorOf(() => approveAndAdvance(desktop, { runId: run.runId, reportId: submitted.id }))
    expect(result.code).toBe('run_not_owned')
    expect(agent.db.all('SELECT id FROM approvals')).toEqual([])
  })

  it('requires both the approve and the advance capability', () => {
    const { agent, run } = started()
    const approveOnly = createTestCtx({ db: agent.db, capabilities: ['read', 'checkpoint.approve'] })
    const orchestrator = withRole(agent, 'orchestrator')
    expect(errorOf(() => approveAndAdvance(approveOnly, { runId: run.runId, reportId: 'rp_x' })).code).toBe('unauthorized')
    expect(errorOf(() => approveAndAdvance(orchestrator, { runId: run.runId, reportId: 'rp_x' })).code).toBe('unauthorized')
  })
})
