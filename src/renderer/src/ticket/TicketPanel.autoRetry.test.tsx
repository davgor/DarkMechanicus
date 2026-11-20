// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AutoRetryView } from '../../../shared/domain/views'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { FakeBackend } from '../epic/__mocks__/fakeBackend'
import { NOW, savedPlan } from '../epic/__mocks__/fixtures'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'
import { TicketPanel } from './TicketPanel'

allowSlowRendering()

afterEach(() => {
  cleanup()
})

function retry(number: number, acknowledgedAt: string | null = null): AutoRetryView {
  return {
    runId: 'rn_2',
    runNumber: 2,
    ticketId: 'tk_202',
    number,
    failureReason: `Attempt ${number + 2} timed out importing the large bundle.`,
    newApproach: number === 1 ? 'Split the import into a streaming reader and a writer.' : 'Move to a higher model tier with a smaller context.',
    at: '2026-09-30T12:00:00.000Z',
    acknowledgedAt
  }
}

function renderPanel(backend: FakeBackend): { edits: number } {
  window.dm = backend
  const recorded = { edits: 0 }
  render(
    <TicketPanel
      runner={backend.runner}
      folderPath="/repo"
      folderKey="00000000000000000000000000000001"
      activity={null}
      scorecard={null}
      scheduler={new ManualScheduler()}
      epicId="ep_1"
      ticketId="tk_202"
      plan={savedPlan()}
      reloadKey={0}
      now={NOW}
      canEdit
      onEditInDraft={() => {
        recorded.edits += 1
      }}
      onClose={() => undefined}
      onSelectTicket={() => undefined}
      onReview={() => Promise.resolve(null)}
      onOpenChat={() => undefined}
      onDelete={() => Promise.resolve(null)}
    />
  )
  return recorded
}

function withRetries(retries: AutoRetryView[]): FakeBackend {
  const backend = new FakeBackend()
  backend.state.ticket = { ...backend.state.ticket, autoRetries: retries }
  return backend
}

describe('orchestrator retries on the ticket panel', () => {
  it("shows each retry's reason and new approach, with an Acknowledge button and an info count", async () => {
    renderPanel(withRetries([retry(1), retry(2)]))
    const section = await screen.findByRole('region', { name: 'Orchestrator retries' })
    const items = within(section).getAllByRole('listitem')
    expect(items.map((item) => item.querySelector('.tp-retry-title')?.textContent)).toEqual(['Retry 1 by the orchestrator', 'Retry 2 by the orchestrator'])
    expect(items[0]?.textContent).toContain('Why it failed: Attempt 3 timed out importing the large bundle.')
    expect(items[0]?.textContent).toContain("What's different this time: Split the import into a streaming reader and a writer.")
    expect(within(section).getAllByRole('button', { name: 'Acknowledge' })).toHaveLength(2)
    expect(screen.getByRole('status').textContent).toBe('2 orchestrator retries to read')
  })

  it('Acknowledge records that the person read it, and only that retry', async () => {
    const backend = withRetries([retry(1), retry(2)])
    renderPanel(backend)
    const section = await screen.findByRole('region', { name: 'Orchestrator retries' })
    const [first] = within(section).getAllByRole('listitem')
    fireEvent.click(within(first as HTMLElement).getByRole('button', { name: 'Acknowledge' }))
    await waitFor(() => expect(within(first as HTMLElement).getByText('Acknowledged').textContent).toBe('Acknowledged'))
    expect(backend.inputs('acknowledgeAutoRetry')).toEqual([{ runId: 'rn_2', ticketId: 'tk_202', number: 1 }])
    expect(within(section).getAllByRole('button', { name: 'Acknowledge' })).toHaveLength(1)
    expect(screen.getByRole('status').textContent).toBe('1 orchestrator retry to read')
    expect(backend.state.ticket.autoRetries.map((item) => item.acknowledgedAt !== null)).toEqual([true, false])
  })

})

describe('orchestrator retries never gate the ticket panel', () => {
  it('an unacknowledged retry blocks and disables nothing', async () => {
    const recorded = renderPanel(withRetries([retry(1)]))
    await screen.findByRole('region', { name: 'Orchestrator retries' })
    const panel = screen.getByLabelText('Ticket DM-202')
    const others = within(panel)
      .getAllByRole('button')
      .filter((button) => button.textContent !== 'Acknowledge')
    expect(others.length).toBeGreaterThan(0)
    expect(others.filter((button) => (button as HTMLButtonElement).disabled).map((button) => button.textContent)).toEqual([])
    expect(within(panel).getAllByRole('tab').every((tab) => !(tab as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit in draft' }))
    fireEvent.click(within(panel).getByRole('tab', { name: /Attempts/ }))
    expect(recorded.edits).toBe(1)
    expect(within(panel).getByRole('tab', { name: /Attempts/ }).getAttribute('aria-selected')).toBe('true')
    // No alert or needs-you treatment: the count is information only.
    expect(within(panel).queryByRole('alert')).toBe(null)
  })

  it('shows no section or count once every retry is read, and none for a ticket without retries', async () => {
    renderPanel(withRetries([retry(1, '2026-09-30T12:05:00.000Z')]))
    const section = await screen.findByRole('region', { name: 'Orchestrator retries' })
    expect(within(section).queryByRole('button', { name: 'Acknowledge' })).toBe(null)
    expect(screen.queryByRole('status')).toBe(null)
    cleanup()
    renderPanel(new FakeBackend())
    await screen.findByRole('heading', { level: 2 })
    expect(screen.queryByRole('region', { name: 'Orchestrator retries' })).toBe(null)
  })

  it('names the run when the ticket has retries in more than one run', async () => {
    renderPanel(withRetries([{ ...retry(1), runId: 'rn_1', runNumber: 1 }, retry(1)]))
    const section = await screen.findByRole('region', { name: 'Orchestrator retries' })
    expect(within(section).getAllByRole('listitem').map((item) => item.querySelector('.tp-retry-title')?.textContent)).toEqual([
      'Retry 1 by the orchestrator (run #1)',
      'Retry 1 by the orchestrator (run #2)'
    ])
  })
})
