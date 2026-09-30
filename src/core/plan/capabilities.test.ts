import { describe, expect, it } from 'vitest'
import { type CapabilityProfile, defaultCapabilityProfile } from '../../shared/domain/bundle'
import type { HostCatalog, HostModel } from '../../shared/domain/views'
import { matchProfile } from './capabilities'

function model(id: string, overrides: Partial<HostModel> = {}): HostModel {
  return {
    id,
    label: id,
    reasoningLevels: ['routine', 'multi_step', 'deep'],
    modalities: ['text', 'images'],
    contextWindowTokens: null,
    skills: [],
    costTier: null,
    latencyTier: null,
    ...overrides
  }
}

function catalog(models: HostModel[], tools: string[] = ['repo_read', 'repo_write', 'shell']): HostCatalog {
  return { hostId: 'host-1', hostType: 'cli', catalogRevision: 'r1', tools, canSelectWorkerModel: true, models }
}

function profile(patch: {
  base?: Partial<CapabilityProfile>
  preferences?: Partial<CapabilityProfile['preferences']>
  estimatedInputTokens?: number | null
  environments?: string[]
} = {}): CapabilityProfile {
  const base = { ...defaultCapabilityProfile(), ...patch.base }
  return {
    ...base,
    context: { ...base.context, estimatedInputTokens: patch.estimatedInputTokens ?? null },
    constraints: { ...base.constraints, environments: patch.environments ?? [] },
    preferences: { ...base.preferences, ...patch.preferences }
  }
}

describe('matchProfile — host tools', () => {
  it('accepts a model on a host that provides every required tool', () => {
    expect(matchProfile(profile(), catalog([model('m1')]))).toEqual({
      eligible: [{ modelId: 'm1', score: 50, reasons: [] }],
      rejected: [],
      hostFailures: [],
      unknownRequirements: []
    })
  })

  it('rejects every model when the host lacks a required tool', () => {
    const result = matchProfile(
      profile({ base: { tools: ['repo_read', 'browser', 'network'] } }),
      catalog([model('m1')], ['repo_read'])
    )
    const failures = ['Host lacks required tool "browser".', 'Host lacks required tool "network".']
    expect(result.hostFailures).toEqual(failures)
    expect(result.eligible).toEqual([])
    expect(result.rejected).toEqual([{ modelId: 'm1', failures }])
  })

  it('lists a model’s own failures before the host failures', () => {
    const result = matchProfile(
      profile({ base: { tools: ['shell'], modalities: ['images'] } }),
      catalog([model('m1', { modalities: ['text'] })], [])
    )
    expect(result.rejected).toEqual([
      { modelId: 'm1', failures: ['Missing modality "images".', 'Host lacks required tool "shell".'] }
    ])
  })
})

describe('matchProfile — unknown requirements', () => {
  it('escalates environment requirements the catalog cannot vouch for, without failing models', () => {
    const result = matchProfile(profile({ environments: ['eu-only', 'sandbox'] }), catalog([model('m1')]))
    expect(result.unknownRequirements).toEqual([
      'Environment requirement "eu-only" cannot be verified: the host catalog declares no environments.',
      'Environment requirement "sandbox" cannot be verified: the host catalog declares no environments.'
    ])
    expect(result.eligible.map((item) => item.modelId)).toEqual(['m1'])
  })

  it('escalates a model override that the catalog does not offer and rejects every model', () => {
    const result = matchProfile(profile({ preferences: { modelOverride: 'ghost' } }), catalog([model('m1')]))
    expect(result.unknownRequirements).toEqual(['Model override "ghost" is not in the host catalog.'])
    expect(result.rejected).toEqual([{ modelId: 'm1', failures: ['The ticket requires model "ghost".'] }])
  })

  it('keeps only the overridden model when the catalog offers it', () => {
    const result = matchProfile(
      profile({ preferences: { modelOverride: 'm2' } }),
      catalog([model('m1'), model('m2'), model('m3')])
    )
    expect(result.unknownRequirements).toEqual([])
    expect(result.eligible.map((item) => item.modelId)).toEqual(['m2'])
    expect(result.rejected.map((item) => item.modelId)).toEqual(['m1', 'm3'])
  })
})

describe('matchProfile — modalities and reasoning', () => {
  it('rejects a model missing a required modality', () => {
    const result = matchProfile(
      profile({ base: { modalities: ['text', 'images'] } }),
      catalog([model('m1', { modalities: ['text'] })])
    )
    expect(result.rejected).toEqual([{ modelId: 'm1', failures: ['Missing modality "images".'] }])
  })

  it('rejects a model whose highest reasoning level is below the demand', () => {
    const deep = profile({ base: { reasoning: { level: 'deep', rationale: '' } } })
    const result = matchProfile(deep, catalog([model('m1', { reasoningLevels: ['multi_step', 'routine'] })]))
    expect(result.rejected).toEqual([
      { modelId: 'm1', failures: ['Needs "deep" reasoning; the model\'s highest level is "multi_step".'] }
    ])
  })

  it('accepts reasoning exactly at or above the demand', () => {
    const multi = profile({ base: { reasoning: { level: 'multi_step', rationale: '' } } })
    const models = [model('exact', { reasoningLevels: ['multi_step'] }), model('above', { reasoningLevels: ['deep'] })]
    expect(matchProfile(multi, catalog(models)).eligible.map((item) => item.modelId)).toEqual(['above', 'exact'])
  })

  it('rejects a model that lists no known reasoning level', () => {
    const routine = profile({ base: { reasoning: { level: 'routine', rationale: '' } } })
    const result = matchProfile(routine, catalog([model('m1', { reasoningLevels: ['genius'] })]))
    expect(result.rejected).toEqual([
      { modelId: 'm1', failures: ['Needs "routine" reasoning; the model lists no reasoning levels.'] }
    ])
  })
})

describe('matchProfile — context window', () => {
  const window = model('m1', { contextWindowTokens: 1000 })

  it('accepts an estimate exactly at the context window', () => {
    expect(matchProfile(profile({ estimatedInputTokens: 1000 }), catalog([window])).eligible).toHaveLength(1)
  })

  it('rejects an estimate one token over the context window', () => {
    expect(matchProfile(profile({ estimatedInputTokens: 1001 }), catalog([window])).rejected).toEqual([
      { modelId: 'm1', failures: ['Estimated input of 1001 tokens exceeds the 1000-token context window.'] }
    ])
  })

  it('does not judge context when either side is unknown', () => {
    expect(matchProfile(profile({ estimatedInputTokens: 5000 }), catalog([model('m1')])).rejected).toEqual([])
    expect(matchProfile(profile(), catalog([window])).rejected).toEqual([])
  })
})

describe('matchProfile — skill and quality ranking', () => {
  it('adds ten points per listed skill, case-insensitively', () => {
    const result = matchProfile(
      profile({ base: { skills: ['TypeScript', 'SQL', 'Rust'] } }),
      catalog([model('m1', { skills: ['typescript', 'sql'] })])
    )
    expect(result.eligible).toEqual([
      { modelId: 'm1', score: 70, reasons: ['Lists skill "TypeScript" (+10).', 'Lists skill "SQL" (+10).'] }
    ])
  })

  it('adds fifteen points for deep reasoning under a high-quality preference', () => {
    const high = profile({ preferences: { quality: 'high' } })
    const result = matchProfile(high, catalog([model('deep'), model('shallow', { reasoningLevels: ['multi_step'] })]))
    expect(result.eligible).toEqual([
      { modelId: 'deep', score: 65, reasons: ['Supports deep reasoning for a high-quality preference (+15).'] },
      { modelId: 'shallow', score: 50, reasons: [] }
    ])
  })

  it('ignores deep reasoning without a high-quality preference', () => {
    const standard = profile({ preferences: { quality: 'standard' } })
    expect(matchProfile(standard, catalog([model('deep')])).eligible[0].score).toBe(50)
  })
})

describe('matchProfile — cost and latency ranking', () => {
  const tiers = catalog([
    model('cheap', { costTier: 'low', latencyTier: 'low' }),
    model('mid', { costTier: 'normal', latencyTier: 'normal' }),
    model('pricey', { costTier: 'high', latencyTier: 'high' })
  ])

  it('rewards a low cost tier and penalizes a high one under a low-cost preference', () => {
    expect(matchProfile(profile({ preferences: { cost: 'low' } }), tiers).eligible).toEqual([
      { modelId: 'cheap', score: 60, reasons: ['Low cost tier fits a low-cost preference (+10).'] },
      { modelId: 'mid', score: 50, reasons: [] },
      { modelId: 'pricey', score: 40, reasons: ['High cost tier works against a low-cost preference (-10).'] }
    ])
  })

  it('ignores cost tiers without a low-cost preference', () => {
    const scores = matchProfile(profile({ preferences: { cost: 'normal' } }), tiers).eligible.map((item) => item.score)
    expect(scores).toEqual([50, 50, 50])
  })

  it('rewards a low latency tier only under a low-latency preference', () => {
    expect(matchProfile(profile({ preferences: { latency: 'low' } }), tiers).eligible[0]).toEqual({
      modelId: 'cheap',
      score: 60,
      reasons: ['Low latency tier fits a low-latency preference (+10).']
    })
    const normal = matchProfile(profile({ preferences: { latency: 'normal' } }), tiers).eligible
    expect(normal.map((item) => item.score)).toEqual([50, 50, 50])
  })

  it('sorts by score, then by model id', () => {
    const models = [model('m-c'), model('m-a', { skills: ['ui'] }), model('m-b', { skills: ['ui'] })]
    const result = matchProfile(profile({ base: { skills: ['ui'] } }), catalog(models))
    expect(result.eligible.map((item) => `${item.modelId}:${item.score}`)).toEqual(['m-a:60', 'm-b:60', 'm-c:50'])
  })
})
