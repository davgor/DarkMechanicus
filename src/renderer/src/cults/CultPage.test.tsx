// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CultMemberDetail, CultRunDetail } from '../../../shared/cults/cultApi'
import type { CultPetitionView } from '../../../shared/cults/cult'
import { cultView, FakeCults, memberDetail, runDetail } from '../__mocks__/fakeCults'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeTerminalKit } from '../__mocks__/fakeTerminalKit'
import { FakeTerminals } from '../__mocks__/fakeTerminals'
import { chatRecord } from '../__mocks__/fixtures'
import { createManualClock } from '../__mocks__/manualClock'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ClockContext, type Clock } from '../epic/clock'
import { CultPage } from './CultPage'

const T0 = Date.parse('2026-11-27T12:10:00.000Z')
const WORK = '/home/u/code/alpha'

let cults: FakeCults
let dm: FakeDm
let terminals: FakeTerminals
let kit: FakeTerminalKit
let clock: Clock & { advance(ms: number): void }

class NoObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  dm = new FakeDm()
  cults = new FakeCults()
  terminals = new FakeTerminals()
  dm.cults = cults
  dm.terminals = terminals
  window.dm = dm
  kit = new FakeTerminalKit()
  clock = createManualClock(T0)
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
const FERRUM = memberDetail({
  chatId: 'chat_a', role: 'acolyte', displayName: 'Acolyte Ferrum-3', model: 'anthropic/claude-sonnet', tier: 'normal',
  tierReason: 'Needs deeper layout reasoning.', slotId: 'ui_ux', workerType: 'ui_ux', typeOrigin: 'definition_slot',
  joinedAt: '2026-11-27T12:01:00.000Z', activity: { working: true, tool: { name: 'edit', target: 'cults/CultPage.tsx' }, at: '2026-11-27T12:09:00.000Z' }
})
const VOX = memberDetail({ chatId: 'chat_b', role: 'acolyte', displayName: 'Acolyte Vox-4', model: 'anthropic/claude-haiku', tier: 'low', joinedAt: '2026-11-27T12:02:00.000Z' })

function petition(patch: Partial<CultPetitionView>): CultPetitionView {
  return { id: 'pt_1', runId: 'run_1', kind: 'acolytes', additional: null, folderPath: null, reason: 'More hands.', state: 'pending', granted: null,
    createdAt: '2026-11-27T12:05:00.000Z', decidedAt: null, ...patch }
}

/** Ten minutes into a 30-minute running run of the Magos and two acolytes. */
function running(patch: Partial<CultRunDetail['run']> = {}, members: CultMemberDetail[] = [MAGOS, FERRUM, VOX]): CultRunDetail {
  return runDetail({ runningSince: '2026-11-27T12:00:00.000Z', ...patch }, members)
}

function seed(runs: CultRunDetail[], cult = cultView()): void {
  cults.cults = [cult]
  cults.runsByCult = { [cult.id]: runs }
  dm.chats.chats = [
    chatRecord({ id: 'chat_magos', folder: WORK, agent: 'omp', title: 'Magos Vettius', cultRunId: 'run_1', cultRole: 'magos' }),
    chatRecord({ id: 'chat_a', folder: WORK, agent: 'omp', title: 'Acolyte Ferrum-3', cultRunId: 'run_1', cultRole: 'acolyte' }),
    chatRecord({ id: 'chat_b', folder: WORK, agent: 'omp', title: 'Acolyte Vox-4', cultRunId: 'run_1', cultRole: 'acolyte' })
  ]
}

async function show(props: { openMember?: { chatId: string } | null } = {}): Promise<void> {
  render(
    <ClockContext.Provider value={clock}>
      <CultPage cultId="cult_1" agentName="OMP" kit={kit} scheduler={new ManualScheduler()} {...props} />
    </ClockContext.Provider>
  )
  await settle()
}

const bar = () => within(screen.getByRole('banner', { name: 'Cult commands' }))
const timer = (): string => screen.getByRole('timer', { name: 'Time left' }).textContent ?? ''

describe('CultPage command bar', () => {
  it('offers Start (with per-run overrides) and Past runs with no active run, and shows the dark empty room', async () => {
    seed([])
    await show()
    expect(bar().getByRole('button', { name: 'Start' })).toBeTruthy()
    expect(bar().getByRole('button', { name: 'Past runs' })).toBeTruthy()
    for (const name of ['Pause', 'Resume', 'Stop', 'Kill now', 'Raise']) expect(bar().queryByRole('button', { name })).toBeNull()
    expect(bar().getByText('Idle')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Empty chamber: no active run' })).toBeTruthy()
    expect(document.querySelector('.cc-chamber')).toBeNull()

    fireEvent.change(bar().getByLabelText('Acolyte cap'), { target: { value: '9' } })
    fireEvent.click(bar().getByLabelText('Unlimited'))
    fireEvent.click(bar().getByRole('button', { name: 'Start' }))
    await settle()
    expect(cults.controls).toEqual([['start', 'cult_1', { timeLimitMs: null, cap: 9, acolyteGraceMs: 180_000, magosWindowMs: 120_000 }]])
  })

  it('refuses Start while an override is out of bounds', async () => {
    seed([])
    await show()
    fireEvent.change(bar().getByLabelText('Acolyte cap'), { target: { value: '25' } })
    expect(bar().getByRole('alert').textContent).toBe('The acolyte cap cannot exceed 24.')
    expect((bar().getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows Pause, Stop, Kill now and the cap with Raise while running, with a live countdown', async () => {
    seed([running()])
    await show()
    expect(bar().getByText('Running')).toBeTruthy()
    for (const name of ['Pause', 'Stop', 'Kill now', 'Raise', 'Past runs']) expect(bar().getByRole('button', { name })).toBeTruthy()
    expect(bar().queryByRole('button', { name: 'Start' })).toBeNull()
    expect(bar().queryByRole('button', { name: 'Resume' })).toBeNull()
    expect(bar().getByText('Cap 6')).toBeTruthy()
    expect(timer()).toBe('20m left')
    act(() => clock.advance(65_000))
    expect(timer()).toBe('18m 55s left')

    fireEvent.click(bar().getByRole('button', { name: 'Pause' }))
    fireEvent.change(bar().getByLabelText('New cap'), { target: { value: '10' } })
    fireEvent.click(bar().getByRole('button', { name: 'Raise' }))
    await settle()
    expect(cults.controls).toEqual([['pause', 'run_1'], ['raiseCap', 'run_1', 10]])
  })

  it('freezes the countdown while paused and offers Resume instead of Pause', async () => {
    seed([running({ state: 'paused', runningSince: null, accumulatedRunningMs: 7 * 60_000 })])
    await show()
    expect(bar().getByText('Paused')).toBeTruthy()
    expect(bar().getByRole('button', { name: 'Resume' })).toBeTruthy()
    expect(bar().queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(timer()).toBe('23m left (paused)')
    act(() => clock.advance(10 * 60_000))
    expect(timer()).toBe('23m left (paused)')
    fireEvent.click(bar().getByRole('button', { name: 'Resume' }))
    await settle()
    expect(cults.controls).toEqual([['resume', 'run_1']])
  })

  it('shows Unlimited with the elapsed running time for a run with no limit', async () => {
    seed([running({ timeLimitMs: null })])
    await show()
    expect(timer()).toBe('Unlimited · 10m elapsed')
    act(() => clock.advance(30_000))
    expect(timer()).toBe('Unlimited · 10m 30s elapsed')
  })

  it('asks before Kill now (destructive) and Stop (graceful shutdown), and Cancel sends nothing', async () => {
    seed([running()])
    await show()
    fireEvent.click(bar().getByRole('button', { name: 'Kill now' }))
    const kill = within(screen.getByRole('dialog', { name: 'Kill this run now?' }))
    expect(cults.controls).toEqual([])
    fireEvent.click(kill.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(cults.controls).toEqual([])

    fireEvent.click(bar().getByRole('button', { name: 'Kill now' }))
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Kill now' })
    expect(confirm.className).toContain('btn-danger')
    fireEvent.click(confirm)
    await settle()
    expect(cults.controls).toEqual([['killNow', 'run_1']])

    fireEvent.click(bar().getByRole('button', { name: 'Stop' }))
    const stop = within(screen.getByRole('dialog', { name: 'Stop this run?' }))
    expect(stop.getByText(/Graceful shutdown/)).toBeTruthy()
    fireEvent.click(stop.getByRole('button', { name: 'Stop gracefully' }))
    await settle()
    expect(cults.controls).toEqual([['killNow', 'run_1'], ['stop', 'run_1']])
  })
})

describe('CultPage petition banners', () => {
  it('shows each pending petition kind over the room, newest first, with kind, reason and the Magos’s name', async () => {
    const run = running()
    run.petitions = [
      petition({ id: 'pt_a', kind: 'acolytes', additional: 4, reason: 'Two more reviewers.', createdAt: '2026-11-27T12:03:00.000Z' }),
      petition({ id: 'pt_f', kind: 'folder_access', folderPath: '/home/u/code/beta', reason: 'Read the shared schema.', createdAt: '2026-11-27T12:04:00.000Z' }),
      petition({ id: 'pt_s', kind: 'allow_save', reason: 'Save the drafted plan.', createdAt: '2026-11-27T12:05:00.000Z' }),
      petition({ id: 'pt_old', kind: 'allow_save', state: 'denied', reason: 'Decided already.' })
    ]
    seed([run])
    await show()
    const banners = within(screen.getByRole('list', { name: 'Pending petitions' })).getAllByRole('listitem')
    expect(banners.map((banner) => banner.getAttribute('aria-label'))).toEqual([
      'Allow save petition from Magos Vettius', 'Folder access petition from Magos Vettius', 'More acolytes petition from Magos Vettius'
    ])
    expect(within(banners[0]).getByText('Save the drafted plan.')).toBeTruthy()
    expect(within(banners[0]).getByRole('note').textContent).toMatch(/^Warning: approving lets the Magos save plans/)
    expect(within(banners[1]).getByText('/home/u/code/beta')).toBeTruthy()
    expect(within(banners[2]).getByText('Two more reviewers.')).toBeTruthy()
    expect(screen.queryByText('Decided already.')).toBeNull()
    expect(screen.getByRole('list', { name: 'Pending petitions' }).closest('.cult-room')).toBeTruthy()
  })

  it('approves an acolytes petition with a grant bounded by what was asked and the ceiling of 24', async () => {
    const run = running({ cap: 22 })
    run.petitions = [petition({ id: 'pt_a', additional: 5 })]
    seed([run])
    await show()
    const banner = within(screen.getByRole('listitem', { name: 'More acolytes petition from Magos Vettius' }))
    const grant = banner.getByLabelText('Acolytes to grant') as HTMLInputElement
    expect(grant.value).toBe('2')
    expect(grant.max).toBe('2')
    fireEvent.change(grant, { target: { value: '9' } })
    fireEvent.click(banner.getByRole('button', { name: 'Approve' }))
    await settle()
    fireEvent.change(grant, { target: { value: '1' } })
    fireEvent.click(banner.getByRole('button', { name: 'Approve' }))
    await settle()
    expect(cults.controls).toEqual([['decidePetition', 'pt_a', true, 2], ['decidePetition', 'pt_a', true, 1]])
  })

  it('denies, and approves Allow save and folder access with no grant', async () => {
    const run = running()
    run.petitions = [petition({ id: 'pt_s', kind: 'allow_save' }), petition({ id: 'pt_f', kind: 'folder_access', folderPath: '/b', createdAt: '2026-11-27T12:01:00.000Z' })]
    seed([run])
    await show()
    fireEvent.click(within(screen.getByRole('listitem', { name: /^Allow save/ })).getByRole('button', { name: 'Deny' }))
    await settle()
    fireEvent.click(within(screen.getByRole('listitem', { name: /^Folder access/ })).getByRole('button', { name: 'Approve' }))
    await settle()
    expect(cults.controls).toEqual([['decidePetition', 'pt_s', false, undefined], ['decidePetition', 'pt_f', true, undefined]])
  })
})

describe('CultPage roster and inspector', () => {
  it('lists every member, the Magos first, as focusable chips with state, model, tier and the reason as a description', async () => {
    seed([running()])
    await show()
    const chips = within(screen.getByRole('list', { name: 'Roster' })).getAllByRole('button')
    expect(chips.map((chip) => chip.querySelector('.cult-chip-name')?.textContent)).toEqual(['Magos Vettius', 'Acolyte Ferrum-3', 'Acolyte Vox-4'])
    expect(chips[1].textContent).toBe('Acolyte Ferrum-3workingUI/UXanthropic/claude-sonnetnormalno report yet')
    expect(document.getElementById(chips[1].getAttribute('aria-describedby') as string)?.textContent).toBe('Tier reason: Needs deeper layout reasoning.')
    expect(chips[2].textContent).toContain('idle')
    chips[1].focus()
    expect(document.activeElement).toBe(chips[1])
  })

  it('lists all 24 acolytes of a full run, none hidden', async () => {
    const many = Array.from({ length: 24 }, (_, index) => memberDetail({ chatId: `chat_${index}`, role: 'acolyte', displayName: `Acolyte ${index}`, joinedAt: `2026-11-27T12:${String(index + 10)}:00.000Z` }))
    seed([running({ cap: 24 }, [MAGOS, ...many])])
    await show()
    expect(within(screen.getByRole('list', { name: 'Roster' })).getAllByRole('button')).toHaveLength(25)
  })

  it('opens the inspector from a chip with the keyboard, showing the activity as plain text, and Escape closes it', async () => {
    seed([running()])
    await show()
    const chip = within(screen.getByRole('list', { name: 'Roster' })).getByRole('button', { name: /^Acolyte Ferrum-3/ })
    chip.focus()
    fireEvent.keyDown(chip, { key: 'Enter' })
    fireEvent.click(chip)
    const inspector = screen.getByRole('region', { name: 'Inspector: Acolyte Ferrum-3' })
    const facts = Object.fromEntries([...inspector.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]))
    expect(facts).toMatchObject({
      Role: 'Acolyte', 'Worker type': 'UI/UX', Model: 'anthropic/claude-sonnet', Tier: 'normal', Reason: 'Needs deeper layout reasoning.',
      State: 'Working', Report: 'Not reported yet', 'Latest activity': 'Working · edit cults/CultPage.tsx'
    })
    expect(document.activeElement).toBe(inspector)
    expect(within(inspector).getByRole('button', { name: 'Watch terminal' })).toBeTruthy()
    expect(within(inspector).getByRole('button', { name: 'Dismiss' })).toBeTruthy()
    fireEvent.keyDown(inspector, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: /^Inspector/ })).toBeNull()
  })

  it('asks before Dismiss and dismisses through the API', async () => {
    seed([running()])
    await show()
    fireEvent.click(screen.getByRole('button', { name: /^Acolyte Vox-4/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(cults.controls).toEqual([])
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Dismiss Acolyte Vox-4?' })).getByRole('button', { name: 'Dismiss' }))
    await settle()
    expect(cults.controls).toEqual([['dismissAcolyte', 'run_1', 'chat_b']])
  })
})

describe('CultPage comms pane', () => {
  it('defaults to the Magos’s interactive terminal, headed by its name, and offers the Pipeline tab', async () => {
    seed([running()])
    await show()
    const tabs = within(screen.getByRole('tablist', { name: 'Comms channels' })).getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Magos Vettius', 'Pipeline'])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('heading', { level: 1, name: 'Magos Vettius' })).toBeTruthy()
    expect(terminals.calls).toEqual([[WORK, 'chat_magos']])
    kit.latest().type('hello')
    expect(terminals.latest().writes).toEqual(['hello'])
    expect(screen.queryByText('Watch only')).toBeNull()

    fireEvent.click(tabs[1])
    expect(document.querySelector('[data-slot="pipeline"]')).toBeTruthy()
  })

  it('Watch terminal opens a read-only tab headed by the acolyte’s name that sends nothing typed or pasted; closing it returns to the Magos', async () => {
    seed([running()])
    await show()
    fireEvent.click(screen.getByRole('button', { name: /^Acolyte Ferrum-3/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Watch terminal' }))
    await settle()
    const tab = screen.getByRole('tab', { name: /Acolyte Ferrum-3/ })
    expect(tab.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('heading', { level: 1, name: 'Acolyte Ferrum-3' })).toBeTruthy()
    expect(screen.getByText('Watch only')).toBeTruthy()
    expect(terminals.calls.at(-1)).toEqual([WORK, 'chat_a'])
    const watched = kit.latest()
    const handle = terminals.latest()
    expect(watched.options.watchOnly).toBe(true)
    watched.type('rm -rf /\r')
    watched.type('\x1b[200~pasted\x1b[201~')
    expect(handle.writes).toEqual([])
    expect(handle.resizes).toEqual([])
    expect(watched.focused).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Close Acolyte Ferrum-3' }))
    await settle()
    expect(screen.queryByRole('tab', { name: /Acolyte Ferrum-3/ })).toBeNull()
    expect(screen.getByRole('tab', { name: 'Magos Vettius' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('heading', { level: 1, name: 'Magos Vettius' })).toBeTruthy()
  })

  it('opens a member asked for from the sidebar: an acolyte in a watch tab, through the run’s sanctum work folder', async () => {
    const sanctum = '/Users/u/Library/Application Support/dark-mechanicus/sanctums/cult_1'
    seed([running({ workDir: sanctum })], cultView({ scope: 'sanctum', folderPath: null }))
    dm.chats.chats = dm.chats.chats.map((chat) => ({ ...chat, folder: sanctum }))
    await show({ openMember: { chatId: 'chat_b' } })
    expect(screen.getByRole('tab', { name: /Acolyte Vox-4/ }).getAttribute('aria-selected')).toBe('true')
    expect(dm.chats.calls.filter((call) => call.method === 'read').map((call) => call.args[0])).toEqual([{ folder: sanctum, chatId: 'chat_b' }])
    expect(terminals.calls).toEqual([[sanctum, 'chat_b']])
    expect(kit.latest().options.watchOnly).toBe(true)
  })

  it('opens the Magos asked for from the sidebar in its interactive tab, for a folder cult', async () => {
    seed([running()])
    await show({ openMember: { chatId: 'chat_magos' } })
    expect(screen.getByRole('tab', { name: 'Magos Vettius' }).getAttribute('aria-selected')).toBe('true')
    expect(terminals.calls).toEqual([[WORK, 'chat_magos']])
    expect(kit.latest().options.watchOnly).toBeUndefined()
  })
})

describe('CultPage Past runs drawer', () => {
  it('lists ended runs with end reason, duration and the chronicle as inert text, not HTML', async () => {
    const chronicle = '<img src=x onerror="alert(1)"><b>Bold</b> **not markdown**'
    seed([
      running(),
      runDetail({ id: 'run_0', state: 'ended', endReason: 'expired', startedAt: '2026-11-26T09:00:00.000Z', endedAt: '2026-11-26T10:30:05.000Z', runningSince: null, chronicle }),
      runDetail({ id: 'run_z', state: 'ended', endReason: 'killed', startedAt: '2026-11-25T09:00:00.000Z', endedAt: '2026-11-25T09:00:40.000Z', runningSince: null })
    ])
    await show()
    expect(screen.queryByRole('complementary', { name: 'Past runs' })).toBeNull()
    fireEvent.click(bar().getByRole('button', { name: 'Past runs' }))
    const drawer = screen.getByRole('complementary', { name: 'Past runs' })
    const items = within(drawer).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(within(items[0]).getByText('Time ran out')).toBeTruthy()
    expect(within(items[0]).getByText('1h 30m 5s')).toBeTruthy()
    const text = items[0].querySelector('.cult-chronicle') as HTMLElement
    expect(text.textContent).toBe(chronicle)
    expect(text.children).toHaveLength(0)
    expect(drawer.querySelector('img, b')).toBeNull()
    expect(within(items[1]).getByText('Killed')).toBeTruthy()
    expect(within(items[1]).getByText('No chronicle was written.')).toBeTruthy()
    expect(items[0].querySelector('[data-slot="past-pipeline"]')).toBeTruthy()
  })
})

describe('CultPage room', () => {
  it('mounts the chamber for an active run, selects a member from the room and leaves the viewscreen empty', async () => {
    seed([running()])
    await show()
    expect(screen.queryByRole('img', { name: /Empty chamber/ })).toBeNull()
    expect(document.querySelector('.cult-room .cc-chamber')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Acolyte Vox-4/ }))
    expect(document.querySelector('.cult-room')?.getAttribute('data-selected-member')).toBe('chat_b')
  })
})
