// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { RetroExperiment } from '../../../shared/domain/experiments'
import type { SprintReportView } from '../../../shared/domain/views'
import { experiment, improvementReport, REPORT_ID } from '../__mocks__/improvementFixtures'
import { recordingHost, renderImprovement, type ImprovementWorld } from '../__mocks__/improvementRig'
import { editWork, plannerFolder, plannerRegion, previewWork, tickExperiment } from '../__mocks__/retroUiSteps'
import { settle } from '../__mocks__/settle'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'

allowSlowRendering()

afterEach(() => {
  cleanup()
})

const XP_A = experiment('xp_a')
const XP_DM = experiment('xp_dm', { destination: { kind: 'darkmechanicus_source' } })

async function open(patch: Partial<Parameters<typeof renderImprovement>[0]> = {}): Promise<ImprovementWorld> {
  const world = renderImprovement({ folder: plannerFolder(), report: improvementReport([XP_A]), ...patch })
  await settle()
  return world
}

/** Revision 2 of the report, its xp_a restated by `patch`. */
function revised(patch: Partial<RetroExperiment>): SprintReportView {
  return improvementReport([experiment('xp_a', patch)], { id: 'sr_2', reportRevision: 2 })
}

describe('where the work goes: a later sprint of the draft', () => {
  it('offers the later sprints in order and sends the one chosen in the list', async () => {
    const world = await open({ host: recordingHost({ sprints: [{ id: 'sp_4', ordinal: 4, goal: '' }, { id: 'sp_3', ordinal: 3, goal: 'Polish' }] }) })
    tickExperiment('xp_a')
    fireEvent.click(within(plannerRegion()).getAllByRole('radio').find((radio) => radio.closest('label')?.textContent?.startsWith('An existing later sprint'))!)
    const list = within(plannerRegion()).getByRole('combobox', { name: 'Later sprint' })
    expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual(['Sprint 3 · Polish', 'Sprint 4'])
    fireEvent.change(list, { target: { value: 'sp_4' } })
    await previewWork()
    expect(world.host.previews).toEqual([{ reportId: REPORT_ID, experimentIds: ['xp_a'], target: { kind: 'sprint', sprintId: 'sp_4' }, fireguard: true }])
  })

  it('counts every sprint as later when the plan does not hold the report’s sprint', async () => {
    await open({ report: improvementReport([XP_A], { sprintId: 'sp_9' }), host: recordingHost({ sprints: [{ id: 'sp_1', ordinal: 1, goal: '' }] }) })
    expect(within(plannerRegion()).getByText('It ends at a human checkpoint. Sprint 0 and earlier stay as they are.')).toBeTruthy()
    expect(within(plannerRegion()).getByRole('combobox', { name: 'Later sprint' }).textContent).toBe('Sprint 1')
  })
})

describe('the destination of the retro’s experiments', () => {
  it('counts the experiments routed from their own Dark Mechanicus source panel', async () => {
    await open({ report: improvementReport([XP_A, XP_DM]) })
    expect(within(plannerRegion()).getByText(/^1 experiment\(s\) aimed at it are routed from their own "Dark Mechanicus source" panel above/)).toBeTruthy()
  })

  it('names no repository when every experiment goes to the Dark Mechanicus source', async () => {
    await open({ report: improvementReport([XP_DM]) })
    expect(within(plannerRegion()).getByText("Each experiment's tickets go to the repository it names.")).toBeTruthy()
  })
})

describe('editing a work ticket before previewing', () => {
  it('sends the edited body and ticket prerequisites, a prerequisite ticked then cleared, and no Fireguard', async () => {
    const world = await open()
    tickExperiment('xp_a')
    const form = editWork(0)
    fireEvent.change(within(form).getByLabelText(/^Body: what changes/), { target: { value: 'Name each importer file.' } })
    fireEvent.change(within(form).getByLabelText('Requires draft tickets (keys, separated by commas)'), { target: { value: 'DM-12' } })
    const other = within(form).getByRole('checkbox', { name: 'xp_a · work 2 xp_a work two' })
    fireEvent.click(other)
    expect(other).toHaveProperty('checked', true)
    fireEvent.click(other)
    expect(other).toHaveProperty('checked', false)
    fireEvent.click(within(plannerRegion()).getByRole('checkbox', { name: 'Add a Fireguard ticket that grades the corrective tests' }))
    await previewWork()
    expect(world.host.previews).toEqual([
      { reportId: REPORT_ID, experimentIds: ['xp_a'], edits: [{ experimentId: 'xp_a', index: 0, body: 'Name each importer file.', dependsOn: [{ ticket: 'DM-12' }] }], fireguard: false }
    ])
  })

  it('offers no other work to require for a lone unsized item, and marks a blank title', async () => {
    await open({ report: improvementReport([experiment('xp_c', { proposedWork: [{ title: 'Only work', body: 'Do it.' }] })]) })
    tickExperiment('xp_c')
    const work = screen.getByRole('region', { name: 'Selected work' })
    expect(within(work).getByText('Unsized')).toBeTruthy()
    const form = editWork(0)
    expect(within(form).queryByRole('group', { name: 'Requires other corrective work' })).toBeNull()
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: '  ' } })
    expect(within(work).getByText('(no title)')).toBeTruthy()
  })
})

describe('an edit written before the report was revised', () => {
  async function editedThenRevised(): Promise<ImprovementWorld> {
    const world = await open()
    tickExperiment('xp_a')
    fireEvent.change(within(editWork(0)).getByLabelText('Title'), { target: { value: 'Mine' } })
    fireEvent.click(within(plannerRegion()).getByRole('button', { name: 'Done' }))
    world.rerender({ report: revised({ proposedWork: [{ title: 'Restated one', body: 'Restated body.', size: 'small' }, XP_A.proposedWork[1]!] }) })
    await settle()
    return world
  }

  it('is held until kept for the restated work, then sent', async () => {
    const world = await editedThenRevised()
    expect(within(plannerRegion()).getByRole('alert').textContent).toContain('You edited this work when it read "xp_a work one"; this revision restates it as "Restated one".')
    fireEvent.click(within(plannerRegion()).getByRole('button', { name: 'Keep my edit' }))
    expect(within(plannerRegion()).queryByRole('alert')).toBeNull()
    await previewWork()
    expect(world.host.previews).toEqual([{ reportId: 'sr_2', experimentIds: ['xp_a'], edits: [{ experimentId: 'xp_a', index: 0, title: 'Mine' }], fireguard: true }])
  })

  it('is dropped when discarded, and the restated work is used as written', async () => {
    const world = await editedThenRevised()
    fireEvent.click(within(plannerRegion()).getByRole('button', { name: 'Discard my edit' }))
    const work = screen.getByRole('region', { name: 'Selected work' })
    expect(within(work).queryByText('Edited')).toBeNull()
    expect(within(work).getByText('Restated one')).toBeTruthy()
    await previewWork()
    expect(world.host.previews).toEqual([{ reportId: 'sr_2', experimentIds: ['xp_a'], fireguard: true }])
  })

  it('names an edit of a work item the revision dropped, and clears it', async () => {
    const world = await open()
    tickExperiment('xp_a')
    fireEvent.change(within(editWork(1)).getByLabelText('Title'), { target: { value: 'Second, mine' } })
    fireEvent.click(within(plannerRegion()).getByRole('button', { name: 'Done' }))
    world.rerender({ report: revised({ proposedWork: [XP_A.proposedWork[0]!] }) })
    await settle()
    const dropped = within(plannerRegion()).getByRole('status')
    expect(dropped.textContent).toMatch(/^Your edit of xp_a work 2: this revision's experiment no longer has that work item/)
    fireEvent.click(within(dropped).getByRole('button', { name: 'Clear dropped edits' }))
    expect(within(plannerRegion()).queryByRole('status')).toBeNull()
  })
})
