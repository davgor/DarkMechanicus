// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ActivityEntry, AttemptTimelineView } from '../../../shared/domain/activity'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend } from './__mocks__/fakeBackend'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
})

const BASE = { sessionId: 'ss_1', attemptId: 'at_202_2', ticketId: 'tk_202' }

function note(seq: number, text: string): ActivityEntry {
  return { ...BASE, kind: 'note', id: `event:${seq}`, at: `2026-09-30T11:0${seq}:00.000Z`, text, step: null }
}

function page(entries: ActivityEntry[], cursor: number, running = true): AttemptTimelineView {
  const state = running ? 'running' : 'accepted'
  return { attemptId: 'at_202_2', runId: 'rn_2', ticketId: 'tk_202', state, isLive: running, cursor, entries, sessions: [] }
}

/** A backend whose attempt timeline hands out the given pages in turn, then repeats the last. */
function backendWith(...pages: AttemptTimelineView[]): { backend: FakeBackend; asked: unknown[] } {
  const backend = new FakeBackend()
  const asked: unknown[] = []
  backend.handlers.getAttemptTimeline = (input: unknown) => {
    asked.push(input)
    return pages.length > 1 ? pages.shift() : pages[0]
  }
  return { backend, asked }
}

async function panel(name: string): Promise<HTMLElement> {
  return screen.findByLabelText(name)
}

describe('opening the live attempt from the workspace', () => {
  it('opens the Activity tab for the attempt when the hourglass on a graph node is clicked', async () => {
    const { backend, asked } = backendWith(page([note(1, 'Reading the code')], 2))
    renderWorkspace(backend, { scheduler: new ManualScheduler() })
    fireEvent.click(await screen.findByRole('button', { name: 'DM-202 is being worked on' }))
    const ticket = await panel('Ticket DM-202')
    expect(await within(ticket).findByText('Reading the code')).toBeTruthy()
    expect(within(ticket).getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true')
    expect(asked).toEqual([{ attemptId: 'at_202_2', sinceSeq: 0, limit: 200 }])
  })

  it('opens it from the hourglass in the list view too', async () => {
    const { backend } = backendWith(page([note(1, 'Reading the code')], 2))
    renderWorkspace(backend, { scheduler: new ManualScheduler() })
    fireEvent.click(await screen.findByRole('button', { name: 'List' }))
    const list = screen.getByLabelText('Plan list')
    expect(within(list).getAllByRole('button', { name: /is being worked on/ })).toHaveLength(1)
    fireEvent.click(within(list).getByRole('button', { name: 'DM-202 is being worked on' }))
    expect(await within(await panel('Ticket DM-202')).findByText('Reading the code')).toBeTruthy()
  })

  it('opens it for the attempt a person clicks in the attempts strip', async () => {
    const { backend, asked } = backendWith(page([note(1, 'Reading the code')], 2))
    renderWorkspace(backend, { scheduler: new ManualScheduler() })
    const strip = await screen.findByLabelText('Run activity')
    fireEvent.click(within(strip).getByRole('button', { name: 'DM-202 #2 running · lease 04:12' }))
    const ticket = await panel('Ticket DM-202')
    expect(await within(ticket).findByText('Reading the code')).toBeTruthy()
    expect(within(ticket).getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true')
    expect(asked).toEqual([{ attemptId: 'at_202_2', sinceSeq: 0, limit: 200 }])
  })

  it('opens it for an attempt that is no longer open, from the expanded strip', async () => {
    const backend = new FakeBackend()
    renderWorkspace(backend, { scheduler: new ManualScheduler() })
    const strip = await screen.findByLabelText('Run activity')
    fireEvent.click(within(strip).getByRole('button', { name: 'Attempts' }))
    fireEvent.click(within(strip).getByRole('button', { name: /^DM-101 #1 accepted/ }))
    const ticket = await panel('Ticket DM-101')
    expect(within(ticket).getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true')
    expect(await within(ticket).findByText('Attempt ended: Accepted')).toBeTruthy()
    expect(backend.inputs('getAttemptTimeline')).toEqual([{ attemptId: 'at_101_1', sinceSeq: 0, limit: 200 }])
  })
})

describe('the live attempt in the workspace', () => {
  it('shows new entries as they arrive without a reload and stops polling when the attempt closes', async () => {
    const pages = [page([note(1, 'Reading the code')], 2), page([note(2, 'Wrote the tests')], 3), page([note(3, 'Done')], 5, false)]
    const { backend, asked } = backendWith(...pages)
    const scheduler = new ManualScheduler()
    renderWorkspace(backend, { scheduler })
    fireEvent.click(await screen.findByRole('button', { name: 'DM-202 is being worked on' }))
    const ticket = await panel('Ticket DM-202')
    await within(ticket).findByText('Reading the code')
    const whileLive = scheduler.intervals().length
    const polls = (): number => asked.length
    act(() => scheduler.fireIntervals(1500))
    await settle()
    expect(await within(ticket).findByText('Wrote the tests')).toBeTruthy()
    act(() => scheduler.fireIntervals(1500))
    await settle()
    expect(await within(ticket).findByText('Attempt ended: Accepted')).toBeTruthy()
    expect(scheduler.intervals()).toHaveLength(whileLive - 1)
    const before = polls()
    act(() => scheduler.fireIntervals())
    await settle()
    expect(polls()).toBe(before)
  })

  it('brings the Activity tab back when the hourglass is clicked again', async () => {
    const { backend } = backendWith(page([note(1, 'Reading the code')], 2))
    renderWorkspace(backend, { scheduler: new ManualScheduler() })
    fireEvent.click(await screen.findByRole('button', { name: 'DM-202 is being worked on' }))
    const ticket = await panel('Ticket DM-202')
    await within(ticket).findByText('Reading the code')
    fireEvent.click(within(ticket).getByRole('tab', { name: 'Overview' }))
    expect(within(ticket).queryByText('Reading the code')).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: 'DM-202 is being worked on' }))
    expect(await within(await panel('Ticket DM-202')).findByText('Reading the code')).toBeTruthy()
  })
})
