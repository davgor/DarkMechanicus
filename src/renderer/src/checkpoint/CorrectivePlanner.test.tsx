// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { deferred } from '../__mocks__/deferred'
import { experiment, improvementReport, planView, REPORT_ID } from '../__mocks__/improvementFixtures'
import { recordingHost, renderImprovement, type ImprovementWorld } from '../__mocks__/improvementRig'
import { settle } from '../__mocks__/settle'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'

allowSlowRendering()

afterEach(() => {
  cleanup()
})

const XP_A = experiment('xp_a')
const XP_B = experiment('xp_b')

/** The planner store is per folder: each test plans in its own. */
function folder(): string {
  return `C:/planner/${expect.getState().currentTestName ?? ''}`
}

async function open(patch: Partial<Parameters<typeof renderImprovement>[0]> = {}): Promise<ImprovementWorld> {
  const world = renderImprovement({ folder: folder(), report: improvementReport([XP_A, XP_B]), ...patch })
  await settle()
  return world
}

const planner = (): HTMLElement => screen.getByRole('region', { name: 'Corrective work' })
const button = (name: string | RegExp): HTMLElement => within(planner()).getByRole('button', { name })
const tick = (id: string): void => {
  fireEvent.click(screen.getByRole('checkbox', { name: `Select ${id} for corrective work` }))
}
const leftOut = (): string[] => within(planner()).queryAllByRole('listitem').filter((item) => item.closest('[aria-label="Left out of the request"]') !== null).map((item) => item.textContent ?? '')

async function preview(): Promise<void> {
  fireEvent.click(button(/^Preview/))
  await settle()
}

describe('DM-187 c4 (view): opening the report starts no work', () => {
  it('previews or creates nothing until the person asks, and says so', async () => {
    const world = await open()
    expect(world.host.previews).toEqual([])
    expect(world.host.creates).toEqual([])
    expect(within(planner()).getByText(/Opening this report or a low grade starts nothing/)).toBeTruthy()
    expect(button('Preview corrective work')).toHaveProperty('disabled', true)
    expect(button('Create draft work')).toHaveProperty('disabled', true)
  })
})

describe('DM-187 c2: select, edit and preview before creating a draft', () => {
  it('previews the selected experiment with its target, destination, criteria and dependencies', async () => {
    const world = await open()
    tick('xp_a')
    expect(within(planner()).getByText('Selected: xp_a')).toBeTruthy()
    await preview()
    expect(world.host.previews).toEqual([{ reportId: REPORT_ID, experimentIds: ['xp_a'], fireguard: true }])
    const panel = screen.getByRole('region', { name: 'Preview of the corrective work' })
    expect(within(panel).getByText('The draft of "Checkout revamp": a new Sprint 4, appended (after Sprint 3, which stays as it is) · goal: Corrective work')).toBeTruthy()
    const second = within(panel).getByRole('listitem', { name: 'Corrective work DM-311' })
    expect(within(second).getByText('The claim packet lists the importer files')).toBeTruthy()
    expect(within(second).getAllByText("This project's repository").length).toBe(1)
    expect(within(second).getByText('DM-310')).toBeTruthy()
    expect(within(within(panel).getByRole('group', { name: 'Dependencies' })).getByText('DM-311 requires DM-310')).toBeTruthy()
    expect(button('Create draft work')).toHaveProperty('disabled', false)
  })

  it('sends an edited title, marks it Edited, and asks for a new preview after the edit', async () => {
    const world = await open()
    tick('xp_a')
    await preview()
    fireEvent.click(within(planner()).getAllByRole('button', { name: 'Edit title, body, criteria or prerequisites' })[0]!)
    const form = within(planner()).getByRole('group', { name: 'Edit xp_a · work 1' })
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Name the importer files' } })
    expect(within(planner()).getByText(/^Your choices changed since the preview/, { selector: 'p.field-hint' })).toBeTruthy()
    expect(button('Create draft work')).toHaveProperty('disabled', true)
    fireEvent.click(within(form).getByRole('button', { name: 'Done' }))
    await preview()
    expect(world.host.previews[1]?.edits).toEqual([{ experimentId: 'xp_a', index: 0, title: 'Name the importer files' }])
    const work = screen.getByRole('region', { name: 'Selected work' })
    expect(within(work).getByText('Name the importer files')).toBeTruthy()
    expect(within(work).getByText('Edited')).toBeTruthy()
  })

  it('creates the previewed work as draft only, against the draft revision the preview read, and opens the draft', async () => {
    const world = await open()
    tick('xp_a')
    await preview()
    fireEvent.click(button('Create draft work'))
    await settle()
    expect(world.host.creates).toEqual([{ reportId: REPORT_ID, experimentIds: ['xp_a'], fireguard: true, expectedDraftRevision: 7 }])
    world.host.draftRevision = 8
    world.rerender({ corrections: { ...world.host } })
    const result = screen.getByRole('status', { name: 'Corrective work created' })
    expect(within(result).getByText(/Created as draft work in "Checkout revamp" \(draft revision 8\)\. Nothing was saved, adopted, started or approved\./)).toBeTruthy()
    expect(within(result).getByText(/Approve retro & redraft saves, adopts and approves only when you press it/)).toBeTruthy()
    fireEvent.click(within(result).getByRole('button', { name: 'Open the draft to review and Save' }))
    expect(world.host.opened).toEqual(['ep_1'])
  })
})

describe('DM-187 c3: repeated clicks start one request', () => {
  it('ignores a second Preview click while the first is in flight', async () => {
    const host = recordingHost()
    host.hold = deferred()
    const world = await open({ host })
    tick('xp_a')
    fireEvent.click(button('Preview corrective work'))
    fireEvent.click(button('Reading the preview…'))
    expect(button('Reading the preview…')).toHaveProperty('disabled', true)
    host.hold.resolve()
    await settle()
    expect(world.host.previews.length).toBe(1)
  })

  it('creates once for a double click on Create draft work', async () => {
    const host = recordingHost()
    const world = await open({ host })
    tick('xp_a')
    await preview()
    host.hold = deferred()
    fireEvent.click(button('Create draft work'))
    fireEvent.click(button('Creating draft work…'))
    host.hold.resolve()
    await settle()
    expect(world.host.creates.length).toBe(1)
  })
})

describe('DM-187 c3: stale draft and stale report keep the person’s work', () => {
  it('a draft changed since the preview refuses creation, drops the preview and keeps the edits', async () => {
    const host = recordingHost()
    host.createAnswer = () => ({ ok: false, failure: { code: 'conflict', message: 'stale', details: { currentDraftRevision: 9 } } })
    await open({ host })
    tick('xp_a')
    fireEvent.click(within(planner()).getAllByRole('button', { name: 'Edit title, body, criteria or prerequisites' })[0]!)
    fireEvent.change(within(planner()).getByLabelText('Title'), { target: { value: 'Kept title' } })
    await preview()
    fireEvent.click(button('Create draft work'))
    await settle()
    expect(within(planner()).getByRole('alert').textContent).toContain('The draft changed since your preview (it is now revision 9). Nothing was created; your selection and edits are kept.')
    expect(screen.queryByRole('region', { name: 'Preview of the corrective work' })).toBeNull()
    expect(within(planner()).getByLabelText('Title')).toHaveProperty('value', 'Kept title')
    expect(within(planner()).getByText('Selected: xp_a')).toBeTruthy()
    fireEvent.click(within(planner()).getByRole('button', { name: 'Preview again' }))
    await settle()
    expect(host.previews.length).toBe(2)
  })

  it('a newer report revision marks the preview stale and keeps the selection', async () => {
    const world = await open()
    tick('xp_a')
    await preview()
    world.rerender({ report: improvementReport([XP_A, XP_B], { id: 'sr_2', reportRevision: 2 }) })
    await settle()
    expect(within(planner()).getByText('This preview was read for report revision 1; the report is now revision 2. Preview again: your selection and edits are kept.')).toBeTruthy()
    expect(within(planner()).getByText('Selected: xp_a')).toBeTruthy()
    expect(within(planner()).getByText('The report was revised since the preview: preview again against the latest revision.')).toBeTruthy()
  })

  it('a result disappears once the draft it wrote is saved or edited further', async () => {
    const world = await open()
    tick('xp_a')
    await preview()
    fireEvent.click(button('Create draft work'))
    await settle()
    world.rerender({ corrections: { ...world.host, draftRevision: 8 } })
    expect(screen.queryByRole('status', { name: 'Corrective work created' })).not.toBeNull()
    world.rerender({ corrections: { ...world.host, draftRevision: 9 } })
    expect(screen.queryByRole('status', { name: 'Corrective work created' })).toBeNull()
  })
})

describe('DM-187 c3: blocked prerequisites and blocked work', () => {
  it('names blocked work from the preview and how to recover, and keeps Create disabled', async () => {
    const host = recordingHost()
    host.previewAnswer = (input) => {
      const plan = planView(input.experimentIds)
      return { ok: true, value: { ...plan, tickets: [], experiments: plan.experiments.map((item) => ({ ...item, state: 'blocked', problems: ['Work 1 is unsized.'] })) } }
    }
    await open({ host })
    tick('xp_a')
    await preview()
    expect(within(planner()).getByText('Work 1 is unsized.')).toBeTruthy()
    expect(within(planner()).getByText(/^xp_a cannot be created as the experiment states it/)).toBeTruthy()
    expect(button('Create draft work')).toHaveProperty('disabled', true)
  })

  it('review fix 1: a prerequisite on a deselected experiment’s work is left out and reported, and the preview still runs', async () => {
    const world = await open()
    tick('xp_a')
    tick('xp_b')
    fireEvent.click(within(planner()).getAllByRole('button', { name: 'Edit title, body, criteria or prerequisites' })[0]!)
    fireEvent.click(within(planner()).getByRole('checkbox', { name: 'xp_b · work 1 xp_b work one' }))
    tick('xp_b')
    expect(leftOut()).toEqual([
      'Your edit of xp_a#0 requires xp_b#0, whose experiment is not selected: that prerequisite is left out of the request. Select its experiment again to keep it.'
    ])
    await preview()
    expect(world.host.previews).toEqual([{ reportId: REPORT_ID, experimentIds: ['xp_a'], edits: [{ experimentId: 'xp_a', index: 0, dependsOn: [] }], fireguard: true }])
    expect(within(planner()).queryByRole('alert')).toBeNull()
  })

  it('review fix 2: cleared criteria keep the generated ones instead of sending an empty list', async () => {
    const world = await open()
    tick('xp_a')
    await preview()
    fireEvent.click(within(planner()).getAllByRole('button', { name: 'Edit title, body, criteria or prerequisites' })[0]!)
    const criteria = within(planner()).getByLabelText('Acceptance criteria, one per line')
    expect(criteria).toHaveProperty('value', 'The claim packet lists the importer files')
    fireEvent.change(criteria, { target: { value: '' } })
    await preview()
    expect(world.host.previews[1]).toEqual({ reportId: REPORT_ID, experimentIds: ['xp_a'], fireguard: true })
  })
})

describe('DM-187 review fix 3: focus after Reset', () => {
  it('stays on the Edit button when Reset is pressed from a closed row', async () => {
    await open()
    tick('xp_a')
    fireEvent.click(within(planner()).getAllByRole('button', { name: 'Edit title, body, criteria or prerequisites' })[0]!)
    fireEvent.change(within(planner()).getByLabelText('Title'), { target: { value: 'Mine' } })
    fireEvent.click(within(planner()).getByRole('button', { name: 'Done' }))
    const edit = within(planner()).getAllByRole('button', { name: 'Edit title, body, criteria or prerequisites' })[0]!
    const reset = within(planner()).getByRole('button', { name: 'Reset to the generated ticket' })
    // A real click focuses the button it presses; that button then goes away with the edit.
    reset.focus()
    fireEvent.click(reset)
    expect(document.activeElement).toBe(edit)
    expect(within(planner()).queryByRole('button', { name: 'Reset to the generated ticket' })).toBeNull()
  })

  it('returns to the Edit button when Reset is pressed from the open form', async () => {
    await open()
    tick('xp_a')
    fireEvent.click(within(planner()).getAllByRole('button', { name: 'Edit title, body, criteria or prerequisites' })[0]!)
    fireEvent.change(within(planner()).getByLabelText('Title'), { target: { value: 'Mine' } })
    fireEvent.click(within(planner()).getByRole('button', { name: 'Reset to the generated ticket' }))
    expect(document.activeElement).toBe(within(planner()).getAllByRole('button', { name: 'Edit title, body, criteria or prerequisites' })[0])
  })
})

describe('DM-187 review fix 4: a dropped target', () => {
  it('is cleared by choosing the already-checked new-sprint option', async () => {
    const host = recordingHost({ sprints: [{ id: 'sp_3', ordinal: 3, goal: 'Polish' }] })
    const world = await open({ host })
    tick('xp_a')
    const radios = within(planner()).getAllByRole('radio')
    fireEvent.click(radios.find((radio) => radio.closest('label')?.textContent?.startsWith('An existing later sprint')) ?? radios[0]!)
    expect(within(planner()).getByRole('combobox', { name: 'Later sprint' })).toHaveProperty('value', 'sp_3')
    world.rerender({ corrections: { ...host, sprints: [] } })
    const fresh = within(planner()).getByRole('radio', { name: /A new sprint appended/ })
    expect(fresh).toHaveProperty('checked', true)
    expect(leftOut()).toEqual(['The sprint chosen earlier is no longer a later sprint of the draft: a new sprint is appended instead.'])
    fireEvent.click(fresh)
    expect(leftOut()).toEqual([])
  })
})

/** What the core previews for a completed epic: a new follow-up epic, its first sprint. */
function followUpPlan(experimentIds: string[]): ReturnType<typeof planView> {
  const plan = planView(experimentIds, { draftRevision: null })
  return { ...plan, target: { ...plan.target, kind: 'follow_up_epic', epicId: null, epicTitle: 'Follow-up: Checkout revamp', sprintOrdinal: 1, afterOrdinal: null } }
}

describe('DM-187 c2 (completed epic): corrective work goes into a follow-up epic', () => {
  it('offers a follow-up epic title instead of any sprint of the draft, and sends the trimmed title', async () => {
    const world = await open({ epicCompleted: true, host: recordingHost({ sprints: [{ id: 'sp_3', ordinal: 3, goal: 'Polish' }] }) })
    expect(within(planner()).queryByRole('radio', { name: /A new sprint appended/ })).toBeNull()
    expect(within(planner()).queryByRole('combobox', { name: 'Later sprint' })).toBeNull()
    expect(within(planner()).getByText(/^A follow-up epic linked to this completed epic, as a draft you review and Save\./)).toBeTruthy()
    const title = within(planner()).getByRole('textbox', { name: 'Title of a new follow-up epic' })
    expect(title).toHaveProperty('placeholder', 'Follow-up: Checkout revamp')
    tick('xp_a')
    await preview()
    fireEvent.change(title, { target: { value: '  Fix packets  ' } })
    expect(title).toHaveProperty('value', '  Fix packets  ')
    await preview()
    expect(world.host.previews).toEqual([
      { reportId: REPORT_ID, experimentIds: ['xp_a'], fireguard: true },
      { reportId: REPORT_ID, experimentIds: ['xp_a'], target: { kind: 'follow_up_epic', title: 'Fix packets' }, fireguard: true }
    ])
  })

  it('drops a sprint chosen before the epic completed, says why, and leaves the target to the follow-up default', async () => {
    const host = recordingHost({ sprints: [{ id: 'sp_3', ordinal: 3, goal: 'Polish' }] })
    const world = await open({ host })
    tick('xp_a')
    fireEvent.click(within(planner()).getAllByRole('radio').find((radio) => radio.closest('label')?.textContent?.startsWith('An existing later sprint'))!)
    world.rerender({ epicCompleted: true })
    expect(leftOut()).toEqual(['The epic is completed: the sprint chosen earlier no longer applies, so the work goes into a follow-up epic.'])
    await preview()
    expect(host.previews).toEqual([{ reportId: REPORT_ID, experimentIds: ['xp_a'], fireguard: true }])
  })
})

describe('DM-187 c2 (completed epic): the result leads to the follow-up epic, never the checkpoint gate', () => {
  it('creates into the follow-up epic and opens it there, with no checkpoint-gate hint', async () => {
    const host = recordingHost()
    host.previewAnswer = (input) => ({ ok: true, value: followUpPlan(input.experimentIds) })
    host.createAnswer = (input) => {
      const plan = followUpPlan(input.experimentIds)
      return { ok: true, value: { ...plan, changed: true, draftRevision: 1, target: { ...plan.target, epicId: 'ep_f' } } }
    }
    const world = await open({ epicCompleted: true, host })
    tick('xp_a')
    await preview()
    expect(within(screen.getByRole('region', { name: 'Preview of the corrective work' })).getByText('A new follow-up epic "Follow-up: Checkout revamp" · Sprint 1 · goal: Corrective work')).toBeTruthy()
    fireEvent.click(button('Create draft work'))
    await settle()
    expect(host.creates).toEqual([{ reportId: REPORT_ID, experimentIds: ['xp_a'], fireguard: true, expectedDraftRevision: null }])
    const result = screen.getByRole('status', { name: 'Corrective work created' })
    expect(within(result).getByText(/^Created as draft work in "Follow-up: Checkout revamp" \(draft revision 1\)\./)).toBeTruthy()
    expect(within(result).queryByText(/Approve retro & redraft/)).toBeNull()
    fireEvent.click(within(result).getByRole('button', { name: 'Open "Follow-up: Checkout revamp" to review and Save' }))
    expect(world.host.opened).toEqual(['ep_f'])
  })

  it('reads work already held in the completed epic itself as nothing added, without the checkpoint-gate hint', async () => {
    const host = recordingHost()
    host.previewAnswer = (input) => ({ ok: true, value: followUpPlan(input.experimentIds) })
    host.createAnswer = (input) => ({ ok: true, value: { ...followUpPlan(input.experimentIds), changed: false, tickets: [], createdIn: [{ epicId: 'ep_1', experimentIds: ['xp_a'] }], draftRevision: 7 } })
    const world = await open({ epicCompleted: true, host })
    tick('xp_a')
    await preview()
    fireEvent.click(button('Create draft work'))
    await settle()
    const result = screen.getByRole('status', { name: 'Corrective work created' })
    expect(within(result).getByText(/Already created by the same request: nothing was added\./)).toBeTruthy()
    expect(within(result).queryByText(/Approve retro & redraft/)).toBeNull()
    fireEvent.click(within(result).getByRole('button', { name: 'Open the draft to review and Save' }))
    expect(world.host.opened).toEqual(['ep_1'])
  })
})
