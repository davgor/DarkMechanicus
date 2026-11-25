/** Claim and heartbeat edges: unscheduled tickets, a missing run catalog, unavailable repository entries and lease lengths. */
import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import { makeBundle, makeTicket } from '../../test/bundles'
import { claim, domainError, startedRun } from '../../test/execution'
import { createStubGit } from '../../test/repoEnv'
import { createTestCtx, withRole } from '../../test/testContext'
import { heartbeatAttempt, normalizeEvidence } from './attempts'

describe('claimTicket — a ticket the pinned plan does not schedule', () => {
  it('refuses the claim as not_found, naming the ticket', () => {
    const ctx = createTestCtx()
    const bundle = makeBundle([[1]])
    bundle.tickets.push(makeTicket(2))
    const { runId } = startedRun(ctx, { bundle })
    const error = domainError(() => claim(ctx, runId, 2))
    expect([error.code, error.message]).toEqual(['not_found', 'DM-2 is not scheduled in any sprint of the pinned plan.'])
  })
})

describe('claimTicket — a run whose host catalog is no longer stored', () => {
  it('keeps the named worker and model, with no host or catalog revision and no fallback', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    ctx.db.run('UPDATE runs SET host_catalog_id = ? WHERE id = ?', 'hc_00000000000000000000000099', runId)
    const { attempt, packet } = claim(ctx, runId, 1, { worker: { label: 'impl-1', modelId: 'big' } })
    expect(attempt.worker).toMatchObject({ label: 'impl-1', modelId: 'big', hostId: null, catalogRevision: null })
    expect(packet.fallback).toBeUndefined()
  })
})

describe('the acceptance packet in a folder whose repository entries cannot be read', () => {
  it('lists no repository when the sprint touched none, and adds no Definition of Done instruction', () => {
    const git = { ...createStubGit(), head: () => ({ branch: 'main', commit: '2'.repeat(40), detached: false }), branchCommit: () => null }
    const ctx = createTestCtx({ projectRoot: '/folder', repositories: ['api'], gitFor: () => git })
    const unread = { ...ctx, repositoryEntries: () => null }
    const base = makeBundle([[1, 2]])
    const bundle: PlanBundle = {
      ...base,
      tickets: base.tickets.map((ticket, index) =>
        index === 0 ? { ...ticket, repo: 'api', optional: true } : { ...ticket, kind: 'acceptance' as const }
      )
    }
    const { runId } = startedRun(ctx, { bundle, branch: { repository: null, name: 'epic/multi', startCommit: null } })
    const node = claim(unread, runId, 2).packet
    expect(node.repositories).toEqual([])
    expect(Object.keys(node)).not.toContain('definitionOfDone')
    expect(node.reporting.instructions).not.toContain('definition_of_done')
  })
})

describe('heartbeatAttempt — the lease length a heartbeat keeps', () => {
  it('falls back to the plan default when the stored claim holds no lease end', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1, { leaseSeconds: 60 })
    ctx.db.run('UPDATE attempts SET lease_expires_at = NULL WHERE id = ?', claimed.attempt.id)
    ctx.clock.advanceSeconds(10)
    const beat = heartbeatAttempt(withRole(ctx, 'worker'), { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken })
    expect(beat).toMatchObject({ state: 'running', leaseExpiresAt: '2026-01-01T00:15:10.000Z' })
  })

  it('keeps the claimed length, but uses the plan default once time given back leaves no positive length', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const worker = withRole(ctx, 'worker')
    const kept = claim(ctx, runId, 1, { leaseSeconds: 60 })
    const credited = claim(ctx, runId, 2, { leaseSeconds: 60 })
    ctx.db.run(
      "INSERT INTO legacy_tooling_lease_credits (attempt_id, kind, at, granted_at, ms) VALUES (?, 'run', ?, ?, ?)",
      credited.attempt.id,
      credited.attempt.createdAt,
      credited.attempt.createdAt,
      120_000
    )
    ctx.clock.advanceSeconds(10)
    const beat = (claimed: typeof kept) => heartbeatAttempt(worker, { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken }).leaseExpiresAt
    expect([beat(kept), beat(credited)]).toEqual(['2026-01-01T00:01:10.000Z', '2026-01-01T00:15:10.000Z'])
  })
})

describe('normalizeEvidence', () => {
  it('reads absent evidence as no checks, no criteria and no notes', () => {
    expect(normalizeEvidence(undefined)).toEqual({ checks: [], criteria: [], notes: '' })
    expect(normalizeEvidence({ notes: 'Ran it' })).toEqual({ checks: [], criteria: [], notes: 'Ran it' })
  })
})
