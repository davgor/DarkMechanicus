// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within, type BoundFunctions, type queries } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ARCHETYPE_INFO, CULT_ARCHETYPES } from '../../../shared/cults/archetypes'
import type { CultDefinitionInput } from '../../../shared/cults/cultApi'
import { FakeCults, cultView } from '../__mocks__/fakeCults'
import { FakeDm } from '../__mocks__/fakeDm'
import { epicSummary, folderView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { FoundCultDialog } from './FoundCultDialog'

let dm: FakeDm
let cults: FakeCults
let submitted: CultDefinitionInput[]
let closed: number

const alpha = folderView()
const beta = folderView({ path: '/home/u/code/beta', name: 'beta' })

beforeEach(() => {
  dm = new FakeDm()
  cults = new FakeCults()
  dm.cults = cults
  window.dm = dm
  submitted = []
  closed = 0
})

afterEach(cleanup)

type Scope = BoundFunctions<typeof queries>

async function open(cult?: Parameters<typeof FoundCultDialog>[0]['cult']): Promise<Scope> {
  render(
    <FoundCultDialog folders={[alpha, beta]} cult={cult}
      onSubmit={(input) => { submitted.push(input); return Promise.resolve(null) }}
      onClose={() => { closed += 1 }} />
  )
  await settle()
  return within(screen.getByRole('dialog'))
}

const input = (dialog: Scope, label: string): HTMLInputElement => dialog.getByLabelText(label) as HTMLInputElement
const type = (dialog: Scope, label: string, value: string): void => {
  fireEvent.change(dialog.getByLabelText(label), { target: { value } })
}
const errorOf = (dialog: Scope, label: string): string | null => {
  const id = dialog.getByLabelText(label).getAttribute('aria-describedby')
  const note = id === null ? null : document.getElementById(id)
  return note?.className === 'form-error' ? note.textContent : null
}

async function fillRequired(dialog: Scope): Promise<void> {
  type(dialog, 'Name', 'Shrine Builders')
  type(dialog, 'Charter', 'Build the Gerry Shrine.')
  await settle()
}

async function save(dialog: Scope): Promise<void> {
  fireEvent.click(dialog.getByRole('button', { name: /Found cult|Save cult/ }))
  await settle()
}

describe('FoundCultDialog defaults', () => {
  it('starts General, 30m, cap 6, a themed Magos name, the first folder and the cheapest model', async () => {
    const dialog = await open()
    expect((dialog.getByRole('radio', { name: /^General/ }) as HTMLInputElement).checked).toBe(true)
    expect(input(dialog, 'Time limit').value).toBe('30m')
    expect(input(dialog, 'Time limit').disabled).toBe(false)
    expect((dialog.getByRole('checkbox', { name: 'Unlimited' }) as HTMLInputElement).checked).toBe(false)
    expect(input(dialog, 'Acolyte cap').value).toBe('6')
    expect(input(dialog, 'Magos name').value).toMatch(/^Magos [A-Z][a-z]+$/)
    expect((dialog.getByLabelText('Workspace') as HTMLSelectElement).value).toBe(alpha.path)
    expect((dialog.getByLabelText('Magos model') as HTMLSelectElement).value).toBe('anthropic/claude-haiku')
    expect(input(dialog, 'Acolyte grace').value).toBe('3m')
    expect(input(dialog, 'Magos window').value).toBe('2m')
  })

  it('saves the whole definition with the defaults, then closes', async () => {
    const dialog = await open()
    await fillRequired(dialog)
    type(dialog, 'Magos name', 'Magos Cawl')
    await save(dialog)
    expect(submitted).toEqual([{
      scope: 'folder', folderPath: alpha.path, name: 'Shrine Builders', charter: 'Build the Gerry Shrine.', archetype: 'general',
      targetEpicId: null, magosName: 'Magos Cawl', magosModelId: 'anthropic/claude-haiku', defaultTimeLimitMs: 30 * 60_000,
      defaultCap: 6, acolyteGraceMs: 3 * 60_000, magosWindowMs: 2 * 60_000
    }])
    expect(closed).toBe(1)
  })

  it('refuses to save without a name and a charter', async () => {
    const dialog = await open()
    await save(dialog)
    expect(submitted).toEqual([])
    expect(errorOf(dialog, 'Name')).toBe('Name the cult.')
    expect(errorOf(dialog, 'Charter')).toBe('Write the charter the Magos works to.')
  })
})

describe('FoundCultDialog workspace and editing', () => {
  it('offers No folder (project-less), saved as a sanctum cult', async () => {
    const dialog = await open()
    const workspace = dialog.getByLabelText('Workspace') as HTMLSelectElement
    expect(Array.from(workspace.options).map((option) => option.textContent)).toEqual(['alpha', 'beta', 'No folder (project-less)'])
    fireEvent.change(workspace, { target: { value: '' } })
    await fillRequired(dialog)
    await save(dialog)
    expect(submitted[0]).toMatchObject({ scope: 'sanctum', folderPath: null })
  })

  it('reuses the form to edit a cult, loading its values', async () => {
    const dialog = await open(cultView({ defaultTimeLimitMs: null, defaultCap: 9, archetype: 'delivery', slots: ARCHETYPE_INFO.delivery.preset.map((slot) => ({ ...slot })) }))
    expect(screen.getByRole('dialog', { name: 'Edit cult' })).toBeTruthy()
    expect((dialog.getByRole('checkbox', { name: 'Unlimited' }) as HTMLInputElement).checked).toBe(true)
    expect(input(dialog, 'Acolyte cap').value).toBe('9')
    await save(dialog)
    expect(submitted[0]).toMatchObject({ name: 'Shrine Builders', archetype: 'delivery', defaultTimeLimitMs: null, defaultCap: 9 })
  })
})

describe('FoundCultDialog time limit and cap', () => {
  it.each([
    ['90hr', 90 * 3_600_000],
    ['2d', 2 * 86_400_000],
    ['1d 6h', 30 * 3_600_000],
    ['1m', 60_000]
  ])('accepts %s', async (text, ms) => {
    const dialog = await open()
    await fillRequired(dialog)
    type(dialog, 'Time limit', text)
    expect(errorOf(dialog, 'Time limit')).toBeNull()
    await save(dialog)
    expect(submitted[0].defaultTimeLimitMs).toBe(ms)
  })

  it.each([
    ['0m', 'A duration must be greater than zero.'],
    ['30s', 'A time limit must be at least 1 minute, or unlimited.'],
    ['soon', '"soon" is not a duration; use whole numbers with s, m, h or d.']
  ])('refuses %s', async (text, message) => {
    const dialog = await open()
    await fillRequired(dialog)
    type(dialog, 'Time limit', text)
    expect(errorOf(dialog, 'Time limit')).toBe(message)
    await save(dialog)
    expect(submitted).toEqual([])
  })

  it('Unlimited disables the duration and saves no limit, even over a refused duration', async () => {
    const dialog = await open()
    await fillRequired(dialog)
    type(dialog, 'Time limit', '0m')
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Unlimited' }))
    expect(input(dialog, 'Time limit').disabled).toBe(true)
    expect(errorOf(dialog, 'Time limit')).toBeNull()
    await save(dialog)
    expect(submitted[0].defaultTimeLimitMs).toBeNull()
  })
})

describe('FoundCultDialog cap', () => {
  it.each([['0', 'The acolyte cap must be a whole number of at least 1.'], ['25', 'The acolyte cap cannot exceed 24.'], ['2.5', 'The acolyte cap must be a whole number of at least 1.']])(
    'refuses a cap of %s',
    async (cap, message) => {
      const dialog = await open()
      type(dialog, 'Acolyte cap', cap)
      expect(errorOf(dialog, 'Acolyte cap')).toBe(message)
    }
  )

  it('accepts caps 1 and 24', async () => {
    const dialog = await open()
    for (const cap of ['1', '24']) {
      type(dialog, 'Acolyte cap', cap)
      expect(errorOf(dialog, 'Acolyte cap')).toBeNull()
    }
  })
})

describe('FoundCultDialog advanced timings', () => {
  it('sits in an Advanced timings disclosure showing the derived backstop', async () => {
    const dialog = await open()
    const details = dialog.getByText('Advanced timings').closest('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(within(details).getByRole('status').textContent).toBe('Backstop: a run still going 6m after shutdown starts is killed.')
    type(dialog, 'Acolyte grace', '60m')
    type(dialog, 'Magos window', '30s')
    expect(within(details).getByRole('status').textContent).toBe('Backstop: a run still going 1h 1m 30s after shutdown starts is killed.')
  })

  it.each([['Acolyte grace', '29s'], ['Acolyte grace', '61m'], ['Magos window', '0m'], ['Magos window', '2h']])('refuses %s of %s', async (label, value) => {
    const dialog = await open()
    await fillRequired(dialog)
    type(dialog, label, value)
    expect(errorOf(dialog, label)).not.toBeNull()
    expect(dialog.getByRole('status').textContent).toBe('Backstop: fix the timings above.')
    await save(dialog)
    expect(submitted).toEqual([])
  })

  it('saves edited timings', async () => {
    const dialog = await open()
    await fillRequired(dialog)
    type(dialog, 'Acolyte grace', '30s')
    type(dialog, 'Magos window', '1h')
    await save(dialog)
    expect(submitted[0]).toMatchObject({ acolyteGraceMs: 30_000, magosWindowMs: 3_600_000 })
  })
})

describe('FoundCultDialog Magos model', () => {
  it('lists models cheapest first and refreshes on request', async () => {
    const dialog = await open()
    const select = dialog.getByLabelText('Magos model') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['Claude Haiku · low', 'Claude Sonnet · normal'])
    fireEvent.click(dialog.getByRole('button', { name: 'Refresh models' }))
    await settle()
    expect(cults.modelRequests).toEqual([false, true])
  })

  it('says OMP is signed out and offers no model', async () => {
    cults.modelsView = { options: [], reason: 'OMP is signed out. Sign in to OMP to choose a model.' }
    const dialog = await open()
    expect(dialog.queryByRole('combobox', { name: 'Magos model' })).toBeNull()
    expect(dialog.getByText('No model offered')).toBeTruthy()
    expect(dialog.getByText('OMP is signed out. Sign in to OMP to choose a model.')).toBeTruthy()
    await fillRequired(dialog)
    await save(dialog)
    expect(submitted[0].magosModelId).toBeNull()
  })
})

describe('FoundCultDialog archetypes and rosters', () => {
  it('offers all six archetypes with their purpose, and previews each roster', async () => {
    const dialog = await open()
    const radios = dialog.getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map((radio) => radio.value)).toEqual([...CULT_ARCHETYPES])
    for (const archetype of CULT_ARCHETYPES) {
      const info = ARCHETYPE_INFO[archetype]
      const radio = dialog.getByRole('radio', { name: new RegExp(`^${info.displayName.replace('/', '\\/')}`) })
      expect(radio.closest('label')?.textContent).toBe(`${info.displayName}${info.description}`)
      fireEvent.click(radio)
      const roster = within(dialog.getByRole('region', { name: 'Roster' }))
      const slots = roster.queryAllByRole('listitem')
      expect(slots.length).toBe(info.preset.length)
      info.preset.forEach((slot, index) => expect(slots[index].textContent).toContain(slot.label === '' ? slot.id : slot.label.slice(0, 3)))
      expect(dialog.getByText(info.reviewContract)).toBeTruthy()
    }
  })

  it('Plan Forge shows its six fixed specialists, read-only, and raises the cap to six', async () => {
    const dialog = await open()
    type(dialog, 'Acolyte cap', '3')
    fireEvent.click(dialog.getByRole('radio', { name: /^Plan Forge/ }))
    const roster = within(dialog.getByRole('region', { name: 'Roster' }))
    expect(roster.getAllByRole('listitem').map((item) => item.querySelector('.badge')?.textContent)).toEqual([
      'UI/UX', 'Implementation engineering', 'Delivery/Scrum', 'Security', 'Quality', 'Architecture/team lead'
    ])
    expect(roster.queryAllByRole('textbox')).toEqual([])
    expect(roster.queryByRole('button', { name: 'Add slot' })).toBeNull()
    expect(input(dialog, 'Acolyte cap').value).toBe('6')
    type(dialog, 'Acolyte cap', '5')
    expect(errorOf(dialog, 'Acolyte cap')).toBe('A Plan Forge needs a cap of at least 6.')
  })
})

describe('FoundCultDialog Plan Forge target', () => {
  it('Plan Forge requires a tracked folder and one target plan from that folder', async () => {
    dm.responses.listEpics = [epicSummary({ id: 'ep_1', title: 'Shrine plan' }), epicSummary({ id: 'ep_2', title: 'Other plan' })]
    const dialog = await open()
    fireEvent.click(dialog.getByRole('radio', { name: /^Plan Forge/ }))
    await settle()
    const target = dialog.getByLabelText('Target plan') as HTMLSelectElement
    expect(Array.from(target.options).map((option) => option.textContent)).toEqual(['Choose a plan', 'Shrine plan', 'Other plan'])
    expect(dm.commandCalls.filter((call) => call.name === 'listEpics').map((call) => call.folder)).toEqual([alpha.path])
    await fillRequired(dialog)
    await save(dialog)
    expect(submitted).toEqual([])
    expect(errorOf(dialog, 'Target plan')).toBe('Choose the plan this Plan Forge works on.')

    fireEvent.change(dialog.getByLabelText('Workspace'), { target: { value: '' } })
    await settle()
    expect(errorOf(dialog, 'Workspace')).toBe('A Plan Forge works in a tracked folder.')

    fireEvent.change(dialog.getByLabelText('Workspace'), { target: { value: beta.path } })
    await settle()
    expect(dm.commandCalls.filter((call) => call.name === 'listEpics').map((call) => call.folder)).toEqual([alpha.path, beta.path])
    fireEvent.change(dialog.getByLabelText('Target plan'), { target: { value: 'ep_2' } })
    await save(dialog)
    expect(submitted).toEqual([expect.objectContaining({ archetype: 'plan_forge', scope: 'folder', folderPath: beta.path, targetEpicId: 'ep_2', defaultCap: 6 })])
    expect(submitted[0].slots).toBeUndefined()
  })

  it('lets a Delivery cult edit its default slots, and saves them', async () => {
    const dialog = await open()
    fireEvent.click(dialog.getByRole('radio', { name: /^Delivery/ }))
    const roster = within(dialog.getByRole('region', { name: 'Roster' }))
    expect(roster.queryByRole('button', { name: 'Add slot' })).toBeNull()
    fireEvent.change(roster.getByLabelText('Label of slot quality'), { target: { value: 'Test lead' } })
    fireEvent.change(roster.getByLabelText('Mission of Test lead'), { target: { value: 'Owns the release proof.' } })
    await fillRequired(dialog)
    await save(dialog)
    expect(submitted[0].slots?.map((slot) => slot.label)).toEqual(['Architecture/team lead', 'Implementation engineering', 'Test lead', 'Delivery/Scrum'])
    expect(submitted[0].slots?.[2]).toMatchObject({ id: 'quality', workerType: 'quality', mission: 'Owns the release proof.', required: true })
  })
})

describe('FoundCultDialog Custom roster', () => {
  it('lets a Custom cult add, reorder, edit and remove required slots and missions', async () => {
    const dialog = await open()
    fireEvent.click(dialog.getByRole('radio', { name: /^Custom/ }))
    const roster = within(dialog.getByRole('region', { name: 'Roster' }))
    fireEvent.click(roster.getByRole('button', { name: 'Add slot' }))
    fireEvent.click(roster.getByRole('button', { name: 'Add slot' }))
    fireEvent.click(roster.getByRole('button', { name: 'Add slot' }))
    fireEvent.change(roster.getByLabelText('Label of slot slot_1'), { target: { value: 'Lorekeeper' } })
    fireEvent.change(roster.getByLabelText('Mission of Lorekeeper'), { target: { value: 'Keeps the lore.' } })
    fireEvent.change(roster.getByLabelText('Label of slot slot_2'), { target: { value: 'Artisan' } })
    fireEvent.change(roster.getByLabelText('Mission of Artisan'), { target: { value: 'Builds the shrine.' } })
    fireEvent.click(roster.getByRole('button', { name: 'Remove slot 3' }))
    fireEvent.click(roster.getByRole('button', { name: 'Move Artisan up' }))
    expect(roster.getByRole('button', { name: 'Move Artisan up' }).hasAttribute('disabled')).toBe(true)
    await fillRequired(dialog)
    await save(dialog)
    expect(submitted[0].slots).toEqual([
      { id: 'slot_2', workerType: 'custom', label: 'Artisan', mission: 'Builds the shrine.', required: true },
      { id: 'slot_1', workerType: 'custom', label: 'Lorekeeper', mission: 'Keeps the lore.', required: true }
    ])
  })

  it('refuses a Custom roster with a blank mission or more required slots than the cap', async () => {
    const dialog = await open()
    fireEvent.click(dialog.getByRole('radio', { name: /^Custom/ }))
    const roster = within(dialog.getByRole('region', { name: 'Roster' }))
    fireEvent.click(roster.getByRole('button', { name: 'Add slot' }))
    fireEvent.click(roster.getByRole('button', { name: 'Add slot' }))
    fireEvent.change(roster.getByLabelText('Label of slot slot_1'), { target: { value: 'A' } })
    fireEvent.change(roster.getByLabelText('Label of slot slot_2'), { target: { value: 'B' } })
    fireEvent.change(roster.getByLabelText('Mission of A'), { target: { value: 'Same mission' } })
    type(dialog, 'Acolyte cap', '1')
    await fillRequired(dialog)
    await save(dialog)
    expect(submitted).toEqual([])
    expect(roster.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(['Slot mission must not be blank.', 'Cap 1 is below the 2 required slots.'])
  })
})

describe('FoundCultDialog refusal', () => {
  it('keeps the dialog open with the reason main gave', async () => {
    render(<FoundCultDialog folders={[alpha]} onSubmit={() => Promise.resolve('The folder is no longer tracked.')} onClose={() => { closed += 1 }} />)
    await settle()
    const dialog = within(screen.getByRole('dialog'))
    await fillRequired(dialog)
    await save(dialog)
    expect(closed).toBe(0)
    expect(dialog.getByRole('alert').textContent).toBe('The folder is no longer tracked.')
  })
})
