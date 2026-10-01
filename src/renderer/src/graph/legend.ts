import type { Tone } from './ticketStates'

export type LegendKind = 'execution' | 'draft' | 'plain'

interface LegendEntries {
  states: { tone: Tone; label: string }[]
  edges: { label: string; dashed: boolean }[]
}

const EXECUTION_STATES: LegendEntries['states'] = [
  { tone: 'accepted', label: 'Accepted' },
  { tone: 'review', label: 'In review' },
  { tone: 'running', label: 'Running' },
  { tone: 'ready', label: 'Ready' },
  { tone: 'waiting', label: 'Waiting' },
  { tone: 'failed', label: 'Failed' }
]

/** Legend rows for the graph: execution states in the Saved view, change states in the Draft view. */
export function legendEntries(kind: LegendKind, draftNumber: number): LegendEntries {
  switch (kind) {
    case 'execution':
      return {
        states: EXECUTION_STATES,
        edges: [
          { label: 'Prerequisite met', dashed: false },
          { label: 'Waiting on it', dashed: true }
        ]
      }
    case 'draft':
      return {
        states: [
          { tone: 'neutral', label: 'Unchanged' },
          { tone: 'new', label: `New in rev ${draftNumber}` },
          { tone: 'edited', label: 'Edited' },
          { tone: 'rejected', label: 'Rejected edit' }
        ],
        edges: [{ label: 'Prerequisite', dashed: false }]
      }
    default:
      return { states: [], edges: [{ label: 'Prerequisite', dashed: false }] }
  }
}

/** Which legend the graph shows: draft change states, run execution states, or edges only. */
export function legendKindFor(mode: 'saved' | 'draft', hasRun: boolean): LegendKind {
  if (mode === 'draft') {
    return 'draft'
  }
  return hasRun ? 'execution' : 'plain'
}
