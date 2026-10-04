/** Submitting an acceptance node: the verdict the command layer verified is stored with the submission. */
import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import { makeBundle, tid } from '../../test/bundles'
import { incrementVerdict } from '../../test/checkpointSeed'
import { attemptRow, claim, domainError, lastEventPayload, startedRun } from '../../test/execution'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { acceptAttempt, reconcileAttempt, rejectAttempt, submitAttempt } from './attempts'
import { attemptView } from './execution'

const NAMED = { branch: 'epic/x', commit: 'c'.repeat(40) }

/** Sprint = {DM-1, DM-2}; DM-2 is the acceptance node, which requires DM-1. */
function plan(): PlanBundle {
  const bundle = makeBundle([[1, 2]])
  bundle.tickets = bundle.tickets.map((ticket) => (ticket.id === tid(2) ? { ...ticket, kind: 'acceptance' as const } : ticket))
  return bundle
}

/** A run whose work ticket is accepted, with the acceptance node claimed. */
function nodeClaim(ctx: TestCtx) {
  const { runId } = startedRun(ctx, { bundle: plan() })
  const work = claim(ctx, runId, 1)
  submitAttempt(ctx, { attemptId: work.attempt.id, claimToken: work.packet.claimToken, outputs: { summary: 'done' } })
  acceptAttempt(ctx, { attemptId: work.attempt.id })
  return { runId, node: claim(ctx, runId, 2), work }
}

describe('submitAttempt on an acceptance node that names an increment', () => {
  it('stores the verified verdict with the submission and shows it on the attempt', () => {
    const ctx = createTestCtx()
    const { node } = nodeClaim(ctx)
    const verdict = incrementVerdict()
    const view = submitAttempt(
      ctx,
      { attemptId: node.attempt.id, claimToken: node.packet.claimToken, outputs: { summary: 'Merged.' }, increment: NAMED },
      verdict
    )
    expect(view.state).toBe('submitted')
    expect(view.increment).toEqual(verdict)
    expect(attemptView(attemptRow(ctx, node.attempt.id)).increment).toEqual(verdict)
    expect(JSON.parse(attemptRow(ctx, node.attempt.id).increment_json ?? 'null')).toEqual(verdict)
  })

  it('records the commit and the verdict in the submitted event', () => {
    const ctx = createTestCtx()
    const { node } = nodeClaim(ctx)
    submitAttempt(
      ctx,
      { attemptId: node.attempt.id, claimToken: node.packet.claimToken, outputs: { summary: 'Merged.' }, increment: NAMED },
      incrementVerdict({ passed: false, reasons: ['not squashed'] })
    )
    expect(lastEventPayload(ctx, 'attempt.submitted')).toMatchObject({
      attemptId: node.attempt.id,
      increment: { commit: 'c'.repeat(40), passed: false }
    })
  })

  it('stores a failed verdict instead of rejecting the submission, so the gate stays unmet and the node can be retried', () => {
    const ctx = createTestCtx()
    const { node, runId } = nodeClaim(ctx)
    const failed = incrementVerdict({ passed: false, reasons: ['Commit ccccccc has 2 parents (a merge commit).'] })
    const view = submitAttempt(
      ctx,
      { attemptId: node.attempt.id, claimToken: node.packet.claimToken, outputs: { summary: 'Merged.' }, increment: NAMED },
      failed
    )
    expect(view).toMatchObject({ state: 'submitted', increment: { passed: false, reasons: failed.reasons } })
    expect(attemptRow(ctx, node.attempt.id).state).toBe('submitted')
    rejectAttempt(ctx, { attemptId: node.attempt.id, reasons: failed.reasons })
    expect(claim(ctx, runId, 2).attempt).toMatchObject({ number: 2, state: 'claimed' })
  })
})

describe('submitAttempt without an increment, or with one it must refuse', () => {
  it('leaves the verdict empty when the node names none, and for every work ticket', () => {
    const ctx = createTestCtx()
    const { node, work } = nodeClaim(ctx)
    expect(attemptRow(ctx, work.attempt.id).increment_json).toBeNull()
    const view = submitAttempt(ctx, { attemptId: node.attempt.id, claimToken: node.packet.claimToken, outputs: { summary: 'Done.' } })
    expect(Object.keys(view)).not.toContain('increment')
    expect(attemptRow(ctx, node.attempt.id).increment_json).toBeNull()
  })

  it('refuses a work ticket that names an increment, leaving its claim open', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: plan() })
    const work = claim(ctx, runId, 1)
    const input = { attemptId: work.attempt.id, claimToken: work.packet.claimToken, outputs: { summary: 'done' }, increment: NAMED }
    const error = domainError(() => submitAttempt(ctx, input, incrementVerdict()))
    expect(error.code).toBe('invalid_input')
    expect(error.message).toContain('DM-1')
    expect(attemptRow(ctx, work.attempt.id).state).toBe('claimed')
    expect(attemptRow(ctx, work.attempt.id).increment_json).toBeNull()
  })

  it('refuses to store an increment nobody verified', () => {
    const ctx = createTestCtx()
    const { node } = nodeClaim(ctx)
    const input = { attemptId: node.attempt.id, claimToken: node.packet.claimToken, outputs: { summary: 'Merged.' }, increment: NAMED }
    expect(domainError(() => submitAttempt(ctx, input)).code).toBe('internal')
    expect(attemptRow(ctx, node.attempt.id).state).toBe('claimed')
  })

  it('checks the claim token before anything about the increment', () => {
    const ctx = createTestCtx()
    const { node } = nodeClaim(ctx)
    const input = { attemptId: node.attempt.id, claimToken: `${node.attempt.id}.wrong`, outputs: { summary: 'Merged.' }, increment: NAMED }
    expect(domainError(() => submitAttempt(ctx, input, incrementVerdict())).code).toBe('stale_claim')
    expect(attemptRow(ctx, node.attempt.id).increment_json).toBeNull()
  })
})

describe('submitAttempt with an idempotency key', () => {
  it('returns the stored submission for a repeat, and refuses the key for a different increment', () => {
    const ctx = createTestCtx()
    const { node } = nodeClaim(ctx)
    const input = {
      attemptId: node.attempt.id,
      claimToken: node.packet.claimToken,
      outputs: { summary: 'Merged.' },
      increment: NAMED,
      idempotencyKey: 'submit-node-1'
    }
    const first = submitAttempt(ctx, input, incrementVerdict())
    expect(submitAttempt(ctx, input, incrementVerdict({ passed: false, reasons: ['changed'] }))).toEqual(first)
    const other = { ...input, increment: { ...NAMED, commit: 'd'.repeat(40) } }
    expect(domainError(() => submitAttempt(ctx, other, incrementVerdict())).code).toBe('idempotency_mismatch')
  })
})

describe('reconcileAttempt resubmitting an acceptance node', () => {
  it('stores no increment, so the gate stays unmet until a submission names one', () => {
    const ctx = createTestCtx()
    const { node } = nodeClaim(ctx)
    ctx.clock.advanceSeconds(3600)
    const view = reconcileAttempt(ctx, {
      attemptId: node.attempt.id,
      resolution: 'resubmit',
      outputs: { summary: 'Finished after the lease ran out.' }
    })
    expect(view.state).toBe('submitted')
    expect(Object.keys(view)).not.toContain('increment')
  })
})
