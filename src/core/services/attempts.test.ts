import { describe, expect, it } from 'vitest'
import { makeBundle, sid, tid } from '../../test/bundles'
import {
  attemptRow,
  bundleWith,
  claim,
  clearOutbox,
  completeTicket,
  domainError,
  errorCode,
  eventKinds,
  hostCatalog,
  hostModel,
  lastEventPayload,
  openAttemptIds,
  pendingOutbox,
  startedRun,
  submitClaim,
  tempDatabasePath,
  ticketStatus
} from '../../test/execution'
import { createSequentialIds, createTestClock, createTestCtx, createTestDb, withRole } from '../../test/testContext'
import { contentHash } from '../canonical'
import { openDatabase } from '../db/database'
import { DomainError } from '../errors'
import { failAttempt, heartbeatAttempt, reconcileAttempt, submitAttempt } from './attempts'
import { registerHost } from './hosts'
import { pauseRun } from './runs'

describe('claimTicket — a successful claim', () => {
  it('creates a claimed work attempt with a lease and moves the ticket to in progress', () => {
    const ctx = createTestCtx()
    const { runId, revisionId, epicId, bundle } = startedRun(ctx)
    clearOutbox(ctx)
    const { attempt } = claim(ctx, runId, 1, { worker: { label: 'impl-1', rationale: 'small change' } })
    expect(attempt).toMatchObject({
      runId,
      ticketId: tid(1),
      number: 1,
      fencingToken: 1,
      kind: 'work',
      state: 'claimed',
      revisionId,
      ticketContentHash: contentHash(bundle.tickets[0]),
      leaseExpiresAt: '2026-01-01T00:15:00.000Z',
      decidedAt: null,
      worker: { sessionId: ctx.session.id, label: 'impl-1', modelId: null, hostId: null, catalogRevision: null, rationale: 'small change' }
    })
    expect(ticketStatus(ctx, tid(1))).toEqual({ status: 'in_progress', revision: 2 })
    expect(eventKinds(ctx, 'attempt.')).toEqual(['attempt.claimed'])
    expect(pendingOutbox(ctx)).toEqual([`epic_state:${epicId}:`, `run_history:${epicId}:${runId}`])
  })

  it('returns a bounded execution packet for the worker', () => {
    const ctx = createTestCtx()
    const { runId, revisionId, epicId, bundle } = startedRun(ctx)
    const { attempt, packet } = claim(ctx, runId, 2)
    expect(packet).toMatchObject({
      runId,
      attemptId: attempt.id,
      claimToken: `${attempt.id}.secret-1`,
      fencingToken: 1,
      leaseExpiresAt: '2026-01-01T00:15:00.000Z',
      heartbeatIntervalSeconds: 300,
      epic: { id: epicId, title: 'Test epic', branch: { repository: null, name: 'main', startCommit: '0123456789abcdef0123456789abcdef01234567' } },
      revisionId,
      sprint: { id: sid(1), ordinal: 1, goal: 'Sprint 1 goal' },
      ticket: bundle.tickets[1],
      ticketContentHash: contentHash(bundle.tickets[1]),
      predecessors: [],
      reporting: { heartbeatTool: 'heartbeat_attempt', submitTool: 'submit_attempt', failTool: 'fail_attempt' }
    })
    expect(packet.reporting.instructions).toContain('submit_attempt')
  })
})

describe('claimTicket — heartbeat interval', () => {
  it('derives the heartbeat interval from the lease, never below ten seconds', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2, 3]]) })
    expect(claim(ctx, runId, 1, { leaseSeconds: 60 }).packet.heartbeatIntervalSeconds).toBe(20)
    expect(claim(ctx, runId, 2, { leaseSeconds: 35 }).packet.heartbeatIntervalSeconds).toBe(11)
    expect(claim(ctx, runId, 3, { leaseSeconds: 24 }).packet.heartbeatIntervalSeconds).toBe(10)
  })
})

describe('claimTicket — predecessor outputs', () => {
  it('hands the worker every prerequisite’s accepted outputs', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2, 3]], [[1, 3], [2, 3]]) })
    const first = { summary: 'schema', artifacts: [], commits: ['aaa1111'], changedFiles: ['db.ts'], branch: 'epic/x' }
    completeTicket(ctx, runId, 1, first)
    completeTicket(ctx, runId, 2, { summary: 'api' })
    expect(claim(ctx, runId, 3).packet.predecessors).toEqual([
      { ticketId: tid(1), key: 'DM-1', title: 'Ticket 1', outputs: first },
      {
        ticketId: tid(2),
        key: 'DM-2',
        title: 'Ticket 2',
        outputs: { summary: 'api', artifacts: [], commits: [], changedFiles: [], branch: null }
      }
    ])
  })
})

describe('claimTicket — readiness rejections', () => {
  it('rejects tickets that are claimed, submitted, or accepted', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2, 3]]) })
    claim(ctx, runId, 1)
    submitClaim(ctx, claim(ctx, runId, 2))
    completeTicket(ctx, runId, 3)
    expect([1, 2, 3].map((n) => errorCode(() => claim(ctx, runId, n)))).toEqual(['already_claimed', 'already_claimed', 'conflict'])
  })

  it('rejects tickets with unmet prerequisites or in another sprint, with their blockers', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2], [3]], [[1, 2]]) })
    const waiting = domainError(() => claim(ctx, runId, 2))
    expect([waiting.code, waiting.message]).toEqual(['unmet_prerequisite', 'DM-2 is waiting for its prerequisites to be accepted.'])
    expect(waiting.details).toEqual({
      ticketId: tid(2),
      state: 'waiting',
      blockers: [{ kind: 'prerequisite', ticketId: tid(1), key: 'DM-1', state: 'ready' }]
    })
    expect(errorCode(() => claim(ctx, runId, 3))).toBe('unmet_prerequisite')
    expect(errorCode(() => claim(ctx, runId, 99))).toBe('not_found')
  })

  it('rejects a ticket blocked by a failed prerequisite and a failed ticket', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: bundleWith([[1, 2]], [[1, 2]], { retryLimit: 1 }) })
    failAttempt(ctx, { attemptId: claim(ctx, runId, 1).attempt.id, failure: { reason: 'broken' } })
    expect([1, 2].map((n) => errorCode(() => claim(ctx, runId, n)))).toEqual(['retry_limit_reached', 'unmet_prerequisite'])
  })

  it('requires reconciliation after a lease expired', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    claim(ctx, runId, 1, { leaseSeconds: 60 })
    ctx.clock.advanceSeconds(61)
    expect(errorCode(() => claim(ctx, runId, 1))).toBe('needs_reconciliation')
  })

  it('rejects a claim beyond the concurrency cap', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: bundleWith([[1, 2]], [], { maxConcurrency: 1 }) })
    claim(ctx, runId, 1)
    const error = domainError(() => claim(ctx, runId, 2))
    expect([error.code, error.details]).toEqual(['capacity_exceeded', { ticketId: tid(2), limit: 1 }])
  })
})

describe('claimTicket — run and session checks', () => {
  it('requires a running run owned by this machine', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    pauseRun(ctx, { runId })
    const paused = domainError(() => claim(ctx, runId, 1))
    expect([paused.code, paused.message]).toEqual(['run_not_active', 'The run is paused; tickets can only be claimed while it is running.'])
    ctx.db.run("UPDATE runs SET state = 'running', owner_machine_id = 'mc_other' WHERE id = ?", runId)
    expect(errorCode(() => claim(ctx, runId, 1))).toBe('run_not_owned')
  })

  it('is refused to workers and after a branch change', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    expect(errorCode(() => claim(withRole(ctx, 'worker'), runId, 1))).toBe('unauthorized')
    const moved = { ...ctx, assertBranch: (): void => { throw new DomainError('branch_changed', 'moved') } }
    expect(errorCode(() => claim(moved, runId, 1))).toBe('branch_changed')
    expect(openAttemptIds(ctx, runId)).toEqual([])
  })
})

describe('claimTicket — competing claims', () => {
  it('lets exactly one of two connections to the same database claim a ticket', () => {
    const file = tempDatabasePath()
    const first = createTestDb(file.path)
    const second = openDatabase(file.path)
    try {
      const shared = { ids: createSequentialIds(), clock: createTestClock() }
      const a = createTestCtx({ db: first, ...shared })
      const b = createTestCtx({ db: second, ...shared })
      const { runId } = startedRun(a)
      const winner = claim(a, runId, 1)
      expect(errorCode(() => claim(b, runId, 1))).toBe('already_claimed')
      expect(openAttemptIds(b, runId)).toEqual([winner.attempt.id])
    } finally {
      first.close()
      second.close()
      file.cleanup()
    }
  })

  it('makes a competing writer wait for the lock instead of claiming alongside it', () => {
    const file = tempDatabasePath()
    const first = createTestDb(file.path)
    const second = openDatabase(file.path, { busyTimeoutMs: 0, beginRetries: 0 })
    try {
      const shared = { ids: createSequentialIds(), clock: createTestClock() }
      const a = createTestCtx({ db: first, ...shared })
      const b = createTestCtx({ db: second, ...shared })
      const { runId } = startedRun(a)
      first.tx(() => {
        claim(a, runId, 1)
        expect(errorCode(() => claim(b, runId, 1))).toBe('raw:database is locked')
      })
      expect(errorCode(() => claim(b, runId, 1))).toBe('already_claimed')
      expect(openAttemptIds(b, runId)).toHaveLength(1)
    } finally {
      first.close()
      second.close()
      file.cleanup()
    }
  })

  it('maps an insert that collides with an open attempt to already_claimed', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const ghost = claim(ctx, runId, 1).attempt.id
    ctx.db.run('UPDATE attempts SET superseded_at = ? WHERE id = ?', ctx.clock.nowIso(), ghost)
    expect(errorCode(() => claim(ctx, runId, 1))).toBe('already_claimed')
    expect(openAttemptIds(ctx, runId)).toEqual([ghost])
  })
})

describe('claimTicket — idempotency', () => {
  it('replays the original claim for a repeated key', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const first = claim(ctx, runId, 1, { idempotencyKey: 'claim-1' })
    ctx.clock.advanceSeconds(3)
    expect(claim(ctx, runId, 1, { idempotencyKey: 'claim-1' })).toEqual(first)
    expect(openAttemptIds(ctx, runId)).toEqual([first.attempt.id])
    expect(eventKinds(ctx, 'attempt.claimed')).toEqual(['attempt.claimed'])
    expect(errorCode(() => claim(ctx, runId, 2, { idempotencyKey: 'claim-1' }))).toBe('idempotency_mismatch')
  })
})

describe('claimTicket — host capabilities', () => {
  function withCatalog(ctx: ReturnType<typeof createTestCtx>): string {
    const catalog = registerHost(ctx, hostCatalog([hostModel('big'), hostModel('text-only', { modalities: ['text'], reasoningLevels: ['routine'] })]))
    ctx.db.run('UPDATE runs SET host_catalog_id = ?', catalog.id)
    return catalog.id
  }

  it('records the selected model with the host and catalog revision of the run’s catalog', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    withCatalog(ctx)
    const { attempt } = claim(ctx, runId, 1, { worker: { label: 'w', modelId: 'big', rationale: 'deep work' } })
    expect(attempt.worker).toEqual({ sessionId: ctx.session.id, label: 'w', modelId: 'big', hostId: 'host-a', catalogRevision: 'cat-1', rationale: 'deep work' })
    const explicit = claim(ctx, runId, 2, { worker: { label: 'w', modelId: 'big', hostId: 'h2', catalogRevision: 'c2' } })
    expect([explicit.attempt.worker.hostId, explicit.attempt.worker.catalogRevision]).toEqual(['h2', 'c2'])
  })

  it('rejects a model that fails the ticket’s hard constraints', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    withCatalog(ctx)
    const error = domainError(() => claim(ctx, runId, 1, { worker: { label: 'w', modelId: 'text-only' } }))
    expect(error.code).toBe('unsupported_capability')
    expect(error.details).toMatchObject({
      modelId: 'text-only',
      failures: ['Needs "multi_step" reasoning; the model\'s highest level is "routine".']
    })
    const unknown = domainError(() => claim(ctx, runId, 1, { worker: { label: 'w', modelId: 'ghost' } }))
    expect(unknown.details).toMatchObject({ failures: ['Model "ghost" is not in the host catalog.'] })
  })

  it('skips the check without a model id or without a run catalog', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    registerHost(ctx, hostCatalog([hostModel('big')]))
    expect(claim(ctx, runId, 1, { worker: { label: 'w', modelId: 'anything' } }).attempt.worker.hostId).toBeNull()
    withCatalog(ctx)
    expect(claim(ctx, runId, 2, { worker: { label: 'w' } }).attempt.state).toBe('claimed')
  })
})

describe('heartbeatAttempt', () => {
  it('moves a claim to running and extends its lease on every heartbeat', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1)
    const worker = withRole(ctx, 'worker')
    ctx.clock.advanceSeconds(100)
    const first = heartbeatAttempt(worker, { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken })
    expect(first).toMatchObject({ state: 'running', heartbeatAt: '2026-01-01T00:01:40.000Z', leaseExpiresAt: '2026-01-01T00:16:40.000Z' })
    expect(eventKinds(ctx, 'attempt.')).toEqual(['attempt.claimed', 'attempt.running'])
    ctx.clock.advanceSeconds(100)
    const second = heartbeatAttempt(worker, { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken, leaseSeconds: 60 })
    expect(second).toMatchObject({ state: 'running', leaseExpiresAt: '2026-01-01T00:04:20.000Z' })
    expect(eventKinds(ctx, 'attempt.')).toEqual(['attempt.claimed', 'attempt.running'])
  })

  it('rejects a heartbeat after the lease expired and records the expiry', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1, { leaseSeconds: 60 })
    ctx.clock.advanceSeconds(61)
    const error = domainError(() => heartbeatAttempt(ctx, { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken }))
    expect([error.code, error.details]).toEqual(['expired_claim', { attemptId: claimed.attempt.id }])
    expect(attemptRow(ctx, claimed.attempt.id).state).toBe('lease_expired')
  })

  it('rejects tokens that do not match the attempt', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const { attempt, packet } = claim(ctx, runId, 1)
    const other = claim(ctx, runId, 2)
    const beat = (claimToken: string): string => errorCode(() => heartbeatAttempt(ctx, { attemptId: attempt.id, claimToken }))
    expect([beat(`${attempt.id}.wrong`), beat(other.packet.claimToken), beat('garbage'), beat(`${attempt.id}.`)]).toEqual([
      'stale_claim',
      'stale_claim',
      'stale_claim',
      'stale_claim'
    ])
    expect(beat(packet.claimToken)).toBe('ok')
  })

  it('rejects an unknown attempt', () => {
    expect(errorCode(() => heartbeatAttempt(createTestCtx(), { attemptId: 'at_missing', claimToken: 'x.y' }))).toBe('not_found')
  })
})

describe('stale workers', () => {
  it('rejects every late write from a claim superseded by reconciliation and a new claim', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const old = claim(ctx, runId, 1, { leaseSeconds: 60 })
    ctx.clock.advanceSeconds(61)
    reconcileAttempt(ctx, { attemptId: old.attempt.id, resolution: 'abandon' })
    const fresh = claim(ctx, runId, 1)
    const worker = withRole(ctx, 'worker')
    const token = { attemptId: old.attempt.id, claimToken: old.packet.claimToken }
    expect(errorCode(() => heartbeatAttempt(worker, token))).toBe('stale_claim')
    expect(errorCode(() => submitAttempt(worker, { ...token, outputs: { summary: 'late' } }))).toBe('stale_claim')
    expect(errorCode(() => failAttempt(worker, { ...token, failure: { reason: 'late' } }))).toBe('stale_claim')
    expect([fresh.attempt.number, fresh.packet.fencingToken, attemptRow(ctx, fresh.attempt.id).state]).toEqual([2, 2, 'claimed'])
  })

  it('rejects a write from a claim whose attempt was superseded by a revision change', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1)
    ctx.db.run('UPDATE attempts SET superseded_at = ? WHERE id = ?', ctx.clock.nowIso(), claimed.attempt.id)
    expect(errorCode(() => submitClaim(ctx, claimed))).toBe('stale_claim')
  })

  it('rejects a write to an attempt that is no longer leased', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1)
    submitClaim(ctx, claimed)
    const error = domainError(() => heartbeatAttempt(ctx, { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken }))
    expect([error.code, error.message]).toEqual(['stale_claim', 'This attempt is submitted; its claim is no longer active.'])
  })
})

describe('submitAttempt', () => {
  it('stores normalized outputs and evidence and releases the lease', () => {
    const ctx = createTestCtx()
    const { runId, epicId } = startedRun(ctx, { bundle: makeBundle([[1, 2]], [[1, 2]]) })
    const claimed = claim(ctx, runId, 1)
    clearOutbox(ctx)
    ctx.clock.advanceSeconds(30)
    const view = submitClaim(withRole(ctx, 'worker'), claimed, {
      outputs: { summary: 'Implemented the schema', commits: ['abc1234'] },
      evidence: { notes: 'All green' }
    })
    expect(view).toMatchObject({
      state: 'submitted',
      submittedAt: '2026-01-01T00:00:30.000Z',
      leaseExpiresAt: null,
      outputs: { summary: 'Implemented the schema', artifacts: [], commits: ['abc1234'], changedFiles: [], branch: null },
      evidence: { checks: [], criteria: [], notes: 'All green' }
    })
    expect(lastEventPayload(ctx, 'attempt.submitted')).toEqual({ attemptId: claimed.attempt.id })
    expect(pendingOutbox(ctx)).toEqual([`run_history:${epicId}:${runId}`])
    expect(ctx.db.get<{ title: string; body: string }>("SELECT title, body FROM search_index WHERE doc_type = 'attempt'")).toEqual({
      title: 'DM-1 attempt #1',
      body: 'Implemented the schema\n\nAll green'
    })
  })

  it('does not unlock dependents', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]], [[1, 2]]) })
    submitClaim(ctx, claim(ctx, runId, 1))
    expect(errorCode(() => claim(ctx, runId, 2))).toBe('unmet_prerequisite')
  })
})

describe('submitAttempt — replays and expiry', () => {
  it('replays the original submission for a repeated key', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1)
    const first = submitClaim(ctx, claimed, { idempotencyKey: 'submit-1' })
    ctx.clock.advanceSeconds(5)
    expect(submitClaim(ctx, claimed, { idempotencyKey: 'submit-1' })).toEqual(first)
    expect(eventKinds(ctx, 'attempt.submitted')).toHaveLength(1)
    expect(errorCode(() => submitClaim(ctx, claimed, { idempotencyKey: 'submit-1', outputs: { summary: 'other' } }))).toBe(
      'idempotency_mismatch'
    )
  })

  it('rejects a submission after the lease expired', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1, { leaseSeconds: 60 })
    ctx.clock.advanceSeconds(61)
    expect(errorCode(() => submitClaim(ctx, claimed))).toBe('expired_claim')
  })
})
