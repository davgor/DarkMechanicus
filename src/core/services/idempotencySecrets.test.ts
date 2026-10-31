/**
 * Secrets never reach the idempotency table. Each test runs a command that returns or receives a
 * secret, with an idempotency key wherever the command takes one, then searches every text column
 * of every table for the secret. Tokens here have the real shape (a random 32-character secret), so
 * text masking is exercised as it is in the app.
 */
import { describe, expect, it } from 'vitest'
import { claim, claimOrReplay, errorCode, startedRun } from '../../test/execution'
import { createSequentialIds, createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { createIdGenerator } from '../ids'
import { acceptAttempt, failAttempt, heartbeatAttempt, reconcileAttempt, rejectAttempt, submitAttempt } from './attempts'
import { issueGrant } from './grants'

function realTokenCtx(): TestCtx {
  return createTestCtx({ ids: { ...createSequentialIds(), secret: createIdGenerator().secret } })
}

/** Every `table.column` whose text holds `needle`, across the whole database. */
function columnsHolding(ctx: TestCtx, needle: string): string[] {
  const tables = ctx.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  return tables.flatMap(({ name: table }) =>
    ctx.db
      .all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
      .filter(({ name: column }) => ctx.db.get(`SELECT 1 FROM "${table}" WHERE instr(CAST("${column}" AS TEXT), ?) > 0`, needle))
      .map(({ name: column }) => `${table}.${column}`)
  )
}

/** Every `table.column` holding the token, its secret, or any 8 characters in a row of the secret. */
function columnsLeaking(ctx: TestCtx, token: string): string[] {
  const secret = token.slice(token.indexOf('.') + 1)
  const pieces = [token, ...Array.from({ length: secret.length - 7 }, (_, start) => secret.slice(start, start + 8))]
  return [...new Set(pieces.flatMap((piece) => columnsHolding(ctx, piece)))].sort()
}

function idempotencyRows(ctx: TestCtx): number {
  return ctx.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM idempotency')?.count ?? 0
}

describe('the claim token in the database', () => {
  it('lives only in the attempt that verifies it after a keyed claim and its replay', () => {
    const ctx = realTokenCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1, { idempotencyKey: 'claim-1' })
    const token = claimed.packet.claimToken
    expect(token).toMatch(/^at_[0-9a-z]{26}\.[A-Za-z0-9_-]{32}$/)
    claimOrReplay(ctx, runId, 1, { idempotencyKey: 'claim-1' })
    expect(idempotencyRows(ctx)).toBe(1)
    expect(columnsLeaking(ctx, token)).toEqual(['attempts.claim_secret'])
  })

  it('is kept out of the idempotency table when pasted into what the reporting and review commands return', () => {
    const ctx = realTokenCtx()
    const { runId } = startedRun(ctx)
    const worker = withRole(ctx, 'worker')
    const tokens = [1, 2].map((ticket) => {
      const claimed = claim(ctx, runId, ticket)
      const { claimToken } = claimed.packet
      const pasted = `token was ${claimToken}`
      heartbeatAttempt(worker, { attemptId: claimed.attempt.id, claimToken, progress: { note: pasted } })
      return { attemptId: claimed.attempt.id, claimToken, pasted }
    })
    const [first, second] = tokens
    if (first === undefined || second === undefined) {
      throw new Error('two claims expected')
    }
    submitAttempt(worker, { ...first, outputs: { summary: first.pasted }, idempotencyKey: 'submit-1' })
    acceptAttempt(ctx, { attemptId: first.attemptId, notes: first.pasted, idempotencyKey: 'accept-1' })
    failAttempt(worker, { ...second, failure: { reason: second.pasted, details: second.pasted }, idempotencyKey: 'fail-1' })
    expect(idempotencyRows(ctx)).toBe(3)
    for (const { claimToken } of tokens) {
      expect(columnsLeaking(ctx, claimToken).filter((column) => column.startsWith('idempotency.'))).toEqual([])
    }
  })

  it('is kept out of the idempotency table when pasted into a rejection', () => {
    const ctx = realTokenCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1)
    const { claimToken } = claimed.packet
    submitAttempt(withRole(ctx, 'worker'), { attemptId: claimed.attempt.id, claimToken, outputs: { summary: 'done' } })
    rejectAttempt(ctx, { attemptId: claimed.attempt.id, reasons: [`leaked ${claimToken}`], idempotencyKey: 'reject-1' })
    expect(idempotencyRows(ctx)).toBe(1)
    expect(columnsLeaking(ctx, claimToken).filter((column) => column.startsWith('idempotency.'))).toEqual([])
  })
})

describe('a grant token in the database', () => {
  it('is stored nowhere, so not in the idempotency table either', () => {
    const desktop = withRole(realTokenCtx(), 'desktop')
    const { token } = issueGrant(desktop, { role: 'orchestrator', label: 'CLI' })
    expect(columnsHolding(desktop, token)).toEqual([])
    expect(columnsHolding(desktop, token.slice(4, 36))).toEqual([])
  })
})

describe('replaying a keyed claim', () => {
  it('returns the original attempt and packet with no token, and leaves the original token working', () => {
    const ctx = realTokenCtx()
    const { runId } = startedRun(ctx)
    const first = claim(ctx, runId, 1, { idempotencyKey: 'claim-1' })
    ctx.clock.advanceSeconds(5)
    const replay = claimOrReplay(ctx, runId, 1, { idempotencyKey: 'claim-1' })
    expect(replay).toEqual({ ...first, packet: { ...first.packet, claimToken: null } })
    const worker = withRole(ctx, 'worker')
    expect(heartbeatAttempt(worker, { attemptId: first.attempt.id, claimToken: first.packet.claimToken }).state).toBe('running')
  })

  it('lets a lost claim expire and be reconciled before the ticket can be claimed again', () => {
    const ctx = realTokenCtx()
    const { runId } = startedRun(ctx)
    const lost = claim(ctx, runId, 1, { idempotencyKey: 'claim-1', leaseSeconds: 60 })
    const replay = claimOrReplay(ctx, runId, 1, { idempotencyKey: 'claim-1', leaseSeconds: 60 })
    expect([replay.packet.claimToken, replay.packet.leaseExpiresAt]).toEqual([null, lost.packet.leaseExpiresAt])
    expect(errorCode(() => claim(ctx, runId, 1))).toBe('already_claimed')
    ctx.clock.advanceSeconds(61)
    reconcileAttempt(ctx, { attemptId: lost.attempt.id, resolution: 'abandon' })
    const fresh = claim(ctx, runId, 1, { idempotencyKey: 'claim-2', leaseSeconds: 60 })
    expect([fresh.attempt.number, fresh.packet.fencingToken]).toEqual([2, 2])
    expect(fresh.packet.claimToken).not.toBe(lost.packet.claimToken)
    const worker = withRole(ctx, 'worker')
    expect(errorCode(() => heartbeatAttempt(worker, { attemptId: lost.attempt.id, claimToken: lost.packet.claimToken }))).toBe('stale_claim')
  })

  it('lets the orchestrator fail a lost claim at once without its token, and claim the ticket again with a new key', () => {
    const ctx = realTokenCtx()
    const { runId } = startedRun(ctx)
    const lost = claim(ctx, runId, 1, { idempotencyKey: 'claim-1' })
    const replay = claimOrReplay(ctx, runId, 1, { idempotencyKey: 'claim-1' })
    const worker = withRole(ctx, 'worker')
    const failure = { reason: 'claim response lost', retryable: true }
    expect(errorCode(() => failAttempt(worker, { attemptId: replay.attempt.id, failure }))).toBe('unauthorized')
    expect(failAttempt(ctx, { attemptId: replay.attempt.id, failure }).state).toBe('failed')
    const stale = claimOrReplay(ctx, runId, 1, { idempotencyKey: 'claim-1' })
    expect([stale.attempt.id, stale.packet.claimToken]).toEqual([lost.attempt.id, null])
    expect(errorCode(() => failAttempt(ctx, { attemptId: stale.attempt.id, failure }))).toBe('unauthorized_transition')
    const fresh = claim(ctx, runId, 1, { idempotencyKey: 'claim-2' })
    expect([fresh.attempt.number, fresh.packet.fencingToken]).toEqual([2, 2])
    expect(errorCode(() => heartbeatAttempt(worker, { attemptId: lost.attempt.id, claimToken: lost.packet.claimToken }))).toBe('stale_claim')
  })
})
