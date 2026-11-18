// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { EvidenceRef } from '../../../shared/domain/space'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { component, spaceGrade, ticketGrade, ticketTiming } from '../__mocks__/ticketScorecardFixtures'
import { FakeBackend } from '../epic/__mocks__/fakeBackend'
import { attempt, NOW, savedPlan } from '../epic/__mocks__/fixtures'
import { TicketPanel, type TicketPanelProps } from './TicketPanel'

afterEach(cleanup)

const CITED: EvidenceRef[] = [
  { kind: 'attempt', id: 'at_202_1', detail: null },
  { kind: 'attempt', id: 'at_999', detail: null },
  { kind: 'check', id: 'at_202_2', detail: 'Unit tests' },
  { kind: 'check', id: 'at_999', detail: 'Lint' },
  { kind: 'criterion', id: 'tk_202', detail: 'c1' },
  { kind: 'ticket', id: 'tk_304', detail: null },
  { kind: 'comment', id: 'cm_1', detail: null },
  { kind: 'observation', id: 'ob_1', detail: null }
]

/** A backend whose ticket DM-202 has a grade in each run: run rn_2's cites every kind of record in `CITED`. */
function scoredBackend(): FakeBackend {
  const backend = new FakeBackend()
  backend.handlers.getTicketGrade = (input: { runId: string }) =>
    ticketGrade({ runId: input.runId, ticketId: 'tk_202', grade: spaceGrade({ components: [component('S'), component('P', { evidence: CITED })] }) })
  backend.handlers.getRunTiming = () => ({ tickets: [ticketTiming('tk_202', [])] })
  backend.handlers.getRunMetrics = () => ({ attempts: [] })
  backend.handlers.getSprintReport = () => null
  backend.handlers.getRun = (input: { runId: string }) => ({ id: input.runId, number: input.runId === 'rn_1' ? 1 : 2 })
  return backend
}

function renderPanel(backend: FakeBackend, patch: Partial<TicketPanelProps> = {}): { selected: string[] } {
  window.dm = backend
  const recorded = { selected: [] as string[] }
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
      onEditInDraft={() => undefined}
      onClose={() => undefined}
      onSelectTicket={(id) => recorded.selected.push(id)}
      onReview={() => Promise.resolve(null)}
      onOpenChat={() => undefined}
      onDelete={() => Promise.resolve(null)}
      {...patch}
    />
  )
  return recorded
}

const selectedTab = (): string | null => screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent ?? null

async function openScorecard(): Promise<void> {
  fireEvent.click(screen.getByRole('tab', { name: 'Scorecard' }))
  await settle()
}

describe('ticket panel tab keys', () => {
  it('arrow keys, Home and End open and focus the tab they reach, wrapping at either end', async () => {
    renderPanel(scoredBackend())
    await settle()
    const strip = screen.getByRole('tablist', { name: 'Ticket sections' })
    fireEvent.keyDown(strip, { key: 'ArrowRight' })
    expect(selectedTab()).toBe('Attempts (2)')
    expect(document.activeElement?.textContent).toBe('Attempts (2)')
    fireEvent.keyDown(strip, { key: 'End' })
    expect(selectedTab()).toBe('Scorecard')
    fireEvent.keyDown(strip, { key: 'ArrowRight' })
    expect(selectedTab()).toBe('Overview')
    fireEvent.keyDown(strip, { key: 'ArrowLeft' })
    expect(selectedTab()).toBe('Scorecard')
    fireEvent.keyDown(strip, { key: 'Home' })
    expect([selectedTab(), document.activeElement?.textContent]).toEqual(['Overview', 'Overview'])
    await settle()
  })

  it('any other key leaves the tab and the key alone', async () => {
    renderPanel(scoredBackend())
    await settle()
    const unhandled = fireEvent.keyDown(screen.getByRole('tablist', { name: 'Ticket sections' }), { key: 'a' })
    expect(unhandled).toBe(true)
    expect(selectedTab()).toBe('Overview')
  })
})

describe('ticket panel scorecard', () => {
  it('opens on the Scorecard tab when another screen asks for it, and the run picker follows the chosen run', async () => {
    const backend = scoredBackend()
    backend.state.ticket = { ...backend.state.ticket, attempts: [attempt('DM-202', 1, 'failed', { runId: 'rn_1', createdAt: '2026-01-01T00:00:00.000Z' }), attempt('DM-202', 2, 'running')] }
    renderPanel(backend, { scorecard: { runId: null } })
    await settle()
    expect(selectedTab()).toBe('Scorecard')
    const picker = screen.getByDisplayValue('Run #2 (latest)')
    fireEvent.change(picker, { target: { value: 'rn_1' } })
    await settle()
    expect((screen.getByDisplayValue('Run #1') as HTMLSelectElement).value).toBe('rn_1')
    expect(backend.inputs('getTicketGrade')).toContainEqual({ runId: 'rn_1', ticketId: 'tk_202' })
  })
})

describe('ticket panel scorecard citations', () => {
  it('offers each citation where this panel can show it, and nothing for records it cannot', async () => {
    renderPanel(scoredBackend())
    await settle()
    await openScorecard()
    const evidence = within(screen.getByRole('listitem', { name: 'Performance' })).getByRole('list', { name: 'Evidence' })
    const offered = within(evidence)
      .getAllByRole('listitem')
      .map((item) => item.textContent)
    expect(offered).toEqual([
      'attempt at_202_1 → Attempts',
      'attempt at_999',
      'check at_202_2 · Unit tests → Evidence',
      'check at_999 · Lint',
      'criterion tk_202 · c1 → Overview',
      'ticket tk_304 → ticket',
      'comment cm_1 → Comments',
      'observation ob_1'
    ])
    expect(within(evidence).getAllByTitle('Not viewable here').map((item) => item.textContent)).toEqual(['attempt at_999', 'check at_999 · Lint', 'observation ob_1'])
  })

  it('a citation opens its tab, the cited attempt\'s evidence, or the other ticket', async () => {
    const recorded = renderPanel(scoredBackend())
    await settle()
    const follow = async (name: string): Promise<string | null> => {
      await openScorecard()
      fireEvent.click(screen.getByRole('button', { name }))
      await settle()
      return selectedTab()
    }
    expect(await follow('attempt at_202_1 → Attempts')).toBe('Attempts (2)')
    expect(await follow('check at_202_2 · Unit tests → Evidence')).toBe('Evidence')
    expect(screen.getByText('This attempt recorded no evidence.')).toBeTruthy()
    expect(await follow('criterion tk_202 · c1 → Overview')).toBe('Overview')
    expect(await follow('comment cm_1 → Comments')).toBe('Comments')
    expect(await follow('ticket tk_304 → ticket')).toBe('Scorecard')
    expect(recorded.selected).toEqual(['tk_304'])
  })

  it('an attempt row this ticket\'s detail does not hold opens nothing and stays on the Scorecard', async () => {
    const recorded = renderPanel(scoredBackend())
    await settle()
    await openScorecard()
    fireEvent.click(within(screen.getByRole('region', { name: 'Attempts in this run' })).getByRole('button', { name: 'Attempt #1 · accepted' }))
    await settle()
    expect(selectedTab()).toBe('Scorecard')
    expect(recorded.selected).toEqual([])
  })
})

describe('ticket panel header fallbacks', () => {
  it('names a ticket missing from the plan by its id while it fails to load', async () => {
    renderPanel(new FakeBackend(), { ticketId: 'tk_missing' })
    await settle()
    const panel = screen.getByRole('complementary', { name: 'Ticket tk_missing' })
    expect(within(panel).getByRole('alert').textContent).toBe('No ticket')
  })

  it('leaves the sprint goal out of the meta line when the ticket\'s sprint is not in the plan', async () => {
    const backend = new FakeBackend()
    backend.state.ticket = { ...backend.state.ticket, sprintId: 'sp_elsewhere' }
    renderPanel(backend)
    await settle()
    expect(screen.getByText('Sprint 2 · rev 4 · Read-only while run #2 is active').tagName).toBe('P')
  })
})
