import { describe, expect, it } from 'vitest'
import type { AttemptDecision, AttemptEvidence, AttemptFailure, AttemptOutputs, WorkerInfo } from '../../shared/domain/views'
import { makeBundle, tid } from '../../test/bundles'
import {
  attemptRow,
  claim,
  clearOutbox,
  errorCode,
  eventKinds,
  lastEventPayload,
  pendingOutbox,
  seedRevision,
  startedRun,
  ticketStatus
} from '../../test/execution'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { toJson } from '../db/database'
import { DomainError } from '../errors'
import { submitAttempt } from './attempts'
import {
  advanceTicketStatus,
  type AttemptRow,
  attemptView,
  expireLeases,
  guardUnique,
  listAttempts,
  loadRunContext,
  runExecution
} from './execution'

const worker: WorkerInfo = {
  sessionId: 'ss_1',
  label: 'w',
  modelId: 'm1',
  hostId: 'h1',
  catalogRevision: 'c1',
  rationale: 'fits'
}
const outputs: AttemptOutputs = { summary: 'done', artifacts: [], commits: ['abc1234'], changedFiles: ['a.ts'], branch: 'epic/x' }
const evidence: AttemptEvidence = { checks: [{ name: 'unit', status: 'passed', detail: '' }], criteria: [], notes: 'ok' }
const failure: AttemptFailure = { reason: 'r', details: 'd', retryable: false }
const decision: AttemptDecision = { outcome: 'accepted', notes: 'n', reasons: [], decidedBy: 'rev' }

function fullRow(overrides: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: 'at_1',
    run_id: 'rn_1',
    ticket_id: tid(1),
    number: 2,
    kind: 'work',
    state: 'accepted',
    fencing_token: 2,
    claim_secret: 'secret',
    worker_json: toJson(worker),
    revision_id: 'rv_1',
    ticket_content_hash: 'sha256:abc',
    lease_expires_at: 'T-lease',
    heartbeat_at: 'T-beat',
    outputs_json: toJson(outputs),
    evidence_json: toJson(evidence),
    failure_json: toJson(failure),
    decision_json: toJson(decision),
    created_at: 'T0',
    updated_at: 'T1',
    submitted_at: 'T2',
    decided_at: 'T3',
    reconciled_at: 'T4',
    superseded_at: 'T5',
    ...overrides
  }
}

describe('attemptView', () => {
  it('maps every column of a decided, superseded attempt', () => {
    expect(attemptView(fullRow())).toEqual({
      id: 'at_1',
      runId: 'rn_1',
      ticketId: tid(1),
      number: 2,
      kind: 'work',
      state: 'accepted',
      fencingToken: 2,
      worker,
      revisionId: 'rv_1',
      ticketContentHash: 'sha256:abc',
      leaseExpiresAt: 'T-lease',
      heartbeatAt: 'T-beat',
      outputs,
      evidence,
      failure,
      decision,
      createdAt: 'T0',
      updatedAt: 'T1',
      submittedAt: 'T2',
      decidedAt: 'T3',
      reconciledAt: 'T4',
      superseded: true
    })
  })

  it('maps empty JSON columns to null and a live attempt as not superseded', () => {
    const view = attemptView(
      fullRow({ outputs_json: null, evidence_json: null, failure_json: null, decision_json: null, superseded_at: null })
    )
    expect([view.outputs, view.evidence, view.failure, view.decision, view.superseded]).toEqual([null, null, null, null, false])
  })
})

describe('loadRunContext', () => {
  it('fails with not_found for an unknown run', () => {
    expect(errorCode(() => loadRunContext(createTestCtx(), 'rn_missing'))).toBe('not_found')
  })

  it('returns the pinned bundle, attempts in creation order, and retry grants', () => {
    const ctx = createTestCtx()
    const { runId, epicId, bundle } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    seedRevision(ctx, epicId, makeBundle([[1, 2, 3]]))
    const first = claim(ctx, runId, 1).attempt.id
    const second = claim(ctx, runId, 2).attempt.id
    ctx.db.run('INSERT INTO retry_grants (run_id, ticket_id, extra) VALUES (?, ?, 2)', runId, tid(2))
    const context = loadRunContext(ctx, runId)
    expect(context.run.id).toBe(runId)
    expect(context.bundle).toEqual(bundle)
    expect(context.attempts.map((row) => row.id)).toEqual([first, second])
    expect(context.retryGrants).toEqual({ [tid(2)]: 2 })
  })
})

describe('expireLeases — lease boundary', () => {
  it('keeps a lease that ends exactly now and expires it one second later', () => {
    const ctx = createTestCtx()
    const { runId, epicId } = startedRun(ctx)
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    clearOutbox(ctx)
    ctx.clock.advanceSeconds(60)
    expect(expireLeases(ctx, runId)).toEqual([])
    expect(attemptRow(ctx, attemptId).state).toBe('claimed')
    ctx.clock.advanceSeconds(1)
    expect(expireLeases(ctx, runId)).toEqual([attemptId])
    expect(attemptRow(ctx, attemptId)).toMatchObject({ state: 'lease_expired', updated_at: '2026-01-01T00:01:01.000Z' })
    expect(lastEventPayload(ctx, 'attempt.lease_expired')).toEqual({
      attemptId,
      leaseExpiresAt: '2026-01-01T00:01:00.000Z'
    })
    expect(pendingOutbox(ctx)).toEqual([`run_history:${epicId}:${runId}`])
  })

  it('never expires a submitted attempt', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1, { leaseSeconds: 60 })
    submitAttempt(ctx, { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken, outputs: { summary: 's' } })
    ctx.clock.advanceSeconds(3600)
    expect(expireLeases(ctx)).toEqual([])
    expect(eventKinds(ctx, 'attempt.lease_expired')).toEqual([])
  })
})

describe('expireLeases — scope', () => {
  it('expires only the named run, or every run when none is named', () => {
    const ctx = createTestCtx()
    const a = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const b = startedRun(ctx, { bundle: makeBundle([[2]]) })
    const first = claim(ctx, a.runId, 1, { leaseSeconds: 60 }).attempt.id
    const second = claim(ctx, b.runId, 2, { leaseSeconds: 60 }).attempt.id
    ctx.clock.advanceSeconds(61)
    expect(expireLeases(ctx, a.runId)).toEqual([first])
    expect(attemptRow(ctx, second).state).toBe('claimed')
    expect(expireLeases(ctx)).toEqual([second])
  })
})

describe('runExecution', () => {
  it('expires overdue leases before computing readiness', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]], [[1, 2]]) })
    const attemptId = claim(ctx, runId, 1, { leaseSeconds: 60 }).attempt.id
    expect(runExecution(ctx, runId).tickets.map((item) => item.state)).toEqual(['running', 'waiting'])
    ctx.clock.advanceSeconds(61)
    const snapshot = runExecution(ctx, runId)
    expect(snapshot.tickets[0]).toMatchObject({ state: 'needs_reconciliation', blockers: [{ kind: 'lease_expired', attemptId }] })
    expect(snapshot.capacity).toEqual({ limit: null, inUse: 0 })
  })
})

describe('listAttempts', () => {
  it('lists newest first and filters by run, ticket, and epic', () => {
    const ctx = createTestCtx()
    const a = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    const b = startedRun(ctx, { bundle: makeBundle([[3]]) })
    const a1 = claim(ctx, a.runId, 1).attempt.id
    ctx.clock.advanceSeconds(1)
    const b3 = claim(ctx, b.runId, 3).attempt.id
    ctx.clock.advanceSeconds(1)
    const a2 = claim(ctx, a.runId, 2).attempt.id
    expect(listAttempts(ctx, {}).map((view) => view.id)).toEqual([a2, b3, a1])
    expect(listAttempts(ctx, { runId: a.runId }).map((view) => view.id)).toEqual([a2, a1])
    expect(listAttempts(ctx, { ticketId: tid(1) }).map((view) => view.id)).toEqual([a1])
    expect(listAttempts(ctx, { epicId: b.epicId }).map((view) => view.id)).toEqual([b3])
  })
})

describe('guardUnique', () => {
  function uniqueTable(): TestCtx {
    const ctx = createTestCtx()
    ctx.db.exec('CREATE TABLE pairs (a TEXT, b TEXT, n INTEGER)')
    ctx.db.exec('CREATE UNIQUE INDEX pairs_open ON pairs(a, b) WHERE n > 0')
    ctx.db.exec('CREATE UNIQUE INDEX pairs_numbered ON pairs(a, b, n)')
    ctx.db.run("INSERT INTO pairs VALUES ('x', 'y', 1)")
    return ctx
  }
  const violation = (): never => {
    throw new DomainError('already_claimed', 'mapped')
  }

  it('returns the write result when nothing collides', () => {
    const ctx = uniqueTable()
    expect(guardUnique(() => ctx.db.run("INSERT INTO pairs VALUES ('x', 'z', 1)").changes, 'pairs.a, pairs.b', violation)).toBe(1)
  })

  it('maps a violation of exactly the named columns', () => {
    const ctx = uniqueTable()
    expect(errorCode(() => guardUnique(() => ctx.db.run("INSERT INTO pairs VALUES ('x', 'y', 2)"), 'pairs.a, pairs.b', violation))).toBe(
      'already_claimed'
    )
  })

  it('rethrows other violations and errors untouched', () => {
    const ctx = uniqueTable()
    ctx.db.run('UPDATE pairs SET n = 0')
    const duplicateNumber = (): unknown => ctx.db.run("INSERT INTO pairs VALUES ('x', 'y', 0)")
    expect(errorCode(() => guardUnique(duplicateNumber, 'pairs.a, pairs.b', violation))).toBe(
      'raw:UNIQUE constraint failed: pairs.a, pairs.b, pairs.n'
    )
    expect(errorCode(() => guardUnique(() => { throw new Error('boom') }, 'pairs.a, pairs.b', violation))).toBe('raw:boom')
  })
})

describe('advanceTicketStatus', () => {
  it('moves a ticket forward, bumping its revision and recording the change', () => {
    const ctx = createTestCtx()
    const { epicId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    clearOutbox(ctx)
    advanceTicketStatus(ctx, { epicId, ticketId: tid(1) }, 'in_progress')
    expect(ticketStatus(ctx, tid(1))).toEqual({ status: 'in_progress', revision: 2 })
    expect(lastEventPayload(ctx, 'ticket.status_changed')).toEqual({ from: 'backlog', to: 'in_progress' })
    expect(pendingOutbox(ctx)).toEqual([`epic_state:${epicId}:`])
  })

  it('never moves a ticket backward or re-records an unchanged status', () => {
    const ctx = createTestCtx()
    const { epicId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    advanceTicketStatus(ctx, { epicId, ticketId: tid(1) }, 'completed')
    advanceTicketStatus(ctx, { epicId, ticketId: tid(1) }, 'in_progress')
    advanceTicketStatus(ctx, { epicId, ticketId: tid(1) }, 'completed')
    expect(ticketStatus(ctx, tid(1))).toEqual({ status: 'completed', revision: 2 })
    expect(eventKinds(ctx, 'ticket.')).toEqual(['ticket.status_changed'])
  })

  it('creates the status row when the ticket has none yet', () => {
    const ctx = createTestCtx()
    const { epicId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    advanceTicketStatus(ctx, { epicId, ticketId: tid(9) }, 'in_progress')
    expect(ticketStatus(ctx, tid(9))).toEqual({ status: 'in_progress', revision: 1 })
    expect(lastEventPayload(ctx, 'ticket.status_changed')).toEqual({ from: null, to: 'in_progress' })
  })
})
