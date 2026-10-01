/** Compact plan-bundle builders for tests. Not shipped. */
import {
  DEFAULT_POLICIES,
  defaultCapabilityProfile,
  PLAN_FORMAT_VERSION,
  type PlanBundle,
  type SprintDef,
  type TicketContent
} from '../shared/domain/bundle'
import { encodeBase32 } from '../core/ids'

export function tid(n: number): string {
  return `tk_${encodeBase32(BigInt(1000 + n), 26)}`
}

export function sid(n: number): string {
  return `sp_${encodeBase32(BigInt(2000 + n), 26)}`
}

export function makeTicket(n: number, overrides: Partial<TicketContent> = {}): TicketContent {
  return {
    id: tid(n),
    key: `DM-${n}`,
    title: `Ticket ${n}`,
    body: '',
    acceptanceCriteria: [{ id: 'c1', text: `Ticket ${n} works` }],
    tags: [],
    priority: 'normal',
    capability: defaultCapabilityProfile(),
    references: [],
    expectedArtifacts: [],
    optional: false,
    ...overrides
  }
}

export function makeSprint(n: number, ticketNumbers: number[], overrides: Partial<SprintDef> = {}): SprintDef {
  return {
    id: sid(n),
    ordinal: n,
    goal: `Sprint ${n} goal`,
    ticketIds: ticketNumbers.map(tid),
    entryCriteria: [],
    exitCriteria: [],
    concurrencyCap: null,
    checkpoint: { mode: 'human' },
    ...overrides
  }
}

/**
 * Builds a bundle from sprint layouts and `[from, to]` edges using ticket numbers,
 * e.g. `makeBundle([[1, 2], [3]], [[1, 3]])` = sprint 1 {1,2}, sprint 2 {3}, 3 requires 1.
 */
export function makeBundle(
  sprints: number[][],
  edges: [number, number][] = [],
  overrides: Partial<PlanBundle> = {}
): PlanBundle {
  const ticketNumbers = sprints.flat()
  return {
    formatVersion: PLAN_FORMAT_VERSION,
    epic: {
      title: 'Test epic',
      intent: 'Prove the plan works.',
      successCriteria: [{ id: 's1', text: 'Everything works' }],
      ownerRole: null
    },
    tickets: ticketNumbers.map((n) => makeTicket(n)),
    sprints: sprints.map((tickets, index) => makeSprint(index + 1, tickets)),
    edges: edges.map(([from, to]) => ({ from: tid(from), to: tid(to) })),
    relations: [],
    policies: { ...DEFAULT_POLICIES },
    rationale: '',
    ...overrides
  }
}
