// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivityEntry, AttemptTimelineView } from '../../../shared/domain/activity'
import { settle } from '../__mocks__/settle'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { FakeBackend } from '../epic/__mocks__/fakeBackend'
import { NOW, savedPlan } from '../epic/__mocks__/fixtures'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'
import { TicketPanel, type TicketPanelProps } from './TicketPanel'

allowSlowRendering()

afterEach(cleanup)

const BASE = { sessionId: 'ss_w', attemptId: 'at_202_2', ticketId: 'tk_202' }

function timeline(entries: ActivityEntry[], attemptId = 'at_202_2'): AttemptTimelineView {
  return { attemptId, runId: 'rn_2', ticketId: 'tk_202', state: 'running', isLive: true, cursor: 5, entries, sessions: [] }
}

function note(text: string): ActivityEntry {
  return { ...BASE, kind: 'note', id: `event:${text}`, at: '2026-09-30T11:05:00.000Z', text, step: null }
}

function fakeBackend(): { backend: FakeBackend; asked: unknown[] } {
  const backend = new FakeBackend()
  const asked: unknown[] = []
  backend.handlers.getAttemptTimeline = (input: unknown) => {
    asked.push(input)
    const id = (input as { attemptId: string }).attemptId
    return timeline([note(`note of ${id}`)], id)
  }
  return { backend, asked }
}

function panelElement(backend: FakeBackend, patch: Partial<TicketPanelProps>, scheduler: ManualScheduler): JSX.Element {
  return (
    <TicketPanel
      runner={backend.runner}
      folderPath="/repo"
      activity={null}
      scheduler={scheduler}
      epicId="ep_1"
      ticketId="tk_202"
      plan={savedPlan()}
      reloadKey={0}
      now={NOW}
      canEdit
      onEditInDraft={() => undefined}
      onClose={() => undefined}
      onSelectTicket={() => undefined}
      onReview={() => Promise.resolve(null)}
      onOpenChat={() => undefined}
      onDelete={() => Promise.resolve(null)}
      {...patch}
    />
  )
}

describe('ticket panel Activity tab', () => {
  it('is a tab the person can open, showing the latest attempt of the ticket', async () => {
    const { backend, asked } = fakeBackend()
    window.dm = backend
    render(panelElement(backend, {}, new ManualScheduler()))
    const tab = await screen.findByRole('tab', { name: 'Activity' })
    expect(tab.getAttribute('aria-selected')).toBe('false')
    fireEvent.click(tab)
    expect(await screen.findByText('note of at_202_2')).toBeTruthy()
    expect(tab.getAttribute('aria-selected')).toBe('true')
    expect(asked).toEqual([{ attemptId: 'at_202_2', sinceSeq: 0, limit: 200 }])
  })

  it('opens on the Activity tab for the attempt it was asked to show', async () => {
    const { backend, asked } = fakeBackend()
    window.dm = backend
    render(panelElement(backend, { activity: { attemptId: 'at_202_1' } }, new ManualScheduler()))
    expect(await screen.findByText('note of at_202_1')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true')
    expect(asked).toEqual([{ attemptId: 'at_202_1', sinceSeq: 0, limit: 200 }])
  })

  it('comes back to the Activity tab each time it is asked, even after the person moved on', async () => {
    const { backend } = fakeBackend()
    window.dm = backend
    const scheduler = new ManualScheduler()
    const view = render(panelElement(backend, { activity: { attemptId: 'at_202_2' } }, scheduler))
    await screen.findByText('note of at_202_2')
    fireEvent.click(screen.getByRole('tab', { name: 'Evidence' }))
    expect(screen.queryByText('note of at_202_2')).toBe(null)
    view.rerender(panelElement(backend, { activity: { attemptId: 'at_202_2' } }, scheduler))
    expect(await screen.findByText('note of at_202_2')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true')
  })

})

describe('ticket panel Activity tab attempts', () => {
  it('shows another attempt of the ticket when the person picks it', async () => {
    const { backend, asked } = fakeBackend()
    window.dm = backend
    render(panelElement(backend, { activity: { attemptId: 'at_202_2' } }, new ManualScheduler()))
    await screen.findByText('note of at_202_2')
    fireEvent.change(within(screen.getByRole('tabpanel')).getByRole('combobox', { name: 'Attempt' }), { target: { value: 'at_202_1' } })
    expect(await screen.findByText('note of at_202_1')).toBeTruthy()
    expect(asked).toHaveLength(2)
  })

  it('keeps polling the open attempt on the scheduler it was given', async () => {
    const { backend, asked } = fakeBackend()
    window.dm = backend
    const scheduler = new ManualScheduler()
    render(panelElement(backend, { activity: { attemptId: 'at_202_2' } }, scheduler))
    await screen.findByText('note of at_202_2')
    expect(scheduler.intervals()).toEqual([1500])
    act(() => scheduler.fireIntervals())
    await settle()
    expect(asked).toHaveLength(2)
  })
})
