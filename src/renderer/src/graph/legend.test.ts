import { describe, expect, it } from 'vitest'
import { legendEntries, legendKindFor } from './legend'
import { EXECUTION_TONES } from './ticketStates'

describe('graph legend', () => {
  it('lists execution states with solid and dashed edges', () => {
    const entries = legendEntries('execution', 5)
    expect(entries.states.map((item) => item.label)).toEqual(['Accepted', 'In review', 'Running', 'Ready', 'Waiting', 'Blocked', 'Failed'])
    expect(entries.edges).toEqual([
      { label: 'Prerequisite met', dashed: false },
      { label: 'Waiting on it', dashed: true }
    ])
  })

  it('has an entry for every tone a ticket card can show in a run', () => {
    const tones = new Set(legendEntries('execution', 5).states.map((item) => item.tone))
    expect(Object.values(EXECUTION_TONES).filter((tone) => !tones.has(tone))).toEqual([])
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
