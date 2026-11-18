// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { CorrectionPlanView } from '../../../shared/domain/corrections'
import { experiment, improvementReport, planView, REPORT_ID, resultOf, workTicket } from '../__mocks__/improvementFixtures'
import { recordingHost, renderImprovement, type ImprovementWorld } from '../__mocks__/improvementRig'
import { editWork, plannerFolder, plannerRegion, previewWork, tickExperiment } from '../__mocks__/retroUiSteps'
import { settle } from '../__mocks__/settle'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'

allowSlowRendering()

afterEach(() => {
  cleanup()
})

const XP_A = experiment('xp_a')

async function open(host = recordingHost()): Promise<ImprovementWorld> {
  const world = renderImprovement({ folder: plannerFolder(), report: improvementReport([XP_A]), host })
  await settle()
  return world
}

const previewPanel = (): HTMLElement => screen.getByRole('region', { name: 'Preview of the corrective work' })
const notice = (): HTMLElement => within(plannerRegion()).getByRole('alert')

/** A preview of blocked work already held elsewhere, with its restatement, an existing node and an invalid draft. */
function blockedPlan(experimentIds: string[]): CorrectionPlanView {
  const plan = planView(experimentIds)
  const existing = { key: 'k', payloadHash: 'p', epicId: 'ep_9', holder: 'revision' as const, revisionNumber: 4, ticketIds: [], keys: ['DM-50'] }
  const restatement = { source: XP_A.source, concern: XP_A.concern, issue: XP_A.issue, hypothesis: 'h', destination: XP_A.destination, proposedWork: [{ title: 'Sized', size: 'small' as const }], baseline: XP_A.baseline, expectedChange: XP_A.expectedChange, guardrails: [], window: XP_A.window }
  return {
    ...plan,
    experiments: plan.experiments.map((item) => ({ ...item, state: 'blocked', existing, restatement, problems: ['Work 1 is vague.'] })),
    tickets: [workTicket('xp_a', 0, { tags: [], existing: true, acceptanceCriteria: [{ id: 'a', text: 'Covers the importer', covers: 'xp_a#0' }] })],
    dependencies: [],
    validation: { valid: false, errors: [{ code: 'cycle', message: 'A cycle.' }], warnings: [{ code: 'goal', message: 'No goal.' }] },
    notes: ['Read at draft revision 7.']
  }
}

describe('the preview of blocked work held elsewhere', () => {
  it('says the edits were previewed, where the work already is, how to restate it, and why the draft is not valid', async () => {
    const host = recordingHost()
    host.previewAnswer = (input) => ({ ok: true, value: blockedPlan(input.experimentIds) })
    const world = await open(host)
    tickExperiment('xp_a')
    fireEvent.change(within(editWork(0)).getByLabelText('Title'), { target: { value: 'Mine' } })
    await previewWork()
    const panel = previewPanel()
    expect(within(panel).getByText('Previewed with your edits: fix or reset them under Selected work.')).toBeTruthy()
    expect(within(panel).getByText(/Already in DM-50 in the saved revision 4 of epic ep_9\./)).toBeTruthy()
    expect(JSON.parse(panel.querySelector('pre')?.textContent ?? 'null')).toMatchObject({ hypothesis: 'h', proposedWork: [{ title: 'Sized', size: 'small' }] })
    fireEvent.click(within(panel).getByRole('button', { name: "Open that epic's draft" }))
    expect(world.host.opened).toEqual(['ep_9'])
    const ticket = within(panel).getByRole('listitem', { name: 'Corrective work DM-310' })
    expect(within(ticket).getByText('existing node: gains covers')).toBeTruthy()
    expect(within(ticket).getByText('Tags', { selector: 'dt' }).nextElementSibling?.textContent).toBe('None')
    expect(within(ticket).getByText('Covers the importer').textContent).toBe('Covers the importer (covers DM-310)')
    expect(within(panel).queryByRole('group', { name: 'Dependencies' })).toBeNull()
    const validation = within(panel).getByRole('group', { name: 'Validation' })
    expect(within(validation).getByText('Not valid yet: Save stays blocked until these are fixed.')).toBeTruthy()
    expect(within(validation).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Error: A cycle.', 'Warning: No goal.', 'Read at draft revision 7.'])
  })
})

describe('refusals that need a reload or a new preview', () => {
  it('reloads the workspace from a refusal naming a missing record, clearing the refusal', async () => {
    const host = recordingHost()
    host.previewAnswer = () => ({ ok: false, failure: { code: 'not_found', message: 'No report sr_1.' } })
    await open(host)
    tickExperiment('xp_a')
    await previewWork()
    expect(notice().className).toBe('cp-refusal')
    expect(within(notice()).queryByRole('button', { name: 'Preview again' })).toBeNull()
    fireEvent.click(within(notice()).getByRole('button', { name: 'Reload' }))
    expect(host.reloads).toEqual(['reload'])
    expect(within(plannerRegion()).queryByRole('alert')).toBeNull()
  })

  it('turns a reload refusal into a note once the newer revision is shown, which can be dismissed', async () => {
    const host = recordingHost()
    host.previewAnswer = () => ({ ok: false, failure: { code: 'conflict', message: 'Replaced.', details: { latestReportId: 'sr_2' } } })
    const world = await open(host)
    tickExperiment('xp_a')
    await previewWork()
    world.rerender({ report: improvementReport([XP_A], { id: 'sr_2', reportRevision: 2 }) })
    expect(notice().className).toBe('cp-plan-info')
    expect(notice().textContent).toMatch(/^The report was read again: its revision 2 is shown now\./)
    fireEvent.click(within(notice()).getByRole('button', { name: 'Dismiss' }))
    expect(within(plannerRegion()).queryByRole('alert')).toBeNull()
  })

  it('asks for nothing when Preview again is pressed with no experiment selected', async () => {
    const host = recordingHost()
    host.previewAnswer = () => ({ ok: false, failure: { code: null, message: 'Disk full.' } })
    await open(host)
    tickExperiment('xp_a')
    await previewWork()
    tickExperiment('xp_a')
    fireEvent.click(within(notice()).getByRole('button', { name: 'Preview again' }))
    await settle()
    expect(host.previews).toHaveLength(1)
    expect(notice().textContent).toContain('The preview could not be read: Disk full.')
  })
})

describe('a creation that fails or names no epic', () => {
  it('keeps the preview when the creation fails for a reason a new preview cannot fix', async () => {
    const host = recordingHost()
    host.createAnswer = () => ({ ok: false, failure: { code: null, message: 'Disk full.' } })
    await open(host)
    tickExperiment('xp_a')
    await previewWork()
    fireEvent.click(within(plannerRegion()).getByRole('button', { name: 'Create draft work' }))
    await settle()
    expect(notice().textContent).toContain('The draft work was not created: Disk full.')
    expect(within(notice()).getAllByRole('button').map((button) => button.textContent)).toEqual(['Dismiss'])
    expect(within(previewPanel()).getByText('Ready to create')).toBeTruthy()
  })

  it('shows the created work without an epic to open when the result names none', async () => {
    const host = recordingHost()
    host.createAnswer = (input) => {
      const created = resultOf(planView(input.experimentIds))
      return { ok: true, value: { ...created, target: { ...created.target, epicId: null }, createdIn: [] } }
    }
    await open(host)
    tickExperiment('xp_a')
    await previewWork()
    fireEvent.click(within(plannerRegion()).getByRole('button', { name: 'Create draft work' }))
    await settle()
    const result = screen.getByRole('status', { name: 'Corrective work created' })
    expect(within(result).getByText(/^Created as draft work in "Checkout revamp"/)).toBeTruthy()
    expect(within(result).queryByRole('button')).toBeNull()
    expect(host.creates).toEqual([{ reportId: REPORT_ID, experimentIds: ['xp_a'], fireguard: true, expectedDraftRevision: 7 }])
  })
})
