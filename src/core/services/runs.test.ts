import { describe, expect, it } from 'vitest'
import type { RunView } from '../../shared/domain/views'
import { makeBundle, sid, tid } from '../../test/bundles'
import {
  attemptRow,
  bundleWith,
  claim,
  clearOutbox,
  domainError,
  epicRow,
  errorCode,
  eventKinds,
  hostCatalog,
  hostModel,
  lastEventPayload,
  pendingOutbox,
  runRow,
  seedEpic,
  seedRevision,
  startedRun
} from '../../test/execution'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { DomainError } from '../errors'
import { buildRunHistoryRecord } from '../repo/portable'
import { SKILLS_VERSION } from '../version'
import type { Ctx } from '../context'
import { acceptAttempt, failAttempt, heartbeatAttempt, submitAttempt } from './attempts'
import { expireLeases, runExecution } from './execution'
import { registerHost } from './hosts'
import { cancelRun, getRun, pauseRun, queueRun, requireOwnedRun, resumeRun, startRun, takeoverRun } from './runs'

const ZERO_COUNTS = {
  accepted: 0,
  submitted: 0,
  running: 0,
  ready: 0,
  waiting: 0,
  blocked: 0,
  failed: 0,
  needsReconciliation: 0
}

function giveAway(ctx: Ctx, runId: string): void {
  ctx.db.run("UPDATE runs SET owner_machine_id = 'mc_other' WHERE id = ?", runId)
}

describe('queueRun', () => {
  it('queues a run pinned to the current saved revision without an active sprint', () => {
    const ctx = createTestCtx({ role: 'desktop' })
    const { epicId, revisionId } = seedEpic(ctx, { bundle: makeBundle([[1, 2], [3]]) })
    clearOutbox(ctx)
    const view = queueRun(ctx, { epicId })
    expect(view).toMatchObject({
      epicId,
      revisionId,
      revisionNumber: 1,
      state: 'queued',
      activeSprintId: null,
      activeSprintOrdinal: null,
      sprintCount: 2,
      host: null,
      skillVersion: null,
      ownerMachineId: ctx.machineId,
      ownedByThisMachine: true,
      pauseReason: null,
      autoContinue: false,
      startedAt: null,
      endedAt: null,
      checkpoint: null,
      counts: { ...ZERO_COUNTS, waiting: 2 }
    })
    expect(runRow(ctx, view.id).number).toBe(1)
    expect(eventKinds(ctx, 'run.')).toEqual(['run.queued'])
    expect(pendingOutbox(ctx)).toEqual([`run_history:${epicId}:${view.id}`])
  })

  it('numbers runs per epic', () => {
    const ctx = createTestCtx({ role: 'desktop' })
    const { epicId } = seedEpic(ctx)
    const first = queueRun(ctx, { epicId })
    cancelRun(ctx, { runId: first.id })
    const second = queueRun(ctx, { epicId })
    expect([first.number, second.number, runRow(ctx, second.id).number]).toEqual([1, 2, 2])
  })

  it('is reserved for the person at the desktop', () => {
    const ctx = createTestCtx({ role: 'orchestrator' })
    expect(errorCode(() => queueRun(ctx, { epicId: seedEpic(ctx).epicId }))).toBe('unauthorized')
  })
})

describe('queueRun — rejections', () => {
  it('rejects an unknown epic, a completed epic, and a plan that was never saved', () => {
    const ctx = createTestCtx({ role: 'desktop' })
    expect(errorCode(() => queueRun(ctx, { epicId: 'ep_missing' }))).toBe('not_found')
    expect(errorCode(() => queueRun(ctx, { epicId: seedEpic(ctx, { status: 'completed', bundle: makeBundle([[1]]) }).epicId }))).toBe(
      'completed_epic'
    )
    const unsaved = domainError(() => queueRun(ctx, { epicId: seedEpic(ctx, { saved: false, bundle: makeBundle([[2]]) }).epicId }))
    expect([unsaved.code, unsaved.message]).toEqual(['invalid_plan', 'Save the plan before starting a run.'])
  })

  it('rejects a second active run for the same epic', () => {
    const ctx = createTestCtx({ role: 'desktop' })
    const { epicId } = seedEpic(ctx)
    const first = queueRun(ctx, { epicId })
    const error = domainError(() => queueRun(ctx, { epicId }))
    expect([error.code, error.details]).toEqual(['active_run_exists', { epicId, runId: first.id }])
  })
})

describe('startRun — new run', () => {
  it('pins the saved revision, activates sprint 1, and records the orchestrator and host', () => {
    const ctx = createTestCtx()
    const { epicId, revisionId } = seedEpic(ctx, { bundle: makeBundle([[1], [2]]) })
    const catalog = registerHost(ctx, hostCatalog([hostModel('m1')]))
    const view = startRun(ctx, { epicId, host: { label: 'Agent CLI', type: 'cli' }, hostCatalogId: catalog.id })
    expect(view).toMatchObject({
      state: 'running',
      revisionId,
      activeSprintId: sid(1),
      activeSprintOrdinal: 1,
      host: { label: 'Agent CLI', type: 'cli', catalogId: catalog.id },
      skillVersion: SKILLS_VERSION,
      startedAt: '2026-01-01T00:00:00.000Z',
      counts: { ...ZERO_COUNTS, ready: 1 }
    })
    expect(runRow(ctx, view.id)).toMatchObject({ orchestrator_session_id: ctx.session.id, host_catalog_id: catalog.id })
    expect(view.tickets.map((ticket) => ticket.state)).toEqual(['ready', 'later_sprint'])
    expect(eventKinds(ctx, 'run.')).toEqual(['run.started'])
  })

  it('records an explicit skill version and a catalog without a host label', () => {
    const ctx = createTestCtx()
    const catalog = registerHost(ctx, hostCatalog([hostModel('m1')]))
    const view = startRun(ctx, { epicId: seedEpic(ctx).epicId, hostCatalogId: catalog.id, skillVersion: '0.9.0' })
    expect([view.skillVersion, view.host]).toEqual(['0.9.0', { label: '', type: '', catalogId: catalog.id }])
  })

  it('rejects an unknown host catalog', () => {
    const ctx = createTestCtx()
    expect(errorCode(() => startRun(ctx, { epicId: seedEpic(ctx).epicId, hostCatalogId: 'hc_missing' }))).toBe('not_found')
  })

  it('is not available to the desktop', () => {
    const ctx = createTestCtx({ role: 'desktop' })
    expect(errorCode(() => startRun(ctx, { epicId: seedEpic(ctx).epicId }))).toBe('unauthorized')
  })
})

describe('startRun — queued runs and conflicts', () => {
  it('starts the queued run and keeps its pinned revision', () => {
    const ctx = createTestCtx()
    const { epicId, revisionId } = seedEpic(ctx)
    const queued = queueRun(withRole(ctx, 'desktop'), { epicId })
    seedRevision(ctx, epicId, makeBundle([[1, 2, 3]]))
    const started = startRun(ctx, { epicId })
    expect([started.id, started.revisionId, started.state, started.activeSprintId]).toEqual([
      queued.id,
      revisionId,
      'running',
      sid(1)
    ])
  })

  it('refuses a queued run that belongs to another machine', () => {
    const ctx = createTestCtx()
    const { epicId } = seedEpic(ctx)
    giveAway(ctx, queueRun(withRole(ctx, 'desktop'), { epicId }).id)
    expect(errorCode(() => startRun(ctx, { epicId }))).toBe('run_not_owned')
  })

  it('rejects a start while another run is active', () => {
    const ctx = createTestCtx()
    const { epicId, runId } = startedRun(ctx)
    expect(domainError(() => startRun(ctx, { epicId })).details).toEqual({ epicId, runId })
  })

  it('rejects completed epics and plans that were never saved', () => {
    const ctx = createTestCtx()
    expect(errorCode(() => startRun(ctx, { epicId: seedEpic(ctx, { status: 'completed' }).epicId }))).toBe('completed_epic')
    const unsaved = seedEpic(ctx, { saved: false, bundle: makeBundle([[3]]) })
    expect(errorCode(() => startRun(ctx, { epicId: unsaved.epicId }))).toBe('invalid_plan')
  })
})

describe('startRun — idempotency and branch guard', () => {
  it('replays the original run for a repeated idempotency key', () => {
    const ctx = createTestCtx()
    const { epicId } = seedEpic(ctx)
    const first = startRun(ctx, { epicId, idempotencyKey: 'start-1' })
    ctx.clock.advanceSeconds(5)
    expect(startRun(ctx, { epicId, idempotencyKey: 'start-1' })).toEqual(first)
    expect(eventKinds(ctx, 'run.')).toEqual(['run.started'])
    expect(errorCode(() => startRun(ctx, { epicId, skillVersion: 'x', idempotencyKey: 'start-1' }))).toBe('idempotency_mismatch')
  })

  it('refuses to start after the coordinating checkout changed branch', () => {
    const ctx = createTestCtx({
      assertBranch: () => {
        throw new DomainError('branch_changed', 'moved')
      }
    })
    const { epicId } = seedEpic(ctx)
    expect(errorCode(() => startRun(ctx, { epicId }))).toBe('branch_changed')
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs')?.n).toBe(0)
  })
})

describe('startRun — branch binding', () => {
  it('binds an explicit branch to an epic without one', () => {
    const ctx = createTestCtx()
    const { epicId } = seedEpic(ctx)
    const branch = { repository: 'git@example.com:dm.git', name: 'epic/runs', startCommit: 'abcdef1' }
    startRun(ctx, { epicId, branch })
    expect(JSON.parse(epicRow(ctx, epicId).branch_json ?? 'null')).toEqual(branch)
    expect(lastEventPayload(ctx, 'epic.branch_set')).toEqual({ branch })
  })

  it('binds the coordinating checkout branch and HEAD by default', () => {
    const ctx = createTestCtx({ checkout: { branch: 'feature/x', commit: 'c0ffee1' } })
    const { epicId } = seedEpic(ctx)
    startRun(ctx, { epicId })
    expect(JSON.parse(epicRow(ctx, epicId).branch_json ?? 'null')).toEqual({
      repository: null,
      name: 'feature/x',
      startCommit: 'c0ffee1'
    })
  })

  it('keeps the branch an epic already has', () => {
    const ctx = createTestCtx()
    const existing = { repository: null, name: 'epic/old', startCommit: null }
    const { epicId } = seedEpic(ctx, { branch: existing })
    startRun(ctx, { epicId, branch: { repository: null, name: 'epic/new', startCommit: null } })
    expect(JSON.parse(epicRow(ctx, epicId).branch_json ?? 'null')).toEqual(existing)
    expect(eventKinds(ctx, 'epic.branch_set')).toEqual([])
  })

  it('binds nothing outside Git', () => {
    const ctx = createTestCtx({ checkout: { branch: null, commit: null } })
    const { epicId } = seedEpic(ctx)
    startRun(ctx, { epicId })
    expect(epicRow(ctx, epicId).branch_json).toBeNull()
    expect(eventKinds(ctx, 'epic.branch_set')).toEqual([])
  })
})

describe('startRun — epic status', () => {
  it('moves a backlog epic to in progress', () => {
    const ctx = createTestCtx()
    const { epicId } = seedEpic(ctx)
    clearOutbox(ctx)
    const view = startRun(ctx, { epicId })
    expect(epicRow(ctx, epicId)).toMatchObject({ status: 'in_progress', revision: 3 })
    expect(lastEventPayload(ctx, 'epic.status_changed')).toEqual({ from: 'backlog', to: 'in_progress' })
    expect(pendingOutbox(ctx)).toEqual([`epic_state:${epicId}:`, `run_history:${epicId}:${view.id}`])
  })

  it('leaves an epic that is already in progress alone', () => {
    const ctx = createTestCtx()
    const { epicId } = seedEpic(ctx, { status: 'in_progress', branch: { repository: null, name: 'b', startCommit: null } })
    startRun(ctx, { epicId })
    expect(epicRow(ctx, epicId)).toMatchObject({ status: 'in_progress', revision: 1 })
    expect(eventKinds(ctx, 'epic.')).toEqual([])
  })
})

describe('startRun — carry forward', () => {
  it('carries forward tickets completed earlier so their dependents are ready', () => {
    const ctx = createTestCtx()
    const { epicId } = seedEpic(ctx, { bundle: makeBundle([[1, 2]], [[1, 2]]) })
    ctx.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(1))
    const view = startRun(ctx, { epicId, carryForward: [{ ticketId: tid(1), note: 'Done in an earlier run' }] })
    expect(view.tickets.map((ticket) => ticket.state)).toEqual(['accepted', 'ready'])
    expect(view.attempts.map((attempt) => [attempt.kind, attempt.state, attempt.decision?.notes])).toEqual([
      ['carry_forward', 'accepted', 'Done in an earlier run']
    ])
  })

  it('rolls the whole start back when a carry-forward is not allowed', () => {
    const ctx = createTestCtx()
    const { epicId } = seedEpic(ctx)
    expect(errorCode(() => startRun(ctx, { epicId, carryForward: [{ ticketId: tid(1), note: 'n' }] }))).toBe(
      'unauthorized_transition'
    )
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs')?.n).toBe(0)
  })
})

describe('getRun — lookup', () => {
  it('finds a run by id, or the active run of an epic', () => {
    const ctx = createTestCtx()
    const { epicId, runId } = startedRun(ctx)
    expect(getRun(ctx, { runId })?.id).toBe(runId)
    expect(getRun(ctx, { epicId })?.id).toBe(runId)
  })

  it('prefers the active run, then the most recent one', () => {
    const ctx = createTestCtx()
    const { epicId, runId: first } = startedRun(ctx)
    cancelRun(ctx, { runId: first })
    const second = startRun(ctx, { epicId }).id
    cancelRun(ctx, { runId: second })
    expect(getRun(ctx, { epicId })?.id).toBe(second)
    ctx.db.run("UPDATE runs SET state = 'paused' WHERE id = ?", first)
    expect(getRun(ctx, { epicId })?.id).toBe(first)
  })

  it('returns null for an epic without runs and rejects unknown runs or empty requests', () => {
    const ctx = createTestCtx({ role: 'reviewer' })
    expect(getRun(ctx, { epicId: seedEpic(ctx).epicId })).toBeNull()
    expect(errorCode(() => getRun(ctx, { runId: 'rn_missing' }))).toBe('not_found')
    expect(errorCode(() => getRun(ctx, {}))).toBe('invalid_input')
  })
})

describe('getRun — view', () => {
  it('expires overdue leases before building the view', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    ctx.clock.advanceSeconds(61)
    const view = getRun(withRole(ctx, 'reviewer'), { runId })
    expect(view?.counts).toEqual({ ...ZERO_COUNTS, ready: 1, needsReconciliation: 1 })
    expect(attemptRow(ctx, attemptId).state).toBe('lease_expired')
  })

  it('marks runs owned by another machine', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    giveAway(ctx, runId)
    expect(getRun(ctx, { runId })).toMatchObject({ ownerMachineId: 'mc_other', ownedByThisMachine: false })
  })
})

describe('getRun — counts', () => {
  it('counts tickets by execution state', () => {
    const ctx = createTestCtx()
    const bundle = bundleWith([[1, 2, 3, 4, 5, 6, 7, 8], [9]], [[3, 5], [6, 7]], { retryLimit: 1 })
    const { runId } = startedRun(ctx, { bundle })
    const accepted = claim(ctx, runId, 1)
    submitAttempt(ctx, { attemptId: accepted.attempt.id, claimToken: accepted.packet.claimToken, outputs: { summary: 'ok' } })
    acceptAttempt(ctx, { attemptId: accepted.attempt.id })
    const submitted = claim(ctx, runId, 2)
    submitAttempt(ctx, { attemptId: submitted.attempt.id, claimToken: submitted.packet.claimToken, outputs: { summary: 'ok' } })
    claim(ctx, runId, 3)
    failAttempt(ctx, { attemptId: claim(ctx, runId, 6).attempt.id, failure: { reason: 'broken' } })
    claim(ctx, runId, 8, { leaseSeconds: 60 })
    ctx.clock.advanceSeconds(61)
    expect(getRun(ctx, { runId })?.counts).toEqual({
      accepted: 1,
      submitted: 1,
      running: 1,
      ready: 1,
      waiting: 1,
      blocked: 1,
      failed: 1,
      needsReconciliation: 1
    })
  })

  it('counts ready tickets held back by the run state as waiting', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]], [[1, 2]]) })
    expect(pauseRun(ctx, { runId }).counts).toEqual({ ...ZERO_COUNTS, waiting: 2 })
  })
})

describe('getRun — attempts', () => {
  it('lists open attempts plus the 50 most recent', () => {
    const ctx = createTestCtx()
    const { runId, revisionId } = startedRun(ctx)
    const open = claim(ctx, runId, 1).attempt.id
    for (let number = 1; number <= 51; number += 1) {
      ctx.clock.advanceSeconds(1)
      ctx.db.run(
        `INSERT INTO attempts (id, run_id, ticket_id, number, kind, state, fencing_token, worker_json, revision_id,
           ticket_content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, 'work', 'failed', ?, '{}', ?, 'h', ?, ?)`,
        `at_old_${number}`,
        runId,
        tid(2),
        number,
        number,
        revisionId ?? '',
        ctx.clock.nowIso(),
        ctx.clock.nowIso()
      )
    }
    const ids = getRun(ctx, { runId })?.attempts.map((attempt) => attempt.id) ?? []
    expect(ids).toHaveLength(51)
    expect([ids[0], ids[49], ids[50]]).toEqual(['at_old_51', 'at_old_2', open])
  })
})

describe('pauseRun', () => {
  it('pauses a running run with a reason, or "paused" by default', () => {
    const ctx = createTestCtx()
    const { runId, epicId } = startedRun(ctx)
    clearOutbox(ctx)
    expect(pauseRun(ctx, { runId, reason: 'lunch' })).toMatchObject({ state: 'paused', pauseReason: 'lunch' })
    expect(lastEventPayload(ctx, 'run.paused')).toEqual({ from: 'running', reason: 'lunch' })
    expect(pendingOutbox(ctx)).toEqual([`run_history:${epicId}:${runId}`])
    ctx.db.run("UPDATE runs SET state = 'awaiting_checkpoint' WHERE id = ?", runId)
    expect(pauseRun(withRole(ctx, 'desktop'), { runId }).pauseReason).toBe('paused')
  })

  it('pauses a queued run', () => {
    const ctx = createTestCtx({ role: 'desktop' })
    const runId = queueRun(ctx, { epicId: seedEpic(ctx).epicId }).id
    expect(pauseRun(ctx, { runId }).state).toBe('paused')
  })

  it('rejects pausing a paused or finished run, and workers', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    expect(errorCode(() => pauseRun(withRole(ctx, 'worker'), { runId }))).toBe('unauthorized')
    pauseRun(ctx, { runId })
    const error = domainError(() => pauseRun(ctx, { runId }))
    expect([error.code, error.message]).toEqual(['run_not_active', "Can't pause a paused run."])
    cancelRun(ctx, { runId })
    expect(errorCode(() => pauseRun(ctx, { runId }))).toBe('run_not_active')
  })
})

describe('resumeRun', () => {
  it('resumes a paused run and clears the pause reason', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    pauseRun(ctx, { runId, reason: 'wait' })
    expect(resumeRun(ctx, { runId })).toMatchObject({ state: 'running', pauseReason: null })
    expect(lastEventPayload(ctx, 'run.resumed')).toEqual({ to: 'running' })
  })

  it('returns a run paused before it ever started to the queue', () => {
    const ctx = createTestCtx({ role: 'desktop' })
    const runId = queueRun(ctx, { epicId: seedEpic(ctx).epicId }).id
    pauseRun(ctx, { runId })
    expect(resumeRun(ctx, { runId }).state).toBe('queued')
  })

  it('requires a paused run owned by this machine and an unchanged branch', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    expect(errorCode(() => resumeRun(ctx, { runId }))).toBe('run_not_active')
    pauseRun(ctx, { runId })
    const moved = { ...ctx, assertBranch: (): void => { throw new DomainError('branch_changed', 'moved') } }
    expect(errorCode(() => resumeRun(moved, { runId }))).toBe('branch_changed')
    giveAway(ctx, runId)
    expect(errorCode(() => resumeRun(ctx, { runId }))).toBe('run_not_owned')
  })
})

describe('cancelRun', () => {
  it('cancels the run and its open attempts but keeps decided ones', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2, 3]]) })
    const done = claim(ctx, runId, 1)
    submitAttempt(ctx, { attemptId: done.attempt.id, claimToken: done.packet.claimToken, outputs: { summary: 's' } })
    acceptAttempt(ctx, { attemptId: done.attempt.id })
    const submitted = claim(ctx, runId, 2)
    submitAttempt(ctx, { attemptId: submitted.attempt.id, claimToken: submitted.packet.claimToken, outputs: { summary: 's' } })
    const running = claim(ctx, runId, 3).attempt.id
    ctx.clock.advanceSeconds(10)
    const view = cancelRun(withRole(ctx, 'desktop'), { runId, reason: 'scope changed' })
    expect([view.state, view.endedAt]).toEqual(['canceled', '2026-01-01T00:00:10.000Z'])
    expect([done.attempt.id, submitted.attempt.id, running].map((id) => attemptRow(ctx, id).state)).toEqual([
      'accepted',
      'canceled',
      'canceled'
    ])
    expect(lastEventPayload(ctx, 'run.canceled')).toEqual({
      reason: 'scope changed',
      canceledAttempts: [submitted.attempt.id, running]
    })
  })

  it('rejects canceling a run that already ended', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    cancelRun(ctx, { runId })
    expect(errorCode(() => cancelRun(ctx, { runId }))).toBe('run_not_active')
    expect(lastEventPayload(ctx, 'run.canceled')).toEqual({ reason: null, canceledAttempts: [] })
  })
})

describe('takeoverRun', () => {
  it('takes over another machine’s run, expiring its leases and pausing it', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const leased = claim(ctx, runId, 1).attempt.id
    const submitted = claim(ctx, runId, 2)
    submitAttempt(ctx, { attemptId: submitted.attempt.id, claimToken: submitted.packet.claimToken, outputs: { summary: 's' } })
    giveAway(ctx, runId)
    ctx.db.run('UPDATE runs SET auto_continue = 1 WHERE id = ?', runId)
    const view = takeoverRun(ctx, { runId })
    expect(view).toMatchObject({
      state: 'paused',
      pauseReason: 'taken_over',
      ownerMachineId: ctx.machineId,
      ownedByThisMachine: true,
      autoContinue: false
    })
    expect([attemptRow(ctx, leased).state, attemptRow(ctx, submitted.attempt.id).state]).toEqual(['lease_expired', 'submitted'])
    expect(lastEventPayload(ctx, 'run.taken_over')).toEqual({ previousOwner: 'mc_other', expiredAttempts: [leased] })
  })

  it('returns a run this machine already owns unchanged', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const leased = claim(ctx, runId, 1).attempt.id
    ctx.db.run('UPDATE runs SET auto_continue = 1 WHERE id = ?', runId)
    expect(takeoverRun(ctx, { runId })).toMatchObject({ state: 'running', autoContinue: true })
    expect(attemptRow(ctx, leased).state).toBe('claimed')
    expect(eventKinds(ctx, 'run.taken_over')).toEqual([])
  })

  it('rejects a run that is no longer active', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    cancelRun(ctx, { runId })
    giveAway(ctx, runId)
    expect(errorCode(() => takeoverRun(ctx, { runId }))).toBe('run_not_active')
  })
})

describe('requireOwnedRun', () => {
  it('returns an owned run and rejects missing or foreign runs', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    expect(requireOwnedRun(ctx, runId).id).toBe(runId)
    expect(errorCode(() => requireOwnedRun(ctx, 'rn_missing'))).toBe('not_found')
    giveAway(ctx, runId)
    const error = domainError(() => requireOwnedRun(ctx, runId))
    expect([error.code, error.message]).toEqual(['run_not_owned', 'This run belongs to another machine; take it over first.'])
  })
})

function pauseSignedOut(ctx: TestCtx, runId: string): RunView {
  return pauseRun(withRole(ctx, 'desktop'), { runId, reason: 'signed_out' })
}

/** Resume run in the desktop app: the only session that may resume a run paused for sign-in. */
function resumeSignedOut(ctx: TestCtx, runId: string): RunView {
  return resumeRun(withRole(ctx, 'desktop'), { runId })
}

describe('pauseRun — signed_out', () => {
  it('lets the desktop pause a run for sign-in, recording the reason and when it was paused', () => {
    const ctx = createTestCtx()
    const { runId, epicId } = startedRun(ctx)
    ctx.clock.advanceSeconds(30)
    clearOutbox(ctx)
    expect(pauseSignedOut(ctx, runId)).toMatchObject({ state: 'paused', pauseReason: 'signed_out' })
    expect(runRow(ctx, runId).paused_at).toBe('2026-01-01T00:00:30.000Z')
    expect(lastEventPayload(ctx, 'run.paused')).toEqual({ from: 'running', reason: 'signed_out' })
    expect(pendingOutbox(ctx)).toEqual([`run_history:${epicId}:${runId}`])
  })

  it('reaches the portable run history as the run record pause reason', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    pauseSignedOut(ctx, runId)
    expect(buildRunHistoryRecord(ctx.db, runId)).toMatchObject({ state: 'paused', pauseReason: 'signed_out' })
  })

  it('refuses an MCP session with unauthorized and leaves the run as it was', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const before = runRow(ctx, runId)
    clearOutbox(ctx)
    const error = domainError(() => pauseRun(ctx, { runId, reason: 'signed_out' }))
    expect([error.code, error.details]).toEqual(['unauthorized', { role: 'orchestrator', capability: 'run.pause_signed_out' }])
    expect(runRow(ctx, runId)).toEqual(before)
    expect(eventKinds(ctx, 'run.paused')).toEqual([])
    expect(pendingOutbox(ctx)).toEqual([])
  })

  it.each(['planner', 'worker', 'reviewer'] as const)('refuses a %s session too', (role) => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    expect(errorCode(() => pauseRun(withRole(ctx, role), { runId, reason: 'signed_out' }))).toBe('unauthorized')
    expect(runRow(ctx, runId)).toMatchObject({ state: 'running', pause_reason: null, paused_at: null })
  })

  it('recognises only the exact reason, so a near miss stays open to any run controller', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    expect(pauseRun(ctx, { runId, reason: 'Signed_out' })).toMatchObject({ state: 'paused', pauseReason: 'Signed_out' })
  })

  it('records when the run was paused for any reason, and clears it on resume', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    ctx.clock.advanceSeconds(5)
    pauseRun(ctx, { runId, reason: 'lunch' })
    expect(runRow(ctx, runId).paused_at).toBe('2026-01-01T00:00:05.000Z')
    resumeRun(ctx, { runId })
    expect(runRow(ctx, runId).paused_at).toBeNull()
  })
})

describe('leases of a run paused for sign-in', () => {
  it('stay open through get_run, readiness and expireLeases while the lease time passes', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    const leaseEnd = attemptRow(ctx, attemptId).lease_expires_at
    pauseSignedOut(ctx, runId)
    ctx.clock.advanceSeconds(3600)
    const view = getRun(withRole(ctx, 'reviewer'), { runId })
    expect(view?.counts).toEqual({ ...ZERO_COUNTS, running: 1, waiting: 1 })
    expect(runExecution(ctx, runId).tickets.map((ticket) => ticket.state)).toEqual(['running', 'ready'])
    expect(expireLeases(ctx, runId)).toEqual([])
    expect(expireLeases(ctx)).toEqual([])
    expect(attemptRow(ctx, attemptId)).toMatchObject({ state: 'claimed', lease_expires_at: leaseEnd })
    expect(eventKinds(ctx, 'attempt.lease_expired')).toEqual([])
  })

  it('still take a heartbeat from the worker, even after the lease time passed', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1, { leaseSeconds: 60 })
    pauseSignedOut(ctx, runId)
    ctx.clock.advanceSeconds(120)
    const beat = heartbeatAttempt(withRole(ctx, 'worker'), {
      attemptId: claimed.attempt.id,
      claimToken: claimed.packet.claimToken,
      leaseSeconds: 300
    })
    expect(beat).toMatchObject({ state: 'running', leaseExpiresAt: '2026-01-01T00:07:00.000Z' })
  })

  it('are the only ones kept: another run still expires its overdue leases', () => {
    const ctx = createTestCtx()
    const paused = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const other = startedRun(ctx, { bundle: makeBundle([[2]]) })
    const kept = claim(ctx, paused.runId, 1, { leaseSeconds: 60 }).attempt.id
    const lapsed = claim(ctx, other.runId, 2, { leaseSeconds: 60 }).attempt.id
    pauseSignedOut(ctx, paused.runId)
    ctx.clock.advanceSeconds(61)
    expect(expireLeases(ctx)).toEqual([lapsed])
    expect(attemptRow(ctx, kept).state).toBe('claimed')
  })
})

describe('leases of a run paused for another reason', () => {
  it('expire exactly as before', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    pauseRun(ctx, { runId, reason: 'lunch' })
    ctx.clock.advanceSeconds(61)
    expect(getRun(ctx, { runId })?.counts).toEqual({ ...ZERO_COUNTS, needsReconciliation: 1 })
    expect(attemptRow(ctx, attemptId).state).toBe('lease_expired')
  })

  it('expire at a takeover of a run that was paused for sign-in', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    pauseSignedOut(ctx, runId)
    giveAway(ctx, runId)
    expect(takeoverRun(ctx, { runId })).toMatchObject({ state: 'paused', pauseReason: 'taken_over' })
    expect(attemptRow(ctx, attemptId).state).toBe('lease_expired')
    expect(lastEventPayload(ctx, 'run.taken_over')).toEqual({ previousOwner: 'mc_other', expiredAttempts: [attemptId] })
  })

  it('do not come back at resume after that takeover', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    pauseSignedOut(ctx, runId)
    giveAway(ctx, runId)
    takeoverRun(ctx, { runId })
    ctx.clock.advanceSeconds(100)
    resumeRun(ctx, { runId })
    expect(attemptRow(ctx, attemptId).state).toBe('lease_expired')
    expect(eventKinds(ctx, 'run.leases_extended')).toEqual([])
  })
})

describe('resumeRun — leases kept while paused for sign-in', () => {
  it('extends each open lease by the time the run spent paused and records it as a run event', () => {
    const ctx = createTestCtx()
    const { runId, epicId } = startedRun(ctx, { bundle: makeBundle([[1, 2, 3]]) })
    const first = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    ctx.clock.advanceSeconds(20)
    const second = claim(ctx, runId, 2, { leaseSeconds: 300 }).attempt.id
    const done = claim(ctx, runId, 3)
    submitAttempt(ctx, { attemptId: done.attempt.id, claimToken: done.packet.claimToken, outputs: { summary: 's' } })
    ctx.clock.advanceSeconds(10)
    pauseSignedOut(ctx, runId)
    ctx.clock.advanceSeconds(100)
    clearOutbox(ctx)
    expect(resumeSignedOut(ctx, runId)).toMatchObject({ state: 'running', pauseReason: null })
    expect(attemptRow(ctx, first).lease_expires_at).toBe('2026-01-01T00:02:40.000Z')
    expect(attemptRow(ctx, second).lease_expires_at).toBe('2026-01-01T00:07:00.000Z')
    expect(attemptRow(ctx, done.attempt.id)).toMatchObject({ state: 'submitted', lease_expires_at: null })
    expect(lastEventPayload(ctx, 'run.leases_extended')).toEqual({
      pausedAt: '2026-01-01T00:00:30.000Z',
      extendedMs: 100_000,
      attempts: [
        { attemptId: first, from: '2026-01-01T00:01:00.000Z', to: '2026-01-01T00:02:40.000Z' },
        { attemptId: second, from: '2026-01-01T00:05:20.000Z', to: '2026-01-01T00:07:00.000Z' }
      ]
    })
    expect(eventKinds(ctx, 'run.')).toEqual(['run.started', 'run.paused', 'run.leases_extended', 'run.resumed'])
    expect(lastEventPayload(ctx, 'run.resumed')).toEqual({ to: 'running' })
    expect(pendingOutbox(ctx)).toEqual([`run_history:${epicId}:${runId}`])
  })

  it('gives the workers back the lease time they had: it lapses only after the extended end', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    ctx.clock.advanceSeconds(40)
    pauseSignedOut(ctx, runId)
    ctx.clock.advanceSeconds(1000)
    resumeSignedOut(ctx, runId)
    ctx.clock.advanceSeconds(20)
    expect(expireLeases(ctx, runId)).toEqual([])
    ctx.clock.advanceSeconds(1)
    expect(expireLeases(ctx, runId)).toEqual([attemptId])
  })
})

describe('resumeRun — the lease length a later heartbeat keeps', () => {
  it('does not grow by the time given back: that time is not part of the claim', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1, { leaseSeconds: 600 })
    ctx.clock.advanceSeconds(60)
    pauseSignedOut(ctx, runId)
    ctx.clock.advanceSeconds(7200)
    resumeSignedOut(ctx, runId)
    ctx.clock.advanceSeconds(60)
    const beat = heartbeatAttempt(withRole(ctx, 'worker'), { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken })
    expect(beat.leaseExpiresAt).toBe('2026-01-01T02:12:00.000Z')
  })

  it('does not grow for a length a heartbeat named either, even one sent during the pause', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1)
    const token = { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken }
    const worker = withRole(ctx, 'worker')
    ctx.clock.advanceSeconds(60)
    heartbeatAttempt(worker, { ...token, leaseSeconds: 300 })
    pauseSignedOut(ctx, runId)
    ctx.clock.advanceSeconds(600)
    expect(heartbeatAttempt(worker, token).leaseExpiresAt).toBe('2026-01-01T00:16:00.000Z')
    ctx.clock.advanceSeconds(60)
    resumeSignedOut(ctx, runId)
    expect(attemptRow(ctx, claimed.attempt.id).lease_expires_at).toBe('2026-01-01T00:27:00.000Z')
    ctx.clock.advanceSeconds(60)
    expect(heartbeatAttempt(worker, token).leaseExpiresAt).toBe('2026-01-01T00:18:00.000Z')
  })
})

describe('resumeRun — nothing to extend', () => {
  it('records no extension event when no lease is open', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    pauseSignedOut(ctx, runId)
    ctx.clock.advanceSeconds(100)
    expect(resumeSignedOut(ctx, runId).state).toBe('running')
    expect(eventKinds(ctx, 'run.leases_extended')).toEqual([])
  })

  it('does not extend leases after a pause for any other reason', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    const leaseEnd = attemptRow(ctx, attemptId).lease_expires_at
    ctx.clock.advanceSeconds(10)
    pauseRun(ctx, { runId, reason: 'lunch' })
    ctx.clock.advanceSeconds(20)
    resumeRun(ctx, { runId })
    expect(attemptRow(ctx, attemptId).lease_expires_at).toBe(leaseEnd)
    expect(eventKinds(ctx, 'run.leases_extended')).toEqual([])
  })

  it('extends nothing for a run whose pause time was never recorded', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    const leaseEnd = attemptRow(ctx, attemptId).lease_expires_at
    pauseSignedOut(ctx, runId)
    ctx.db.run('UPDATE runs SET paused_at = NULL WHERE id = ?', runId)
    ctx.clock.advanceSeconds(100)
    resumeSignedOut(ctx, runId)
    expect(attemptRow(ctx, attemptId).lease_expires_at).toBe(leaseEnd)
    expect(eventKinds(ctx, 'run.leases_extended')).toEqual([])
  })
})

describe('resumeRun — a run paused for sign-in is for the person to resume', () => {
  it('refuses an MCP session with unauthorized, naming the desktop app, and changes nothing', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    ctx.clock.advanceSeconds(10)
    pauseSignedOut(ctx, runId)
    ctx.clock.advanceSeconds(100)
    const runBefore = runRow(ctx, runId)
    const attemptBefore = attemptRow(ctx, attemptId)
    clearOutbox(ctx)
    const error = domainError(() => resumeRun(ctx, { runId }))
    expect([error.code, error.details]).toEqual(['unauthorized', { role: 'orchestrator', capability: 'run.resume_signed_out' }])
    expect(error.message).toBe(
      'This run is paused because its agent was signed out. The person resumes it in the desktop app, with Resume run.'
    )
    expect(runRow(ctx, runId)).toEqual(runBefore)
    expect(attemptRow(ctx, attemptId)).toEqual(attemptBefore)
    expect(eventKinds(ctx, 'run.')).toEqual(['run.started', 'run.paused'])
    expect(pendingOutbox(ctx)).toEqual([])
  })

  it('lets the desktop resume it, extending the kept leases by the time the run spent paused', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    ctx.clock.advanceSeconds(10)
    pauseSignedOut(ctx, runId)
    ctx.clock.advanceSeconds(100)
    expect(errorCode(() => resumeRun(ctx, { runId }))).toBe('unauthorized')
    expect(resumeSignedOut(ctx, runId)).toMatchObject({ state: 'running', pauseReason: null })
    expect(attemptRow(ctx, attemptId).lease_expires_at).toBe('2026-01-01T00:02:40.000Z')
    expect(eventKinds(ctx, 'run.')).toEqual(['run.started', 'run.paused', 'run.leases_extended', 'run.resumed'])
  })
})

describe('resumeRun — a run paused for any other reason', () => {
  it('recognises only the exact reason, so a near miss is resumed by an agent as before', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    pauseRun(ctx, { runId, reason: 'Signed_out' })
    expect(resumeRun(ctx, { runId })).toMatchObject({ state: 'running', pauseReason: null })
  })

  it.each([undefined, 'lunch', 'ticket_failed'])('still lets an MCP session resume a run paused for %s', (reason) => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    pauseRun(ctx, { runId, ...(reason === undefined ? {} : { reason }) })
    expect(resumeRun(ctx, { runId })).toMatchObject({ state: 'running', pauseReason: null })
    expect(lastEventPayload(ctx, 'run.resumed')).toEqual({ to: 'running' })
  })

  it('checks the run state first: a run that is not paused is not active to resume, not unauthorized', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    expect(errorCode(() => resumeRun(ctx, { runId }))).toBe('run_not_active')
  })
})

describe('pauseRun — a run that is already paused, marked signed out', () => {
  it('switches the reason, sets when it was paused to that moment, and records a run event', () => {
    const ctx = createTestCtx()
    const { runId, epicId } = startedRun(ctx)
    ctx.clock.advanceSeconds(5)
    pauseRun(ctx, { runId, reason: 'lunch' })
    ctx.clock.advanceSeconds(25)
    clearOutbox(ctx)
    expect(pauseSignedOut(ctx, runId)).toMatchObject({ state: 'paused', pauseReason: 'signed_out' })
    expect(runRow(ctx, runId)).toMatchObject({ state: 'paused', pause_reason: 'signed_out', paused_at: '2026-01-01T00:00:30.000Z' })
    expect(eventKinds(ctx, 'run.')).toEqual(['run.started', 'run.paused', 'run.paused'])
    expect(lastEventPayload(ctx, 'run.paused')).toEqual({ from: 'paused', reason: 'signed_out', previousReason: 'lunch' })
    expect(pendingOutbox(ctx)).toEqual([`run_history:${epicId}:${runId}`])
  })

  it('keeps the open leases: they do not expire while the run stays paused', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    const leaseEnd = attemptRow(ctx, attemptId).lease_expires_at
    ctx.clock.advanceSeconds(10)
    pauseRun(ctx, { runId, reason: 'lunch' })
    ctx.clock.advanceSeconds(20)
    pauseSignedOut(ctx, runId)
    ctx.clock.advanceSeconds(3600)
    expect(getRun(withRole(ctx, 'reviewer'), { runId })?.counts).toEqual({ ...ZERO_COUNTS, running: 1, waiting: 1 })
    expect(expireLeases(ctx, runId)).toEqual([])
    expect(expireLeases(ctx)).toEqual([])
    expect(attemptRow(ctx, attemptId)).toMatchObject({ state: 'claimed', lease_expires_at: leaseEnd })
    expect(eventKinds(ctx, 'attempt.lease_expired')).toEqual([])
  })
})

describe('pauseRun — a paused run marked signed out: resuming it', () => {
  it('extends them on resume by the time since the switch, not since the first pause', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    ctx.clock.advanceSeconds(10)
    pauseRun(ctx, { runId, reason: 'lunch' })
    ctx.clock.advanceSeconds(20)
    pauseSignedOut(ctx, runId)
    ctx.clock.advanceSeconds(100)
    expect(resumeSignedOut(ctx, runId)).toMatchObject({ state: 'running', pauseReason: null })
    expect(attemptRow(ctx, attemptId).lease_expires_at).toBe('2026-01-01T00:02:40.000Z')
    expect(lastEventPayload(ctx, 'run.leases_extended')).toEqual({
      pausedAt: '2026-01-01T00:00:30.000Z',
      extendedMs: 100_000,
      attempts: [{ attemptId, from: '2026-01-01T00:01:00.000Z', to: '2026-01-01T00:02:40.000Z' }]
    })
    ctx.clock.advanceSeconds(30)
    expect(expireLeases(ctx, runId)).toEqual([])
    ctx.clock.advanceSeconds(1)
    expect(expireLeases(ctx, runId)).toEqual([attemptId])
  })

  it('lets a lease that was already overdue lapse first: only the open leases are kept', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    const overdue = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    const open = claim(ctx, runId, 2, { leaseSeconds: 600 }).attempt.id
    pauseRun(ctx, { runId, reason: 'lunch' })
    ctx.clock.advanceSeconds(100)
    pauseSignedOut(ctx, runId)
    expect([attemptRow(ctx, overdue).state, attemptRow(ctx, open).state]).toEqual(['lease_expired', 'claimed'])
    expect(eventKinds(ctx, 'attempt.lease_expired')).toEqual(['attempt.lease_expired'])
    ctx.clock.advanceSeconds(50)
    resumeSignedOut(ctx, runId)
    expect(attemptRow(ctx, overdue).state).toBe('lease_expired')
    expect(attemptRow(ctx, open).lease_expires_at).toBe('2026-01-01T00:10:50.000Z')
  })
})

describe('pauseRun — a paused run marked signed out: takeover, authorization and repeats', () => {
  it('also switches a run paused by a takeover, whose leases had already lapsed', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    giveAway(ctx, runId)
    takeoverRun(ctx, { runId })
    ctx.clock.advanceSeconds(30)
    expect(pauseSignedOut(ctx, runId)).toMatchObject({ state: 'paused', pauseReason: 'signed_out' })
    expect(lastEventPayload(ctx, 'run.paused')).toMatchObject({ previousReason: 'taken_over' })
    expect(attemptRow(ctx, attemptId).state).toBe('lease_expired')
    resumeSignedOut(ctx, runId)
    expect(attemptRow(ctx, attemptId).state).toBe('lease_expired')
    expect(eventKinds(ctx, 'run.leases_extended')).toEqual([])
  })

  it('is for the desktop alone: an MCP session gets unauthorized and the pause stays as it was', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    pauseRun(ctx, { runId, reason: 'lunch' })
    const before = runRow(ctx, runId)
    clearOutbox(ctx)
    const error = domainError(() => pauseRun(ctx, { runId, reason: 'signed_out' }))
    expect([error.code, error.details]).toEqual(['unauthorized', { role: 'orchestrator', capability: 'run.pause_signed_out' }])
    expect(runRow(ctx, runId)).toEqual(before)
    expect(eventKinds(ctx, 'run.')).toEqual(['run.started', 'run.paused'])
    expect(pendingOutbox(ctx)).toEqual([])
  })

  it('leaves a run that is already paused for sign-in alone, keeping when it was paused', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    ctx.clock.advanceSeconds(30)
    pauseSignedOut(ctx, runId)
    const before = runRow(ctx, runId)
    ctx.clock.advanceSeconds(100)
    clearOutbox(ctx)
    expect(pauseSignedOut(ctx, runId)).toMatchObject({ state: 'paused', pauseReason: 'signed_out' })
    expect(runRow(ctx, runId)).toEqual(before)
    expect(eventKinds(ctx, 'run.')).toEqual(['run.started', 'run.paused'])
    expect(pendingOutbox(ctx)).toEqual([])
    resumeSignedOut(ctx, runId)
    expect(attemptRow(ctx, attemptId).lease_expires_at).toBe('2026-01-01T00:02:40.000Z')
  })
})

describe('pauseRun — a paused run marked signed out: what stays as it was', () => {
  it('does not change how a paused run is paused for any other reason: still run_not_active', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    pauseRun(ctx, { runId, reason: 'lunch' })
    const desktop = withRole(ctx, 'desktop')
    expect(errorCode(() => pauseRun(desktop, { runId, reason: 'later' }))).toBe('run_not_active')
    expect(errorCode(() => pauseRun(desktop, { runId }))).toBe('run_not_active')
    expect(runRow(ctx, runId)).toMatchObject({ state: 'paused', pause_reason: 'lunch' })
  })

  it('still refuses a run that has ended', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    cancelRun(ctx, { runId })
    const error = domainError(() => pauseSignedOut(ctx, runId))
    expect([error.code, error.details]).toEqual(['run_not_active', { runId, state: 'canceled' }])
  })
})
