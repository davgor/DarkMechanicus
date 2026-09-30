import { describe, expect, it } from 'vitest'
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
import { createTestCtx, withRole } from '../../test/testContext'
import { DomainError } from '../errors'
import { SKILLS_VERSION } from '../version'
import type { Ctx } from '../context'
import { acceptAttempt, failAttempt, submitAttempt } from './attempts'
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
    cancelRun(ctx, { runId: queueRun(ctx, { epicId }).id })
    expect(runRow(ctx, queueRun(ctx, { epicId }).id).number).toBe(2)
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
