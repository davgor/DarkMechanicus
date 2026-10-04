import { describe, expect, it } from 'vitest'
import { defaultCapabilityProfile, type ReasoningEffort, type ReasoningLevel } from '../../shared/domain/bundle'
import { ORCHESTRATOR_FALLBACK_LABEL, type AttemptState } from '../../shared/domain/status'
import type { HostCatalog, HostModel } from '../../shared/domain/views'
import { makeBundle, makeTicket, sid, tid } from '../../test/bundles'
import { computeTierFacts, type TierFactsAttempt } from './tierFacts'

function model(id: string, costTier: HostModel['costTier'], reasoningLevels: ReasoningLevel[]): HostModel {
  return { id, label: id, reasoningLevels, modalities: ['text'], contextWindowTokens: null, skills: [], costTier, latencyTier: null }
}

/** small < mid < mid-deep (same cost tier, deeper reasoning) < big, by cost tier and then reasoning depth. */
const CATALOG: HostCatalog = {
  hostId: 'host',
  hostType: 'cli',
  catalogRevision: '1',
  tools: [],
  canSelectWorkerModel: true,
  models: [
    model('small', 'low', ['routine']),
    model('mid', 'normal', ['routine', 'multi_step']),
    model('mid-deep', 'normal', ['routine', 'multi_step', 'deep']),
    model('big', 'high', ['deep'])
  ]
}

interface WorkerSpec {
  modelId?: string | null
  effort?: ReasoningEffort | null
  label?: string
}

function attempt(ticket: number, number: number, state: AttemptState, worker: WorkerSpec = {}): TierFactsAttempt {
  return {
    id: `at_${ticket}_${number}`,
    ticketId: tid(ticket),
    number,
    kind: 'work',
    state,
    worker: { label: worker.label ?? 'worker', modelId: worker.modelId ?? null, effort: worker.effort ?? null }
  }
}

/** The attempt recorded for a ticket completed earlier, which no worker ran. */
function carriedForward(ticket: number, number: number): TierFactsAttempt {
  return { ...attempt(ticket, number, 'accepted'), kind: 'carry_forward' }
}

const BUNDLE = makeBundle([[1, 2, 3], [4]])

function factsOf(attempts: TierFactsAttempt[], catalog: HostCatalog | null = CATALOG, sprint = 1) {
  return computeTierFacts({ bundle: BUNDLE, sprintId: sid(sprint), attempts, catalog })
}

function escalated(attempts: TierFactsAttempt[], catalog: HostCatalog | null = CATALOG): boolean | undefined {
  return factsOf(attempts, catalog).find((facts) => facts.ticketId === tid(1))?.escalated
}

describe('computeTierFacts: what is planned', () => {
  it("lists every ticket of the sprint in sprint order with its size, planned level and planned effort", () => {
    const bundle = makeBundle([[1, 2], [3]])
    bundle.tickets = [
      makeTicket(1, { size: 'medium', capability: { ...defaultCapabilityProfile(), reasoning: { level: 'deep', rationale: '', effort: 'high' } } }),
      makeTicket(2),
      makeTicket(3, { size: 'micro' })
    ]
    const facts = computeTierFacts({ bundle, sprintId: sid(1), attempts: [], catalog: null })
    expect(facts).toEqual([
      { ticketId: tid(1), key: 'DM-1', size: 'medium', plannedLevel: 'deep', plannedEffort: 'high', attempts: [], attemptCount: 0, rejectionCount: 0, escalated: false },
      { ticketId: tid(2), key: 'DM-2', size: null, plannedLevel: 'multi_step', plannedEffort: null, attempts: [], attemptCount: 0, rejectionCount: 0, escalated: false }
    ])
  })

  it('is empty for a sprint the plan does not have', () => {
    expect(factsOf([], CATALOG, 9)).toEqual([])
  })

  it('reads only the attempts of the sprint tickets', () => {
    const facts = factsOf([attempt(4, 1, 'accepted', { modelId: 'big' })])
    expect(facts.map((item) => [item.key, item.attemptCount])).toEqual([['DM-1', 0], ['DM-2', 0], ['DM-3', 0]])
  })
})

describe('computeTierFacts: what happened', () => {
  it("lists each attempt's model and effort in attempt order, with the worker's label", () => {
    const facts = factsOf([
      attempt(1, 2, 'accepted', { modelId: 'mid', effort: 'high', label: 'Claude Code' }),
      attempt(1, 1, 'rejected', { modelId: 'small', effort: 'low' })
    ])
    expect(facts[0]?.attempts).toEqual([
      { attemptId: 'at_1_1', number: 1, state: 'rejected', modelId: 'small', effort: 'low', label: 'worker', fallback: false },
      { attemptId: 'at_1_2', number: 2, state: 'accepted', modelId: 'mid', effort: 'high', label: 'Claude Code', fallback: false }
    ])
  })

  it('counts every work attempt and the rejected ones, and leaves failed and canceled attempts out of the rejections', () => {
    const facts = factsOf([
      attempt(1, 1, 'rejected', { modelId: 'small' }),
      attempt(1, 2, 'failed', { modelId: 'small' }),
      attempt(1, 3, 'rejected', { modelId: 'mid' }),
      attempt(1, 4, 'canceled', { modelId: 'mid' }),
      attempt(1, 5, 'accepted', { modelId: 'big' })
    ])
    expect(facts[0]).toMatchObject({ attemptCount: 5, rejectionCount: 2 })
    expect(facts[0]?.attempts).toHaveLength(5)
  })

  it('leaves carry-forward attempts out, since no worker ran them', () => {
    const facts = factsOf([
      attempt(1, 1, 'accepted', { modelId: 'small' }),
      carriedForward(2, 1)
    ])
    expect(facts[1]).toMatchObject({ key: 'DM-2', attemptCount: 0, attempts: [] })
    expect(facts[0]).toMatchObject({ key: 'DM-1', attemptCount: 1 })
  })
})

describe('computeTierFacts: escalation by model tier', () => {
  it.each([
    ['a higher cost tier', 'small', 'mid'],
    ['two cost tiers up', 'small', 'big'],
    ['the same cost tier with deeper reasoning', 'mid', 'mid-deep']
  ])('is escalated by %s on a later attempt', (_label, first, second) => {
    expect(escalated([attempt(1, 1, 'rejected', { modelId: first }), attempt(1, 2, 'accepted', { modelId: second })])).toBe(true)
  })

  it.each([
    ['the same model again', 'mid', 'mid'],
    ['a lower tier later', 'big', 'small'],
    ['a lower reasoning depth in the same cost tier', 'mid-deep', 'mid']
  ])('is not escalated by %s', (_label, first, second) => {
    expect(escalated([attempt(1, 1, 'rejected', { modelId: first }), attempt(1, 2, 'accepted', { modelId: second })])).toBe(false)
  })

  it('is not escalated by a single attempt, however strong its model', () => {
    expect(escalated([attempt(1, 1, 'accepted', { modelId: 'big', effort: 'high' })])).toBe(false)
  })

  it('stays escalated when a later attempt drops back to a lower tier', () => {
    const attempts = [
      attempt(1, 1, 'rejected', { modelId: 'small' }),
      attempt(1, 2, 'rejected', { modelId: 'mid' }),
      attempt(1, 3, 'accepted', { modelId: 'small' })
    ]
    expect(escalated(attempts)).toBe(true)
  })
})

describe('computeTierFacts: escalation by effort', () => {
  it.each([
    ['low', 'medium'],
    ['medium', 'high'],
    ['low', 'high']
  ] as const)('is escalated when a later attempt on the same model runs at higher effort (%s then %s)', (first, second) => {
    const attempts = [attempt(1, 1, 'rejected', { modelId: 'mid', effort: first }), attempt(1, 2, 'accepted', { modelId: 'mid', effort: second })]
    expect(escalated(attempts)).toBe(true)
  })

  it('is not escalated by the same or a lower effort', () => {
    expect(escalated([attempt(1, 1, 'rejected', { modelId: 'mid', effort: 'high' }), attempt(1, 2, 'accepted', { modelId: 'mid', effort: 'high' })])).toBe(false)
    expect(escalated([attempt(1, 1, 'rejected', { modelId: 'mid', effort: 'high' }), attempt(1, 2, 'accepted', { modelId: 'mid', effort: 'low' })])).toBe(false)
  })

  it('counts a higher effort even when the later model is a lower tier, since either one escalates', () => {
    const attempts = [attempt(1, 1, 'rejected', { modelId: 'big', effort: 'low' }), attempt(1, 2, 'accepted', { modelId: 'small', effort: 'high' })]
    expect(escalated(attempts)).toBe(true)
  })

  it('does not compare an effort that an attempt did not record', () => {
    const attempts = [attempt(1, 1, 'rejected', { modelId: 'mid', effort: null }), attempt(1, 2, 'accepted', { modelId: 'mid', effort: 'high' })]
    expect(escalated(attempts)).toBe(false)
  })
})

describe('computeTierFacts: attempts that cannot be ranked', () => {
  const FALLBACK: WorkerSpec = { label: ORCHESTRATOR_FALLBACK_LABEL, modelId: null, effort: null }

  it('lists an orchestrator fallback attempt, flagged, and counts it, but never ranks it', () => {
    const facts = factsOf([attempt(1, 1, 'rejected', { modelId: 'small', effort: 'low' }), attempt(1, 2, 'accepted', FALLBACK)])
    expect(facts[0]?.attempts[1]).toEqual({
      attemptId: 'at_1_2',
      number: 2,
      state: 'accepted',
      modelId: null,
      effort: null,
      label: ORCHESTRATOR_FALLBACK_LABEL,
      fallback: true
    })
    expect(facts[0]).toMatchObject({ attemptCount: 2, escalated: false })
  })

  it('compares the ranked attempts around a fallback attempt as if it were not there', () => {
    const attempts = [attempt(1, 1, 'rejected', { modelId: 'small' }), attempt(1, 2, 'rejected', FALLBACK), attempt(1, 3, 'accepted', { modelId: 'mid' })]
    expect(escalated(attempts)).toBe(true)
  })

  it('does not flag an attempt with no model that is not the orchestrator fallback', () => {
    const facts = factsOf([attempt(1, 1, 'accepted', { label: 'worker-1' })])
    expect(facts[0]?.attempts[0]).toMatchObject({ modelId: null, fallback: false })
  })

  it('cannot rank a model the host catalog does not list, so only its efforts are compared', () => {
    const models = [attempt(1, 1, 'rejected', { modelId: 'ghost' }), attempt(1, 2, 'accepted', { modelId: 'big' })]
    expect(escalated(models)).toBe(false)
    const efforts = [attempt(1, 1, 'rejected', { modelId: 'ghost', effort: 'low' }), attempt(1, 2, 'accepted', { modelId: 'big', effort: 'medium' })]
    expect(escalated(efforts)).toBe(true)
  })

  it('has no tiers without a host catalog, and still compares efforts', () => {
    const models = [attempt(1, 1, 'rejected', { modelId: 'small' }), attempt(1, 2, 'accepted', { modelId: 'big' })]
    expect(escalated(models, null)).toBe(false)
    const efforts = [attempt(1, 1, 'rejected', { modelId: 'small', effort: 'low' }), attempt(1, 2, 'accepted', { modelId: 'small', effort: 'high' })]
    expect(escalated(efforts, null)).toBe(true)
  })
})
