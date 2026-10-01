import { describe, expect, it } from 'vitest'
import { legendEntries, legendKindFor } from './legend'

describe('graph legend', () => {
  it('lists execution states with solid and dashed edges', () => {
    const entries = legendEntries('execution', 5)
    expect(entries.states.map((item) => item.label)).toEqual(['Accepted', 'In review', 'Running', 'Ready', 'Waiting', 'Failed'])
    expect(entries.edges).toEqual([
      { label: 'Prerequisite met', dashed: false },
      { label: 'Waiting on it', dashed: true }
    ])
  })

  it('lists draft change states and a plain edge', () => {
    expect(legendEntries('draft', 5)).toEqual({
      states: [
        { tone: 'neutral', label: 'Unchanged' },
        { tone: 'new', label: 'New in rev 5' },
        { tone: 'edited', label: 'Edited' },
        { tone: 'rejected', label: 'Rejected edit' }
      ],
      edges: [{ label: 'Prerequisite', dashed: false }]
    })
    expect(legendEntries('plain', 1)).toEqual({ states: [], edges: [{ label: 'Prerequisite', dashed: false }] })
  })
})

describe('legend kind', () => {
  it('follows the view and whether a run overlays the plan', () => {
    expect([legendKindFor('draft', true), legendKindFor('saved', true), legendKindFor('saved', false)]).toEqual([
      'draft',
      'execution',
      'plain'
    ])
  })
})
