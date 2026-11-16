import { describe, expect, it } from 'vitest'
import type { KnowledgeFact, KnowledgeLayer } from './fact'
import { mergeLayers } from './merge'

function make(id: string, layer: KnowledgeLayer, extra: Partial<KnowledgeFact> = {}): KnowledgeFact {
  return {
    id,
    type: 'convention',
    title: `${id} (${layer})`,
    scope: { roles: ['orchestrator'], events: [], topics: [], paths: [] },
    priority: 50,
    supersedes: [],
    anchors: [],
    layer,
    path: `${layer}/${id}.md`,
    body: 'body',
    tokens: 5,
    ...extra
  }
}

const layersOf = (facts: KnowledgeFact[]) => Object.fromEntries(facts.map((f) => [f.id, f.layer]))

describe('mergeLayers', () => {
  it.each([
    ['overall', 'builtin'],
    ['repo', 'builtin'],
    ['repo', 'overall']
  ] as const)('%s overrides %s for the same id', (high, low) => {
    for (const input of [[make('a', low), make('a', high)], [make('a', high), make('a', low)]]) {
      const { facts, diagnostics } = mergeLayers(input)
      expect(layersOf(facts)).toEqual({ a: high })
      expect(diagnostics).toEqual([])
    }
  })

  it('supersedes removes ids from lower layers but not higher ones', () => {
    const { facts } = mergeLayers([
      make('old', 'builtin'),
      make('keep', 'repo'),
      make('new', 'overall', { supersedes: ['old', 'keep'] })
    ])
    expect(layersOf(facts)).toEqual({ new: 'overall', keep: 'repo' })
  })

  it('supersedes removes ids within the same layer', () => {
    const { facts } = mergeLayers([make('old', 'repo'), make('new', 'repo', { supersedes: ['old'] })])
    expect(facts.map((f) => f.id)).toEqual(['new'])
  })

  it('keeps the first duplicate id by path order and reports it', () => {
    const second = make('dup', 'overall', { path: 'overall/b.md', title: 'second' })
    const first = make('dup', 'overall', { path: 'overall/a.md', title: 'first' })
    const { facts, diagnostics } = mergeLayers([second, first])
    expect(facts.map((f) => f.title)).toEqual(['first'])
    expect(diagnostics).toEqual([
      { layer: 'overall', path: 'overall/b.md', message: expect.stringContaining('duplicate id "dup"') }
    ])
  })

  it('keeps a fact with an unknown event and reports it', () => {
    const fact = make('evt', 'repo', {
      scope: { roles: ['orchestrator'], events: ['ticket.claimed', 'nope.event'], topics: [], paths: [] }
    })
    const { facts, diagnostics } = mergeLayers([fact])
    expect(facts).toEqual([fact])
    expect(diagnostics).toEqual([
      { layer: 'repo', path: 'repo/evt.md', message: expect.stringContaining('unknown event "nope.event"') }
    ])
  })
})
