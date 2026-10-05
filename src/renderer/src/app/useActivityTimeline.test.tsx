// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActivityEntry, AttemptTimelineView, RunTimelineView } from '../../../shared/domain/activity'
import { FakeDm } from '../__mocks__/fakeDm'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { TIMELINE_POLL_MS, useAttemptTimeline, useRunTimeline } from './useActivityTimeline'

let dm: FakeDm
let scheduler: ManualScheduler
let errors: unknown[]
let requests: unknown[]

beforeEach(() => {
  scheduler = new ManualScheduler()
  errors = []
  requests = []
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

function note(seq: number): ActivityEntry {
  return {
    kind: 'note',
    id: `event:${seq}`,
    at: '2026-01-01T00:00:00.000Z',
    sessionId: 'ss_w',
    attemptId: 'at_1',
    ticketId: 'tk_1',
    text: `note ${seq}`,
    step: null
  }
}

function alive(until: string): ActivityEntry {
  return {
    kind: 'alive',
    id: 'alive:at_1',
    at: '2026-01-01T00:00:00.000Z',
    sessionId: 'ss_w',
    attemptId: 'at_1',
    ticketId: 'tk_1',
    until,
    leaseExpiresAt: null,
    active: true
  }
}

function page(entries: ActivityEntry[], cursor: number, isLive = true): AttemptTimelineView {
  return {
    attemptId: 'at_1',
    runId: 'rn_1',
    ticketId: 'tk_1',
    state: isLive ? 'running' : 'accepted',
    isLive,
    cursor,
    entries,
    sessions: []
  }
}

function serve(...pages: AttemptTimelineView[]): void {
  dm.handlers.getAttemptTimeline = (input) => {
    requests.push(input)
    return pages.shift() ?? page([], 0)
  }
}

async function poll(): Promise<void> {
  act(() => scheduler.fireIntervals())
  await settle()
}

function mountAttempt(path: string | null, attemptId: string | null) {
  return renderHook(
    (props: { path: string | null; attemptId: string | null }) =>
      useAttemptTimeline({ ...props, scheduler, onError: (error) => errors.push(error) }),
    { initialProps: { path, attemptId } }
  )
}

describe('useAttemptTimeline', () => {
  it('loads the whole history first, then only what is new, replacing the growing span by id', async () => {
    serve(page([alive('00:10'), note(2)], 5), page([alive('00:40'), note(6)], 8), page([alive('00:40')], 8))
    const view = mountAttempt('/a', 'at_1')
    await settle()
    expect(view.result.current?.entries.map((entry) => entry.id)).toEqual(['alive:at_1', 'event:2'])
    await poll()
    await poll()
    expect(view.result.current?.entries.map((entry) => entry.id)).toEqual(['alive:at_1', 'event:2', 'event:6'])
    expect(view.result.current?.entries[0]).toMatchObject({ until: '00:40' })
    expect(requests).toEqual([
      { attemptId: 'at_1', sinceSeq: 0, limit: 200 },
      { attemptId: 'at_1', sinceSeq: 5, limit: 200 },
      { attemptId: 'at_1', sinceSeq: 8, limit: 200 }
    ])
  })

  it('polls on the shared interval and stops once the attempt is no longer live', async () => {
    serve(page([note(1)], 2), page([note(3)], 4, false))
    mountAttempt('/a', 'at_1')
    await settle()
    expect(scheduler.intervals()).toEqual([TIMELINE_POLL_MS])
    await poll()
    await poll()
    expect(scheduler.intervals()).toEqual([])
    expect(requests).toHaveLength(2)
  })

})

describe('useAttemptTimeline — what it follows', () => {
  it('follows nothing without a folder and an attempt', async () => {
    serve(page([note(1)], 2))
    const view = mountAttempt(null, 'at_1')
    await settle()
    expect([view.result.current, requests.length, scheduler.intervals()]).toEqual([null, 0, []])
  })

  it('starts over for another attempt and stops polling on unmount', async () => {
    serve(page([note(1)], 2), page([note(9)], 3))
    const view = mountAttempt('/a', 'at_1')
    await settle()
    view.rerender({ path: '/a', attemptId: 'at_2' })
    await settle()
    expect(view.result.current?.entries.map((entry) => entry.id)).toEqual(['event:9'])
    expect(requests[1]).toEqual({ attemptId: 'at_2', sinceSeq: 0, limit: 200 })
    view.unmount()
    expect(scheduler.intervals()).toEqual([])
  })

  it('follows nothing without an attempt either', async () => {
    serve(page([note(1)], 2))
    const view = mountAttempt('/a', null)
    await settle()
    expect([view.result.current, requests.length, scheduler.intervals()]).toEqual([null, 0, []])
  })

  it('ignores a page for an attempt it has stopped following when the page arrives late', async () => {
    dm.handlers.getAttemptTimeline = (input) => {
      requests.push(input)
      return (input as { attemptId: string }).attemptId === 'at_1' ? page([note(1)], 2) : page([note(9)], 3)
    }
    const late = dm.holdNext('getAttemptTimeline')
    const view = mountAttempt('/a', 'at_1')
    await settle()
    expect(view.result.current).toBeNull()
    view.rerender({ path: '/a', attemptId: 'at_2' })
    await settle()
    expect(view.result.current?.entries.map((entry) => entry.id)).toEqual(['event:9'])
    late.resolve()
    await settle()
    expect(view.result.current?.entries.map((entry) => entry.id)).toEqual(['event:9'])
    expect(requests.map((request) => (request as { attemptId: string }).attemptId)).toEqual(['at_2', 'at_1'])
  })

  it('reports a failing timeline once', async () => {
    dm.failures.getAttemptTimeline = { code: 'not_found', message: 'Attempt at_1 not found.' }
    mountAttempt('/a', 'at_1')
    await settle()
    await poll()
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('Attempt at_1 not found.')
  })
})

describe('useRunTimeline', () => {
  it('merges each poll into the group of the session that did it', async () => {
    const group = (entries: ActivityEntry[]): RunTimelineView['groups'][number] => ({
      session: { id: 'ss_o', role: 'orchestrator', label: 'Orchestrator' },
      entries
    })
    const runPage = (entries: ActivityEntry[], cursor: number): RunTimelineView => ({
      runId: 'rn_1',
      epicId: 'ep_1',
      state: 'running',
      isLive: true,
      cursor,
      groups: entries.length === 0 ? [] : [group(entries)]
    })
    const pages = [runPage([note(1)], 2), runPage([note(3)], 4), runPage([], 4)]
    dm.handlers.getRunTimeline = (input) => {
      requests.push(input)
      return pages.shift()
    }
    const view = renderHook(() => useRunTimeline({ path: '/a', runId: 'rn_1', scheduler, onError: (error) => errors.push(error) }))
    await settle()
    await poll()
    await poll()
    expect(view.result.current?.groups.map((item) => item.entries.map((entry) => entry.id))).toEqual([['event:1', 'event:3']])
    expect(requests.map((request) => (request as { sinceSeq: number }).sinceSeq)).toEqual([0, 2, 4])
  })

})

describe('useRunTimeline — what it follows', () => {
  it.each([
    ['without a folder', null, 'rn_1'],
    ['without a run', '/a', null]
  ])('follows nothing %s', async (_name, path, runId) => {
    dm.handlers.getRunTimeline = (input) => {
      requests.push(input)
      return undefined
    }
    const view = renderHook(() => useRunTimeline({ path, runId, scheduler, onError: (error) => errors.push(error) }))
    await settle()
    expect([view.result.current, requests.length, scheduler.intervals()]).toEqual([null, 0, []])
  })

  it('asks for its own run in its own folder and stops polling once the run ended', async () => {
    const ended: RunTimelineView = { runId: 'rn_1', epicId: 'ep_1', state: 'completed', isLive: false, cursor: 7, groups: [] }
    dm.handlers.getRunTimeline = (input) => {
      requests.push(input)
      return ended
    }
    const view = renderHook(() => useRunTimeline({ path: '/a', runId: 'rn_1', scheduler, onError: (error) => errors.push(error) }))
    await settle()
    expect(requests).toEqual([{ runId: 'rn_1', sinceSeq: 0, limit: 200 }])
    expect(dm.callsOf('getRunTimeline').map((call) => call.folder)).toEqual(['/a'])
    expect(view.result.current).toMatchObject({ runId: 'rn_1', isLive: false })
    expect(scheduler.intervals()).toEqual([])
  })
})
