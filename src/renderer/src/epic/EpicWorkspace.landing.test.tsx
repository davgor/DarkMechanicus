// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AttemptTimelineView } from '../../../shared/domain/activity'
import type { TicketLanding } from '../app/landing'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend } from './__mocks__/fakeBackend'
import { draftPlan, epicDetail } from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(cleanup)

const LANDING: TicketLanding = { kind: 'ticket', epicId: 'ep_1', ticketId: 'tk_202', attemptId: 'at_202_2' }

function backend(): FakeBackend {
  const fake = new FakeBackend()
  fake.handlers.getAttemptTimeline = (): AttemptTimelineView => ({ attemptId: 'at_202_2', runId: 'rn_2', ticketId: 'tk_202', state: 'running', isLive: true, cursor: 1, entries: [], sessions: [] })
  return fake
}

describe('landing on a ticket from another screen', () => {
  it('opens the ticket on its Activity tab for the attempt once the epic has loaded, and tells the shell it took the request', async () => {
    const landed: number[] = []
    renderWorkspace(backend(), { scheduler: new ManualScheduler(), landing: LANDING, onLanded: () => landed.push(1) })

    const ticket = await screen.findByLabelText('Ticket DM-202')
    expect((await within(ticket).findByRole('tab', { name: 'Activity' })).getAttribute('aria-selected')).toBe('true')
    expect(landed).toEqual([1])
  })

  it('opens the ticket without the Activity tab when no attempt is named', async () => {
    renderWorkspace(backend(), { scheduler: new ManualScheduler(), landing: { ...LANDING, attemptId: null }, onLanded: () => undefined })

    const ticket = await screen.findByLabelText('Ticket DM-202')
    expect((await within(ticket).findByRole('tab', { name: 'Activity' })).getAttribute('aria-selected')).toBe('false')
  })

  it('shows the saved plan, where the Activity tab is, when the epic opens on a draft with changes', async () => {
    const fake = backend()
    fake.state.epic = epicDetail({ hasDraft: true, draftRevision: 7, draftChanged: true })
    fake.state.draft = draftPlan({ draftRevision: 7 })
    renderWorkspace(fake, { scheduler: new ManualScheduler(), landing: LANDING, onLanded: () => undefined })

    const ticket = await screen.findByLabelText('Ticket DM-202')
    expect((await within(ticket).findByRole('tab', { name: 'Activity' })).getAttribute('aria-selected')).toBe('true')
  })

  it('takes the request once: closing the panel is not undone, and a ticket the epic does not have opens nothing', async () => {
    const landed: number[] = []
    const first = renderWorkspace(backend(), { scheduler: new ManualScheduler(), landing: LANDING, onLanded: () => landed.push(1) })
    await screen.findByLabelText('Ticket DM-202')
    first.refresh(1)
    await settle()
    expect(landed).toEqual([1])
    cleanup()

    const missing: number[] = []
    renderWorkspace(backend(), { scheduler: new ManualScheduler(), landing: { ...LANDING, ticketId: 'tk_gone' }, onLanded: () => missing.push(1) })
    await settle()
    expect(screen.queryByLabelText(/^Ticket DM-/)).toBeNull()
    expect(missing).toEqual([1])
  })

  it('leaves the workspace as it is when there is no request', async () => {
    renderWorkspace(backend(), { scheduler: new ManualScheduler() })
    await settle()
    expect(screen.queryByLabelText(/^Ticket DM-/)).toBeNull()
  })
})
