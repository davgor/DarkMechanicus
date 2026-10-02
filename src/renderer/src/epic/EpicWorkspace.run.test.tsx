// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import {
  attempt,
  checkpointView,
  condition,
  epicDetail,
  mcpTestEpic,
  mcpTestPlan,
  mcpTestReport,
  mcpTestRun,
  runView,
  ticketDetail
} from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
})

function runBar(): HTMLElement {
  return screen.getByLabelText('Run')
}

describe('run bar controls', () => {
  it('pauses and resumes the run', async () => {
    const h = renderWorkspace(new FakeBackend())
    fireEvent.click(await screen.findByRole('button', { name: 'Pause run' }))
    expect(await screen.findByText('Run paused. Open attempts may still report.')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Resume run' }))
    expect(await screen.findByText('Run resumed.')).toBeTruthy()
    expect(h.backend.names().filter((name) => name.endsWith('Run'))).toEqual(['getRun', 'pauseRun', 'getRun', 'resumeRun', 'getRun'])
  })

  it('cancels the run only after confirmation', async () => {
    const h = renderWorkspace(new FakeBackend())
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel run' })
    expect(within(dialog).getByText('Cancel Run #2? Open attempts are canceled and no more work is dispatched.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep running' }))
    expect(h.backend.inputs('cancelRun')).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel run' }))
    expect(await screen.findByText('Run canceled.')).toBeTruthy()
    expect(h.backend.inputs('cancelRun')).toEqual([{ runId: 'rn_2' }])
    expect(screen.queryByRole('alertdialog')).toBe(null)
  })

  it('offers only take over for a run imported from another machine', async () => {
    const h = renderWorkspace(new FakeBackend(scenario({ run: runView({ ownedByThisMachine: false }) })))
    expect((await screen.findByText('This run was imported from another machine. Take over to control it here.')).tagName).toBe('P')
    expect(within(runBar()).queryByRole('button', { name: 'Pause run' })).toBe(null)
    fireEvent.click(within(runBar()).getByRole('button', { name: 'Take over' }))
    expect(await screen.findByText('Run taken over. Reconcile expired attempts before resuming.')).toBeTruthy()
    expect(h.backend.inputs('takeoverRun')).toEqual([{ runId: 'rn_2' }])
  })

  it('announces a newer saved revision and adopts it at the checkpoint', async () => {
    const epic = epicDetail({ currentRevisionId: 'rv_5', currentRevisionNumber: 5 })
    const h = renderWorkspace(new FakeBackend(scenario({ epic, run: runView({ state: 'awaiting_checkpoint' }) })))
    expect(await screen.findByText('Rev 5 saved — adopt at the next checkpoint')).toBeTruthy()
    fireEvent.click(within(runBar()).getByRole('button', { name: 'Adopt' }))
    expect(await screen.findByText('Revision adopted. The run continues on the new plan.')).toBeTruthy()
    expect(h.backend.inputs('adoptRevision')).toEqual([{ runId: 'rn_2', revisionId: 'rv_5' }])
  })

  it('keeps adoption disabled while the run is working', async () => {
    renderWorkspace(new FakeBackend(scenario({ epic: epicDetail({ currentRevisionId: 'rv_5', currentRevisionNumber: 5 }) })))
    await screen.findByText('Rev 5 saved — adopt at the next checkpoint')
    expect((within(runBar()).getByRole('button', { name: 'Adopt' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('checkpoint review in the workspace', () => {
  const ready = checkpointView({ gatesMet: true, conditions: [condition('report_submitted', true, 'ok')] })

  it('opens the sprint report instead of the graph and returns to it', async () => {
    renderWorkspace(new FakeBackend(scenario({ run: runView({ state: 'awaiting_checkpoint' }), checkpoint: checkpointView() })))
    expect((await screen.findByText('AWAITING CHECKPOINT')).textContent).toBe('AWAITING CHECKPOINT')
    fireEvent.click(within(runBar()).getByRole('button', { name: 'Sprint report' }))
    expect(screen.getByLabelText('Sprint checkpoint').className).toBe('cp')
    expect(screen.queryByLabelText('Plan graph')).toBe(null)
    fireEvent.click(within(runBar()).getByRole('button', { name: 'Open graph' }))
    expect(screen.getByLabelText('Plan graph').className).toBe('pg is-readonly')
  })

  it('approves and advances, retries failed tickets and toggles auto-continue', async () => {
    const h = renderWorkspace(new FakeBackend(scenario({ run: runView({ state: 'awaiting_checkpoint' }), checkpoint: ready })))
    fireEvent.click(await within(await screen.findByLabelText('Run')).findByRole('button', { name: 'Sprint report' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Allow automatic continuation/ }))
    expect(await screen.findByText('Automatic continuation allowed for this run.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Approve & advance to Sprint 3' }))
    expect(await screen.findByText('Checkpoint approved — Sprint 3 started.')).toBeTruthy()
    expect(h.backend.inputs('approveAndAdvance')).toEqual([{ runId: 'rn_2', reportId: 'sr_1' }])
    expect(h.backend.inputs('authorizeAutoContinue')).toEqual([{ runId: 'rn_2', enabled: true }])
    expect(screen.queryByLabelText('Sprint checkpoint')).toBe(null)
  })

  it('adds a proposed follow-up to a newly opened draft and retries a failed ticket', async () => {
    const tickets = runView().tickets.map((item) => (item.ticketId === 'tk_202' ? { ...item, state: 'failed' as const } : item))
    const run = runView({ state: 'awaiting_checkpoint', tickets })
    const h = renderWorkspace(new FakeBackend(scenario({ run, checkpoint: checkpointView() })))
    fireEvent.click(await within(await screen.findByLabelText('Run')).findByRole('button', { name: 'Sprint report' }))
    fireEvent.click(screen.getAllByRole('button', { name: '+ Add to draft' })[0] as HTMLElement)
    expect(await screen.findByText('Added "Provide a signing identity" to Sprint 3 of the draft.')).toBeTruthy()
    expect(h.backend.names().filter((name) => name === 'openDraft' || name === 'updatePlanDraft')).toEqual(['openDraft', 'updatePlanDraft'])
    fireEvent.click(screen.getByRole('button', { name: 'Retry DM-202' }))
    expect(await screen.findByText('Retry granted. The orchestrator can claim the ticket again.')).toBeTruthy()
    expect(h.backend.inputs('grantRetry')).toEqual([{ runId: 'rn_2', ticketId: 'tk_202' }])
  })
})

describe('completed epic overview in the workspace', () => {
  function completedEpic(): FakeBackend {
    return new FakeBackend(
      scenario({ epic: mcpTestEpic(), saved: mcpTestPlan(), run: mcpTestRun(), checkpoint: null, reports: [mcpTestReport()] })
    )
  }

  it('offers the overview of a completed epic from the run bar, read-only, and returns to the graph', async () => {
    const h = renderWorkspace(completedEpic())
    fireEvent.click(await within(await screen.findByLabelText('Run')).findByRole('button', { name: 'Epic report' }))
    const overview = screen.getByLabelText('Epic overview')
    expect(within(overview).getByText(/^The MCP authoring and execution path works end to end/)).toBeTruthy()
    expect(within(overview).getByLabelText('Sprint 1 report').tagName).toBe('ARTICLE')
    expect(screen.queryByLabelText('Plan graph')).toBe(null)
    expect(screen.queryByLabelText('Sprint checkpoint')).toBe(null)
    expect(within(overview).queryAllByRole('button')).toEqual([])
    expect(screen.queryAllByRole('checkbox')).toEqual([])
    expect(within(runBar()).getAllByRole('button').map((item) => item.textContent)).toEqual(['Open graph'])
    expect(h.backend.names().includes('getCheckpoint')).toBe(false)
    fireEvent.click(within(runBar()).getByRole('button', { name: 'Open graph' }))
    expect(screen.getByLabelText('Plan graph').className).toBe('pg is-readonly')
  })

  it('keeps the overview open after the final checkpoint is approved', async () => {
    const final = checkpointView({ gatesMet: true, isFinalSprint: true, sprintOrdinal: 3, conditions: [condition('report_submitted', true, 'ok')] })
    const h = renderWorkspace(new FakeBackend(scenario({ run: runView({ state: 'awaiting_checkpoint' }), checkpoint: final })))
    h.backend.handlers.approveAndAdvance = () => {
      Object.assign(h.backend.state, { epic: mcpTestEpic(), saved: mcpTestPlan(), run: mcpTestRun(), checkpoint: null, reports: [mcpTestReport()] })
      return h.backend.state.run
    }
    fireEvent.click(await within(await screen.findByLabelText('Run')).findByRole('button', { name: 'Sprint report' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve & complete epic' }))
    expect(await screen.findByText('Checkpoint approved — the epic is complete.')).toBeTruthy()
    const overview = await screen.findByLabelText('Epic overview')
    expect(within(overview).getByRole('heading', { name: 'Epic complete' })).toBeTruthy()
    expect(screen.queryByLabelText('Plan graph')).toBe(null)
    expect(screen.queryByRole('button', { name: /Approve/ })).toBe(null)
    expect(within(runBar()).getByRole('button', { name: 'Open graph' })).toBeTruthy()
  })
})

describe('ticket review from the workspace', () => {
  it('opens the ticket panel from the graph and accepts a submitted attempt', async () => {
    const ticket = ticketDetail({ attempts: [attempt('DM-202', 3, 'submitted')] })
    const h = renderWorkspace(new FakeBackend(scenario({ ticket })))
    fireEvent.click(await screen.findByText('Transactional bundle import'))
    const panel = await screen.findByLabelText('Ticket DM-202')
    expect(document.querySelector('.ew-main')?.className).toBe('ew-main has-panel')
    fireEvent.click(await within(panel).findByRole('tab', { name: 'Attempts (1)' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Accept' }))
    await screen.findByText('RUNNING · ATTEMPT 2')
    expect(h.backend.inputs('acceptAttempt')).toEqual([{ attemptId: 'at_202_3' }])
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit in draft' }))
    expect((await screen.findByLabelText('Edit ticket DM-202')).tagName).toBe('ASIDE')
    fireEvent.click(screen.getByRole('button', { name: 'Close ticket' }))
    expect(screen.queryByLabelText('Edit ticket DM-202')).toBe(null)
    expect(document.querySelector('.ew-main')?.className).toBe('ew-main')
  })

  it('selects a ticket from the attempts strip', async () => {
    renderWorkspace(new FakeBackend())
    const strip = await screen.findByLabelText('Run activity')
    fireEvent.click(within(strip).getByRole('button', { name: 'DM-201 #1 submitted' }))
    expect((await screen.findByLabelText('Ticket DM-201')).tagName).toBe('ASIDE')
  })
})
