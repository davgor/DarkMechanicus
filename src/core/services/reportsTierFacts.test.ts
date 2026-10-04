import { describe, expect, it } from 'vitest'
import { defaultCapabilityProfile, type PlanBundle } from '../../shared/domain/bundle'
import { ORCHESTRATOR_FALLBACK_LABEL } from '../../shared/domain/status'
import type { HostCatalog, HostModel } from '../../shared/domain/views'
import { makeBundle, makeTicket, sid, tid } from '../../test/bundles'
import { seedAttempt, seedRun, type SeededRun } from '../../test/checkpointSeed'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { contentHash } from '../canonical'
import { registerHost } from './hosts'
import { getSprintReport, submitSprintReport } from './reports'

function model(id: string, costTier: HostModel['costTier'], reasoningLevels: string[]): HostModel {
  return { id, label: id, reasoningLevels, modalities: ['text'], contextWindowTokens: null, skills: [], costTier, latencyTier: null }
}

const CATALOG: HostCatalog = {
  hostId: 'host',
  hostType: 'cli',
  catalogRevision: '1',
  tools: [],
  canSelectWorkerModel: true,
  models: [model('small', 'low', ['routine']), model('mid', 'normal', ['routine', 'multi_step']), model('big', 'high', ['deep'])]
}

/** Sprint 1 = {DM-1 (medium, deep, high effort), DM-2}, sprint 2 = {DM-3}. */
function plan(): PlanBundle {
  const bundle = makeBundle([[1, 2], [3]])
  bundle.tickets = [
    makeTicket(1, { size: 'medium', capability: { ...defaultCapabilityProfile(), reasoning: { level: 'deep', rationale: '', effort: 'high' } } }),
    makeTicket(2),
    makeTicket(3, { size: 'small' })
  ]
  return bundle
}

function setup(withCatalog = true): { ctx: TestCtx; run: SeededRun } {
  const ctx = createTestCtx()
  const run = seedRun(ctx, { bundle: plan() })
  if (withCatalog) {
    const registered = registerHost(ctx, CATALOG)
    ctx.db.run('UPDATE runs SET host_catalog_id = ? WHERE id = ?', registered.id, run.runId)
  }
  return { ctx, run }
}

function report(ctx: TestCtx, run: SeededRun, sprint = 1) {
  return submitSprintReport(ctx, { runId: run.runId, sprintId: sid(sprint), report: { summary: 'Done' } })
}

describe('the report view: computed tier facts of the sprint tickets', () => {
  it('lists the sprint tickets with their size, planned level and effort, and no attempts yet', () => {
    const { ctx, run } = setup()
    expect(report(ctx, run).tierFacts).toEqual([
      { ticketId: tid(1), key: 'DM-1', size: 'medium', plannedLevel: 'deep', plannedEffort: 'high', attempts: [], attemptCount: 0, rejectionCount: 0, escalated: false },
      { ticketId: tid(2), key: 'DM-2', size: null, plannedLevel: 'multi_step', plannedEffort: null, attempts: [], attemptCount: 0, rejectionCount: 0, escalated: false }
    ])
  })

  it("adds each attempt's model and effort, the attempt and rejection counts, and whether the ticket escalated", () => {
    const { ctx, run } = setup()
    seedAttempt(ctx, run, { ticket: 1, state: 'rejected', worker: { label: 'Claude Code', modelId: 'small', effort: 'low' } })
    seedAttempt(ctx, run, { ticket: 1, state: 'accepted', worker: { label: 'Claude Code', modelId: 'big', effort: 'high' } })
    seedAttempt(ctx, run, { ticket: 2, state: 'accepted', worker: { label: 'Claude Code', modelId: 'mid', effort: 'medium' } })
    const [first, second] = report(ctx, run).tierFacts
    expect(first).toMatchObject({ key: 'DM-1', attemptCount: 2, rejectionCount: 1, escalated: true })
    expect(first?.attempts.map((item) => [item.number, item.state, item.modelId, item.effort])).toEqual([
      [1, 'rejected', 'small', 'low'],
      [2, 'accepted', 'big', 'high']
    ])
    expect(second).toMatchObject({ key: 'DM-2', attemptCount: 1, rejectionCount: 0, escalated: false })
  })

})

describe('the report view: tier facts from the attempts and the catalog', () => {
  it('ranks models with the catalog of the run, and has no tiers when no catalog was registered', () => {
    const attempts = (run: SeededRun, ctx: TestCtx): void => {
      seedAttempt(ctx, run, { ticket: 1, state: 'rejected', worker: { modelId: 'small' } })
      seedAttempt(ctx, run, { ticket: 1, state: 'accepted', worker: { modelId: 'big' } })
    }
    const ranked = setup(true)
    attempts(ranked.run, ranked.ctx)
    expect(report(ranked.ctx, ranked.run).tierFacts[0]?.escalated).toBe(true)
    const unranked = setup(false)
    attempts(unranked.run, unranked.ctx)
    expect(report(unranked.ctx, unranked.run).tierFacts[0]?.escalated).toBe(false)
  })

  it('shows an orchestrator fallback attempt as one that was not ranked', () => {
    const { ctx, run } = setup()
    seedAttempt(ctx, run, { ticket: 1, state: 'rejected', worker: { modelId: 'small', effort: 'low' } })
    seedAttempt(ctx, run, { ticket: 1, state: 'accepted', worker: { label: ORCHESTRATOR_FALLBACK_LABEL, modelId: null, effort: null } })
    const facts = report(ctx, run).tierFacts[0]
    expect(facts?.attempts[1]).toMatchObject({ modelId: null, effort: null, label: ORCHESTRATOR_FALLBACK_LABEL, fallback: true })
    expect([facts?.attemptCount, facts?.escalated]).toEqual([2, false])
  })

  it('reads a worker recorded before efforts as having no effort', () => {
    const { ctx, run } = setup()
    seedAttempt(ctx, run, { ticket: 1, state: 'accepted', worker: { modelId: 'mid' } })
    expect(report(ctx, run).tierFacts[0]?.attempts[0]?.effort).toBeNull()
  })

  it('is read from the attempts when the report is read, not stored with it, so later attempts show and the hash holds', () => {
    const { ctx, run } = setup()
    const view = report(ctx, run)
    seedAttempt(ctx, run, { ticket: 1, state: 'accepted', worker: { modelId: 'mid', effort: 'medium' } })
    const later = getSprintReport(ctx, { runId: run.runId })
    expect(later?.tierFacts[0]?.attemptCount).toBe(1)
    expect(later?.contentHash).toBe(view.contentHash)
    expect(view.contentHash).toBe(contentHash(view.report))
    expect(Object.keys(view.report)).not.toContain('tierFacts')
    expect(ctx.db.get<{ content_json: string }>('SELECT content_json FROM sprint_reports')?.content_json).not.toContain('tierFacts')
  })

  it('covers the tickets of the sprint the report belongs to', () => {
    const ctx = createTestCtx()
    const run = seedRun(ctx, { bundle: plan(), activeSprint: 2 })
    expect(report(ctx, run, 2).tierFacts.map((item) => [item.key, item.size])).toEqual([['DM-3', 'small']])
  })
})
