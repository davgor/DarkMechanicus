/**
 * DM-171 c1: who may report usage. Each role gets its own Workspace session over one database, so the capability
 * table and the services' claim checks are exercised as an agent session meets them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { metricsWorld, type MetricsWorld, usage } from '../../test/metricsWorld'
import { createHarness, type Harness } from '../../test/workspaceHarness'

let harness: Harness
let w: MetricsWorld
let alpha: { id: string; token: string }
let beta: { id: string; token: string }

beforeEach(async () => {
  harness = createHarness()
  w = await metricsWorld(harness, { alpha: { title: 'Alpha' }, beta: { title: 'Beta' } }, ['alpha', 'beta'])
  alpha = w.attempt.alpha ?? { id: '', token: '' }
  beta = w.attempt.beta ?? { id: '', token: '' }
})

afterEach(() => {
  harness.cleanup()
})

const rating = {
  metric: 'human_rating',
  unit: 'rating_1_5',
  measurement: { state: 'observed', value: 5 },
  accumulation: 'event',
  eventId: 'rate-1'
}

describe('DM-171 c1: allowed scoped reporting succeeds', () => {
  it('a worker records usage of its own claimed attempt, scoped by the server to that attempt, run, ticket and sprint', async () => {
    const plan = await w.orchestrator.getPlan({
      epicId: w.epicId,
      view: 'saved'
    })
    const result = await harness.open('worker').recordAttemptMetrics({
      attemptId: alpha.id,
      claimToken: alpha.token,
      reports: [usage()]
    })
    expect(result.created).toHaveLength(1)
    expect(result.observations[0]?.scope).toEqual({
      level: 'attempt',
      epicId: w.epicId,
      sprintId: plan.bundle.sprints[0]?.id,
      runId: w.runId,
      ticketId: w.ticket.alpha,
      attemptId: alpha.id
    })
  })

  it('the orchestrator records orchestration overhead in the run bucket, labeled and charged to no attempt', async () => {
    const result = await w.orchestrator.recordRunMetrics({
      runId: w.runId,
      overhead: 'orchestration',
      reports: [
        usage({
          source: { kind: 'agent', actor: 'orchestrator-session' },
          eventId: 'orch-1',
          measurement: { state: 'observed', value: 4_000 }
        })
      ]
    })
    const stored = result.observations[0]
    expect([stored?.scope.level, stored?.scope.attemptId, stored?.scope.ticketId, stored?.attributes.overhead]).toEqual(['run', null, null, 'orchestration'])
  })
})

describe('DM-171 c1: allowed run overhead and relayed usage succeed', () => {
  it('the reviewer records review overhead in the run bucket', async () => {
    const result = await harness.open('reviewer').recordRunMetrics({
      runId: w.runId,
      overhead: 'review',
      reports: [
        usage({
          source: { kind: 'agent', actor: 'reviewer-session' },
          eventId: 'review-1',
          metric: 'active_ms',
          unit: 'milliseconds',
          measurement: { state: 'observed', value: 90_000 }
        })
      ]
    })
    expect([result.created.length, result.observations[0]?.attributes.overhead, result.observations[0]?.scope.level]).toEqual([1, 'review', 'run'])
  })

  it('the orchestrator relays host usage for an attempt of its run without a claim token', async () => {
    const result = await w.orchestrator.recordAttemptMetrics({
      attemptId: beta.id,
      reports: [usage({ eventId: 'b-1' })]
    })
    expect([result.created.length, result.observations[0]?.scope.attemptId]).toEqual([1, beta.id])
  })
})

describe('DM-171 c1: cross-attempt writes and missing proof are refused', () => {
  it('a worker using its claim token on another attempt is refused as stale_claim', async () => {
    await expect(
      harness.open('worker').recordAttemptMetrics({
        attemptId: beta.id,
        claimToken: alpha.token,
        reports: [usage()]
      })
    ).rejects.toMatchObject({ code: 'stale_claim' })
  })

  it('a worker without a claim token is refused as unauthorized, even for its own attempt', async () => {
    await expect(harness.open('worker').recordAttemptMetrics({ attemptId: alpha.id, reports: [usage()] })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('a worker writing to the run overhead bucket is refused as unauthorized', async () => {
    await expect(
      harness.open('worker').recordRunMetrics({
        runId: w.runId,
        overhead: 'review',
        reports: [usage()]
      })
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })
})

describe('DM-171 c1: roles without a reporting capability are refused', () => {
  it('a reviewer cannot report attempt usage and a reader cannot report at all', async () => {
    await expect(
      harness.open('reviewer').recordAttemptMetrics({
        attemptId: alpha.id,
        claimToken: alpha.token,
        reports: [usage()]
      })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(
      harness.open('reader').recordAttemptMetrics({
        attemptId: alpha.id,
        claimToken: alpha.token,
        reports: [usage()]
      })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(
      harness.open('reader').recordRunMetrics({
        runId: w.runId,
        overhead: 'review',
        reports: [usage()]
      })
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('the desktop has no agent usage command', async () => {
    await expect(
      harness.open('desktop').recordAttemptMetrics({
        attemptId: alpha.id,
        reports: [usage({ eventId: 'desk-1' })]
      })
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('nothing is stored by a refused report', async () => {
    await expect(
      harness.open('worker').recordAttemptMetrics({
        attemptId: beta.id,
        claimToken: alpha.token,
        reports: [usage()]
      })
    ).rejects.toMatchObject({ code: 'stale_claim' })
    expect((await w.orchestrator.getRunMetrics({ runId: w.runId })).observationCount).toBe(0)
  })
})

describe('DM-171 c1: agent-authored human feedback and server measures are refused', () => {
  it('a worker reporting a satisfaction rating as an agent is refused as unauthorized', async () => {
    const report = usage({
      ...rating,
      source: { kind: 'agent', actor: 'worker' }
    })
    await expect(
      harness.open('worker').recordAttemptMetrics({
        attemptId: alpha.id,
        claimToken: alpha.token,
        reports: [report]
      })
    ).rejects.toMatchObject({
      code: 'unauthorized',
      details: { index: 0, metric: 'human_rating' }
    })
  })

  it('a worker impersonating a human source is refused as unauthorized', async () => {
    const report = usage({
      ...rating,
      source: { kind: 'human', actor: 'owner' }
    })
    await expect(
      harness.open('worker').recordAttemptMetrics({
        attemptId: alpha.id,
        claimToken: alpha.token,
        reports: [report]
      })
    ).rejects.toMatchObject({
      code: 'unauthorized',
      details: { index: 0, sourceKind: 'human' }
    })
  })
})

describe('DM-171 c1: metrics only a person or the server records are refused', () => {
  it('a token metric stated as a human or server source is refused as unauthorized', async () => {
    await expect(
      w.orchestrator.recordAttemptMetrics({
        attemptId: alpha.id,
        reports: [usage({ source: { kind: 'server', actor: 'dm' } })]
      })
    ).rejects.toMatchObject({
      code: 'unauthorized',
      details: { sourceKind: 'server' }
    })
  })

  it('an orchestrator reporting rescue minutes is refused as unauthorized', async () => {
    const report = usage({
      metric: 'rescue_minutes',
      unit: 'minutes',
      accumulation: 'event',
      eventId: 'rescue-1',
      source: { kind: 'agent', actor: 'orch' }
    })
    await expect(
      w.orchestrator.recordRunMetrics({
        runId: w.runId,
        overhead: 'review',
        reports: [report]
      })
    ).rejects.toMatchObject({
      code: 'unauthorized',
      details: { metric: 'rescue_minutes' }
    })
  })
})

describe('DM-171 c1: server-derived pass/fail measures are refused', () => {
  it('agents claiming a server verification or handoff result are refused as unauthorized', async () => {
    const verification = usage({
      metric: 'verification',
      unit: 'pass_fail',
      accumulation: 'event',
      eventId: 'v-1',
      measurement: { state: 'observed', value: 1 }
    })
    const handoff = usage({
      metric: 'handoff_check',
      unit: 'pass_fail',
      accumulation: 'event',
      eventId: 'h-1',
      measurement: { state: 'observed', value: 1 }
    })
    await expect(
      harness.open('worker').recordAttemptMetrics({
        attemptId: alpha.id,
        claimToken: alpha.token,
        reports: [verification]
      })
    ).rejects.toMatchObject({
      code: 'unauthorized',
      details: { metric: 'verification' }
    })
    await expect(
      harness.open('reviewer').recordRunMetrics({
        runId: w.runId,
        overhead: 'review',
        reports: [handoff]
      })
    ).rejects.toMatchObject({
      code: 'unauthorized',
      details: { metric: 'handoff_check' }
    })
  })
})

describe('DM-171 c1: stale and expired claims are fenced', () => {
  it('a worker whose lease expired is refused as expired_claim, while the orchestrator may still attribute usage', async () => {
    harness.clock.advanceSeconds(3 * 3600)
    await expect(
      harness.open('worker').recordAttemptMetrics({
        attemptId: alpha.id,
        claimToken: alpha.token,
        reports: [usage({ eventId: 'late-1' })]
      })
    ).rejects.toMatchObject({
      code: 'expired_claim'
    })
    const relayed = await w.orchestrator.recordAttemptMetrics({
      attemptId: alpha.id,
      reports: [usage({ eventId: 'late-relay' })]
    })
    expect(relayed.created).toHaveLength(1)
  })

  it('the first attempt’s token after a retry claimed the ticket is stale_claim; the retry’s own token reports', async () => {
    harness.clock.advanceSeconds(3 * 3600)
    await w.orchestrator.reconcileAttempt({
      attemptId: alpha.id,
      resolution: 'abandon'
    })
    const retry = await w.orchestrator.claimTicket({
      runId: w.runId,
      ticketId: w.ticket.alpha ?? '',
      worker: { label: 'worker-alpha-2' }
    })
    const worker = harness.open('worker')
    await expect(
      worker.recordAttemptMetrics({
        attemptId: alpha.id,
        claimToken: alpha.token,
        reports: [usage({ eventId: 'late-2' })]
      })
    ).rejects.toMatchObject({ code: 'stale_claim' })
    const own = await worker.recordAttemptMetrics({
      attemptId: retry.attempt.id,
      claimToken: retry.packet.claimToken ?? '',
      reports: [usage({ eventId: 'r-1' })]
    })
    expect(own.observations[0]?.scope.attemptId).toBe(retry.attempt.id)
  })
})

describe('DM-171 c1: a submitted attempt’s claim is stale', () => {
  it('a worker reporting after it submitted is refused as stale_claim', async () => {
    await w.orchestrator.submitAttempt({
      attemptId: alpha.id,
      claimToken: alpha.token,
      outputs: { summary: 'done' }
    })
    await expect(
      harness.open('worker').recordAttemptMetrics({
        attemptId: alpha.id,
        claimToken: alpha.token,
        reports: [usage({ eventId: 'r-2' })]
      })
    ).rejects.toMatchObject({
      code: 'stale_claim'
    })
  })
})
