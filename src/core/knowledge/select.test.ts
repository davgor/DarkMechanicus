import { describe, expect, it } from 'vitest'
import type { LearningView } from '../../shared/domain/learnings'
import type { KnowledgeFact, KnowledgeLayer } from './fact'
import { DEFAULT_CONTEXT_BUDGET, DEFAULT_LEARNING_BUDGET, selectFacts, selectLearnings } from './select'

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
    expect(DEFAULT_CONTEXT_BUDGET).toBe(1800)
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

// DM-936: published learnings, selected beside the facts within their own budget.
const SOURCE = {
  runId: 'rn_00000000000000000000000001',
  sprintId: 'sp_00000000000000000000000001',
  cardId: 'kc_00000000000000000000000001',
  attemptId: 'ka_00000000000000000000000001'
}

interface LearningSpec {
  roles?: ('orchestrator' | 'worker')[]
  events?: LearningView['applicability']['events']
  paths?: string[]
  retired?: boolean
  replacedBy?: string | null
  createdAt?: string
  rule?: string
}

const RETIREMENT = { state: 'retired', retiredAt: '2026-01-02T00:00:00.000Z', retiredReason: 'Obsolete' } as const
const ACTIVE = { state: 'active', retiredAt: null, retiredReason: null } as const

function learning(id: string, spec: LearningSpec = {}): LearningView {
  return {
    formatVersion: 1,
    id,
    title: `Learning ${id}`,
    rule: spec.rule ?? 'Do the thing.',
    check: 'Evidence shows it.',
    applicability: { roles: spec.roles ?? ['worker'], events: spec.events ?? [], paths: spec.paths ?? [] },
    evidence: [{ kind: 'rejected_attempt', sourceId: 'at_x', contentHash: `sha256:${'a'.repeat(64)}` }],
    replaces: null,
    source: SOURCE,
    ...(spec.retired === true ? RETIREMENT : ACTIVE),
    replacedBy: spec.replacedBy ?? null,
    createdAt: spec.createdAt ?? '2026-01-01T00:00:00.000Z',
    revision: 1,
    definitionHash: `sha256:${'b'.repeat(64)}`
  }
}

const workerQuery = { role: 'worker', event: 'ticket.claimed', paths: ['src/core/db/migrations.ts'], budgetTokens: DEFAULT_LEARNING_BUDGET }
const learningIds = (result: { learnings: { id: string }[] }) => result.learnings.map((item) => item.id)

describe('selectLearnings scope', () => {
  it('keeps only active learnings for the role whose events and paths match, path-scoped first', () => {
    const all = [
      learning('lr_any'),
      learning('lr_path', { paths: ['src/core/db/**'] }),
      learning('lr_event', { events: ['ticket.claimed'] }),
      learning('lr_wrong_event', { events: ['attempt.rejected'] }),
      learning('lr_wrong_path', { paths: ['src/renderer/**'] }),
      learning('lr_orchestrator', { roles: ['orchestrator'] }),
      learning('lr_retired', { retired: true }),
      learning('lr_replaced', { retired: true, replacedBy: 'lr_path' })
    ]
    const result = selectLearnings(all, workerQuery)
    expect(learningIds(result)).toEqual(['lr_path', 'lr_event', 'lr_any'])
    expect(result.omitted).toEqual([])
  })

  it('selects orchestrator learnings for the event, and none scoped to an event when the query names none', () => {
    const all = [learning('lr_o', { roles: ['orchestrator'], events: ['attempt.rejected'] }), learning('lr_w')]
    expect(learningIds(selectLearnings(all, { role: 'orchestrator', event: 'attempt.rejected', budgetTokens: 600 }))).toEqual(['lr_o'])
    expect(learningIds(selectLearnings(all, { role: 'orchestrator', budgetTokens: 600 }))).toEqual([])
  })

  it('leaves the facts selection unchanged: learnings never enter selectFacts', () => {
    const facts = [make('a', { roles: ['worker'] })]
    const before = selectFacts(facts, { role: 'worker', event: 'ticket.claimed', budgetTokens: 10 })
    expect(ids(before.facts)).toEqual(['a'])
  })
})

describe('selectLearnings budget and shape', () => {
  it('fills its own budget and reports what it left out, newest first among equals', () => {
    const long = 'x'.repeat(400)
    const all = [
      learning('lr_old', { rule: long, createdAt: '2026-01-01T00:00:00.000Z' }),
      learning('lr_new', { rule: long, createdAt: '2026-01-03T00:00:00.000Z' }),
      learning('lr_mid', { rule: long, createdAt: '2026-01-02T00:00:00.000Z' })
    ]
    const tokens = Math.ceil(('Learning lr_old'.length + long.length + 'Evidence shows it.'.length) / 4)
    const result = selectLearnings(all, { ...workerQuery, budgetTokens: tokens * 2 })
    expect(learningIds(result)).toEqual(['lr_new', 'lr_mid'])
    expect(result.omitted).toEqual([{ id: 'lr_old', title: 'Learning lr_old', tokens }])
    expect(result.usedTokens).toBe(tokens * 2)
  })

  it('carries text and provenance only: no applicability, lifecycle or authority field', () => {
    const [item] = selectLearnings([learning('lr_a')], workerQuery).learnings
    expect(item).toEqual({ id: 'lr_a', title: 'Learning lr_a', rule: 'Do the thing.', check: 'Evidence shows it.', source: SOURCE })
  })

  it('orders learnings equal in scope and age by id', () => {
    const all = [learning('lr_c'), learning('lr_a'), learning('lr_b')]
    expect(learningIds(selectLearnings(all, workerQuery))).toEqual(['lr_a', 'lr_b', 'lr_c'])
  })
})
