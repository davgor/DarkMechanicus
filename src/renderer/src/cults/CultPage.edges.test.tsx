// @vitest-environment jsdom
/**
 * The Cult page's edge states over the fake backends: refusals and failures from main shown where they happened, the
 * roster and inspector for Magos-created types and the Magos itself, run states with fewer controls, the comms tabs by
 * keyboard and without a Magos or a run, a Plan Forge council's later states and the Past runs drawer's empty state.
 */
import { act, cleanup, fireEvent, render, screen, within, type RenderResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CultMemberDetail, CultRunDetail, RunWorkerTypeDetail } from '../../../shared/cults/cultApi'
import type { CultPetitionView, CultView } from '../../../shared/cults/cult'
import { deferred } from '../__mocks__/deferred'
import { cultView, FakeCults, memberDetail, runDetail } from '../__mocks__/fakeCults'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeTerminalKit } from '../__mocks__/fakeTerminalKit'
import { FakeTerminals } from '../__mocks__/fakeTerminals'
import { chatRecord } from '../__mocks__/fixtures'
import { createManualClock } from '../__mocks__/manualClock'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ClockContext } from '../epic/clock'
import { CultPage } from './CultPage'

const T0 = Date.parse('2026-11-27T12:10:00.000Z')
const WORK = '/home/u/code/alpha'

let cults: FakeCults
let dm: FakeDm

class NoObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  dm = new FakeDm()
  cults = new FakeCults()
  dm.cults = cults
  dm.terminals = new FakeTerminals()
  window.dm = dm
  vi.stubGlobal('ResizeObserver', NoObserver)
  vi.stubGlobal('IntersectionObserver', NoObserver)
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const MAGOS = memberDetail()
const FERRUM = memberDetail({ chatId: 'chat_a', role: 'acolyte', displayName: 'Acolyte Ferrum-3', joinedAt: '2026-11-27T12:01:00.000Z' })
const VOX = memberDetail({ chatId: 'chat_b', role: 'acolyte', displayName: 'Acolyte Vox-4', joinedAt: '2026-11-27T12:02:00.000Z' })

function running(patch: Partial<CultRunDetail['run']> = {}, members: CultMemberDetail[] = [MAGOS, FERRUM, VOX]): CultRunDetail {
  return runDetail({ runningSince: '2026-11-27T12:00:00.000Z', ...patch }, members)
}

function dynamicType(patch: Partial<RunWorkerTypeDetail>): RunWorkerTypeDetail {
  return { id: 'dyn_1', displayName: 'Lore keeper', description: 'd', mission: 'm', rationale: 'Keeps the record.', requiredForConclusion: false,
    creatorMemberId: 'chat_magos', createdAt: 'a', updatedAt: 'a', retiredAt: null, origin: 'magos_created', state: 'active', assignedChatIds: [],
    reportCount: 0, ...patch }
}

function petition(patch: Partial<CultPetitionView>): CultPetitionView {
  return { id: 'pt_1', runId: 'run_1', kind: 'acolytes', additional: 3, folderPath: null, reason: 'More hands.', state: 'pending', granted: null,
    createdAt: '2026-11-27T12:05:00.000Z', decidedAt: null, ...patch }
}

function seed(runs: CultRunDetail[], cult: CultView = cultView()): void {
  cults.cults = [cult]
  cults.runsByCult = { [cult.id]: runs }
  dm.chats.chats = [
    chatRecord({ id: 'chat_magos', folder: WORK, agent: 'omp', title: 'Magos Vettius', cultRunId: 'run_1', cultRole: 'magos' }),
    chatRecord({ id: 'chat_a', folder: WORK, agent: 'omp', title: 'Acolyte Ferrum-3', cultRunId: 'run_1', cultRole: 'acolyte' }),
    chatRecord({ id: 'chat_b', folder: WORK, agent: 'omp', title: 'Acolyte Vox-4', cultRunId: 'run_1', cultRole: 'acolyte' })
  ]
}

function page(openMember: { chatId: string } | null = null): JSX.Element {
  return (
    <ClockContext.Provider value={createManualClock(T0)}>
      <CultPage cultId="cult_1" agentName="OMP" kit={new FakeTerminalKit()} scheduler={new ManualScheduler()} openMember={openMember} />
    </ClockContext.Provider>
  )
}

async function show(openMember: { chatId: string } | null = null): Promise<RenderResult> {
  const view = render(page(openMember))
  await settle()
  return view
}

const bar = () => within(screen.getByRole('banner', { name: 'Cult commands' }))
const chip = (name: string): HTMLElement => within(screen.getByRole('list', { name: 'Roster' })).getByRole('button', { name: new RegExp(`^${name}`) })
const facts = (name: string): Record<string, string | null | undefined> => {
  const inspector = screen.getByRole('region', { name: `Inspector: ${name}` })
  return Object.fromEntries([...inspector.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]))
}
const selectedTab = (): string | null => screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent ?? null
const refused = (message: string) => Promise.resolve({ ok: false as const, error: { code: 'invalid_state' as const, message } })

describe('CultPage loading failures', () => {
  it('says why the cult could not be read: unknown cult, refused runs, or a failed call', async () => {
    seed([])
    cults.cults = []
    const first = await show()
    expect(screen.getByRole('alert').textContent).toBe('No cult cult_1.')
    first.unmount()

    seed([])
    cults.runs = () => refused('The runs could not be read.')
    const second = await show()
    expect(screen.getByRole('alert').textContent).toBe('The runs could not be read.')
    second.unmount()

    cults.get = () => Promise.reject('The app lost its connection.')
    await show()
    expect(screen.getByRole('alert').textContent).toBe('The app lost its connection.')
  })

  it('ignores a run push that arrives before the cult has loaded, then shows what was loaded', async () => {
    seed([running()])
    const gate = deferred()
    const get = cults.get
    cults.get = async (cultId) => {
      await gate.promise
      return get(cultId)
    }
    await show()
    expect(screen.getByRole('status').textContent).toBe('Loading cult…')
    act(() => cults.push(running({ state: 'paused', runningSince: null })))
    gate.resolve()
    await settle()
    expect(bar().getByText('Running')).toBeTruthy()
  })
})

describe('CultPage start refusals', () => {
  it('starts with no default limit as Unlimited, and reloads the runs only once a start went through', async () => {
    seed([], cultView({ defaultTimeLimitMs: null }))
    let reads = 0
    const runs = cults.runs
    cults.runs = (cultId) => {
      reads += 1
      return runs(cultId)
    }
    await show()
    expect((bar().getByLabelText('Time limit') as HTMLInputElement).value).toBe('')
    expect((bar().getByLabelText('Time limit') as HTMLInputElement).disabled).toBe(true)
    expect((bar().getByLabelText('Unlimited') as HTMLInputElement).checked).toBe(true)
    const start = cults.start
    cults.start = () => refused('A run of this cult is still ending.')
    fireEvent.click(bar().getByRole('button', { name: 'Start' }))
    await settle()
    expect(bar().getByRole('alert').textContent).toBe('A run of this cult is still ending.')
    expect(reads).toBe(1)
    cults.start = start
    fireEvent.click(bar().getByRole('button', { name: 'Start' }))
    await settle()
    expect(bar().queryByRole('alert')).toBeNull()
    expect(reads).toBe(2)
  })

  it('refuses Start for a short limit and for each shutdown timing it cannot read or allow', async () => {
    seed([])
    await show()
    const start = bar().getByRole('button', { name: 'Start' }) as HTMLButtonElement
    const expectRefusal = (label: string, value: string, message: string): void => {
      fireEvent.change(bar().getByLabelText(label), { target: { value } })
      expect(bar().getByRole('alert').textContent).toBe(message)
      expect(start.disabled).toBe(true)
    }
    expectRefusal('Time limit', '10s', 'A time limit must be at least 1 minute, or unlimited.')
    fireEvent.change(bar().getByLabelText('Time limit'), { target: { value: '30m' } })
    expectRefusal('Acolyte grace', 'abc', 'Acolyte grace: "abc" is not a duration; use whole numbers with s, m, h or d.')
    expectRefusal('Acolyte grace', '5s', 'Shutdown timings must be from 30 seconds to 60 minutes.')
    fireEvent.change(bar().getByLabelText('Acolyte grace'), { target: { value: '3m' } })
    expectRefusal('Magos window', 'soon', 'Magos window: "soon" is not a duration; use whole numbers with s, m, h or d.')
    fireEvent.click(start)
    await settle()
    expect(cults.controls).toEqual([])
  })
})

describe('CultPage run control refusals', () => {
  it('shows a refused Raise and a failed Pause call as the bar\'s alert', async () => {
    seed([running()])
    await show()
    cults.raiseCap = () => refused('The cap is already 24.')
    fireEvent.click(bar().getByRole('button', { name: 'Raise' }))
    await settle()
    expect(bar().getByRole('alert').textContent).toBe('The cap is already 24.')
    cults.pause = () => Promise.reject(new Error('The app lost its connection.'))
    fireEvent.click(bar().getByRole('button', { name: 'Pause' }))
    await settle()
    expect(bar().getByRole('alert').textContent).toBe('The app lost its connection.')
  })

  it('shows a Resume that failed with no Error as its text', async () => {
    seed([running({ state: 'paused', runningSince: null })])
    await show()
    cults.resume = () => Promise.reject('pipe closed')
    fireEvent.click(bar().getByRole('button', { name: 'Resume' }))
    await settle()
    expect(bar().getByRole('alert').textContent).toBe('pipe closed')
  })

  it('offers Stop and Kill now but no Raise while starting, and only Kill now while shutting down', async () => {
    seed([running({ state: 'starting', runningSince: null })])
    const view = await show()
    expect(bar().getByText('Starting')).toBeTruthy()
    for (const name of ['Stop', 'Kill now']) expect(bar().getByRole('button', { name })).toBeTruthy()
    for (const name of ['Pause', 'Resume', 'Raise', 'Start']) expect(bar().queryByRole('button', { name })).toBeNull()
    view.unmount()

    seed([running({ state: 'shutting_down', runningSince: null })])
    await show()
    expect(bar().getByText('Shutting down')).toBeTruthy()
    expect(bar().getByRole('button', { name: 'Kill now' })).toBeTruthy()
    for (const name of ['Stop', 'Pause', 'Raise']) expect(bar().queryByRole('button', { name })).toBeNull()
    expect(bar().queryByLabelText('New cap')).toBeNull()
  })
})

describe('CultPage roster of Magos-created types', () => {
  it('shows each created type as Magos-created with whether it is required, and the report and model as they are', async () => {
    const run = running({}, [
      MAGOS,
      { ...FERRUM, runWorkerTypeId: 'dyn_1', typeOrigin: 'magos_created', reported: true, model: null,
        activity: { working: true, tool: { name: 'edit', target: '' }, at: '2026-11-27T12:09:00.000Z' } },
      { ...VOX, runWorkerTypeId: 'dyn_2', typeOrigin: 'magos_created' }
    ])
    run.workerTypes = [dynamicType({}), dynamicType({ id: 'dyn_2', displayName: 'Warden', rationale: 'Guards the gate.', requiredForConclusion: true })]
    seed([run])
    await show()
    expect(chip('Acolyte Ferrum-3').textContent).toBe('Acolyte Ferrum-3workingLore keeperMagos-createdoptionalreported')
    expect(chip('Acolyte Vox-4').textContent).toContain('WardenMagos-createdrequired')
    fireEvent.click(chip('Acolyte Ferrum-3'))
    expect(facts('Acolyte Ferrum-3')).toMatchObject({
      'Worker type': 'Lore keeper', Origin: 'Magos-created, optional', Rationale: 'Keeps the record.', Model: 'default', Report: 'Reported',
      'Latest activity': 'Working · edit'
    })
    fireEvent.click(chip('Acolyte Vox-4'))
    expect(facts('Acolyte Vox-4')).toMatchObject({ Origin: 'Magos-created, required', Rationale: 'Guards the gate.', Report: 'Not reported yet' })
  })
})

describe('CultPage inspector edges', () => {
  it('inspects the Magos with no type or report, and Open terminal returns the comms to its tab', async () => {
    seed([running()])
    await show()
    fireEvent.click(screen.getByRole('tab', { name: 'Pipeline' }))
    fireEvent.click(chip('Magos Vettius'))
    expect(facts('Magos Vettius')).toMatchObject({ Role: 'Magos', 'Worker type': '—', Tier: '—', Report: '—' })
    const inspector = within(screen.getByRole('region', { name: 'Inspector: Magos Vettius' }))
    expect(inspector.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    fireEvent.click(inspector.getByRole('button', { name: 'Open terminal' }))
    expect(selectedTab()).toBe('Magos Vettius')
  })

  it('offers no Dismiss while paused and stays open for keys other than Escape', async () => {
    seed([running({ state: 'paused', runningSince: null })])
    await show()
    fireEvent.click(chip('Acolyte Vox-4'))
    const inspector = screen.getByRole('region', { name: 'Inspector: Acolyte Vox-4' })
    expect(within(inspector).queryByRole('button', { name: 'Dismiss' })).toBeNull()
    fireEvent.keyDown(inspector, { key: 'Enter' })
    expect(screen.getByRole('region', { name: 'Inspector: Acolyte Vox-4' })).toBeTruthy()
  })

  it('keeps the inspector open with main\'s reason when a Dismiss is refused', async () => {
    seed([running()])
    await show()
    cults.dismissAcolyte = () => refused('Acolyte Vox-4 is already leaving.')
    fireEvent.click(chip('Acolyte Vox-4'))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Dismiss' }))
    await settle()
    const inspector = within(screen.getByRole('region', { name: 'Inspector: Acolyte Vox-4' }))
    expect(inspector.getByRole('alert').textContent).toBe('Acolyte Vox-4 is already leaving.')
  })
})

describe('CultPage comms tabs by keyboard', () => {
  it('moves between tabs with Left and Right, wrapping at both ends, and ignores other keys and non-tabs', async () => {
    seed([running()])
    await show({ chatId: 'chat_a' })
    const tabs = () => screen.getAllByRole('tab')
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Magos Vettius', 'Pipeline', 'Acolyte Ferrum-3watch only'])
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Magos Vettius' }), { key: 'ArrowLeft' })
    expect(selectedTab()).toBe('Acolyte Ferrum-3watch only')
    expect(document.activeElement).toBe(tabs()[2])
    fireEvent.keyDown(tabs()[2]!, { key: 'ArrowRight' })
    expect(selectedTab()).toBe('Magos Vettius')
    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowRight' })
    expect(selectedTab()).toBe('Pipeline')
    fireEvent.keyDown(tabs()[1]!, { key: 'Enter' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close Acolyte Ferrum-3' }), { key: 'ArrowRight' })
    expect(selectedTab()).toBe('Pipeline')
  })
})

describe('CultPage watch tabs', () => {
  it('adds a watch tab per new sidebar request, never twice, and closing another tab keeps the one shown', async () => {
    seed([running()])
    const view = await show({ chatId: 'chat_b' })
    view.rerender(page({ chatId: 'chat_a' }))
    await settle()
    expect(selectedTab()).toBe('Acolyte Ferrum-3watch only')
    view.rerender(page({ chatId: 'chat_b' }))
    await settle()
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Magos Vettius', 'Pipeline', 'Acolyte Vox-4watch only', 'Acolyte Ferrum-3watch only'
    ])
    expect(selectedTab()).toBe('Acolyte Vox-4watch only')
    fireEvent.click(screen.getByRole('button', { name: 'Close Acolyte Ferrum-3' }))
    await settle()
    expect(selectedTab()).toBe('Acolyte Vox-4watch only')
    expect(screen.queryByRole('tab', { name: /Ferrum/ })).toBeNull()
  })

  it('opens one watch tab however often Watch terminal is pressed, and drops it when the run ends', async () => {
    seed([running()])
    await show()
    fireEvent.click(chip('Acolyte Ferrum-3'))
    fireEvent.click(screen.getByRole('button', { name: 'Watch terminal' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Pipeline' }))
    fireEvent.click(screen.getByRole('button', { name: 'Watch terminal' }))
    await settle()
    expect(screen.getAllByRole('tab', { name: /Ferrum/ })).toHaveLength(1)
    expect(selectedTab()).toBe('Acolyte Ferrum-3watch only')
    act(() => cults.push(running({ state: 'ended', endReason: 'completed', endedAt: '2026-11-27T12:10:00.000Z' })))
    expect(screen.queryByRole('tab', { name: /Ferrum/ })).toBeNull()
    expect(screen.getByText('Start the cult to talk to its Magos.')).toBeTruthy()
  })
})

describe('CultPage comms without a Magos or a run', () => {
  it('names the tab Magos and says it has not joined, and petitions name the cult\'s Magos', async () => {
    const run = running({}, [FERRUM])
    run.petitions = [petition({})]
    seed([run], cultView({ magosName: 'Magos Cawl' }))
    await show()
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Magos', 'Pipeline'])
    expect(screen.getByText('The Magos has not joined yet.')).toBeTruthy()
    expect(screen.getByRole('listitem', { name: 'More acolytes petition from Magos Cawl' })).toBeTruthy()
  })

  it('asks to start the cult in the Pipeline tab with no run', async () => {
    seed([])
    await show()
    fireEvent.click(screen.getByRole('tab', { name: 'Pipeline' }))
    expect(screen.getByText('Start the cult to see its pipeline.')).toBeTruthy()
  })

  it('shows why a member\'s terminal could not be opened: a refused read or a failed call', async () => {
    seed([running()])
    dm.chats.failures.read = { code: 'not_found', message: 'No chat chat_magos.' }
    const view = await show()
    expect(within(screen.getByRole('tabpanel')).getByRole('alert').textContent).toBe('No chat chat_magos.')
    view.unmount()
    dm.chats.read = () => Promise.reject('pipe closed')
    await show()
    expect(within(screen.getByRole('tabpanel')).getByRole('alert').textContent).toBe('pipe closed')
  })
})

describe('CultPage petition edges', () => {
  it('cannot grant acolytes at the ceiling, and shows a refused decision on its banner', async () => {
    const run = running({ cap: 24 })
    run.petitions = [petition({ id: 'pt_a', additional: 3 }), petition({ id: 'pt_s', kind: 'allow_save', createdAt: '2026-11-27T12:06:00.000Z' })]
    seed([run])
    await show()
    const acolytes = within(screen.getByRole('listitem', { name: /^More acolytes/ }))
    expect(acolytes.getByText('Asks for 3; the run is at the ceiling of 24.')).toBeTruthy()
    expect((acolytes.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
    cults.decidePetition = () => refused('The petition was already decided.')
    const save = within(screen.getByRole('listitem', { name: /^Allow save/ }))
    fireEvent.click(save.getByRole('button', { name: 'Deny' }))
    await settle()
    expect(save.getByRole('alert').textContent).toBe('The petition was already decided.')
  })
})

function council(patch: Partial<CultRunDetail>): CultRunDetail {
  return { ...running(), ...patch }
}

describe('CultPage Plan Forge council states', () => {
  it('names an unknown holder and missing ids as they are, and leaves retired types out', async () => {
    const run = council({
      slots: [{ slotId: 'ui_ux', workerType: 'ui_ux', label: 'UI/UX', required: false, liveMemberChatIds: ['chat_zz'], reportCount: 0,
        lastReportAt: null, origin: 'definition_slot' }],
      workerTypes: [dynamicType({ id: 'dyn_old', displayName: 'Old type', state: 'retired' })],
      missing: { slots: ['ghost'], workerTypes: ['dyn_gone'] }
    })
    seed([run], cultView({ archetype: 'plan_forge', targetEpicId: 'ep_9' }))
    await show()
    const coverage = within(screen.getByRole('region', { name: 'Council coverage' }))
    const items = coverage.getAllByRole('listitem')
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual(['UI/UX: waiting, chat_zz'])
    expect(within(items[0]!).getByText('optional')).toBeTruthy()
    expect(coverage.getByRole('status').textContent).toBe('Collecting: waiting for ghost, dyn_gone')
  })

  it('says it is resolving once all reported, then the recorded synthesis', async () => {
    const slots: CultRunDetail['slots'] = [{ slotId: 'ui_ux', workerType: 'ui_ux', label: 'UI/UX', required: true, liveMemberChatIds: [],
      reportCount: 1, lastReportAt: null, origin: 'definition_slot' }]
    seed([council({ slots })], cultView({ archetype: 'plan_forge', targetEpicId: 'ep_9' }))
    await show()
    const status = () => within(screen.getByRole('region', { name: 'Council coverage' })).getByRole('status').textContent
    expect(status()).toBe('Resolving: every required perspective reported; the Magos has not recorded a synthesis')
    act(() => cults.push(council({ slots, synthesis: { draftRevision: 3, accepted: 2, rejected: 1, recordedAt: '2026-11-27T12:09:00.000Z' } })))
    expect(status()).toBe('Synthesis recorded on draft revision 3: 2 accepted, 1 rejected')
  })

  it('shows no coverage strip for a council with nothing to cover yet', async () => {
    seed([running()], cultView({ archetype: 'plan_forge', targetEpicId: 'ep_9' }))
    await show()
    expect(screen.queryByRole('region', { name: 'Council coverage' })).toBeNull()
  })
})

describe('CultPage Past runs drawer edges', () => {
  it('says no run has ended yet, and closes on Escape but not on other keys', async () => {
    seed([running()])
    await show()
    fireEvent.click(bar().getByRole('button', { name: 'Past runs' }))
    const drawer = screen.getByRole('complementary', { name: 'Past runs' })
    expect(within(drawer).getByText('No run of this cult has ended yet.')).toBeTruthy()
    fireEvent.keyDown(drawer, { key: 'Tab' })
    expect(screen.getByRole('complementary', { name: 'Past runs' })).toBeTruthy()
    fireEvent.keyDown(drawer, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Past runs' })).toBeNull()
  })

  it('reads an ended run with no reason or end time as Ended, lasting —', async () => {
    seed([runDetail({ id: 'run_0', state: 'ended', endReason: null, endedAt: null, runningSince: null })])
    await show()
    fireEvent.click(bar().getByRole('button', { name: 'Past runs' }))
    const item = within(screen.getByRole('complementary', { name: 'Past runs' })).getByRole('listitem')
    expect(within(item).getByText('Ended')).toBeTruthy()
    expect(within(item).getByText('—')).toBeTruthy()
  })
})
