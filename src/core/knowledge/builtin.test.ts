import { describe, expect, it } from 'vitest'
import kernelSource from '../../../skills/orchestrator.md?raw'
import { BUILTIN_KNOWLEDGE } from './builtin'
import { KNOWLEDGE_EVENTS, type KnowledgeEvent } from './events'
import { parseFact, type KnowledgeFact } from './fact'
import { mergeLayers } from './merge'
import { DEFAULT_CONTEXT_BUDGET, selectFacts } from './select'

const parsed = BUILTIN_KNOWLEDGE.map(({ path, source }) => parseFact(source, { layer: 'builtin', path }))
const facts: KnowledgeFact[] = parsed.flatMap((result) => (result.ok ? [result.fact] : []))
const merged = mergeLayers(facts)

/** The pull-only topics the kernel lists after "Topics, pulled only:". */
function kernelTopics(): string[] {
  const line = kernelSource.split(/\r?\n/).find((text) => text.startsWith('Topics, pulled only:'))
  return [...(line ?? '').matchAll(/`([a-z-]+)`/g)].map((match) => match[1])
}

describe('built-in knowledge', () => {
  it('bundles the fact files under skills/knowledge', () => {
    expect(BUILTIN_KNOWLEDGE.length).toBeGreaterThan(0)
    for (const { path } of BUILTIN_KNOWLEDGE) expect(path).toMatch(/^skills\/knowledge\/.+\.md$/)
  })

  it('parses and merges every built-in fact with no diagnostic', () => {
    const diagnostics = parsed.flatMap((result) => (result.ok ? [] : [result.diagnostic]))
    expect([...diagnostics, ...merged.diagnostics]).toEqual([])
    expect(merged.facts).toHaveLength(BUILTIN_KNOWLEDGE.length)
  })

  it('keeps each built-in fact to one rule cluster of at most 400 tokens', () => {
    const oversized = merged.facts.filter((fact) => fact.tokens > 400).map((fact) => `${fact.id}: ${fact.tokens}`)
    expect(oversized).toEqual([])
  })

  it('resolves every fact id that the kernel or a fact refers to', () => {
    const ids = new Set(merged.facts.map((fact) => fact.id))
    const texts = [kernelSource, ...merged.facts.map((fact) => fact.body)]
    const referenced = texts.flatMap((text) => [...text.matchAll(/`(orchestrator\.[a-z0-9.-]+)`/g)].map((match) => match[1]))
    expect(referenced.filter((id) => !ids.has(id))).toEqual([])
  })
})

describe('built-in knowledge selection', () => {
  it.each(KNOWLEDGE_EVENTS.map((event) => event.id))(
    'pushes at least one built-in orchestrator fact for %s within the default budget, omitting nothing',
    (event) => {
      const result = selectFacts(merged.facts, { role: 'orchestrator', event, budgetTokens: DEFAULT_CONTEXT_BUDGET })
      expect(result.facts.length).toBeGreaterThan(0)
      expect(result.omitted).toEqual([])
      expect(result.usedTokens).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET)
    }
  )

  it('lists the pull-only topics in the kernel, and each pulls its facts within the default budget', () => {
    const topics = kernelTopics()
    expect(topics).toEqual([
      'folders-of-repositories',
      'fallback-claim',
      'lost-claim-response',
      'integration-worktree',
      'plan-changes',
      'retro-redraft',
      'required-leftover',
      'record-keeping',
      'host-catalog',
      'time-box'
    ])
    for (const topic of topics) {
      const result = selectFacts(merged.facts, { role: 'orchestrator', topics: [topic], budgetTokens: DEFAULT_CONTEXT_BUDGET })
      expect(result.facts.length, topic).toBeGreaterThan(0)
      expect(result.omitted, topic).toEqual([])
    }
  })

  it('names every catalog event in the kernel', () => {
    for (const { id } of KNOWLEDGE_EVENTS) expect(kernelSource).toContain(`\`${id}\``)
  })
})

describe('the orchestrator kernel', () => {
  it('is at most 800 words', () => {
    expect(kernelSource.trim().split(/\s+/).length).toBeLessThanOrEqual(800)
  })
})

/**
 * Each SPACE measurement rule and the moments its trigger can occur: the events whose pushed context carries it, and
 * the topics that pull it. A person may report an escaped defect, or ask for a grade, at any time, so those rules come
 * with the run's start and with recovery; usage is recorded after each row, from the topic `orchestrator.row-checks`
 * names.
 */
const SPACE_DELIVERY: [string, { events: KnowledgeEvent[]; topics: string[] }][] = [
  ['orchestrator.space-usage', { events: [], topics: ['record-keeping'] }],
  ['orchestrator.space-review-evidence', { events: ['ticket.claimed', 'acceptance.claimed'], topics: [] }],
  ['orchestrator.space-grades', { events: ['run.started', 'run.recovery', 'sprint.reported'], topics: ['record-keeping'] }],
  ['orchestrator.space-escaped-defects', { events: ['run.started', 'run.recovery', 'row_check.failed'], topics: ['record-keeping'] }],
  ['orchestrator.space-experiments', { events: ['sprint.reported'], topics: [] }],
  ['orchestrator.space-experiment-progress', { events: ['sprint.reported', 'checkpoint.approved', 'attempt.accepted'], topics: [] }],
  ['orchestrator.space-corrective-work', { events: ['sprint.reported', 'checkpoint.approved'], topics: ['retro-redraft'] }]
]

describe('built-in SPACE measurement facts', () => {
  it.each(SPACE_DELIVERY)('delivers %s at every moment its trigger can occur', (id, { events, topics }) => {
    for (const event of events) {
      const result = selectFacts(merged.facts, { role: 'orchestrator', event, budgetTokens: DEFAULT_CONTEXT_BUDGET })
      expect(result.facts.map((fact) => fact.id), event).toContain(id)
    }
    for (const topic of topics) {
      const result = selectFacts(merged.facts, { role: 'orchestrator', topics: [topic], budgetTokens: DEFAULT_CONTEXT_BUDGET })
      expect(result.facts.map((fact) => fact.id), topic).toContain(id)
    }
  })

  it('lists every orchestrator.space-* fact, so a new one states when it is delivered', () => {
    const ids = merged.facts.map((fact) => fact.id).filter((id) => id.startsWith('orchestrator.space-'))
    expect(ids.sort()).toEqual(SPACE_DELIVERY.map(([id]) => id).sort())
  })

  it('names the usage fact from the row checks pushed after each accepted ticket, since no event pushes it', () => {
    const rowChecks = merged.facts.find((fact) => fact.id === 'orchestrator.row-checks')
    expect(rowChecks?.scope.events).toContain('attempt.accepted')
    expect(rowChecks?.body).toContain('`orchestrator.space-usage`')
  })
})
