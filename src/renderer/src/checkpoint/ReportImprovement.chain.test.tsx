// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProposalOutline } from '../../../shared/domain/retroFindings'
import { bundle, runView, SCORES } from '../epic/__mocks__/fixtures'
import { experiment, experimentRead, finding, findings, improvementReport, outcome } from '../__mocks__/improvementFixtures'
import { renderImprovement } from '../__mocks__/improvementRig'
import { FakeDm } from '../__mocks__/fakeDm'
import { settle } from '../__mocks__/settle'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'
import { ReportImprovement } from './ReportImprovement'
import { ReportTabs } from './ReportTabs'

allowSlowRendering()

afterEach(() => {
  cleanup()
})

function folder(): string {
  return `C:/improvement-chain/${expect.getState().currentTestName ?? ''}`
}

const XP_A = experiment('xp_a')
const section = (name: string): HTMLElement => screen.getByRole('region', { name })

function fieldOf(item: HTMLElement, label: string): HTMLElement {
  return within(item).getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement
}

const OUTLINE: ProposalOutline = {
  concern: 'plan_context',
  destination: 'source_repository',
  source: XP_A.source,
  baseline: { measure: 'T.actual_ms', unit: 'milliseconds', value: 5_400_000, state: 'observed' },
  direction: 'decrease',
  guardrails: [],
  needs: []
}

describe('findings of other grades, with proposals, contradictions and notes', () => {
  it('reads each finding’s subject, hypotheses, proposal, contradiction and experiments, then the notes', async () => {
    const sprint = finding('f_sp', { subject: { level: 'sprint', id: 'sp_2' }, assessmentId: 'as_sp2', hypotheses: [], proposal: OUTLINE, withheld: null, contradictedBy: ['f_none'] })
    const plain = finding('f_none', { rank: 2, kind: 'delivery_gap', proposal: null, withheld: null })
    const read = findings([sprint, plain], {
      status: 'insufficient_data',
      contradictions: [{ subject: { level: 'run', id: 'rn_2' }, findingIds: ['f_sp', 'f_none'], detail: 'Time rose while delivery fell.' }],
      notes: ['Two tickets had no budget.']
    })
    renderImprovement({ folder: folder(), report: improvementReport([XP_A]), findings: read, host: null })
    await settle()
    const items = within(section('Findings')).getAllByRole('listitem').filter((item) => item.classList.contains('cp-experiment'))
    expect(within(section('Findings')).getByText(/^Too little was measured to size a change/)).toBeTruthy()
    expect(fieldOf(items[0]!, 'Subject').textContent).toBe('Sprint grade')
    expect(fieldOf(items[0]!, 'Hypotheses').textContent).toBe('None offered')
    expect(fieldOf(items[0]!, 'Proposal').textContent).toContain('Read against T.actual_ms 5,400,000 milliseconds (observed)')
    expect(fieldOf(items[0]!, 'Contradicted by').textContent).toBe('#2 Delivery gap')
    expect(fieldOf(items[0]!, 'Experiments').textContent).toBe('No experiment of this retro was drawn from it')
    expect(fieldOf(items[1]!, 'Proposal').textContent).toBe('None')
    expect(within(items[1]!).queryByText('Contradicted by', { selector: 'dt' })).toBeNull()
    expect(within(section('Findings')).getByText('Run grade: Time rose while delivery fell.')).toBeTruthy()
    expect(within(section('Findings')).getByText('Two tickets had no budget.')).toBeTruthy()
  })
})

describe('a read-only report', () => {
  it('names the follow-up epic holding an experiment’s work without offering to open it', async () => {
    const tickets = [{ epicId: 'ep_f', epicTitle: 'Follow-up: Checkout', ticketId: 'tk_f1', key: 'FU-1', title: 'Name the files', role: 'work' as const, workIndex: 0, revisionNumber: 2, accepted: null }]
    const read = experimentRead(XP_A, { outcome: outcome('xp_a', { corrections: { tickets, runIds: [] } }) })
    renderImprovement({ folder: folder(), report: improvementReport([XP_A]), reads: { xp_a: read }, host: null })
    await settle()
    const item = within(section('Experiments')).getByText('xp_a').closest('li')!
    expect(fieldOf(item, 'Held in').textContent).toBe('Follow-up epic "Follow-up: Checkout" ep_f ')
    expect(within(fieldOf(item, 'Held in')).queryByRole('button')).toBeNull()
  })

  it('says a retro without experiments proposes no corrective work, and offers no planner', async () => {
    const report = improvementReport([])
    const withoutExperiments = { ...report.report.retro!, experiments: undefined }
    const world = renderImprovement({ folder: folder(), report: { ...report, report: { ...report.report, retro: withoutExperiments } } })
    await settle()
    expect(within(section('Experiments')).getByText('The retro proposes no experiment, so there is no corrective work to plan from it.')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Corrective work' })).toBeNull()
    expect(world.dm.callsOf('getExperiment')).toEqual([])
  })
})

describe('the Improvement tab among the report tabs', () => {
  it('opens the full Scorecard from the measured result', async () => {
    const dm = new FakeDm()
    dm.responses.getRetroFindings = findings([])
    dm.handlers.getExperiment = () => experimentRead(XP_A)
    window.dm = dm
    const improvement = (
      <ReportImprovement
        report={improvementReport([XP_A])}
        run={runView()}
        bundle={bundle()}
        epicTitle="Checkout revamp"
        epicCompleted={false}
        source={{ ...SCORES, folderPath: folder() }}
        onSelectTicket={() => undefined}
      />
    )
    render(<ReportTabs label="Sprint 2" report={<p>The report</p>} scorecard={<p>The full scorecard</p>} improvement={improvement} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Improvement' }))
    await settle()
    fireEvent.click(within(section('Measured result')).getByRole('button', { name: 'Open the full Scorecard →' }))
    expect(screen.getByRole('tab', { name: 'Scorecard' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('The full scorecard')).toBeTruthy()
  })
})
