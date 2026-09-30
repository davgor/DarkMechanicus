import { describe, expect, it } from 'vitest'
import { epicSummary } from '../__mocks__/fixtures'
import type { Bucket } from './buckets'
import { bucketOfEpic, groupEpics } from './buckets'

function ids(bucket: Bucket | undefined): string[] {
  return (bucket?.epics ?? []).map((epic) => epic.id)
}

describe('groupEpics buckets', () => {
  it('always returns the three buckets in the fixed order', () => {
    expect(groupEpics([]).map((bucket) => bucket.id)).toEqual(['in_progress', 'backlog', 'completed'])
  })

  it('labels the buckets with the product vocabulary', () => {
    expect(groupEpics([]).map((bucket) => bucket.label)).toEqual([
      'In progress',
      'Backlog',
      'Completed'
    ])
  })

  it('places each epic in the bucket of its status and counts them', () => {
    const buckets = groupEpics([
      epicSummary({ id: 'a', status: 'backlog' }),
      epicSummary({ id: 'b', status: 'in_progress' }),
      epicSummary({ id: 'c', status: 'backlog' }),
      epicSummary({ id: 'd', status: 'completed' })
    ])
    expect(buckets.map((bucket) => [bucket.id, bucket.count, ids(bucket)])).toEqual([
      ['in_progress', 1, ['b']],
      ['backlog', 2, ['a', 'c']],
      ['completed', 1, ['d']]
    ])
  })

  it('reports zero counts for empty buckets', () => {
    expect(groupEpics([]).map((bucket) => bucket.count)).toEqual([0, 0, 0])
  })
})

describe('groupEpics ordering', () => {
  it('orders open epics by creation time, oldest first, then by id', () => {
    const buckets = groupEpics([
      epicSummary({ id: 'c', createdAt: '2026-02-01T00:00:00.000Z' }),
      epicSummary({ id: 'b', createdAt: '2026-01-01T00:00:00.000Z' }),
      epicSummary({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' })
    ])
    expect(ids(buckets[1])).toEqual(['a', 'b', 'c'])
  })

  it('orders completed epics by completion time, newest first', () => {
    const done = { status: 'completed' } as const
    const buckets = groupEpics([
      epicSummary({ ...done, id: 'old', completedAt: '2026-01-05T00:00:00.000Z' }),
      epicSummary({ ...done, id: 'new', completedAt: '2026-03-05T00:00:00.000Z' }),
      epicSummary({ ...done, id: 'mid', completedAt: '2026-02-05T00:00:00.000Z' })
    ])
    expect(ids(buckets[2])).toEqual(['new', 'mid', 'old'])
  })

  it('falls back to the update time for completed epics without a completion time', () => {
    const done = { status: 'completed', completedAt: null } as const
    const buckets = groupEpics([
      epicSummary({ ...done, id: 'x', updatedAt: '2026-01-01T00:00:00.000Z' }),
      epicSummary({ ...done, id: 'y', updatedAt: '2026-04-01T00:00:00.000Z' })
    ])
    expect(ids(buckets[2])).toEqual(['y', 'x'])
  })

  it('breaks completion-time ties by id ascending', () => {
    const done = { status: 'completed', completedAt: '2026-01-05T00:00:00.000Z' } as const
    const buckets = groupEpics([epicSummary({ ...done, id: 'b' }), epicSummary({ ...done, id: 'a' })])
    expect(ids(buckets[2])).toEqual(['a', 'b'])
  })

  it('does not mutate the input array', () => {
    const input = [epicSummary({ id: 'b', status: 'backlog' }), epicSummary({ id: 'a', status: 'backlog' })]
    groupEpics(input)
    expect(input.map((epic) => epic.id)).toEqual(['b', 'a'])
  })
})

describe('bucketOfEpic', () => {
  const epics = [
    epicSummary({ id: 'a', status: 'completed' }),
    epicSummary({ id: 'b', status: 'in_progress' })
  ]

  it('finds the bucket holding an epic', () => {
    expect(bucketOfEpic(epics, 'a')).toBe('completed')
    expect(bucketOfEpic(epics, 'b')).toBe('in_progress')
  })

  it('returns null for an unknown epic', () => {
    expect(bucketOfEpic(epics, 'zzz')).toBeNull()
  })
})
