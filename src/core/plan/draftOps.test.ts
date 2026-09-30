import { describe, expect, it } from 'vitest'
import type { DraftOp } from '../../shared/domain/api'
import type { PlanBundle } from '../../shared/domain/bundle'
import { makeBundle, makeSprint, makeTicket, sid, tid } from '../../test/bundles'
import { DomainError } from '../errors'
import { applyDraftOps, type DraftOpsResult } from './draftOps'
import { validatePlan } from './graph'
import { maxKeyNumber } from './normalize'

const LATER_SPRINT_TAIL = 'A prerequisite must be in the same sprint or an earlier one.'

/** Sprint 1 {DM-1, DM-2}, sprint 2 {DM-3}, DM-3 requires DM-1. */
function baseBundle(): PlanBundle {
  return makeBundle([[1, 2], [3]], [[1, 3]])
}

/** Readable, deterministic ids (`tk_new1`, `sp_new1`) and keys continuing after the bundle's own. */
function makeDeps(bundle: PlanBundle): { newId(kind: 'ticket' | 'sprint'): string; nextKey(): string } {
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

function apply(bundle: PlanBundle, ...ops: DraftOp[]): DraftOpsResult {
  return applyDraftOps(bundle, ops, makeDeps(bundle))
}

interface Rejection {
  code: string
  message: string
  details: Record<string, unknown> | undefined
}

function rejection(bundle: PlanBundle, ...ops: DraftOp[]): Rejection | undefined {
  try {
    apply(bundle, ...ops)
  } catch (error: unknown) {
    if (error instanceof DomainError) {
      return { code: error.code, message: error.message, details: error.details }
    }
    throw error
  }
  return undefined
}

function ticketIdsOf(bundle: PlanBundle, ordinal: number): string[] {
  return bundle.sprints.find((sprint) => sprint.ordinal === ordinal)?.ticketIds ?? []
}

function ordinals(bundle: PlanBundle): [string, number][] {
  return bundle.sprints.map((sprint) => [sprint.id, sprint.ordinal])
}

describe('applyDraftOps batches', () => {
  it('returns an independent copy and an empty ref map for no ops', () => {
    const input = baseBundle()
    const result = applyDraftOps(input, [], makeDeps(input))
    expect(result.bundle).toEqual(baseBundle())
    expect(result.bundle).not.toBe(input)
    expect(result.bundle.tickets).not.toBe(input.tickets)
    expect(result.refMap).toEqual({})
  })

  it('applies ops in order, later ops seeing earlier ones', () => {
    const { bundle } = apply(
      baseBundle(),
      { op: 'add_ticket', ref: 'a', sprint: '2', ticket: { title: 'First' } },
      { op: 'update_ticket', ticket: 'a', patch: { title: 'Renamed' } },
      { op: 'add_dependency', from: 'DM-2', to: 'a' }
    )
    expect(bundle.tickets.map((ticket) => ticket.title)).toEqual(['Ticket 1', 'Ticket 2', 'Ticket 3', 'Renamed'])
    expect(bundle.edges).toEqual([
      { from: tid(1), to: tid(3) },
      { from: tid(2), to: 'tk_new1' }
    ])
  })

  it('never modifies the input bundle, on success or failure', () => {
    const input = baseBundle()
    apply(input, { op: 'remove_ticket', ticket: 'DM-1' }, { op: 'set_rationale', rationale: 'changed' })
    expect(input).toEqual(baseBundle())
    rejection(input, { op: 'remove_ticket', ticket: 'DM-2' }, { op: 'remove_ticket', ticket: 'DM-99' })
    expect(input).toEqual(baseBundle())
  })

})

describe('applyDraftOps failures', () => {
  it('is all-or-nothing: a failing op rejects the whole request with its index and name', () => {
    const failure = rejection(
      baseBundle(),
      { op: 'set_rationale', rationale: 'fine' },
      { op: 'set_epic', title: 'Also fine' },
      { op: 'remove_ticket', ticket: 'DM-99' }
    )
    expect(failure).toEqual({
      code: 'not_found',
      message: 'Unknown ticket "DM-99".',
      details: { opIndex: 2, op: 'remove_ticket' }
    })
  })

  it('reports index 0 for a first-op failure', () => {
    const failure = rejection(baseBundle(), { op: 'remove_sprint', sprint: '9' })
    expect(failure?.details).toEqual({ opIndex: 0, op: 'remove_sprint' })
  })

  it('lets errors that are not domain errors escape untouched', () => {
    const deps = {
      newId: (): string => {
        throw new Error('id source exhausted')
      },
      nextKey: () => 'DM-4'
    }
    const attempt = (): DraftOpsResult =>
      applyDraftOps(baseBundle(), [{ op: 'add_ticket', sprint: '1', ticket: { title: 'x' } }], deps)
    expect(attempt).toThrow('id source exhausted')
    expect(attempt).not.toThrow(DomainError)
  })

  it('produces a plan that validates after a realistic batch', () => {
    const { bundle } = apply(
      baseBundle(),
      { op: 'add_sprint', ref: 's', sprint: { goal: 'Hardening' } },
      { op: 'add_ticket', ref: 't', sprint: 's', ticket: { title: 'Harden', acceptanceCriteria: ['is hard'] } },
      { op: 'add_dependency', from: 'DM-3', to: 't' }
    )
    expect(validatePlan(bundle).errors).toEqual([])
  })
})

describe('applyDraftOps unknown operations', () => {
  it('rejects an unknown operation name', () => {
    const op = { op: 'explode' } as unknown as DraftOp
    expect(rejection(baseBundle(), op)).toEqual({
      code: 'invalid_input',
      message: 'Unknown draft operation "explode".',
      details: { opIndex: 0, op: 'explode' }
    })
  })

  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])(
    'rejects the inherited property name %s used as an operation',
    (name) => {
      const op = { op: name } as unknown as DraftOp
      expect(rejection(baseBundle(), op)?.message).toBe(`Unknown draft operation "${name}".`)
    }
  )
})

describe('applyDraftOps client refs', () => {
  it('maps declared refs to the ids they received', () => {
    const { refMap } = apply(
      baseBundle(),
      { op: 'add_sprint', ref: 'hardening', sprint: { goal: 'g' } },
      { op: 'add_ticket', ref: 'task.a', sprint: 'hardening', ticket: { title: 'A' } },
      { op: 'add_ticket', sprint: '1', ticket: { title: 'no ref' } }
    )
    expect(refMap).toEqual({ hardening: 'sp_new1', 'task.a': 'tk_new1' })
  })

  it('rejects a ref declared twice in one request, even across sprints and tickets', () => {
    const twice = rejection(
      baseBundle(),
      { op: 'add_sprint', ref: 'x', sprint: { goal: 'g' } },
      { op: 'add_ticket', ref: 'x', sprint: '1', ticket: { title: 'T' } }
    )
    expect(twice).toEqual({
      code: 'invalid_input',
      message: 'Client ref "x" is declared twice in one request.',
      details: { opIndex: 1, op: 'add_ticket' }
    })
    const sprints = rejection(
      baseBundle(),
      { op: 'add_sprint', ref: 'y', sprint: { goal: 'a' } },
      { op: 'add_sprint', ref: 'y', sprint: { goal: 'b' } }
    )
    expect(sprints?.code).toBe('invalid_input')
  })

  it('lets different refs coexist and does not carry refs between requests', () => {
    const distinct = rejection(
      baseBundle(),
      { op: 'add_sprint', ref: 'a', sprint: { goal: 'g' } },
      { op: 'add_sprint', ref: 'b', sprint: { goal: 'g' } }
    )
    expect(distinct).toBeUndefined()
    const first = apply(baseBundle(), { op: 'add_sprint', ref: 'a', sprint: { goal: 'g' } })
    const second = apply(first.bundle, { op: 'add_sprint', ref: 'a', sprint: { goal: 'again' } })
    expect(second.refMap).toEqual({ a: 'sp_new1' })
  })

})

describe('applyDraftOps ref resolution', () => {
  it('resolves tickets by stable id, by key and by ref', () => {
    const { bundle } = apply(
      baseBundle(),
      { op: 'add_ticket', ref: 'new', sprint: '1', ticket: { title: 'New' } },
      { op: 'update_ticket', ticket: tid(1), patch: { priority: 'low' } },
      { op: 'update_ticket', ticket: 'DM-2', patch: { priority: 'high' } },
      { op: 'update_ticket', ticket: 'new', patch: { priority: 'critical' } }
    )
    expect(bundle.tickets.map((ticket) => ticket.priority)).toEqual(['low', 'high', 'normal', 'critical'])
  })

  it('resolves sprints by stable id, by ordinal string and by ref', () => {
    const { bundle } = apply(
      baseBundle(),
      { op: 'add_sprint', ref: 'extra', sprint: { goal: 'third' } },
      { op: 'update_sprint', sprint: sid(1), patch: { goal: 'by id' } },
      { op: 'update_sprint', sprint: '2', patch: { goal: 'by ordinal' } },
      { op: 'update_sprint', sprint: 'extra', patch: { goal: 'by ref' } }
    )
    expect(bundle.sprints.map((sprint) => sprint.goal)).toEqual(['by id', 'by ordinal', 'by ref'])
  })

  it('reports unknown tickets and sprints as not found', () => {
    const ticket = rejection(baseBundle(), { op: 'update_ticket', ticket: 'DM-99', patch: {} })
    expect(ticket).toEqual({
      code: 'not_found',
      message: 'Unknown ticket "DM-99".',
      details: { opIndex: 0, op: 'update_ticket' }
    })
    const sprint = rejection(baseBundle(), { op: 'update_sprint', sprint: 'nope', patch: {} })
    expect(sprint).toEqual({ code: 'not_found', message: 'Unknown sprint "nope".', details: { opIndex: 0, op: 'update_sprint' } })
  })

  it.each(['0', '3', '10', '-1', '1.5', ' 1', '1a'])('does not resolve %j as a sprint ordinal', (ref) => {
    expect(rejection(baseBundle(), { op: 'remove_sprint', sprint: ref })?.message).toBe(`Unknown sprint "${ref}".`)
  })

  it('does not resolve a ticket ref as a sprint or a sprint ref as a ticket', () => {
    const asSprint = rejection(
      baseBundle(),
      { op: 'add_ticket', ref: 'a', sprint: '1', ticket: { title: 'T' } },
      { op: 'update_sprint', sprint: 'a', patch: {} }
    )
    const asTicket = rejection(
      baseBundle(),
      { op: 'add_sprint', ref: 's', sprint: { goal: 'g' } },
      { op: 'update_ticket', ticket: 's', patch: {} }
    )
    expect(asSprint?.message).toBe('Unknown sprint "a".')
    expect(asTicket?.message).toBe('Unknown ticket "s".')
  })
})

describe('applyDraftOps refs named like inherited properties', () => {
  const NAMES = ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']

  it.each(NAMES)('accepts %s as a client ref', (ref) => {
    const { bundle, refMap } = apply(
      baseBundle(),
      { op: 'add_ticket', ref, sprint: '1', ticket: { title: 'New' } },
      { op: 'update_ticket', ticket: ref, patch: { title: 'Renamed' } }
    )
    expect(bundle.tickets[3]?.title).toBe('Renamed')
    expect(Object.keys(refMap)).toEqual([ref])
    expect(refMap[ref]).toBe('tk_new1')
  })

  it.each(NAMES)('still rejects %s declared twice', (ref) => {
    const failure = rejection(
      baseBundle(),
      { op: 'add_sprint', ref, sprint: { goal: 'g' } },
      { op: 'add_ticket', ref, sprint: '1', ticket: { title: 'T' } }
    )
    expect(failure?.message).toBe(`Client ref "${ref}" is declared twice in one request.`)
  })

  it('does not treat an undeclared inherited name as a ref', () => {
    const failure = rejection(baseBundle(), { op: 'update_ticket', ticket: 'constructor', patch: {} })
    expect(failure?.message).toBe('Unknown ticket "constructor".')
    expect(rejection(baseBundle(), { op: 'remove_sprint', sprint: '__proto__' })?.message).toBe('Unknown sprint "__proto__".')
  })

  it('never pollutes Object.prototype', () => {
    apply(baseBundle(), { op: 'add_sprint', ref: '__proto__', sprint: { goal: 'g' } })
    expect(Reflect.getPrototypeOf({})).toBe(Object.prototype)
    expect(Object.keys(Object.prototype)).toEqual([])
    expect(({} as Record<string, unknown>).sp_new1).toBeUndefined()
  })
})

describe('set_epic', () => {
  const withOwner = (): PlanBundle => {
    const bundle = baseBundle()
    bundle.epic.ownerRole = 'lead'
    return bundle
  }

  it('changes nothing when no field is given', () => {
    expect(apply(withOwner(), { op: 'set_epic' }).bundle.epic).toEqual(withOwner().epic)
  })

  it('sets a trimmed title and an intent, leaving other fields alone', () => {
    const { epic } = apply(withOwner(), { op: 'set_epic', title: '  New title ', intent: '# Why' }).bundle
    expect(epic).toEqual({ ...withOwner().epic, title: 'New title', intent: '# Why' })
  })

  it('normalizes success criteria against the existing ones with the s prefix', () => {
    const { epic } = apply(baseBundle(), { op: 'set_epic', successCriteria: ['Everything works', 'Second goal'] }).bundle
    expect(epic.successCriteria).toEqual([
      { id: 's1', text: 'Everything works' },
      { id: 's2', text: 'Second goal' }
    ])
    expect(apply(baseBundle(), { op: 'set_epic', successCriteria: [] }).bundle.epic.successCriteria).toEqual([])
  })

  it('sets and clears the owner role', () => {
    expect(apply(baseBundle(), { op: 'set_epic', ownerRole: 'reviewer' }).bundle.epic.ownerRole).toBe('reviewer')
    expect(apply(withOwner(), { op: 'set_epic', ownerRole: null }).bundle.epic.ownerRole).toBeNull()
    expect(apply(withOwner(), { op: 'set_epic', title: 'x' }).bundle.epic.ownerRole).toBe('lead')
  })
})

describe('add_sprint', () => {
  it('appends a sprint with the next ordinal and a generated id', () => {
    const { bundle } = apply(baseBundle(), { op: 'add_sprint', sprint: { goal: '  Polish  ' } })
    expect(bundle.sprints).toHaveLength(3)
    expect(bundle.sprints[2]).toEqual({
      id: 'sp_new1',
      ordinal: 3,
      goal: 'Polish',
      ticketIds: [],
      entryCriteria: [],
      exitCriteria: [],
      concurrencyCap: null,
      checkpoint: { mode: 'human' }
    })
  })

  it('passes criteria, cap and checkpoint mode through', () => {
    const { bundle } = apply(baseBundle(), {
      op: 'add_sprint',
      sprint: { goal: 'g', entryCriteria: ['ready'], exitCriteria: ['done'], concurrencyCap: 2, checkpoint: { mode: 'auto' } }
    })
    expect(bundle.sprints[2]).toMatchObject({
      entryCriteria: [{ id: 'n1', text: 'ready' }],
      exitCriteria: [{ id: 'x1', text: 'done' }],
      concurrencyCap: 2,
      checkpoint: { mode: 'auto' }
    })
  })

  it('inserts at a 1-based position and renumbers the sprints after it', () => {
    const { bundle } = apply(baseBundle(), { op: 'add_sprint', ref: 'mid', sprint: { goal: 'middle' }, position: 2 })
    expect(ordinals(bundle)).toEqual([[sid(1), 1], ['sp_new1', 2], [sid(2), 3]])
    expect(ticketIdsOf(bundle, 3)).toEqual([tid(3)])
  })

  it('inserts at the front for position 1 and clamps positions outside the range', () => {
    expect(ordinals(apply(baseBundle(), { op: 'add_sprint', sprint: { goal: 'g' }, position: 1 }).bundle)).toEqual([
      ['sp_new1', 1],
      [sid(1), 2],
      [sid(2), 3]
    ])
    const atZero = apply(baseBundle(), { op: 'add_sprint', sprint: { goal: 'g' }, position: 0 }).bundle
    const beyond = apply(baseBundle(), { op: 'add_sprint', sprint: { goal: 'g' }, position: 99 }).bundle
    expect(ordinals(atZero)[0]).toEqual(['sp_new1', 1])
    expect(ordinals(beyond)[2]).toEqual(['sp_new1', 3])
  })

})

describe('add_sprint ordering', () => {
  it('keeps existing sprints in ordinal order even when stored out of order', () => {
    const shuffled = makeBundle([[1], [2]], [], { sprints: [makeSprint(2, [2]), makeSprint(1, [1])] })
    const { bundle } = apply(shuffled, { op: 'add_sprint', sprint: { goal: 'g' } })
    expect(ordinals(bundle)).toEqual([[sid(1), 1], [sid(2), 2], ['sp_new1', 3]])
  })

  it('keeps the tickets and criteria of existing sprints untouched', () => {
    const { bundle } = apply(baseBundle(), { op: 'add_sprint', sprint: { goal: 'g' }, position: 1 })
    expect(bundle.sprints[1]?.ticketIds).toEqual([tid(1), tid(2)])
    expect(bundle.sprints[1]?.goal).toBe('Sprint 1 goal')
  })
})

describe('update_sprint', () => {
  it('patches only the addressed sprint', () => {
    const { bundle } = apply(baseBundle(), {
      op: 'update_sprint',
      sprint: '2',
      patch: { goal: '  Changed ', concurrencyCap: 4, checkpoint: { mode: 'auto' } }
    })
    expect(bundle.sprints[1]).toMatchObject({
      goal: 'Changed',
      concurrencyCap: 4,
      checkpoint: { mode: 'auto' },
      ticketIds: [tid(3)]
    })
    expect(bundle.sprints[0]).toEqual(baseBundle().sprints[0])
  })

  it('clears the cap with null and keeps it when omitted', () => {
    const capped = makeBundle([[1]], [], { sprints: [makeSprint(1, [1], { concurrencyCap: 3 })] })
    const cleared = apply(capped, { op: 'update_sprint', sprint: '1', patch: { concurrencyCap: null } })
    const kept = apply(capped, { op: 'update_sprint', sprint: '1', patch: { goal: 'x' } })
    expect(cleared.bundle.sprints[0]?.concurrencyCap).toBeNull()
    expect(kept.bundle.sprints[0]?.concurrencyCap).toBe(3)
  })

  it('updates criteria in place, reusing ids by text', () => {
    const start = apply(baseBundle(), { op: 'update_sprint', sprint: '1', patch: { exitCriteria: ['tests pass'] } }).bundle
    const { bundle } = apply(start, { op: 'update_sprint', sprint: '1', patch: { exitCriteria: ['docs', 'tests pass'] } })
    expect(bundle.sprints[0]?.exitCriteria).toEqual([{ id: 'x2', text: 'docs' }, { id: 'x1', text: 'tests pass' }])
  })
})

describe('remove_sprint', () => {
  it('removes an empty sprint and renumbers the ones after it', () => {
    const plan = makeBundle([[1], [], [3]], [[1, 3]])
    const { bundle } = apply(plan, { op: 'remove_sprint', sprint: '2' })
    expect(ordinals(bundle)).toEqual([[sid(1), 1], [sid(3), 2]])
    expect(bundle.sprints.map((sprint) => sprint.ticketIds)).toEqual([[tid(1)], [tid(3)]])
  })

  it('refuses to remove a sprint that still has tickets', () => {
    expect(rejection(baseBundle(), { op: 'remove_sprint', sprint: '1' })).toEqual({
      code: 'invalid_input',
      message: 'Sprint 1 still has 2 ticket(s). Move or remove them first.',
      details: { opIndex: 0, op: 'remove_sprint' }
    })
    expect(rejection(baseBundle(), { op: 'remove_sprint', sprint: sid(2) })?.message).toBe(
      'Sprint 2 still has 1 ticket(s). Move or remove them first.'
    )
  })

  it('refuses to remove the last remaining sprint', () => {
    expect(rejection(makeBundle([[]]), { op: 'remove_sprint', sprint: '1' })).toEqual({
      code: 'invalid_input',
      message: 'A plan keeps at least one sprint.',
      details: { opIndex: 0, op: 'remove_sprint' }
    })
  })

  it('checks tickets before the last-sprint rule', () => {
    expect(rejection(makeBundle([[1]]), { op: 'remove_sprint', sprint: '1' })?.message).toBe(
      'Sprint 1 still has 1 ticket(s). Move or remove them first.'
    )
  })

  it('allows removing a sprint added in the same request', () => {
    const { bundle } = apply(
      baseBundle(),
      { op: 'add_sprint', ref: 'temp', sprint: { goal: 'g' } },
      { op: 'remove_sprint', sprint: 'temp' }
    )
    expect(bundle.sprints).toHaveLength(2)
  })
})

describe('add_ticket', () => {
  it('builds the ticket, allocates the next key and appends it to the sprint', () => {
    const { bundle } = apply(baseBundle(), {
      op: 'add_ticket',
      sprint: '2',
      ticket: {
        title: '  New work ',
        body: 'notes',
        acceptanceCriteria: ['it works'],
        tags: ['api'],
        priority: 'high',
        optional: true
      }
    })
    const added = bundle.tickets[3]
    expect(added).toMatchObject({
      id: 'tk_new1',
      key: 'DM-4',
      title: 'New work',
      body: 'notes',
      acceptanceCriteria: [{ id: 'c1', text: 'it works' }],
      tags: ['api'],
      priority: 'high',
      optional: true
    })
    expect(ticketIdsOf(bundle, 2)).toEqual([tid(3), 'tk_new1'])
    expect(ticketIdsOf(bundle, 1)).toEqual([tid(1), tid(2)])
  })

  it('allocates increasing keys for several tickets', () => {
    const { bundle } = apply(
      baseBundle(),
      { op: 'add_ticket', sprint: '1', ticket: { title: 'a' } },
      { op: 'add_ticket', sprint: '1', ticket: { title: 'b' } }
    )
    expect(bundle.tickets.slice(3).map((ticket) => ticket.key)).toEqual(['DM-4', 'DM-5'])
    expect(ticketIdsOf(bundle, 1)).toEqual([tid(1), tid(2), 'tk_new1', 'tk_new2'])
  })

  it.each(['', '   ', '\n\t'])('rejects the blank title %j', (title) => {
    expect(rejection(baseBundle(), { op: 'add_ticket', sprint: '1', ticket: { title } })).toEqual({
      code: 'invalid_input',
      message: 'A ticket needs a title.',
      details: { opIndex: 0, op: 'add_ticket' }
    })
  })

  it('reports an unknown sprint before checking the title', () => {
    const failure = rejection(baseBundle(), { op: 'add_ticket', sprint: '7', ticket: { title: '' } })
    expect(failure?.code).toBe('not_found')
    expect(failure?.message).toBe('Unknown sprint "7".')
  })
})

describe('update_ticket', () => {
  it('patches only the addressed ticket', () => {
    const { bundle } = apply(baseBundle(), {
      op: 'update_ticket',
      ticket: 'DM-2',
      patch: { title: '  Better title ', body: 'more', tags: ['x'], optional: true }
    })
    expect(bundle.tickets[1]).toMatchObject({
      id: tid(2),
      key: 'DM-2',
      title: 'Better title',
      body: 'more',
      tags: ['x'],
      optional: true
    })
    expect(bundle.tickets[0]).toEqual(baseBundle().tickets[0])
    expect(bundle.tickets[2]).toEqual(baseBundle().tickets[2])
  })

  it('accepts patches that leave the title alone', () => {
    const { bundle } = apply(baseBundle(), { op: 'update_ticket', ticket: 'DM-1', patch: { priority: 'critical' } })
    expect(bundle.tickets[0]).toMatchObject({ title: 'Ticket 1', priority: 'critical' })
  })

  it.each(['', '  '])('rejects a patch that blanks the title (%j)', (title) => {
    expect(rejection(baseBundle(), { op: 'update_ticket', ticket: 'DM-2', patch: { title } })).toEqual({
      code: 'invalid_input',
      message: 'DM-2 needs a title.',
      details: { opIndex: 0, op: 'update_ticket' }
    })
  })

  it('keeps criterion ids stable across edits', () => {
    const { bundle } = apply(
      baseBundle(),
      { op: 'update_ticket', ticket: 'DM-1', patch: { acceptanceCriteria: ['Ticket 1 works', 'extra'] } }
    )
    expect(bundle.tickets[0]?.acceptanceCriteria).toEqual([
      { id: 'c1', text: 'Ticket 1 works' },
      { id: 'c2', text: 'extra' }
    ])
  })
})

describe('remove_ticket', () => {
  const linked = (): PlanBundle => {
    const bundle = makeBundle([[1, 2], [3]], [[1, 2], [2, 3], [1, 3]])
    bundle.relations = [
      { kind: 'related_to', from: tid(1), to: tid(3) },
      { kind: 'related_to', from: tid(3), to: tid(2) },
      { kind: 'duplicate_of', from: tid(2), to: tid(1) }
    ]
    return bundle
  }

  it('removes the ticket from the plan, its sprint, its edges and its relations', () => {
    const { bundle } = apply(linked(), { op: 'remove_ticket', ticket: 'DM-2' })
    expect(bundle.tickets.map((ticket) => ticket.key)).toEqual(['DM-1', 'DM-3'])
    expect(ticketIdsOf(bundle, 1)).toEqual([tid(1)])
    expect(ticketIdsOf(bundle, 2)).toEqual([tid(3)])
    expect(bundle.edges).toEqual([{ from: tid(1), to: tid(3) }])
    expect(bundle.relations).toEqual([{ kind: 'related_to', from: tid(1), to: tid(3) }])
  })

  it('removes edges where the ticket is the prerequisite as well as the dependent', () => {
    const { bundle } = apply(linked(), { op: 'remove_ticket', ticket: 'DM-1' })
    expect(bundle.edges).toEqual([{ from: tid(2), to: tid(3) }])
    expect(bundle.relations).toEqual([{ kind: 'related_to', from: tid(3), to: tid(2) }])
  })

  it('leaves the rest of the plan valid', () => {
    expect(validatePlan(apply(linked(), { op: 'remove_ticket', ticket: 'DM-3' }).bundle).errors).toEqual([])
  })

  it('reports an unknown ticket', () => {
    expect(rejection(linked(), { op: 'remove_ticket', ticket: 'DM-9' })?.code).toBe('not_found')
  })
})

describe('move_ticket placement', () => {
  it('moves a ticket to the end of another sprint by default', () => {
    const { bundle } = apply(baseBundle(), { op: 'move_ticket', ticket: 'DM-2', toSprint: '2' })
    expect(ticketIdsOf(bundle, 1)).toEqual([tid(1)])
    expect(ticketIdsOf(bundle, 2)).toEqual([tid(3), tid(2)])
  })

  it('inserts at a zero-based position and clamps oversized positions', () => {
    const first = apply(baseBundle(), { op: 'move_ticket', ticket: 'DM-2', toSprint: '2', position: 0 }).bundle
    expect(ticketIdsOf(first, 2)).toEqual([tid(2), tid(3)])
    const clamped = apply(baseBundle(), { op: 'move_ticket', ticket: 'DM-2', toSprint: '2', position: 99 }).bundle
    expect(ticketIdsOf(clamped, 2)).toEqual([tid(3), tid(2)])
  })

  it('reorders within the same sprint without duplicating the ticket', () => {
    const { bundle } = apply(baseBundle(), { op: 'move_ticket', ticket: 'DM-1', toSprint: '1', position: 1 })
    expect(ticketIdsOf(bundle, 1)).toEqual([tid(2), tid(1)])
    expect(ticketIdsOf(bundle, 2)).toEqual([tid(3)])
  })

  it('moves a ticket that is already in the target sprint to the end when no position is given', () => {
    const { bundle } = apply(baseBundle(), { op: 'move_ticket', ticket: 'DM-1', toSprint: '1' })
    expect(ticketIdsOf(bundle, 1)).toEqual([tid(2), tid(1)])
  })

  it('resolves the ticket and sprint by id and by ref', () => {
    const { bundle } = apply(
      baseBundle(),
      { op: 'add_sprint', ref: 'last', sprint: { goal: 'g' } },
      { op: 'move_ticket', ticket: tid(3), toSprint: 'last' },
      { op: 'move_ticket', ticket: 'DM-2', toSprint: sid(2) }
    )
    expect(ticketIdsOf(bundle, 1)).toEqual([tid(1)])
    expect(ticketIdsOf(bundle, 2)).toEqual([tid(2)])
    expect(ticketIdsOf(bundle, 3)).toEqual([tid(3)])
  })

  it('reports unknown tickets and sprints', () => {
    expect(rejection(baseBundle(), { op: 'move_ticket', ticket: 'DM-9', toSprint: '1' })?.message).toBe('Unknown ticket "DM-9".')
    expect(rejection(baseBundle(), { op: 'move_ticket', ticket: 'DM-1', toSprint: '9' })?.message).toBe('Unknown sprint "9".')
  })
})

describe('move_ticket sprint ordering', () => {
  it('accepts moves that keep every prerequisite in the same or an earlier sprint', () => {
    expect(rejection(baseBundle(), { op: 'move_ticket', ticket: 'DM-3', toSprint: '1' })).toBeUndefined()
    expect(rejection(baseBundle(), { op: 'move_ticket', ticket: 'DM-1', toSprint: '2' })).toBeUndefined()
    const later = makeBundle([[1], [2]], [[1, 2]])
    expect(rejection(later, { op: 'move_ticket', ticket: 'DM-2', toSprint: '2', position: 0 })).toBeUndefined()
  })

  it('rejects moving a prerequisite after its dependent', () => {
    const plan = makeBundle([[1, 3], [2]], [[1, 3]])
    expect(rejection(plan, { op: 'move_ticket', ticket: 'DM-1', toSprint: '2' })).toEqual({
      code: 'invalid_graph',
      message: `Move rejected. DM-3 (Sprint 1) would require DM-1 in later Sprint 2. ${LATER_SPRINT_TAIL}`,
      details: { opIndex: 0, op: 'move_ticket' }
    })
  })

  it('rejects moving a dependent before its prerequisite', () => {
    const plan = makeBundle([[3], [1], [2]], [[1, 2]])
    expect(rejection(plan, { op: 'move_ticket', ticket: 'DM-2', toSprint: '1' })?.message).toBe(
      `Move rejected. DM-2 (Sprint 1) would require DM-1 in later Sprint 2. ${LATER_SPRINT_TAIL}`
    )
  })

  it('leaves the input untouched when a move is rejected', () => {
    const plan = makeBundle([[1, 3], [2]], [[1, 3]])
    rejection(plan, { op: 'move_ticket', ticket: 'DM-1', toSprint: '2' })
    expect(plan).toEqual(makeBundle([[1, 3], [2]], [[1, 3]]))
  })

  it('only checks the edges of the moved ticket', () => {
    const plan = makeBundle([[1], [2], [4]], [[2, 1]])
    expect(validatePlan(plan).errors.map((issue) => issue.code)).toEqual(['later_sprint_prerequisite'])
    expect(rejection(plan, { op: 'move_ticket', ticket: 'DM-4', toSprint: '1' })).toBeUndefined()
  })
})

describe('add_dependency', () => {
  it('adds an edge from the prerequisite to the dependent', () => {
    const { bundle } = apply(baseBundle(), { op: 'add_dependency', from: 'DM-1', to: 'DM-2' })
    expect(bundle.edges).toEqual([
      { from: tid(1), to: tid(3) },
      { from: tid(1), to: tid(2) }
    ])
  })

  it('accepts prerequisites in an earlier sprint', () => {
    const { bundle } = apply(baseBundle(), { op: 'add_dependency', from: tid(2), to: tid(3) })
    expect(bundle.edges[1]).toEqual({ from: tid(2), to: tid(3) })
  })

  it('rejects a duplicate edge with the reason', () => {
    expect(rejection(baseBundle(), { op: 'add_dependency', from: 'DM-1', to: 'DM-3' })).toEqual({
      code: 'invalid_graph',
      message: 'Dependency not added. DM-3 already requires DM-1.',
      details: { opIndex: 0, op: 'add_dependency' }
    })
  })

  it('rejects a prerequisite in a later sprint naming both tickets and sprints', () => {
    expect(rejection(baseBundle(), { op: 'add_dependency', from: 'DM-3', to: 'DM-2' })?.message).toBe(
      `Dependency not added. DM-2 is in Sprint 1 and can't require DM-3 in Sprint 2. ${LATER_SPRINT_TAIL}`
    )
  })

  it('rejects a cycle and a self dependency', () => {
    const chain = makeBundle([[1, 2, 3]], [[1, 2], [2, 3]])
    expect(rejection(chain, { op: 'add_dependency', from: 'DM-3', to: 'DM-1' })?.message).toBe(
      'Dependency not added. Dependency cycle: DM-1 → DM-2 → DM-3 → DM-1.'
    )
    expect(rejection(chain, { op: 'add_dependency', from: 'DM-2', to: 'DM-2' })?.message).toBe(
      "Dependency not added. DM-2 can't depend on itself."
    )
  })

  it('reports unknown tickets as not found, checking the prerequisite first', () => {
    expect(rejection(baseBundle(), { op: 'add_dependency', from: 'DM-8', to: 'DM-9' })).toEqual({
      code: 'not_found',
      message: 'Unknown ticket "DM-8".',
      details: { opIndex: 0, op: 'add_dependency' }
    })
    expect(rejection(baseBundle(), { op: 'add_dependency', from: 'DM-1', to: 'DM-9' })?.message).toBe('Unknown ticket "DM-9".')
  })
})

describe('remove_dependency', () => {
  const chain = (): PlanBundle => makeBundle([[1, 2, 3]], [[1, 2], [1, 3], [2, 3]])

  it('removes exactly the named edge', () => {
    const { bundle } = apply(chain(), { op: 'remove_dependency', from: 'DM-1', to: 'DM-3' })
    expect(bundle.edges).toEqual([
      { from: tid(1), to: tid(2) },
      { from: tid(2), to: tid(3) }
    ])
  })

  it('rejects removing an edge that does not exist', () => {
    expect(rejection(chain(), { op: 'remove_dependency', from: 'DM-3', to: 'DM-2' })).toEqual({
      code: 'not_found',
      message: 'DM-2 does not require DM-3.',
      details: { opIndex: 0, op: 'remove_dependency' }
    })
  })

  it('does not treat the reverse direction as the same edge', () => {
    expect(rejection(chain(), { op: 'remove_dependency', from: 'DM-2', to: 'DM-1' })?.message).toBe('DM-1 does not require DM-2.')
  })

  it('reports unknown tickets', () => {
    expect(rejection(chain(), { op: 'remove_dependency', from: 'DM-1', to: 'DM-9' })?.message).toBe('Unknown ticket "DM-9".')
  })
})

describe('add_relation', () => {
  const related = (): PlanBundle => {
    const bundle = baseBundle()
    bundle.relations = [{ kind: 'related_to', from: tid(1), to: tid(2) }]
    return bundle
  }

  it('adds a relation between two tickets', () => {
    const { bundle } = apply(baseBundle(), { op: 'add_relation', kind: 'duplicate_of', from: 'DM-3', to: 'DM-1' })
    expect(bundle.relations).toEqual([{ kind: 'duplicate_of', from: tid(3), to: tid(1) }])
  })

  it('ignores an exact duplicate', () => {
    const { bundle } = apply(related(), { op: 'add_relation', kind: 'related_to', from: 'DM-1', to: 'DM-2' })
    expect(bundle.relations).toEqual(related().relations)
  })

  it('treats a different kind, source or target as a new relation', () => {
    const { bundle } = apply(
      related(),
      { op: 'add_relation', kind: 'duplicate_of', from: 'DM-1', to: 'DM-2' },
      { op: 'add_relation', kind: 'related_to', from: 'DM-3', to: 'DM-2' },
      { op: 'add_relation', kind: 'related_to', from: 'DM-1', to: 'DM-3' },
      { op: 'add_relation', kind: 'related_to', from: 'DM-2', to: 'DM-1' }
    )
    expect(bundle.relations).toHaveLength(5)
  })

  it('rejects relating a ticket to itself', () => {
    expect(rejection(baseBundle(), { op: 'add_relation', kind: 'related_to', from: 'DM-1', to: tid(1) })).toEqual({
      code: 'invalid_input',
      message: "DM-1 can't relate to itself.",
      details: { opIndex: 0, op: 'add_relation' }
    })
  })

  it('reports unknown tickets', () => {
    expect(rejection(baseBundle(), { op: 'add_relation', kind: 'related_to', from: 'DM-1', to: 'DM-9' })?.code).toBe('not_found')
  })

  it('never creates an execution edge', () => {
    const { bundle } = apply(baseBundle(), { op: 'add_relation', kind: 'related_to', from: 'DM-3', to: 'DM-2' })
    expect(bundle.edges).toEqual(baseBundle().edges)
  })
})

describe('remove_relation', () => {
  const related = (): PlanBundle => {
    const bundle = baseBundle()
    bundle.relations = [
      { kind: 'related_to', from: tid(1), to: tid(2) },
      { kind: 'duplicate_of', from: tid(1), to: tid(2) },
      { kind: 'related_to', from: tid(2), to: tid(1) },
      { kind: 'related_to', from: tid(1), to: tid(3) }
    ]
    return bundle
  }

  it('removes only the relation that matches kind, source and target', () => {
    const { bundle } = apply(related(), { op: 'remove_relation', kind: 'related_to', from: 'DM-1', to: 'DM-2' })
    expect(bundle.relations).toEqual([
      { kind: 'duplicate_of', from: tid(1), to: tid(2) },
      { kind: 'related_to', from: tid(2), to: tid(1) },
      { kind: 'related_to', from: tid(1), to: tid(3) }
    ])
  })

  it('keeps relations that differ only in kind, direction or target', () => {
    const { bundle } = apply(related(), { op: 'remove_relation', kind: 'duplicate_of', from: 'DM-1', to: 'DM-2' })
    expect(bundle.relations.map((relation) => relation.kind)).toEqual(['related_to', 'related_to', 'related_to'])
    const reversed = apply(related(), { op: 'remove_relation', kind: 'related_to', from: 'DM-2', to: 'DM-1' })
    expect(reversed.bundle.relations).toHaveLength(3)
    expect(reversed.bundle.relations.some((relation) => relation.from === tid(2))).toBe(false)
  })

  it('does nothing when the relation does not exist', () => {
    const { bundle } = apply(related(), { op: 'remove_relation', kind: 'related_to', from: 'DM-3', to: 'DM-1' })
    expect(bundle.relations).toEqual(related().relations)
  })

  it('reports unknown tickets', () => {
    const failure = rejection(related(), { op: 'remove_relation', kind: 'related_to', from: 'DM-9', to: 'DM-1' })
    expect(failure?.message).toBe('Unknown ticket "DM-9".')
  })
})

describe('set_policies', () => {
  it('merges the patch over the current policies', () => {
    const { bundle } = apply(baseBundle(), {
      op: 'set_policies',
      patch: { retryLimit: 5, onTicketFailure: 'pause_run', maxConcurrency: 4 }
    })
    expect(bundle.policies).toEqual({ maxConcurrency: 4, retryLimit: 5, onTicketFailure: 'pause_run', leaseSeconds: 900 })
  })

  it('accepts the smallest valid values and unlimited concurrency', () => {
    const { bundle } = apply(baseBundle(), { op: 'set_policies', patch: { retryLimit: 1, leaseSeconds: 30, maxConcurrency: 1 } })
    expect(bundle.policies).toMatchObject({ retryLimit: 1, leaseSeconds: 30, maxConcurrency: 1 })
    const unlimited = apply(bundle, { op: 'set_policies', patch: { maxConcurrency: null } }).bundle
    expect(unlimited.policies.maxConcurrency).toBeNull()
  })

  it.each([
    [{ retryLimit: 0 }, 'Retry limit must be a whole number of at least 1.'],
    [{ leaseSeconds: 29 }, 'Lease duration must be at least 30 seconds.'],
    [{ maxConcurrency: 0 }, 'Concurrency caps must be whole numbers of at least 1.']
  ])('rejects %j', (patch, message) => {
    expect(rejection(baseBundle(), { op: 'set_policies', patch })).toEqual({
      code: 'invalid_input',
      message,
      details: { opIndex: 0, op: 'set_policies' }
    })
  })

  it('leaves the policies alone when the patch is rejected', () => {
    const input = baseBundle()
    rejection(input, { op: 'set_policies', patch: { retryLimit: 0 } })
    expect(input.policies).toEqual(baseBundle().policies)
  })

  it('ignores unrelated plan errors when judging the policy patch', () => {
    const broken = baseBundle()
    broken.tickets[1] = makeTicket(2, { title: '' })
    const { bundle } = apply(broken, { op: 'set_policies', patch: { retryLimit: 2 } })
    expect(bundle.policies.retryLimit).toBe(2)
  })
})

describe('set_rationale', () => {
  it('replaces the rationale, including with an empty string', () => {
    const first = apply(baseBundle(), { op: 'set_rationale', rationale: '## Why\nBecause.' }).bundle
    expect(first.rationale).toBe('## Why\nBecause.')
    expect(apply(first, { op: 'set_rationale', rationale: '' }).bundle.rationale).toBe('')
  })
})
