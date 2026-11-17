import { describe, expect, it } from 'vitest'
import type { KnowledgeFact, KnowledgeLayer } from './fact'
import { DEFAULT_CONTEXT_BUDGET, selectFacts } from './select'

interface Spec {
  layer?: KnowledgeLayer
  roles?: string[]
  events?: string[]
  topics?: string[]
  paths?: string[]
  priority?: number
  tokens?: number
}

function make(id: string, spec: Spec = {}): KnowledgeFact {
  const layer = spec.layer ?? 'repo'
  return {
    id,
    type: 'convention',
    title: `title ${id}`,
    scope: {
      roles: spec.roles ?? ['orchestrator'],
      events: spec.events ?? ['ticket.claimed'],
      topics: spec.topics ?? [],
      paths: spec.paths ?? []
    },
    priority: spec.priority ?? 50,
    supersedes: [],
    anchors: [],
    layer,
    path: `${layer}/${id}.md`,
    body: 'body',
    tokens: spec.tokens ?? 10
  }
}

const base = { role: 'orchestrator', budgetTokens: DEFAULT_CONTEXT_BUDGET }
const ids = (facts: KnowledgeFact[]) => facts.map((f) => f.id)

describe('selectFacts', () => {
  it('exports the default budget', () => {
    expect(DEFAULT_CONTEXT_BUDGET).toBe(1500)
  })

  it('filters by role and needs an event or topic match', () => {
    const facts = [make('orch'), make('worker', { roles: ['worker'] }), make('other', { events: ['run.started'] })]
    expect(ids(selectFacts(facts, { ...base, event: 'ticket.claimed' }).facts)).toEqual(['orch'])
    expect(ids(selectFacts(facts, base).facts)).toEqual([])
  })

  it('ranks event matches before topic-only matches', () => {
    const facts = [
      make('topic', { events: [], topics: ['git'], priority: 100 }),
      make('event', { priority: 0 })
    ]
    expect(ids(selectFacts(facts, { ...base, event: 'ticket.claimed', topics: ['git'] }).facts)).toEqual([
      'event',
      'topic'
    ])
  })

  it('boosts facts whose path globs match without excluding the rest', () => {
    const facts = [
      make('plain', { priority: 90 }),
      make('boosted', { priority: 10, paths: ['src/**/*.ts'] }),
      make('miss', { priority: 80, paths: ['docs/*.md'] })
    ]
    const result = selectFacts(facts, { ...base, event: 'ticket.claimed', paths: ['src/core/a.ts'] })
    expect(ids(result.facts)).toEqual(['boosted', 'plain', 'miss'])
  })

  it('breaks ties by priority, then layer, then id', () => {
    const facts = [
      make('b', { layer: 'builtin', priority: 60 }),
      make('c', { layer: 'overall' }),
      make('z', { layer: 'repo' }),
      make('a', { layer: 'repo' }),
      make('d', { layer: 'builtin' })
    ]
    expect(ids(selectFacts(facts, { ...base, event: 'ticket.claimed' }).facts)).toEqual(['b', 'a', 'z', 'c', 'd'])
  })
})

describe('selectFacts budget and determinism', () => {
  it('never exceeds the budget and lists the rest as omitted', () => {
    const facts = [
      make('first', { priority: 90, tokens: 60 }),
      make('big', { priority: 80, tokens: 50 }),
      make('small', { priority: 70, tokens: 40 })
    ]
    const result = selectFacts(facts, { ...base, event: 'ticket.claimed', budgetTokens: 100 })
    expect(ids(result.facts)).toEqual(['first', 'small'])
    expect(result.usedTokens).toBe(100)
    expect(result.omitted).toEqual([{ id: 'big', title: 'title big', tokens: 50 }])
  })

  it('is deterministic for shuffled input', () => {
    const facts = [
      make('a', { priority: 50, layer: 'builtin' }),
      make('b', { priority: 50, layer: 'repo' }),
      make('c', { priority: 70, topics: ['git'], events: [] }),
      make('d', { priority: 50, layer: 'overall', paths: ['src/**'] }),
      make('e', { priority: 50, layer: 'repo' }),
      make('f', { priority: 90, tokens: 1000 })
    ]
    const query = { ...base, event: 'ticket.claimed', topics: ['git'], paths: ['src/x.ts'], budgetTokens: 1030 }
    const expected = selectFacts(facts, query)
    let seed = 7
    for (let round = 0; round < 20; round++) {
      const shuffled = [...facts]
      for (let i = shuffled.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) % 2147483648
        const j = seed % (i + 1)
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }
      expect(selectFacts(shuffled, query)).toEqual(expected)
    }
    expect(ids(expected.facts)).toEqual(['d', 'f', 'b', 'e'])
  })
})
