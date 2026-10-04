/**
 * Redrafting the next sprint from a retro: what moves where, what is added, what is skipped and why,
 * and that a second pass over the same retro changes nothing. Pure: a bundle in, a bundle and a change list out.
 */
import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { RetroDiscovery, RetroLeftover } from '../../shared/domain/retro'
import { makeBundle, makeTicket, sid, tid } from '../../test/bundles'
import { errorOf } from '../../test/checkpointSeed'
import type { DraftDeps } from './draftOps'
import { validatePlan } from './graph'
import { maxKeyNumber } from './normalize'
import { redraftBundle, type RedraftOutcome } from './redraft'

/** Readable, deterministic ids (`tk_new1`, `sp_new1`) and keys continuing after the bundle's own. */
function makeDeps(bundle: PlanBundle): DraftDeps {
  const counters = { ticket: 0, sprint: 0 }
  let key = maxKeyNumber(bundle.tickets.map((ticket) => ticket.key))
  return {
    newId: (kind) => {
      counters[kind] += 1
      return `${kind === 'ticket' ? 'tk' : 'sp'}_new${counters[kind]}`
    },
    nextKey: () => {
      key += 1
      return `DM-${key}`
    }
  }
}

/** Marks the numbered tickets as the acceptance nodes of their sprints, titled the way a new node is. */
function withNodes(bundle: PlanBundle, nodes: number[]): PlanBundle {
  bundle.tickets = bundle.tickets.map((ticket) => {
    const ordinal = nodes.findIndex((node) => tid(node) === ticket.id) + 1
    return ordinal === 0 ? ticket : { ...ticket, kind: 'acceptance' as const, title: `Sprint ${ordinal} acceptance` }
  })
  return bundle
}

/** Sprint 1: work DM-1..DM-3 and node DM-4. Sprint 2: work DM-5 and node DM-6. */
function plan(edges: [number, number][] = []): PlanBundle {
  return withNodes(makeBundle([[1, 2, 3, 4], [5, 6]], edges), [4, 6])
}

interface Request {
  sprintId?: string
  leftovers?: RetroLeftover[]
  discoveries?: RetroDiscovery[]
  accepted?: string[]
  keys?: Record<string, string>
}

function keysOf(bundle: PlanBundle): Map<string, string> {
  return new Map(bundle.tickets.map((ticket) => [ticket.id, ticket.key]))
}

function redraft(bundle: PlanBundle, request: Request = {}): RedraftOutcome {
  return redraftBundle(
    bundle,
    {
      sprintId: request.sprintId ?? sid(1),
      leftovers: request.leftovers ?? [],
      discoveries: request.discoveries ?? [],
      accepted: new Set(request.accepted ?? []),
      keys: new Map([...keysOf(bundle), ...Object.entries(request.keys ?? {})])
    },
    makeDeps(bundle)
  )
}

function leftover(ticket: number | string, reason = 'Not finished'): RetroLeftover {
  return { ticket: typeof ticket === 'number' ? tid(ticket) : ticket, reason }
}

function discovery(title: string, ticket: number | string | null = null, body = ''): RetroDiscovery {
  return { title, body, ticket: typeof ticket === 'number' ? tid(ticket) : ticket }
}

function idsIn(bundle: PlanBundle, ordinal: number): string[] {
  return bundle.sprints.find((sprint) => sprint.ordinal === ordinal)?.ticketIds ?? []
}

describe('moving leftovers', () => {
  it('moves each leftover from the active sprint to the next one, ahead of that sprint\'s acceptance node', () => {
    const out = redraft(plan(), { leftovers: [leftover(2, 'Waiting on a signing identity')] })
    expect(idsIn(out.bundle, 1)).toEqual([tid(1), tid(3), tid(4)])
    expect(idsIn(out.bundle, 2)).toEqual([tid(5), tid(2), tid(6)])
    expect(out.changed).toBe(true)
    expect(out.changes).toMatchObject({
      sprintId: sid(1),
      sprintOrdinal: 1,
      nextSprintId: sid(2),
      nextSprintOrdinal: 2,
      sprintAdded: false,
      moved: [{ ticketId: tid(2), key: 'DM-2', title: 'Ticket 2', reason: 'Waiting on a signing identity' }],
      dependentsMoved: [],
      added: [],
      skipped: [],
      droppedDependencies: []
    })
    expect(validatePlan(out.bundle).valid).toBe(true)
  })

  it('keeps the moved ticket exactly as it was: content, prerequisites and relations', () => {
    const bundle = plan([[1, 2]])
    bundle.relations = [{ kind: 'related_to', from: tid(2), to: tid(5) }]
    const out = redraft(bundle, { leftovers: [leftover(2)] })
    expect(out.bundle.tickets.find((ticket) => ticket.id === tid(2))).toEqual(bundle.tickets.find((ticket) => ticket.id === tid(2)))
    expect(out.bundle.edges).toEqual(bundle.edges)
    expect(out.bundle.relations).toEqual(bundle.relations)
    expect(out.bundle.tickets).toHaveLength(bundle.tickets.length)
  })

})

describe('moving several leftovers', () => {
  it('moves the leftovers in the order of the sprint they leave, whatever order the retro lists them in', () => {
    const out = redraft(plan(), { leftovers: [leftover(3), leftover(1)] })
    expect(idsIn(out.bundle, 2)).toEqual([tid(5), tid(1), tid(3), tid(6)])
    expect(out.changes.moved.map((item) => item.key)).toEqual(['DM-3', 'DM-1'])
  })

  it('moves a ticket once when the retro lists it twice', () => {
    const out = redraft(plan(), { leftovers: [leftover(2, 'First'), leftover(2, 'Second')] })
    expect(out.changes.moved).toEqual([{ ticketId: tid(2), key: 'DM-2', title: 'Ticket 2', reason: 'First' }])
    expect(out.changes.skipped).toEqual([])
    expect(idsIn(out.bundle, 2)).toEqual([tid(5), tid(2), tid(6)])
  })

  it('appends to a next sprint that has no acceptance node', () => {
    const bundle = withNodes(makeBundle([[1, 2], [3]]), [2])
    const out = redraft(bundle, { leftovers: [leftover(1)] })
    expect(idsIn(out.bundle, 1)).toEqual([tid(2)])
    expect(idsIn(out.bundle, 2)).toEqual([tid(3), tid(1)])
  })

  it('moves an optional leftover too', () => {
    const bundle = plan()
    bundle.tickets = bundle.tickets.map((ticket) => (ticket.id === tid(3) ? { ...ticket, optional: true } : ticket))
    expect(idsIn(redraft(bundle, { leftovers: [leftover(3)] }).bundle, 2)).toEqual([tid(5), tid(3), tid(6)])
  })
})

describe('prerequisites stay valid', () => {
  it('moves the dependents of a leftover along with it, transitively, in sprint order', () => {
    const bundle = withNodes(makeBundle([[1, 2, 3, 4, 5], [6, 7]], [[1, 2], [2, 3], [3, 4]]), [5, 7])
    const out = redraft(bundle, { leftovers: [leftover(2)] })
    expect(idsIn(out.bundle, 1)).toEqual([tid(1), tid(5)])
    expect(idsIn(out.bundle, 2)).toEqual([tid(6), tid(2), tid(3), tid(4), tid(7)])
    expect(out.changes.moved.map((item) => item.key)).toEqual(['DM-2'])
    expect(out.changes.dependentsMoved).toEqual([
      { ticketId: tid(3), key: 'DM-3', title: 'Ticket 3', requires: 'DM-2' },
      { ticketId: tid(4), key: 'DM-4', title: 'Ticket 4', requires: 'DM-3' }
    ])
    expect(out.bundle.edges).toEqual(bundle.edges)
    expect(validatePlan(out.bundle).valid).toBe(true)
  })

  it('does not list a dependent that is a leftover itself as moved along', () => {
    const bundle = withNodes(makeBundle([[1, 2, 3], [4, 5]], [[1, 2]]), [3, 5])
    const out = redraft(bundle, { leftovers: [leftover(1), leftover(2)] })
    expect(out.changes.moved.map((item) => item.key)).toEqual(['DM-1', 'DM-2'])
    expect(out.changes.dependentsMoved).toEqual([])
  })

  it('leaves dependents that are already in a later sprint where they are', () => {
    const bundle = plan([[2, 5]])
    const out = redraft(bundle, { leftovers: [leftover(2)] })
    expect(out.changes.dependentsMoved).toEqual([])
    expect(idsIn(out.bundle, 2)).toEqual([tid(5), tid(2), tid(6)])
    expect(validatePlan(out.bundle).valid).toBe(true)
  })

  it('drops an explicit dependency of the active sprint\'s acceptance node on a ticket that moved, and says so', () => {
    const bundle = plan([[3, 4]])
    const out = redraft(bundle, { leftovers: [leftover(3)] })
    expect(out.bundle.edges).toEqual([])
    expect(out.changes.droppedDependencies).toEqual([{ from: tid(3), to: tid(4) }])
    expect(out.changes.dependentsMoved).toEqual([])
    expect(idsIn(out.bundle, 1)).toEqual([tid(1), tid(2), tid(4)])
    expect(validatePlan(out.bundle).valid).toBe(true)
  })

  it('never moves the node of the active sprint, even for a dependent chain that reaches it', () => {
    const bundle = plan([[2, 3], [3, 4]])
    const out = redraft(bundle, { leftovers: [leftover(2)] })
    expect(idsIn(out.bundle, 1)).toEqual([tid(1), tid(4)])
    expect(out.changes.dependentsMoved.map((item) => item.key)).toEqual(['DM-3'])
    expect(out.changes.droppedDependencies).toEqual([{ from: tid(3), to: tid(4) }])
  })
})

describe('a sprint after the final one', () => {
  it('adds one, with its own acceptance node last, when the active sprint is the final sprint', () => {
    const bundle = withNodes(makeBundle([[1, 2, 3]]), [3])
    const out = redraft(bundle, { leftovers: [leftover(2)] })
    expect(out.bundle.sprints.map((sprint) => [sprint.id, sprint.ordinal])).toEqual([[sid(1), 1], ['sp_new1', 2]])
    expect(idsIn(out.bundle, 1)).toEqual([tid(1), tid(3)])
    expect(idsIn(out.bundle, 2)).toEqual([tid(2), 'tk_new1'])
    const node = out.bundle.tickets.find((ticket) => ticket.id === 'tk_new1')
    expect(node).toMatchObject({ kind: 'acceptance', key: 'DM-4', title: 'Sprint 2 acceptance' })
    expect(out.changes).toMatchObject({ nextSprintId: 'sp_new1', nextSprintOrdinal: 2, sprintAdded: true })
    expect(validatePlan(out.bundle).valid).toBe(true)
  })

  it('gives the added sprint a goal that names the sprint it came from', () => {
    const out = redraft(withNodes(makeBundle([[1, 2, 3]]), [3]), { leftovers: [leftover(2)] })
    expect(out.bundle.sprints[1]?.goal).toContain('Sprint 1')
  })

  it('does not touch the acceptance node of the active sprint', () => {
    const bundle = withNodes(makeBundle([[1, 2, 3]]), [3])
    const out = redraft(bundle, { leftovers: [leftover(2)] })
    expect(out.bundle.tickets.find((ticket) => ticket.id === tid(3))).toEqual(bundle.tickets.find((ticket) => ticket.id === tid(3)))
  })

  it('adds the sprint right after the active one when it is the last, whatever its ordinal', () => {
    const bundle = withNodes(makeBundle([[1, 2], [3, 4, 5]]), [2, 5])
    const out = redraft(bundle, { sprintId: sid(2), leftovers: [leftover(3)] })
    expect(out.bundle.sprints.map((sprint) => sprint.ordinal)).toEqual([1, 2, 3])
    expect(idsIn(out.bundle, 3)).toEqual([tid(3), 'tk_new1'])
    expect(out.changes).toMatchObject({ sprintOrdinal: 2, nextSprintOrdinal: 3, sprintAdded: true })
  })
})

describe('adding discoveries', () => {
  it('adds each discovery to the next sprint as an unsized ticket, after the moved leftovers and ahead of the node', () => {
    const out = redraft(plan(), {
      leftovers: [leftover(2)],
      discoveries: [discovery('Cache the host catalog', 1, 'Every claim reloads it.'), discovery('Document the ticket keys')]
    })
    expect(idsIn(out.bundle, 2)).toEqual([tid(5), tid(2), 'tk_new1', 'tk_new2', tid(6)])
    const [first, second] = ['tk_new1', 'tk_new2'].map((id) => out.bundle.tickets.find((ticket) => ticket.id === id))
    expect(first).toMatchObject({
      key: 'DM-7',
      title: 'Cache the host catalog',
      body: 'Every claim reloads it.',
      optional: false,
      acceptanceCriteria: [],
      references: [{ kind: 'ticket', label: 'DM-1', location: 'DM-1', hash: null, remoteOnly: false }]
    })
    expect(second).toMatchObject({ key: 'DM-8', title: 'Document the ticket keys', body: '', references: [] })
    expect(first).not.toHaveProperty('size')
    expect(second).not.toHaveProperty('size')
    expect(first).not.toHaveProperty('kind')
    expect(out.changes.added).toEqual([
      { ticketId: 'tk_new1', key: 'DM-7', title: 'Cache the host catalog', source: 'DM-1' },
      { ticketId: 'tk_new2', key: 'DM-8', title: 'Document the ticket keys', source: null }
    ])
    expect(validatePlan(out.bundle).valid).toBe(true)
  })

  it('references the source ticket by display key even when the draft no longer holds it', () => {
    const out = redraft(plan(), { discoveries: [discovery('Revive the cache', 'tk_gone')], keys: { tk_gone: 'DM-40' } })
    expect(out.bundle.tickets.find((ticket) => ticket.id === 'tk_new1')?.references).toEqual([
      { kind: 'ticket', label: 'DM-40', location: 'DM-40', hash: null, remoteOnly: false }
    ])
    expect(out.changes.added[0]?.source).toBe('DM-40')
  })

  it('adds a discovery with no leftover at all, and adds the next sprint when there is none', () => {
    const out = redraft(withNodes(makeBundle([[1, 2]]), [2]), { discoveries: [discovery('Profile the claim path')] })
    expect(idsIn(out.bundle, 2)).toEqual(['tk_new2', 'tk_new1'])
    expect(out.changes).toMatchObject({ sprintAdded: true, nextSprintOrdinal: 2, moved: [] })
    expect(out.bundle.tickets.find((ticket) => ticket.id === 'tk_new1')).toMatchObject({ kind: 'acceptance' })
    expect(validatePlan(out.bundle).valid).toBe(true)
  })

  it('trims the title of the ticket it adds', () => {
    const out = redraft(plan(), { discoveries: [discovery('  Trim me  ')] })
    expect(out.changes.added.map((item) => item.title)).toEqual(['Trim me'])
  })
})

/** Sprints 1..3, each with two work tickets and its node: DM-1 DM-2 node 3; DM-4 DM-5 node 6; DM-7 DM-8 node 9. */
function threeSprints(): PlanBundle {
  return withNodes(makeBundle([[1, 2, 3], [4, 5, 6], [7, 8, 9]]), [3, 6, 9])
}

describe('leftovers that are skipped, and why', () => {
  it('skips the acceptance node of the active sprint and moves nothing for it', () => {
    const bundle = threeSprints()
    const out = redraft(bundle, { leftovers: [leftover(3, 'Node was never accepted')] })
    expect(out.changed).toBe(false)
    expect(out.bundle).toEqual(bundle)
    expect(out.changes.skipped).toEqual([
      {
        kind: 'leftover',
        ticketId: tid(3),
        label: 'DM-3',
        code: 'acceptance_node',
        message: expect.stringContaining('DM-3 is an acceptance node')
      }
    ])
  })

  it('skips a leftover that is not in the active sprint and names the sprint it is in', () => {
    const out = redraft(threeSprints(), { leftovers: [leftover(8)] })
    expect(out.changes.skipped).toMatchObject([{ kind: 'leftover', ticketId: tid(8), code: 'not_in_active_sprint' }])
    expect(out.changes.skipped[0]?.message).toContain('Sprint 3')
    expect(out.changed).toBe(false)
  })

  it('skips a leftover that is already in the next sprint', () => {
    const out = redraft(threeSprints(), { leftovers: [leftover(4)] })
    expect(out.changes.skipped).toMatchObject([{ ticketId: tid(4), code: 'already_in_next_sprint' }])
    expect(out.changed).toBe(false)
  })

  it('skips a leftover the draft no longer has, labelled by its key when the retro\'s plan had it', () => {
    const out = redraft(threeSprints(), { leftovers: [leftover('tk_gone')], keys: { tk_gone: 'DM-41' } })
    expect(out.changes.skipped).toMatchObject([{ kind: 'leftover', ticketId: 'tk_gone', label: 'DM-41', code: 'not_in_draft' }])
  })

  it('labels a leftover the draft and the run both lack by its id', () => {
    const out = redraft(threeSprints(), { leftovers: [leftover('tk_unknown')] })
    expect(out.changes.skipped).toMatchObject([{ ticketId: 'tk_unknown', label: 'tk_unknown', code: 'not_in_draft' }])
  })

  it('skips a leftover the run has accepted since the retro was written', () => {
    const out = redraft(threeSprints(), { leftovers: [leftover(2)], accepted: [tid(2)] })
    expect(out.changes.skipped).toMatchObject([{ ticketId: tid(2), code: 'already_accepted' }])
    expect(out.changed).toBe(false)
  })

})

describe('skipping some leftovers while moving the others', () => {
  it('does not report an accepted leftover as skipped when a moving ticket pulls it along anyway', () => {
    const bundle = withNodes(makeBundle([[1, 2, 3], [4, 5]], [[1, 2]]), [3, 5])
    const out = redraft(bundle, { leftovers: [leftover(1), leftover(2)], accepted: [tid(2)] })
    expect(out.changes.dependentsMoved.map((item) => item.key)).toEqual(['DM-2'])
    expect(out.changes.skipped).toEqual([])
    expect(idsIn(out.bundle, 1)).toEqual([tid(3)])
  })

  it('moves the leftovers it can and skips the rest in the same pass', () => {
    const out = redraft(threeSprints(), { leftovers: [leftover(3), leftover(1), leftover(8)] })
    expect(out.changes.moved.map((item) => item.key)).toEqual(['DM-1'])
    expect(out.changes.skipped.map((item) => [item.label, item.code])).toEqual([
      ['DM-3', 'acceptance_node'],
      ['DM-8', 'not_in_active_sprint']
    ])
  })

  it('adds no sprint when everything was skipped on the final sprint', () => {
    const bundle = withNodes(makeBundle([[1, 2]]), [2])
    const out = redraft(bundle, { leftovers: [leftover(2)] })
    expect(out.bundle.sprints).toHaveLength(1)
    expect(out.changes).toMatchObject({ sprintAdded: false, nextSprintId: null, nextSprintOrdinal: null })
    expect(out.changed).toBe(false)
  })
})

describe('discoveries that are skipped, and why', () => {
  it('skips a discovery whose title a ticket of the draft already has, ignoring case and spacing, and names that ticket', () => {
    const out = redraft(plan(), { discoveries: [discovery('  ticket 5 ')] })
    expect(out.changes.added).toEqual([])
    expect(out.changes.skipped).toEqual([
      {
        kind: 'discovery',
        ticketId: null,
        label: 'ticket 5',
        code: 'already_drafted',
        message: expect.stringContaining('DM-5')
      }
    ])
    expect(out.changed).toBe(false)
  })

  it('skips a discovery with a blank title', () => {
    const out = redraft(plan(), { discoveries: [discovery('   ')] })
    expect(out.changes.skipped).toMatchObject([{ kind: 'discovery', label: '', code: 'blank_title' }])
    expect(out.changed).toBe(false)
  })

  it('does not take an acceptance node\'s title for a drafted ticket', () => {
    const out = redraft(plan(), { discoveries: [discovery('Sprint 2 acceptance')] })
    expect(out.changes.added.map((item) => item.title)).toEqual(['Sprint 2 acceptance'])
  })

  it('adds two discoveries with the same title once', () => {
    const out = redraft(plan(), { discoveries: [discovery('Same title'), discovery('same title')] })
    expect(out.changes.added.map((item) => item.title)).toEqual(['Same title'])
    expect(out.changes.skipped.map((item) => item.code)).toEqual(['already_drafted'])
  })
})

describe('nothing to do', () => {
  it('changes nothing, adds no sprint and says there is no next sprint when the retro has no leftovers or discoveries', () => {
    const bundle = withNodes(makeBundle([[1, 2]]), [2])
    const out = redraft(bundle)
    expect(out.changed).toBe(false)
    expect(out.bundle).toEqual(bundle)
    expect(out.changes).toEqual({
      sprintId: sid(1),
      sprintOrdinal: 1,
      nextSprintId: null,
      nextSprintOrdinal: null,
      sprintAdded: false,
      moved: [],
      dependentsMoved: [],
      added: [],
      skipped: [],
      droppedDependencies: []
    })
  })

  it('still names the next sprint when it exists', () => {
    const out = redraft(plan())
    expect(out.changes).toMatchObject({ nextSprintId: sid(2), nextSprintOrdinal: 2, sprintAdded: false })
  })

  it('does not change the bundle it was given', () => {
    const bundle = plan([[2, 3]])
    const before = structuredClone(bundle)
    redraft(bundle, { leftovers: [leftover(2)], discoveries: [discovery('New work')] })
    expect(bundle).toEqual(before)
  })
})

describe('a second pass over the same retro', () => {
  it('adds no duplicates: nothing moves again, nothing is added again, and the bundle stays as the first pass left it', () => {
    const request: Request = {
      leftovers: [leftover(2, 'Waiting on a signing identity')],
      discoveries: [discovery('Cache the host catalog', 1, 'Every claim reloads it.'), discovery('Document the ticket keys')]
    }
    const first = redraft(plan([[2, 3]]), request)
    const second = redraft(first.bundle, request)
    expect(second.changed).toBe(false)
    expect(second.bundle).toEqual(first.bundle)
    expect(second.changes.moved).toEqual([])
    expect(second.changes.added).toEqual([])
    expect(second.changes.skipped.map((item) => [item.label, item.code])).toEqual([
      ['DM-2', 'already_in_next_sprint'],
      ['Cache the host catalog', 'already_drafted'],
      ['Document the ticket keys', 'already_drafted']
    ])
  })

  it('adds no second sprint after a final sprint', () => {
    const request: Request = { leftovers: [leftover(2)], discoveries: [discovery('New work')] }
    const first = redraft(withNodes(makeBundle([[1, 2, 3]]), [3]), request)
    const second = redraft(first.bundle, request)
    expect(second.bundle.sprints).toHaveLength(2)
    expect(second.changed).toBe(false)
    expect(second.changes).toMatchObject({ sprintAdded: false, nextSprintId: 'sp_new1' })
  })
})

describe('refusals', () => {
  it('refuses a retro whose sprint the draft no longer has', () => {
    const result = errorOf(() => redraft(plan(), { sprintId: sid(9), leftovers: [leftover(2)] }))
    expect(result).toMatchObject({ code: 'conflict', message: expect.stringContaining(sid(9)) })
  })
})

describe('the rest of the draft', () => {
  it('keeps unrelated tickets, edges and sprints as they were', () => {
    const bundle = plan([[1, 5]])
    bundle.tickets.push(makeTicket(9, { title: 'Unrelated' }))
    bundle.sprints = bundle.sprints.map((sprint) => (sprint.ordinal === 2 ? { ...sprint, ticketIds: [...sprint.ticketIds, tid(9)] } : sprint))
    const out = redraft(bundle, { discoveries: [discovery('Fresh idea')] })
    expect(out.bundle.edges).toEqual(bundle.edges)
    expect(idsIn(out.bundle, 1)).toEqual(idsIn(bundle, 1))
    expect(out.bundle.tickets.filter((ticket) => ticket.id !== 'tk_new1').map((ticket) => ticket.id)).toEqual(bundle.tickets.map((ticket) => ticket.id))
  })
})
