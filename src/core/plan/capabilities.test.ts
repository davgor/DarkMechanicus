import { describe, expect, it } from 'vitest'
import { type CapabilityProfile, defaultCapabilityProfile, type ToolCapability } from '../../shared/domain/bundle'
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

function catalog(models: HostModel[], tools: ToolCapability[] = ['repo_read', 'repo_write', 'shell']): HostCatalog {
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
    const result = matchProfile(profile(), catalog([model('m1')]))
    expect(result.eligible.map((item) => item.modelId)).toEqual(['m1'])
    expect(result.rejected).toEqual([])
    expect(result.hostFailures).toEqual([])
    expect(result.unknownRequirements).toEqual([])
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
    expect(matchProfile(multi, catalog(models)).eligible.map((item) => item.modelId)).toEqual(['exact', 'above'])
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


type Match = ReturnType<typeof matchProfile>

const order = (result: Match): string[] => result.eligible.map((item) => item.modelId)
const scoreOf = (result: Match, id: string): number | undefined => result.eligible.find((item) => item.modelId === id)?.score
const reasonsOf = (result: Match, id: string): string[] => result.eligible.find((item) => item.modelId === id)?.reasons ?? []

function needing(
  level: 'routine' | 'multi_step' | 'deep',
  patch: NonNullable<Parameters<typeof profile>[0]> & { effort?: 'low' | 'medium' | 'high' } = {}
): CapabilityProfile {
  const { effort, ...rest } = patch
  const reasoning = effort === undefined ? { level, rationale: '' } : { level, rationale: '', effort }
  return profile({ ...rest, base: { ...rest.base, reasoning } })
}

/** Shaped like the live catalog: a deep model at high cost, a multi_step one at normal cost, a routine one at low cost. */
const LIVE = catalog([
  model('deep-model', { costTier: 'high' }),
  model('mid-model', { reasoningLevels: ['routine', 'multi_step'], costTier: 'normal' }),
  model('routine-model', { reasoningLevels: ['routine'], costTier: 'low' })
])

describe('matchProfile — right-sized ranking', () => {
  it('ranks the routine model first for a routine ticket with no preferences', () => {
    const result = matchProfile(needing('routine'), LIVE)
    expect(order(result)).toEqual(['routine-model', 'mid-model', 'deep-model'])
    expect(result.recommended?.modelId).toBe('routine-model')
  })

  it('ranks the multi_step model first for a multi_step ticket', () => {
    const result = matchProfile(needing('multi_step'), LIVE)
    expect(order(result)).toEqual(['mid-model', 'deep-model'])
    expect(result.rejected.map((item) => item.modelId)).toEqual(['routine-model'])
    expect(result.recommended?.modelId).toBe('mid-model')
  })

  it('matches only the deep model for a deep ticket', () => {
    const result = matchProfile(needing('deep'), LIVE)
    expect(order(result)).toEqual(['deep-model'])
    expect(result.rejected.map((item) => item.modelId)).toEqual(['mid-model', 'routine-model'])
    expect(result.recommended?.modelId).toBe('deep-model')
  })

  it('takes twenty points for each reasoning rank by which a model exceeds the ticket’s need, and says so', () => {
    const flat = catalog([
      model('exact', { reasoningLevels: ['routine'], costTier: 'low' }),
      model('one-up', { reasoningLevels: ['routine', 'multi_step'], costTier: 'low' }),
      model('two-up', { costTier: 'low' })
    ])
    const result = matchProfile(needing('routine'), flat)
    expect(result.eligible.map((item) => [item.modelId, item.score])).toEqual([
      ['exact', 50],
      ['one-up', 30],
      ['two-up', 10]
    ])
    expect(reasonsOf(result, 'exact')).toContain('Fits the ticket\'s "routine" reasoning need exactly (+0).')
    expect(reasonsOf(result, 'one-up')).toContain(
      'Highest reasoning level "multi_step" is 1 rank above the ticket\'s "routine" need (-20).'
    )
    expect(reasonsOf(result, 'two-up')).toContain(
      'Highest reasoning level "deep" is 2 ranks above the ticket\'s "routine" need (-40).'
    )
  })
})

describe('matchProfile — skill and quality ranking', () => {
  it('adds five points per listed skill the ticket asks for, case-insensitively', () => {
    const asked = profile({ base: { skills: ['TypeScript', 'SQL', 'Rust'] } })
    const one = matchProfile(asked, catalog([exact('m1', { skills: ['sql'] })]))
    expect(one.eligible[0]).toMatchObject({ score: 55 })
    expect(reasonsOf(one, 'm1')).toContain('Lists skill "SQL" (+5).')
    const two = matchProfile(asked, catalog([exact('m1', { skills: ['typescript', 'sql'] })]))
    expect(two.eligible[0]).toMatchObject({ score: 60 })
    expect(reasonsOf(two, 'm1')).toContain('Lists skills "TypeScript", "SQL" (+10).')
  })

  it('caps the skill points at ten so tags stay a nudge', () => {
    const asked = profile({ base: { skills: ['TypeScript', 'SQL', 'Rust'] } })
    const result = matchProfile(asked, catalog([exact('m1', { skills: ['typescript', 'sql', 'rust'] })]))
    expect(result.eligible[0]).toMatchObject({ score: 60 })
    expect(reasonsOf(result, 'm1')).toContain('Lists skills "TypeScript", "SQL", "Rust" (+10, capped at 10).')
  })

  it('does not let a model that lists more skill tags beat a better-fitting one on tags alone', () => {
    const tags = ['a', 'b', 'c', 'd', 'e', 'f']
    const crowded = catalog([
      model('deep-model', { skills: tags, costTier: 'high' }),
      model('routine-model', { reasoningLevels: ['routine'], skills: ['a'], costTier: 'low' })
    ])
    const result = matchProfile(needing('routine', { base: { skills: tags } }), crowded)
    expect(order(result)).toEqual(['routine-model', 'deep-model'])
    expect(scoreOf(result, 'deep-model')).toBe(20)
    expect(scoreOf(result, 'routine-model')).toBe(55)
  })

  it.each([['routine'], ['multi_step']] as const)(
    'does not let a high-quality preference put a deeper model ahead of one that fits a %s ticket',
    (level) => {
      const result = matchProfile(needing(level, { preferences: { quality: 'high' } }), LIVE)
      expect(order(result)[0]).toBe(level === 'routine' ? 'routine-model' : 'mid-model')
      expect(result.recommended?.modelId).toBe(order(result)[0])
    }
  )

  it('gives no points for depth under a high-quality preference and says so', () => {
    const standard = matchProfile(needing('routine'), LIVE)
    const high = matchProfile(needing('routine', { preferences: { quality: 'high' } }), LIVE)
    for (const id of order(high)) {
      expect(scoreOf(high, id)).toBe(scoreOf(standard, id))
      expect(reasonsOf(high, id)).toContain(
        'High-quality preference earns no credit for depth beyond the ticket\'s need (+0).'
      )
    }
    expect(reasonsOf(standard, 'deep-model').join(' ')).not.toContain('High-quality')
  })
})

/** A model whose highest level is multi_step: an exact fit for the default profile. */
const exact = (id: string, overrides: Partial<HostModel> = {}): HostModel =>
  model(id, { reasoningLevels: ['multi_step'], ...overrides })

const TIERS = catalog([
  exact('cheap', { costTier: 'low', latencyTier: 'low' }),
  exact('mid', { costTier: 'normal', latencyTier: 'normal' }),
  exact('pricey', { costTier: 'high', latencyTier: 'high' })
])

describe('matchProfile — cost ranking', () => {

  it('rewards a low cost tier and penalizes a high one under a low-cost preference', () => {
    const result = matchProfile(profile({ preferences: { cost: 'low' } }), TIERS)
    expect(result.eligible.map((item) => [item.modelId, item.score])).toEqual([
      ['cheap', 60],
      ['mid', 50],
      ['pricey', 40]
    ])
    expect(reasonsOf(result, 'cheap')).toContain('Low cost tier fits a low-cost preference (+10).')
    expect(reasonsOf(result, 'pricey')).toContain('High cost tier works against a low-cost preference (-10).')
  })

  it('leaves the scores alone without a low-cost preference and lets the tier order equal scores', () => {
    const result = matchProfile(profile({ preferences: { cost: 'normal' } }), TIERS)
    expect(result.eligible.map((item) => item.score)).toEqual([50, 50, 50])
    expect(order(result)).toEqual(['cheap', 'mid', 'pricey'])
  })

  it('sorts equal scores by cost tier, cheaper first, then by model id', () => {
    const models = [
      exact('a-high', { costTier: 'high' }),
      exact('m-normal', { costTier: 'normal' }),
      exact('z-low', { costTier: 'low' }),
      exact('b-normal', { costTier: 'normal' }),
      exact('c-undeclared', {})
    ]
    const result = matchProfile(profile(), catalog(models))
    expect(new Set(result.eligible.map((item) => item.score)).size).toBe(1)
    expect(order(result)).toEqual(['z-low', 'b-normal', 'c-undeclared', 'm-normal', 'a-high'])
  })

  it('puts a cheaper cost tier first at equal fit when no cost preference is set', () => {
    const pair = catalog([exact('a-pricey', { costTier: 'high' }), exact('b-cheap', { costTier: 'low' })])
    expect(order(matchProfile(profile(), pair))).toEqual(['b-cheap', 'a-pricey'])
  })

  it('explains the cost tier in reasons', () => {
    const result = matchProfile(profile(), catalog([exact('priced', { costTier: 'high' }), exact('unpriced', {})]))
    expect(reasonsOf(result, 'priced')).toContain('Cost tier "high": cheaper tiers sort first on equal scores.')
    expect(reasonsOf(result, 'unpriced')).toContain('No cost tier declared; ranked as "normal" on equal scores.')
  })

})

describe('matchProfile — latency and id ranking', () => {
  it('rewards a low latency tier only under a low-latency preference', () => {
    const low = matchProfile(profile({ preferences: { latency: 'low' } }), TIERS)
    expect(order(low)[0]).toBe('cheap')
    expect(scoreOf(low, 'cheap')).toBe(60)
    expect(reasonsOf(low, 'cheap')).toContain('Low latency tier fits a low-latency preference (+10).')
    const normal = matchProfile(profile({ preferences: { latency: 'normal' } }), TIERS)
    expect(normal.eligible.map((item) => item.score)).toEqual([50, 50, 50])
  })

  it('sorts by score, then by model id', () => {
    const models = [model('m-c'), model('m-a', { skills: ['ui'] }), model('m-b', { skills: ['ui'] })]
    const result = matchProfile(profile({ base: { skills: ['ui'] } }), catalog(models))
    expect(result.eligible.map((item) => `${item.modelId}:${item.score}`)).toEqual(['m-a:35', 'm-b:35', 'm-c:30'])
  })
})

describe('matchProfile — ticket size', () => {
  const asked = profile({ base: { skills: ['ui'] } })
  const pair = catalog([exact('pricey', { costTier: 'normal', skills: ['ui'] }), exact('cheap', { costTier: 'low' })])

  it.each([['micro'], ['small']] as const)('favours the cheapest fitting model on a %s ticket', (size) => {
    const result = matchProfile(asked, pair, { size })
    expect(order(result)).toEqual(['cheap', 'pricey'])
    expect(scoreOf(result, 'pricey')).toBe(47)
    expect(reasonsOf(result, 'pricey')).toContain(
      `${size === 'micro' ? 'Micro' : 'Small'} ticket favours the cheapest fitting model: "normal" cost tier (-8).`
    )
  })

  it.each([[undefined], ['medium'], ['large']] as const)(
    'lets a skill match decide between equal-fit models on a %s ticket',
    (size) => {
      const result = matchProfile(asked, pair, size === undefined ? {} : { size })
      expect(order(result)).toEqual(['pricey', 'cheap'])
      expect(scoreOf(result, 'pricey')).toBe(55)
    }
  )

  it('charges a high cost tier sixteen points on a small ticket', () => {
    const result = matchProfile(profile(), catalog([exact('dear', { costTier: 'high' })]), { size: 'small' })
    expect(scoreOf(result, 'dear')).toBe(34)
  })

  it('never lets the size steering outweigh a reasoning rank', () => {
    const fit = catalog([
      model('z-exact-pricey', { reasoningLevels: ['routine'], costTier: 'high' }),
      model('a-over-cheap', { reasoningLevels: ['routine', 'multi_step'], costTier: 'low' })
    ])
    expect(order(matchProfile(needing('routine'), fit, { size: 'micro' }))).toEqual(['z-exact-pricey', 'a-over-cheap'])
  })
})

describe('matchProfile — recommendation', () => {
  it('is null when no model is eligible', () => {
    const result = matchProfile(needing('deep'), catalog([model('m1', { reasoningLevels: ['routine'] })]))
    expect(result.eligible).toEqual([])
    expect(result.recommended).toBeNull()
  })

  it('recommends the top-ranked model at the ticket’s own effort and carries its reasons', () => {
    const result = matchProfile(needing('routine', { effort: 'high' }), LIVE)
    expect(result.recommended).toMatchObject({ modelId: 'routine-model', effort: 'high' })
    const reasons = result.recommended?.reasons ?? []
    expect(reasons).toContain('Top-ranked of 3 eligible models.')
    expect(reasons).toContain('Fits the ticket\'s "routine" reasoning need exactly (+0).')
    expect(reasons).toContain('Cost tier "low": cheaper tiers sort first on equal scores.')
    expect(reasons).toContain('Uses the ticket\'s "high" effort.')
  })

  it.each([
    ['micro', 'low'],
    ['small', 'low'],
    ['medium', 'medium'],
    ['large', 'high']
  ] as const)('defaults a %s ticket with no effort to %s effort', (size, effort) => {
    const result = matchProfile(needing('routine'), LIVE, { size })
    expect(result.recommended?.effort).toBe(effort)
    expect(result.recommended?.reasons).toContain(`No effort set; a ${size} ticket defaults to "${effort}" effort.`)
  })

  it('defaults to medium effort and says so when the ticket has neither a size nor an effort', () => {
    const result = matchProfile(needing('routine'), LIVE)
    expect(result.recommended?.effort).toBe('medium')
    expect(result.recommended?.reasons).toContain('The ticket sets no size or effort; defaulting to "medium" effort.')
  })

  it('prefers the ticket’s effort over the size default', () => {
    const result = matchProfile(needing('routine', { effort: 'medium' }), LIVE, { size: 'micro' })
    expect(result.recommended?.effort).toBe('medium')
  })

  it('moves the effort onto one the recommended model declares', () => {
    const up = catalog([model('m1', { efforts: ['medium', 'high'] })])
    const raised = matchProfile(needing('multi_step', { effort: 'low' }), up)
    expect(raised.recommended?.effort).toBe('medium')
    expect(raised.recommended?.reasons).toContain('"low" effort is not one the model declares; using "medium" instead.')
    const down = catalog([model('m1', { efforts: ['low'] })])
    const lowered = matchProfile(needing('multi_step', { effort: 'high' }), down)
    expect(lowered.recommended?.effort).toBe('low')
    const open = matchProfile(needing('multi_step', { effort: 'high' }), catalog([model('m1', { efforts: [] })]))
    expect(open.recommended?.effort).toBe('high')
  })
})

type State = 'rejected' | 'failed' | 'accepted' | 'canceled' | 'lease_expired' | 'claimed' | 'running' | 'submitted'
const attempt = (state: State, modelId: string | null, effort: 'low' | 'medium' | 'high' | null = null) => ({
  state,
  modelId,
  effort
})

describe('matchProfile — escalation one tier up', () => {
  it('recommends the cheapest eligible model one tier above the last attempt’s model after a rejection', () => {
    const result = matchProfile(needing('routine'), LIVE, { attempts: [attempt('rejected', 'routine-model')] })
    expect(result.recommended?.modelId).toBe('mid-model')
    expect(result.recommended?.reasons).toContain(
      'Last attempt on "routine-model" was rejected; escalating to the cheapest eligible model one tier above it.'
    )
    expect(order(result)[0]).toBe('routine-model')
  })

  it('does the same after a failed attempt', () => {
    const result = matchProfile(needing('routine'), LIVE, { attempts: [attempt('failed', 'mid-model')] })
    expect(result.recommended?.modelId).toBe('deep-model')
    expect(result.recommended?.reasons).toContain(
      'Last attempt on "mid-model" failed; escalating to the cheapest eligible model one tier above it.'
    )
  })

  it('goes by the most recent rejected or failed attempt', () => {
    const attempts = [attempt('rejected', 'routine-model'), attempt('rejected', 'mid-model')]
    expect(matchProfile(needing('routine'), LIVE, { attempts }).recommended?.modelId).toBe('deep-model')
  })

  it('derives tiers from the catalog, cost tier first and then depth, and steps up one tier at a time', () => {
    const tiers = catalog([
      model('d', { costTier: 'high' }),
      model('p', { reasoningLevels: ['routine', 'multi_step'], costTier: 'high' }),
      model('m', { reasoningLevels: ['routine', 'multi_step'], costTier: 'normal' }),
      model('r', { reasoningLevels: ['routine'], costTier: 'low' })
    ])
    const after = (modelId: string): string | undefined =>
      matchProfile(needing('routine'), tiers, { attempts: [attempt('rejected', modelId)] }).recommended?.modelId
    expect(after('r')).toBe('m')
    expect(after('m')).toBe('p')
    expect(after('p')).toBe('d')
  })

  it('only escalates to models that are eligible for the ticket', () => {
    const seeing = catalog([
      model('deep-model', { costTier: 'high' }),
      model('mid-model', { reasoningLevels: ['routine', 'multi_step'], modalities: ['text'], costTier: 'normal' }),
      model('routine-model', { reasoningLevels: ['routine'], costTier: 'low' })
    ])
    const asked = needing('routine', { base: { modalities: ['text', 'images'] } })
    const result = matchProfile(asked, seeing, { attempts: [attempt('rejected', 'routine-model')] })
    expect(result.recommended?.modelId).toBe('deep-model')
  })

  it('recommends the ticket’s normal effort on the model one tier up', () => {
    const attempts = [attempt('rejected', 'routine-model', 'low')]
    const result = matchProfile(needing('routine', { effort: 'high' }), LIVE, { attempts })
    expect(result.recommended).toMatchObject({ modelId: 'mid-model', effort: 'high' })
  })

})

describe('matchProfile — escalation by effort', () => {
  it('recommends the same model at a higher effort when nothing sits above it', () => {
    const result = matchProfile(needing('deep'), LIVE, { attempts: [attempt('failed', 'deep-model', 'medium')] })
    expect(result.recommended).toMatchObject({ modelId: 'deep-model', effort: 'high' })
    expect(result.recommended?.reasons).toContain(
      'Last attempt on "deep-model" failed; nothing eligible sits above it, so the same model runs at higher effort.'
    )
  })

  it('starts from the ticket’s normal effort when the attempt recorded none', () => {
    const result = matchProfile(needing('deep'), LIVE, { attempts: [attempt('rejected', 'deep-model')] })
    expect(result.recommended).toMatchObject({ modelId: 'deep-model', effort: 'high' })
    const small = matchProfile(needing('deep'), LIVE, { size: 'small', attempts: [attempt('rejected', 'deep-model')] })
    expect(small.recommended?.effort).toBe('medium')
  })

  it('repeats the model and says so when it is already at its highest effort', () => {
    const result = matchProfile(needing('deep'), LIVE, { attempts: [attempt('rejected', 'deep-model', 'high')] })
    expect(result.recommended).toMatchObject({ modelId: 'deep-model', effort: 'high' })
    expect(result.recommended?.reasons).toContain(
      'Last attempt on "deep-model" was rejected; nothing eligible sits above it and "high" is already its highest effort, so the same model is repeated.'
    )
  })

  it('only raises the effort to one the model declares', () => {
    const open = catalog([model('only', { efforts: ['low', 'high'] })])
    const raised = matchProfile(needing('deep'), open, { attempts: [attempt('rejected', 'only', 'low')] })
    expect(raised.recommended).toMatchObject({ modelId: 'only', effort: 'high' })
    const capped = catalog([model('only', { efforts: ['low', 'medium'] })])
    const stuck = matchProfile(needing('deep'), capped, { attempts: [attempt('rejected', 'only', 'medium')] })
    expect(stuck.recommended).toMatchObject({ modelId: 'only', effort: 'medium' })
    expect(stuck.recommended?.reasons.join(' ')).toContain('"medium" is already its highest effort')
  })

})

describe('matchProfile — escalation fallbacks', () => {
  it.each(['accepted', 'canceled', 'lease_expired', 'claimed', 'running', 'submitted'] as const)(
    'does not escalate on a %s attempt',
    (state) => {
      const result = matchProfile(needing('routine'), LIVE, { attempts: [attempt(state, 'routine-model')] })
      expect(result.recommended?.modelId).toBe('routine-model')
      expect(result.recommended?.reasons.join(' ')).not.toContain('Last attempt')
    }
  )

  it('falls back to the normal recommendation when the last attempt’s model left the catalog', () => {
    const result = matchProfile(needing('routine'), LIVE, { attempts: [attempt('rejected', 'retired-model')] })
    expect(result.recommended?.modelId).toBe('routine-model')
    expect(result.recommended?.reasons).toContain(
      'Last attempt on "retired-model" was rejected, but that model is not in the host catalog; using the normal recommendation.'
    )
  })

  it('falls back to the normal recommendation when the last attempt recorded no model', () => {
    const result = matchProfile(needing('routine'), LIVE, { attempts: [attempt('failed', null)] })
    expect(result.recommended?.modelId).toBe('routine-model')
    expect(result.recommended?.reasons).toContain(
      'Last attempt failed but recorded no model; using the normal recommendation.'
    )
  })

  it('falls back when nothing sits above and the last model is no longer eligible', () => {
    const seeing = catalog([
      model('text-only', { costTier: 'high', modalities: ['text'] }),
      model('seeing', { costTier: 'high' })
    ])
    const asked = needing('deep', { base: { modalities: ['text', 'images'] } })
    const result = matchProfile(asked, seeing, { attempts: [attempt('rejected', 'text-only')] })
    expect(result.recommended?.modelId).toBe('seeing')
    expect(result.recommended?.reasons).toContain(
      'Last attempt on "text-only" was rejected, but that model is no longer eligible and nothing eligible sits above it; using the normal recommendation.'
    )
  })
})
