import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import { makeBundle, makeTicket, sid, tid } from '../../test/bundles'
import { computeChanges } from './diff'

function edited(base: PlanBundle, mutate: (copy: PlanBundle) => void): PlanBundle {
  const copy = structuredClone(base)
  mutate(copy)
  return copy
}

function details(base: PlanBundle | null, next: PlanBundle): string[] {
  return computeChanges(base, next).map((change) => `${change.kind} ${change.target}: ${change.detail}`)
}

describe('computeChanges without a base', () => {
  it('reports nothing for identical bundles', () => {
    const base = makeBundle([[1, 2]], [[1, 2]], { rationale: 'Why' })
    expect(computeChanges(base, structuredClone(base))).toEqual([])
  })

  it('lists everything as added in a deterministic order', () => {
    const next = makeBundle([[1], [2]], [[1, 2]], {
      relations: [{ kind: 'related_to', from: tid(1), to: tid(2) }],
      rationale: 'Because.'
    })
    expect(computeChanges(null, next)).toEqual([
      { kind: 'added', target: 'epic', id: 'epic', label: 'Test epic', detail: 'Epic created' },
      { kind: 'added', target: 'sprint', id: sid(1), label: 'Sprint 1', detail: 'Sprint 1 added' },
      { kind: 'added', target: 'sprint', id: sid(2), label: 'Sprint 2', detail: 'Sprint 2 added' },
      { kind: 'added', target: 'ticket', id: tid(1), label: 'DM-1 Ticket 1', detail: 'DM-1 Ticket 1 added to Sprint 1' },
      { kind: 'added', target: 'ticket', id: tid(2), label: 'DM-2 Ticket 2', detail: 'DM-2 Ticket 2 added to Sprint 2' },
      { kind: 'added', target: 'edge', id: `${tid(1)}->${tid(2)}`, label: 'DM-2 requires DM-1', detail: 'DM-2 now requires DM-1' },
      {
        kind: 'added',
        target: 'relation',
        id: `related_to:${tid(1)}->${tid(2)}`,
        label: 'DM-1 related to DM-2',
        detail: 'DM-1 marked related to DM-2'
      },
      {
        kind: 'added',
        target: 'policies',
        id: 'policies',
        label: 'Policies',
        detail: 'max concurrency unlimited; retry limit 3; on ticket failure continue_independent; lease 900s'
      },
      { kind: 'added', target: 'rationale', id: 'rationale', label: 'Planning rationale', detail: 'Planning rationale added' }
    ])
  })

  it('omits an empty rationale and orders sprints by ordinal', () => {
    const next = makeBundle([[1], [2]])
    next.sprints.reverse()
    next.policies.maxConcurrency = 4
    expect(details(null, next)).toEqual([
      'added epic: Epic created',
      'added sprint: Sprint 1 added',
      'added sprint: Sprint 2 added',
      'added ticket: DM-1 Ticket 1 added to Sprint 1',
      'added ticket: DM-2 Ticket 2 added to Sprint 2',
      'added policies: max concurrency 4; retry limit 3; on ticket failure continue_independent; lease 900s'
    ])
  })
})

describe('computeChanges for tickets added and removed', () => {
  it('names the sprint a ticket was added to and removed from', () => {
    const base = makeBundle([[1, 2], [3]])
    const next = edited(base, (copy) => {
      copy.tickets = copy.tickets.filter((ticket) => ticket.id !== tid(2))
      copy.sprints[0].ticketIds = [tid(1)]
      copy.tickets.push(makeTicket(305, { title: 'Plan list view' }))
      copy.sprints[1].ticketIds.push(tid(305))
    })
    expect(computeChanges(base, next)).toEqual([
      { kind: 'added', target: 'ticket', id: tid(305), label: 'DM-305 Plan list view', detail: 'DM-305 Plan list view added to Sprint 2' },
      { kind: 'removed', target: 'ticket', id: tid(2), label: 'DM-2 Ticket 2', detail: 'DM-2 Ticket 2 removed from Sprint 1' }
    ])
  })

  it('says "no sprint" for a ticket outside every sprint', () => {
    const next = makeBundle([[1]])
    next.tickets.push(makeTicket(9))
    expect(details(makeBundle([[1]]), next)).toEqual(['added ticket: DM-9 Ticket 9 added to no sprint'])
  })
})

describe('computeChanges for edited tickets', () => {
  it('names every changed field in a fixed order', () => {
    const base = makeBundle([[1], [2]])
    const next = edited(base, (copy) => {
      const ticket = copy.tickets[0]
      Object.assign(ticket, {
        key: 'DM-9',
        title: 'Renamed',
        body: 'New body',
        acceptanceCriteria: [{ id: 'c1', text: 'Changed' }, { id: 'c2', text: 'Added' }],
        tags: ['ui'],
        priority: 'high',
        optional: true,
        references: [{ kind: 'url', label: 'Spec', location: 'https://example.com', hash: null, remoteOnly: true }],
        expectedArtifacts: ['report.md']
      })
      ticket.capability.workType = 'testing'
      copy.sprints[0].ticketIds = []
      copy.sprints[1].ticketIds.push(tid(1))
    })
    expect(computeChanges(base, next)).toEqual([
      {
        kind: 'edited',
        target: 'ticket',
        id: tid(1),
        label: 'DM-9 Renamed',
        detail:
          'key DM-1 → DM-9; title changed from "Ticket 1"; body edited; acceptance criteria edited (2 lines); tags changed; priority normal → high; capability profile changed; now optional; references changed; expected artifacts changed; moved from Sprint 1 to Sprint 2'
      }
    ])
  })
})

describe('computeChanges for criteria and flags', () => {
  it('counts one changed criterion line in the singular', () => {
    const base = makeBundle([[1]])
    const next = edited(base, (copy) => {
      copy.tickets[0].acceptanceCriteria = [{ id: 'c1', text: 'Reworded' }]
    })
    expect(details(base, next)).toEqual(['edited ticket: acceptance criteria edited (1 line)'])
  })

  it('counts removed criteria and reports pure reordering', () => {
    const base = makeBundle([[1, 2]])
    base.tickets[0].acceptanceCriteria.push({ id: 'c2', text: 'Second' }, { id: 'c3', text: 'Third' })
    base.tickets[1].acceptanceCriteria.push({ id: 'c2', text: 'Second' })
    const next = edited(base, (copy) => {
      copy.tickets[0].acceptanceCriteria = [{ id: 'c1', text: 'Ticket 1 works' }]
      copy.tickets[1].acceptanceCriteria.reverse()
    })
    expect(details(base, next)).toEqual([
      'edited ticket: acceptance criteria edited (2 lines)',
      'edited ticket: acceptance criteria reordered'
    ])
  })

  it('reports a ticket becoming required and keeps renumbered sprints from looking like moves', () => {
    const base = makeBundle([[1]])
    base.tickets[0].optional = true
    const next = edited(base, (copy) => {
      copy.tickets[0].optional = false
      copy.sprints[0].ordinal = 2
      copy.sprints.push({ ...copy.sprints[0], id: sid(9), ordinal: 1, ticketIds: [] })
    })
    expect(details(base, next)).toEqual([
      'added sprint: Sprint 1 added',
      'edited sprint: renumbered from Sprint 1',
      'edited ticket: now required'
    ])
  })
})

describe('computeChanges for sprints', () => {
  it('names each changed sprint field', () => {
    const base = makeBundle([[1, 2, 3], [4]])
    base.sprints[0].concurrencyCap = 2
    const next = edited(base, (copy) => {
      const sprint = copy.sprints[0]
      sprint.goal = 'New goal'
      sprint.entryCriteria = [{ id: 'n1', text: 'Ready' }]
      sprint.exitCriteria = [{ id: 'x1', text: 'Done' }]
      sprint.concurrencyCap = 3
      sprint.checkpoint = { mode: 'auto' }
      sprint.ticketIds = [tid(3), tid(1), tid(2)]
    })
    expect(details(base, next)).toEqual([
      'edited sprint: goal changed; entry criteria edited (1 line); exit criteria edited (1 line); concurrency cap 2 → 3; checkpoint mode human → auto; ticket order changed'
    ])
  })

  it('shows the plan default for a cleared cap and reports removed sprints last', () => {
    const base = makeBundle([[1], [], [2]])
    const next = edited(base, (copy) => {
      copy.sprints[0].concurrencyCap = 5
      copy.sprints = [copy.sprints[0], { ...copy.sprints[2], ordinal: 2 }]
    })
    const back = edited(next, (copy) => {
      copy.sprints[0].concurrencyCap = null
    })
    expect(details(base, next)).toEqual([
      'edited sprint: concurrency cap plan default → 5',
      'edited sprint: renumbered from Sprint 3',
      'removed sprint: Sprint 2 removed'
    ])
    expect(details(next, back)).toEqual(['edited sprint: concurrency cap 5 → plan default'])
  })
})

describe('computeChanges for edges and relations', () => {
  it('reports added and removed dependencies with the keys of their own side', () => {
    const base = makeBundle([[1, 2, 3]], [[1, 2]])
    const next = edited(base, (copy) => {
      copy.tickets = copy.tickets.filter((ticket) => ticket.id !== tid(1))
      copy.sprints[0].ticketIds = [tid(2), tid(3)]
      copy.edges = [{ from: tid(2), to: tid(3) }]
    })
    expect(computeChanges(base, next).filter((change) => change.target === 'edge')).toEqual([
      { kind: 'added', target: 'edge', id: `${tid(2)}->${tid(3)}`, label: 'DM-3 requires DM-2', detail: 'DM-3 now requires DM-2' },
      { kind: 'removed', target: 'edge', id: `${tid(1)}->${tid(2)}`, label: 'DM-2 requires DM-1', detail: 'DM-2 no longer requires DM-1' }
    ])
  })

  it('reports added and removed relations of each kind', () => {
    const base = makeBundle([[1, 2]], [], { relations: [{ kind: 'related_to', from: tid(1), to: tid(2) }] })
    const next = edited(base, (copy) => {
      copy.relations = [{ kind: 'duplicate_of', from: tid(2), to: tid(1) }]
    })
    expect(computeChanges(base, next)).toEqual([
      {
        kind: 'added',
        target: 'relation',
        id: `duplicate_of:${tid(2)}->${tid(1)}`,
        label: 'DM-2 duplicate of DM-1',
        detail: 'DM-2 marked duplicate of DM-1'
      },
      {
        kind: 'removed',
        target: 'relation',
        id: `related_to:${tid(1)}->${tid(2)}`,
        label: 'DM-1 related to DM-2',
        detail: 'DM-1 no longer marked related to DM-2'
      }
    ])
  })
})

describe('computeChanges for policies and rationale', () => {
  it('shows each changed policy with its old and new value', () => {
    const base = makeBundle([[1]])
    const next = edited(base, (copy) => {
      copy.policies = { maxConcurrency: 2, retryLimit: 5, onTicketFailure: 'pause_run', leaseSeconds: 600 }
    })
    const cleared = edited(next, (copy) => {
      copy.policies.maxConcurrency = null
    })
    expect(computeChanges(base, next)).toEqual([
      {
        kind: 'edited',
        target: 'policies',
        id: 'policies',
        label: 'Policies',
        detail: 'max concurrency unlimited → 2; retry limit 3 → 5; on ticket failure continue_independent → pause_run; lease 900s → 600s'
      }
    ])
    expect(details(next, cleared)).toEqual(['edited policies: max concurrency 2 → unlimited'])
  })

  it('distinguishes added, edited, and removed rationale', () => {
    const empty = makeBundle([[1]])
    const first = edited(empty, (copy) => {
      copy.rationale = 'First'
    })
    const second = edited(first, (copy) => {
      copy.rationale = 'Second'
    })
    expect(computeChanges(empty, first)).toEqual([
      { kind: 'added', target: 'rationale', id: 'rationale', label: 'Planning rationale', detail: 'Planning rationale added' }
    ])
    expect(details(first, second)).toEqual(['edited rationale: Planning rationale edited'])
    expect(details(second, empty)).toEqual(['removed rationale: Planning rationale removed'])
  })
})

describe('computeChanges for epic content', () => {
  it('names changed title, intent, success criteria, and owner role', () => {
    const base = makeBundle([[1]])
    const next = edited(base, (copy) => {
      copy.epic = {
        title: 'Renamed epic',
        intent: 'Different intent',
        successCriteria: [{ id: 's2', text: 'Another' }],
        ownerRole: 'qa'
      }
    })
    expect(computeChanges(base, next)).toEqual([
      {
        kind: 'edited',
        target: 'epic',
        id: 'epic',
        label: 'Renamed epic',
        detail: 'title changed from "Test epic"; intent edited; success criteria edited (2 lines); owner role none → qa'
      }
    ])
  })

  it('reports reordered success criteria and a cleared owner role', () => {
    const base = makeBundle([[1]])
    base.epic.successCriteria.push({ id: 's2', text: 'More' })
    base.epic.ownerRole = 'qa'
    const next = edited(base, (copy) => {
      copy.epic.successCriteria.reverse()
      copy.epic.ownerRole = null
    })
    expect(details(base, next)).toEqual(['edited epic: success criteria reordered; owner role qa → none'])
  })
})

describe('computeChanges for ticket size and reasoning effort', () => {
  const effortOf = (effort: 'low' | 'medium' | 'high') => (copy: PlanBundle) => {
    copy.tickets[0].capability.reasoning.effort = effort
  }

  it('shows a size set on a ticket, and a size changed', () => {
    const base = makeBundle([[1]])
    const sized = edited(base, (copy) => {
      copy.tickets[0].size = 'medium'
    })
    expect(details(base, sized)).toEqual(['edited ticket: size unset → medium'])
    const resized = edited(sized, (copy) => {
      copy.tickets[0].size = 'micro'
    })
    expect(details(sized, resized)).toEqual(['edited ticket: size medium → micro'])
  })

  it('shows a size removed again', () => {
    const sized = edited(makeBundle([[1]]), (copy) => {
      copy.tickets[0].size = 'small'
    })
    expect(details(sized, makeBundle([[1]]))).toEqual(['edited ticket: size small → unset'])
  })

  it('names an effort change on its own, without calling it a capability profile change', () => {
    const base = makeBundle([[1]])
    const next = edited(base, effortOf('high'))
    expect(details(base, next)).toEqual(['edited ticket: reasoning effort unset → high'])
    expect(details(next, edited(next, effortOf('low')))).toEqual(['edited ticket: reasoning effort high → low'])
  })

  it('reports the size, the effort and other capability edits side by side, in a fixed order', () => {
    const base = makeBundle([[1]])
    const next = edited(base, (copy) => {
      copy.tickets[0].priority = 'high'
      copy.tickets[0].size = 'large'
      copy.tickets[0].capability.workType = 'review'
      copy.tickets[0].capability.reasoning.effort = 'medium'
    })
    expect(details(base, next)).toEqual([
      'edited ticket: priority normal → high; size unset → large; reasoning effort unset → medium; capability profile changed'
    ])
  })
})

/** Sprint 1: work 1 and 2, and an acceptance node 3 whose first criterion covers DM-1. */
function acceptanceNode(): PlanBundle {
  const base = makeBundle([[1, 2, 3]])
  base.tickets[2] = makeTicket(3, {
    kind: 'acceptance',
    acceptanceCriteria: [
      { id: 'c1', text: 'DM-1 verified', covers: tid(1) },
      { id: 'c2', text: 'DM-2 verified' }
    ]
  })
  return base
}

describe('computeChanges for ticket kind and covered tickets', () => {
  it('shows a work ticket made an acceptance node, and the other way round', () => {
    const base = makeBundle([[1]])
    const made = edited(base, (copy) => {
      copy.tickets[0].kind = 'acceptance'
    })
    expect(details(base, made)).toEqual(['edited ticket: kind work → acceptance'])
    expect(details(made, base)).toEqual(['edited ticket: kind acceptance → work'])
  })

  it('does not report a ticket whose kind stays the same', () => {
    expect(details(acceptanceNode(), structuredClone(acceptanceNode()))).toEqual([])
  })

})

describe('computeChanges for covered tickets', () => {
  it('reports a covers set on a criterion as an edited line, not as a reordering', () => {
    const base = acceptanceNode()
    const next = edited(base, (copy) => {
      copy.tickets[2].acceptanceCriteria[1].covers = tid(2)
    })
    expect(details(base, next)).toEqual(['edited ticket: acceptance criteria edited (1 line)'])
  })

  it('reports a covers changed to another ticket, and a covers cleared', () => {
    const base = acceptanceNode()
    const moved = edited(base, (copy) => {
      copy.tickets[2].acceptanceCriteria[0].covers = tid(2)
    })
    expect(details(base, moved)).toEqual(['edited ticket: acceptance criteria edited (1 line)'])
    const cleared = edited(base, (copy) => {
      delete copy.tickets[2].acceptanceCriteria[0].covers
    })
    expect(details(base, cleared)).toEqual(['edited ticket: acceptance criteria edited (1 line)'])
  })

  it('still calls a pure reordering of covering criteria a reordering', () => {
    const base = acceptanceNode()
    const next = edited(base, (copy) => {
      copy.tickets[2].acceptanceCriteria.reverse()
    })
    expect(details(base, next)).toEqual(['edited ticket: acceptance criteria reordered'])
  })

  it('reports a kind change and a covers change in the same ticket together', () => {
    const base = acceptanceNode()
    const next = edited(base, (copy) => {
      delete copy.tickets[2].kind
      copy.tickets[2].acceptanceCriteria[0].covers = tid(2)
    })
    expect(details(base, next)).toEqual(['edited ticket: kind acceptance → work; acceptance criteria edited (1 line)'])
  })
})
