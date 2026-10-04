import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../../shared/domain/bundle'
import { draftPlan, ticket } from '../epic/__mocks__/fixtures'
import { followUpOp } from './gateView'

const DRAFT = draftPlan().bundle

/** The draft with a sprint 2 acceptance node (DM-299) that explicitly requires DM-202. */
function withAcceptanceNode(): PlanBundle {
  return {
    ...DRAFT,
    tickets: [...DRAFT.tickets, ticket('DM-299', 'Sprint 2 acceptance', { kind: 'acceptance' })],
    sprints: DRAFT.sprints.map((item) => (item.id === 'sp_2' ? { ...item, ticketIds: [...item.ticketIds, 'tk_299'] } : item)),
    edges: [...DRAFT.edges, { from: 'tk_202', to: 'tk_299' }]
  }
}

const NEW_SPRINT_GOAL = 'Finish what Sprint 3 left over and take up what it found.'

describe('a retro discovery goes to the next sprint', () => {
  const discovery = { kind: 'discovery' as const, title: 'Cache the folder registry', body: 'Reads hit the disk on every poll.' }

  it('becomes a ticket of the sprint after the checkpoint', () => {
    expect(followUpOp(discovery, DRAFT, 2)).toEqual({
      sprintOrdinal: 3,
      moved: [],
      ops: [{ op: 'add_ticket', sprint: 'sp_3', ticket: { title: 'Cache the folder registry', body: 'Reads hit the disk on every poll.' } }]
    })
  })

  it('adds nothing when a ticket of the draft already has the title, whatever its case, and says where it is', () => {
    expect(followUpOp({ ...discovery, title: '  plan LIST view ' }, DRAFT, 2)).toEqual({ sprintOrdinal: 3, moved: [], ops: [] })
    expect(followUpOp({ ...discovery, title: 'repository init' }, DRAFT, 2)?.sprintOrdinal).toBe(1)
  })

  it('ignores the title of an acceptance node', () => {
    const plan = withAcceptanceNode()
    expect(followUpOp({ ...discovery, title: 'Sprint 2 acceptance' }, plan, 2)?.ops.length).toBe(1)
  })

  it('adds a sprint after the final one to hold it', () => {
    expect(followUpOp(discovery, DRAFT, 3)).toEqual({
      sprintOrdinal: 4,
      moved: [],
      ops: [
        { op: 'add_sprint', ref: 'next', sprint: { goal: NEW_SPRINT_GOAL }, position: 4 },
        { op: 'add_ticket', sprint: 'next', ticket: { title: 'Cache the folder registry', body: 'Reads hit the disk on every poll.' } }
      ]
    })
  })

  it('has nowhere to go in a draft without sprints', () => {
    expect(followUpOp(discovery, { ...DRAFT, sprints: [] }, 2)).toBe(null)
  })
})

describe('a retro leftover moves to the next sprint', () => {
  it('moves the ticket to the sprint after the checkpoint', () => {
    expect(followUpOp({ kind: 'leftover', ticketId: 'tk_202' }, DRAFT, 2)).toEqual({
      sprintOrdinal: 3,
      moved: ['DM-202'],
      ops: [{ op: 'move_ticket', ticket: 'tk_202', toSprint: 'sp_3' }]
    })
  })

  it('takes along the tickets that require it, moving them first so no move leaves a prerequisite behind', () => {
    expect(followUpOp({ kind: 'leftover', ticketId: 'tk_203' }, DRAFT, 2)).toEqual({
      sprintOrdinal: 3,
      moved: ['DM-203', 'DM-204'],
      ops: [
        { op: 'move_ticket', ticket: 'tk_204', toSprint: 'sp_3' },
        { op: 'move_ticket', ticket: 'tk_203', toSprint: 'sp_3', position: 4 }
      ]
    })
  })

  it('follows a chain of requirements to its end and keeps the sprint order in the next sprint', () => {
    const chained = { ...DRAFT, edges: [...DRAFT.edges, { from: 'tk_202', to: 'tk_203' }] }
    const planned = followUpOp({ kind: 'leftover', ticketId: 'tk_202' }, chained, 2)
    expect(planned?.moved).toEqual(['DM-202', 'DM-203', 'DM-204'])
    expect(planned?.ops).toEqual([
      { op: 'move_ticket', ticket: 'tk_204', toSprint: 'sp_3' },
      { op: 'move_ticket', ticket: 'tk_203', toSprint: 'sp_3', position: 4 },
      { op: 'move_ticket', ticket: 'tk_202', toSprint: 'sp_3', position: 4 }
    ])
  })

  it('drops what its sprint acceptance node explicitly required of it, first', () => {
    expect(followUpOp({ kind: 'leftover', ticketId: 'tk_202' }, withAcceptanceNode(), 2)?.ops).toEqual([
      { op: 'remove_dependency', from: 'tk_202', to: 'tk_299' },
      { op: 'move_ticket', ticket: 'tk_202', toSprint: 'sp_3' }
    ])
  })

})

describe('a retro leftover moves to the next sprint (2)', () => {
  it('does nothing for a ticket that is already in the next sprint or a later one, and says where it is', () => {
    expect(followUpOp({ kind: 'leftover', ticketId: 'tk_301' }, DRAFT, 2)).toEqual({ sprintOrdinal: 3, moved: [], ops: [] })
    expect(followUpOp({ kind: 'leftover', ticketId: 'tk_301' }, DRAFT, 1)?.sprintOrdinal).toBe(3)
  })

  it('has nowhere to go for a ticket the draft does not have, an acceptance node or a draft without sprints', () => {
    expect(followUpOp({ kind: 'leftover', ticketId: 'tk_gone' }, DRAFT, 2)).toBe(null)
    expect(followUpOp({ kind: 'leftover', ticketId: 'tk_299' }, withAcceptanceNode(), 2)).toBe(null)
    expect(followUpOp({ kind: 'leftover', ticketId: 'tk_202' }, { ...DRAFT, sprints: [] }, 2)).toBe(null)
  })

  it('adds a sprint after the final one, ahead of the move', () => {
    expect(followUpOp({ kind: 'leftover', ticketId: 'tk_304' }, DRAFT, 3)).toEqual({
      sprintOrdinal: 4,
      moved: ['DM-304'],
      ops: [
        { op: 'add_sprint', ref: 'next', sprint: { goal: NEW_SPRINT_GOAL }, position: 4 },
        { op: 'move_ticket', ticket: 'tk_304', toSprint: 'next' }
      ]
    })
  })

  it('puts a group of moves into a new sprint ahead of its acceptance node, keeping their order', () => {
    const chained = { ...DRAFT, edges: [...DRAFT.edges, { from: 'tk_301', to: 'tk_302' }] }
    expect(followUpOp({ kind: 'leftover', ticketId: 'tk_301' }, chained, 3)?.ops).toEqual([
      { op: 'add_sprint', ref: 'next', sprint: { goal: NEW_SPRINT_GOAL }, position: 4 },
      { op: 'move_ticket', ticket: 'tk_302', toSprint: 'next' },
      { op: 'move_ticket', ticket: 'tk_301', toSprint: 'next', position: 0 }
    ])
  })

  it('reads an explicit follow-up kind like a plain proposal', () => {
    const explicit = followUpOp({ kind: 'follow_up', title: 'T', body: 'B' }, DRAFT, 2)
    expect(explicit).toEqual(followUpOp({ title: 'T', body: 'B' }, DRAFT, 2))
  })
})
