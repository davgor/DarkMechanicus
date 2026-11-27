// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCults, cultView, memberDetail, runDetail } from '../__mocks__/fakeCults'
import { FakeDm } from '../__mocks__/fakeDm'
import { folderView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { ClockContext, type Clock } from '../epic/clock'
import { CultsSection } from './CultsSection'
import type { CultRunDetail } from '../../../shared/cults/cultApi'

let cults: FakeCults

/** Ten minutes into the seeded running run. */
const CLOCK: Clock = { now: () => Date.parse('2026-11-27T12:10:00.000Z'), subscribe: () => () => undefined }

beforeEach(() => {
  const dm = new FakeDm()
  cults = new FakeCults()
  dm.cults = cults
  window.dm = dm
})

afterEach(cleanup)

interface Calls {
  selected: string[]
  opened: string[]
}

async function renderSection(selectedCultId: string | null = null): Promise<Calls> {
  const calls: Calls = { selected: [], opened: [] }
  render(
    <ClockContext.Provider value={CLOCK}>
      <CultsSection folders={[folderView()]} selectedCultId={selectedCultId}
        onSelectCult={(id) => calls.selected.push(id)} onOpenMember={(cultId, id) => calls.opened.push(`${cultId}:${id}`)} />
    </ClockContext.Provider>
  )
  await settle()
  return calls
}

/** A running Plan-Forge-like run: the Magos, a working UI/UX acolyte with a tier reason, an idle Magos-typed acolyte, and one that left. */
function liveRun(): CultRunDetail {
  const detail = runDetail({}, [
    memberDetail(),
    memberDetail({ chatId: 'chat_a', role: 'acolyte', displayName: 'Acolyte Ferrum-3', model: 'anthropic/claude-sonnet', tier: 'normal', tierReason: 'Needs deeper layout reasoning.', slotId: 'ui_ux', workerType: 'ui_ux', typeOrigin: 'definition_slot' }),
    memberDetail({ chatId: 'chat_b', role: 'acolyte', displayName: 'Acolyte Vox-4', model: 'anthropic/claude-haiku', tier: 'low', runWorkerTypeId: 'dyn_1', typeOrigin: 'magos_created' }),
    memberDetail({ chatId: 'chat_c', role: 'acolyte', displayName: 'Acolyte Gone-1', leftAt: '2026-11-27T12:05:00.000Z', state: 'dismissed' })
  ])
  const members = detail.members.map((member) => (member.chatId === 'chat_a' ? { ...member, activity: { working: true, tool: null, at: '2026-11-27T12:09:00.000Z' } } : member))
  return {
    ...detail,
    members,
    workerTypes: [{ id: 'dyn_1', displayName: 'Lore keeper', description: 'd', mission: 'm', rationale: 'r', requiredForConclusion: false, creatorMemberId: 'chat_magos', createdAt: 'a', updatedAt: 'a', retiredAt: null, origin: 'magos_created', state: 'active', assignedChatIds: ['chat_b'], reportCount: 0 }]
  }
}

describe('CultsSection rows', () => {
  it('shows the empty state under the CULTS head with its + button', async () => {
    await renderSection()
    const section = screen.getByRole('region', { name: 'Cults' })
    expect(within(section).getByRole('button', { name: 'Cults' }).textContent).toContain('CULTS')
    expect(within(section).getByRole('button', { name: 'Found a cult' })).toBeTruthy()
    expect(within(section).getByText('No cults yet. Use + to found one.')).toBeTruthy()
  })

  it('shows each cult with its archetype, state dot and the live time left of an active run', async () => {
    cults.cults = [cultView(), cultView({ id: 'cult_2', name: 'Plan Council', archetype: 'plan_forge' }), cultView({ id: 'cult_3', name: 'Paused Ones' }), cultView({ id: 'cult_4', name: 'Winding Down', archetype: 'delivery' })]
    cults.runsByCult = {
      cult_1: [runDetail()],
      cult_3: [runDetail({ id: 'run_3', cultId: 'cult_3', state: 'paused', runningSince: null, accumulatedRunningMs: 5 * 60_000 })],
      cult_4: [runDetail({ id: 'run_4', cultId: 'cult_4', state: 'shutting_down', timeLimitMs: null, runningSince: null })]
    }
    const calls = await renderSection('cult_2')
    const row = (name: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^${name}`) })
    expect(row('Shrine Builders').textContent).toBe('Shrine BuildersGeneralrunning20m left')
    expect(row('Plan Council').textContent).toBe('Plan CouncilPlan Forgeidle')
    expect(row('Plan Council').getAttribute('aria-current')).toBe('true')
    expect(row('Paused Ones').textContent).toBe('Paused OnesGeneralpaused25m left')
    expect(row('Winding Down').textContent).toBe('Winding DownDeliveryendingunlimited')
    fireEvent.click(row('Shrine Builders'))
    expect(calls.selected).toEqual(['cult_1'])
  })
})

describe('CultsSection expansion', () => {
  it('expands a running cult to its Magos and live acolytes by display name with state, worker type, model, tier and tier reason', async () => {
    cults.cults = [cultView()]
    cults.runsByCult = { cult_1: [liveRun()] }
    const calls = await renderSection()
    const toggle = screen.getByRole('button', { name: 'Runs of Shrine Builders' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('list', { name: 'Members' })).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    const members = within(screen.getByRole('list', { name: 'Members' }))
    fireEvent.click(members.getByRole('button', { name: /^Magos Vettius/ }))
    // A member opens on its cult's page, whose work folder may be a project-less sanctum that is no tracked folder.
    expect(calls.opened).toEqual(['cult_1:chat_magos'])

    const ferrum = members.getByText('Acolyte Ferrum-3').closest('button') as HTMLElement
    expect(ferrum.closest('li')?.textContent).toBe('Acolyte Ferrum-3watch onlyworkingUI/UXanthropic/claude-sonnetnormalTier reason: Needs deeper layout reasoning.')
    expect(within(ferrum).getByText('normal').className).toContain('badge')
    const reasonId = ferrum.getAttribute('aria-describedby') as string
    expect(document.getElementById(reasonId)?.textContent).toBe('Tier reason: Needs deeper layout reasoning.')
    fireEvent.click(ferrum)
    expect(calls.opened).toEqual(['cult_1:chat_magos', 'cult_1:chat_a'])

    const vox = members.getByText('Acolyte Vox-4').closest('button') as HTMLElement
    expect(vox.textContent).toBe('Acolyte Vox-4watch onlyidleLore keeperanthropic/claude-haikulow')
    expect(vox.getAttribute('aria-describedby')).toBeNull()
    expect(members.queryByText('Acolyte Gone-1')).toBeNull()
  })
})

describe('CultsSection past runs and pushes', () => {
  it('lists past runs collapsed, with their start time and end reason', async () => {
    cults.cults = [cultView()]
    cults.runsByCult = {
      cult_1: [
        runDetail({ id: 'run_2', state: 'ended', endReason: 'expired', startedAt: '2026-11-26T09:00:00.000Z' }),
        runDetail({ id: 'run_1', state: 'ended', endReason: 'stopped', startedAt: '2026-11-25T09:00:00.000Z' })
      ]
    }
    await renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Runs of Shrine Builders' }))
    expect(screen.getByText('No active run.')).toBeTruthy()
    const past = screen.getByRole('button', { name: /Past runs \(2\)/ })
    expect(past.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(past)
    const items = within(screen.getByRole('list', { name: 'Past runs' })).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      `${new Date('2026-11-26T09:00:00.000Z').toLocaleString()}time ran out`,
      `${new Date('2026-11-25T09:00:00.000Z').toLocaleString()}stopped`
    ])
  })

  it('refreshes an expanded run when main pushes its snapshot', async () => {
    cults.cults = [cultView()]
    cults.runsByCult = { cult_1: [runDetail({}, [memberDetail()])] }
    await renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Runs of Shrine Builders' }))
    expect(screen.getByText('No acolytes yet.')).toBeTruthy()
    act(() => cults.push(runDetail({}, [memberDetail(), memberDetail({ chatId: 'chat_new', role: 'acolyte', displayName: 'Acolyte Ignis-2' })])))
    expect(screen.getByText('Acolyte Ignis-2')).toBeTruthy()
  })
})

describe('CultsSection menu', () => {
  it('asks before deleting, says the running cult is ended first, and deletes on confirm', async () => {
    cults.cults = [cultView()]
    cults.runsByCult = { cult_1: [runDetail()] }
    await renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Shrine Builders' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete this cult?' })
    expect(dialog.textContent).toContain('Its running cult is ended first')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(cults.deleted).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Shrine Builders' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete cult' }))
    await settle()
    expect(cults.deleted).toEqual(['cult_1'])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('No cults yet. Use + to found one.')).toBeTruthy()
  })

  it('keeps the dialog open with the reason when the delete is refused', async () => {
    cults.cults = [cultView()]
    cults.delete = () => Promise.resolve({ ok: false, error: { code: 'invalid_state', message: 'The run did not end.' } })
    await renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Shrine Builders' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete cult' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('The run did not end.')
  })

  it('opens Edit with the cult loaded, and + with the Found a cult dialog', async () => {
    cults.cults = [cultView({ defaultTimeLimitMs: 90 * 3_600_000 })]
    await renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Shrine Builders' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    const edit = within(screen.getByRole('dialog', { name: 'Edit cult' }))
    expect((edit.getByLabelText('Name') as HTMLInputElement).value).toBe('Shrine Builders')
    expect((edit.getByLabelText('Time limit') as HTMLInputElement).value).toBe('3d 18h')
    fireEvent.click(edit.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Found a cult' }))
    expect(screen.getByRole('dialog', { name: 'Found a cult' })).toBeTruthy()
  })
})
