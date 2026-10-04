import { describe, expect, it } from 'vitest'
import type { DependencyEdge } from '../../shared/domain/bundle'
import { makeBundle, makeTicket, sid, tid } from '../../test/bundles'
import { groupIntoRows, planRows } from './graph'

function link(from: string, to: string): DependencyEdge {
  return { from, to }
}

describe('groupIntoRows', () => {
  it('has no rows for no tickets', () => {
    expect(groupIntoRows([], [])).toEqual([])
  })

  it('puts tickets without same-sprint prerequisites in row 1, in the order given', () => {
    expect(groupIntoRows(['c', 'a', 'b'], [])).toEqual([['c', 'a', 'b']])
  })

  it('puts a ticket one row below its prerequisite', () => {
    expect(groupIntoRows(['a', 'b', 'c'], [link('a', 'b'), link('b', 'c')])).toEqual([['a'], ['b'], ['c']])
  })

  it('uses the longest path, so a shortcut edge does not lift a ticket', () => {
    const edges = [link('a', 'b'), link('b', 'c'), link('a', 'c')]
    expect(groupIntoRows(['a', 'b', 'c'], edges)).toEqual([['a'], ['b'], ['c']])
  })

  it('groups a fork and its join into three rows', () => {
    const edges = [link('a', 'b'), link('a', 'c'), link('b', 'd'), link('c', 'd')]
    expect(groupIntoRows(['a', 'b', 'c', 'd'], edges)).toEqual([['a'], ['b', 'c'], ['d']])
  })

  it('ignores prerequisites that are not among the listed tickets', () => {
    expect(groupIntoRows(['b'], [link('earlier-sprint', 'b')])).toEqual([['b']])
  })

  it('ignores self edges', () => {
    expect(groupIntoRows(['a'], [link('a', 'a')])).toEqual([['a']])
  })

  it('places the members of a cycle together, after the rows that can be ordered', () => {
    const edges = [link('p', 'q'), link('q', 'p')]
    expect(groupIntoRows(['x', 'p', 'q'], edges)).toEqual([['x'], ['p', 'q']])
  })

  it('places a cycle with nothing before it in row 1', () => {
    expect(groupIntoRows(['a', 'b'], [link('a', 'b'), link('b', 'a')])).toEqual([['a', 'b']])
  })
})

describe('planRows', () => {
  it('numbers rows from 1 in each sprint and lists each row once', () => {
    const bundle = makeBundle([[1, 2, 3, 4], [5, 6]], [[1, 3], [2, 3], [3, 4], [5, 6]])
    expect(planRows(bundle)).toEqual([
      { sprintId: sid(1), row: 1, ticketIds: [tid(1), tid(2)] },
      { sprintId: sid(1), row: 2, ticketIds: [tid(3)] },
      { sprintId: sid(1), row: 3, ticketIds: [tid(4)] },
      { sprintId: sid(2), row: 1, ticketIds: [tid(5)] },
      { sprintId: sid(2), row: 2, ticketIds: [tid(6)] }
    ])
  })

  it('does not count a prerequisite in an earlier sprint as a same-sprint prerequisite', () => {
    const bundle = makeBundle([[1], [2]], [[1, 2]])
    expect(planRows(bundle)).toEqual([
      { sprintId: sid(1), row: 1, ticketIds: [tid(1)] },
      { sprintId: sid(2), row: 1, ticketIds: [tid(2)] }
    ])
  })

  it('orders sprints by ordinal rather than by position', () => {
    const bundle = makeBundle([[1], [2]])
    bundle.sprints = [bundle.sprints[1], bundle.sprints[0]]
    expect(planRows(bundle).map((item) => item.sprintId)).toEqual([sid(1), sid(2)])
  })

  it('skips ids that are not tickets and keeps a ticket in the first sprint that lists it', () => {
    const bundle = makeBundle([[1], [2]])
    bundle.sprints[0]?.ticketIds.push(tid(99))
    bundle.sprints[1]?.ticketIds.unshift(tid(1))
    expect(planRows(bundle)).toEqual([
      { sprintId: sid(1), row: 1, ticketIds: [tid(1)] },
      { sprintId: sid(2), row: 1, ticketIds: [tid(2)] }
    ])
  })

  it('has no rows for a sprint without tickets', () => {
    const bundle = makeBundle([[1], []])
    expect(planRows(bundle).map((item) => item.sprintId)).toEqual([sid(1)])
  })
})

describe('planRows and acceptance nodes', () => {
  it('keeps the acceptance node of a sprint out of every row', () => {
    const bundle = makeBundle([[1, 2, 3]], [[1, 2]])
    bundle.tickets[2] = makeTicket(3, { kind: 'acceptance' })
    expect(planRows(bundle)).toEqual([
      { sprintId: sid(1), row: 1, ticketIds: [tid(1)] },
      { sprintId: sid(1), row: 2, ticketIds: [tid(2)] }
    ])
  })

  it('has no rows for a sprint that lists only its acceptance node', () => {
    const bundle = makeBundle([[1], [2]])
    bundle.tickets[1] = makeTicket(2, { kind: 'acceptance' })
    expect(planRows(bundle).map((item) => item.sprintId)).toEqual([sid(1)])
  })

  it('treats a ticket of kind work like one without a kind', () => {
    const bundle = makeBundle([[1, 2]])
    bundle.tickets[1] = makeTicket(2, { kind: 'work' })
    expect(planRows(bundle)).toEqual([{ sprintId: sid(1), row: 1, ticketIds: [tid(1), tid(2)] }])
  })
})
