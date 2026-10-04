import { describe, expect, it } from 'vitest'
import { tid } from '../../test/bundles'
import { claim, clearOutbox, hostCatalog, hostModel, lastEventPayload, openAttemptIds, startedRun, ticketStatus } from '../../test/execution'
import { createTestCtx } from '../../test/testContext'
import type { HostCatalog } from '../../shared/domain/views'
import { registerHost } from './hosts'

type TestCtx = ReturnType<typeof createTestCtx>

const ROUTINE_ONLY = 'Needs "multi_step" reasoning; the model\'s highest level is "routine".'

/** Binds a run catalog with a capable model ('big') and one that fails multi_step tickets ('text-only'). */
function withCatalog(ctx: TestCtx, overrides: Partial<HostCatalog> = {}): void {
  const models = [hostModel('big'), hostModel('text-only', { modalities: ['text'], reasoningLevels: ['routine'] })]
  const catalog = registerHost(ctx, hostCatalog(models, overrides))
  ctx.db.run('UPDATE runs SET host_catalog_id = ?', catalog.id)
}

describe('claimTicket — the orchestrator collects a ticket no named model can take', () => {
  it('claims the ticket for the orchestrator instead of refusing it', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    withCatalog(ctx)
    clearOutbox(ctx)
    const { attempt } = claim(ctx, runId, 1, { worker: { label: 'impl-1', modelId: 'text-only', rationale: 'cheap first' } })
    expect(attempt.state).toBe('claimed')
    expect(attempt.worker).toEqual({
      sessionId: ctx.session.id,
      label: 'Orchestrator (fallback)',
      modelId: null,
      hostId: 'host-a',
      catalogRevision: 'cat-1',
      rationale: `impl-1 on "text-only" could not take DM-1: ${ROUTINE_ONLY} The orchestrator collected it. Requested rationale: cheap first`,
      effort: null
    })
    expect(openAttemptIds(ctx, runId)).toEqual([attempt.id])
    expect(ticketStatus(ctx, tid(1))?.status).toBe('in_progress')
  })

  it('tells the orchestrator why in the execution packet and the claim event', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    withCatalog(ctx)
    const { packet } = claim(ctx, runId, 1, { worker: { label: 'impl-1', modelId: 'text-only' } })
    expect(packet.fallback).toEqual({ requestedModelId: 'text-only', reasons: [ROUTINE_ONLY] })
    expect(lastEventPayload(ctx, 'attempt.claimed')).toMatchObject({
      worker: 'Orchestrator (fallback)',
      modelId: null,
      fallback: { requestedModelId: 'text-only', reasons: [ROUTINE_ONLY] }
    })
  })

})

describe('claimTicket — what makes the orchestrator collect a ticket', () => {
  it('collects a ticket whose model is not in the catalog', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    withCatalog(ctx)
    const { packet } = claim(ctx, runId, 1, { worker: { label: 'w', modelId: 'ghost' } })
    expect(packet.fallback).toEqual({ requestedModelId: 'ghost', reasons: ['Model "ghost" is not in the host catalog.'] })
  })

  it('collects a ticket the host itself cannot serve', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    withCatalog(ctx, { tools: [] })
    const { attempt, packet } = claim(ctx, runId, 1, { worker: { label: 'w', modelId: 'big' } })
    expect(attempt.worker.label).toBe('Orchestrator (fallback)')
    expect(packet.fallback?.requestedModelId).toBe('big')
    expect(packet.fallback?.reasons.every((reason) => reason.startsWith('Host lacks required tool'))).toBe(true)
    expect(packet.fallback?.reasons.length).toBeGreaterThan(0)
  })

  it('keeps the named worker, with no fallback, when the model meets the requirements', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    withCatalog(ctx)
    const { attempt, packet } = claim(ctx, runId, 1, { worker: { label: 'w', modelId: 'big' } })
    expect(attempt.worker.label).toBe('w')
    expect(attempt.worker.modelId).toBe('big')
    expect(packet.fallback).toBeUndefined()
    expect(lastEventPayload(ctx, 'attempt.claimed')).not.toHaveProperty('fallback')
  })

  it('keeps a long requested rationale within the stored limit', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    withCatalog(ctx)
    const { attempt } = claim(ctx, runId, 1, { worker: { label: 'w', modelId: 'text-only', rationale: 'x'.repeat(2_000) } })
    expect(attempt.worker.rationale?.length).toBe(2_000)
    expect(attempt.worker.rationale?.startsWith('w on "text-only" could not take DM-1:')).toBe(true)
  })
})
