import { describe, expect, it } from 'vitest'
import kernelSource from '../../../skills/orchestrator.md?raw'
import { BUILTIN_KNOWLEDGE } from './builtin'
import { KNOWLEDGE_EVENTS } from './events'
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
