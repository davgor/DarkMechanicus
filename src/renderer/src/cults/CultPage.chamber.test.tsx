// @vitest-environment jsdom
/**
 * The Cult page's live chamber (DM-667) over the fake cults backend, with reduced motion so events apply at once: a
 * sprite click opens the roster's inspector, an acolyte's robe, roster chip, bubble and pipeline name share one colour,
 * the Shrine sits in the viewscreen with Enlarge, no active run shows the dark empty room, and the run's pipeline plays
 * in the room once per entry, never its history.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CultMemberDetail, CultPipelineEntry, CultRunDetail, PipelineMember } from '../../../shared/cults/cultApi'
import { cultView, FakeCults, memberDetail, runDetail } from '../__mocks__/fakeCults'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeTerminalKit } from '../__mocks__/fakeTerminalKit'
import { createManualClock } from '../__mocks__/manualClock'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ClockContext } from '../epic/clock'
import { CultPage } from './CultPage'
import { memberColor, memberHue } from './memberColors'
import { PIPELINE_POLL_MS } from './useCultPipeline'

const T0 = Date.parse('2026-11-27T12:10:00.000Z')
const at = (ms: number): string => new Date(T0 + ms).toISOString()

const MAGOS = memberDetail()
const FERRUM = memberDetail({ chatId: 'chat_a', role: 'acolyte', displayName: 'Acolyte Ferrum-3', joinedAt: '2026-11-27T12:01:00.000Z',
  activity: { working: true, tool: { name: 'edit', target: 'cults/CultPage.tsx' }, at: at(-60_000) } })
const VOX = memberDetail({ chatId: 'chat_b', role: 'acolyte', displayName: 'Acolyte Vox-4', joinedAt: '2026-11-27T12:02:00.000Z',
  activity: { working: false, tool: null, at: at(-60_000) } })

let cults: FakeCults
let scheduler: ManualScheduler

class NoObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  const dm = new FakeDm()
  cults = new FakeCults()
  dm.cults = cults
  window.dm = dm
  scheduler = new ManualScheduler()
  vi.stubGlobal('ResizeObserver', NoObserver)
  vi.stubGlobal('IntersectionObserver', NoObserver)
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  // Reduced motion: the chamber applies each event at once and draws its static view.
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }))
  // jsdom lays nothing out: the chamber draws only once the room has a size.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(960)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(540)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function running(members: CultMemberDetail[] = [MAGOS, FERRUM, VOX], patch: Partial<CultRunDetail> = {}): CultRunDetail {
  return { ...runDetail({}, members), ...patch }
}

const who = (member: CultMemberDetail): PipelineMember => ({ chatId: member.chatId, displayName: member.displayName, role: member.role })

function mail(seq: number, from: CultMemberDetail, to: CultMemberDetail[], text: string): CultPipelineEntry {
  return { seq, at: at(seq * 1000), kind: 'message', eventKind: null, sender: who(from), recipients: to.map(who), orderId: null,
    messageIds: [`m${seq}`], inReplyTo: null, text, truncated: false }
}

async function show(runs: CultRunDetail[], entries: CultPipelineEntry[] = []): Promise<void> {
  cults.cults = [cultView()]
  cults.runsByCult = { cult_1: runs }
  cults.pipelines = { run_1: entries }
  render(
    <ClockContext.Provider value={createManualClock(T0)}>
      <CultPage cultId="cult_1" agentName="OMP" kit={new FakeTerminalKit()} scheduler={scheduler} />
    </ClockContext.Provider>
  )
  await settle()
}

const sprite = (chatId: string): HTMLElement => document.querySelector(`.cc-acolyte[data-member-id="${chatId}"] .pg-mascot-sprite`) as HTMLElement
const bubbleOf = (id: string): HTMLElement | null => document.querySelector(`.cc-bubble[data-speaker="${id}"]`)

/** New pipeline entries arrive and the recovery poll reads them. */
async function deliver(...entries: CultPipelineEntry[]): Promise<void> {
  cults.pipelines.run_1!.push(...entries)
  act(() => scheduler.fireIntervals(PIPELINE_POLL_MS))
  await settle()
}

describe('CultPage live chamber: inspector and colours', () => {
  it('opens the roster\'s inspector for the member whose sprite is clicked', async () => {
    await show([running()])
    expect(screen.queryByRole('region', { name: /^Inspector/ })).toBeNull()
    fireEvent.click(sprite('chat_b'))
    const inspector = screen.getByRole('region', { name: 'Inspector: Acolyte Vox-4' })
    expect(within(inspector).getByRole('button', { name: 'Watch terminal' })).toBeTruthy()
    expect(document.querySelector('.cc-acolyte[data-member-id="chat_b"]')?.getAttribute('data-selected')).toBe('true')
    expect(document.querySelector('.cult-chip[data-member-id="chat_b"]')?.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(sprite('chat_a'))
    expect(screen.getByRole('region', { name: 'Inspector: Acolyte Ferrum-3' })).toBeTruthy()
  })

  it('gives each acolyte\'s robe, bubble, roster chip and pipeline name the same colour', async () => {
    await show([running()])
    for (const [index, chatId] of ['chat_a', 'chat_b'].entries()) {
      const robe = (document.querySelector(`.cc-acolyte[data-member-id="${chatId}"]`) as HTMLElement).style.getPropertyValue('--member-hue')
      const chip = (document.querySelector(`.cult-chip[data-member-id="${chatId}"]`) as HTMLElement).style.getPropertyValue('--member-hue')
      expect(robe).toBe(`${memberHue(index)}deg`)
      expect(chip).toBe(String(memberHue(index)))
    }
    await deliver(mail(3, VOX, [MAGOS], 'Report sent.'))
    expect(bubbleOf('chat_b')!.style.getPropertyValue('--bubble-color')).toBe(memberColor(1))
    fireEvent.click(screen.getByRole('tab', { name: 'Pipeline' }))
    await settle()
    const name = [...document.querySelectorAll<HTMLElement>('.cult-pipe-member')].find((node) => node.textContent?.includes('Acolyte Vox-4'))
    expect(name!.style.getPropertyValue('--member-color')).toBe(memberColor(1))
  })
})

describe('CultPage live chamber: the viewscreen and the dark room', () => {
  it('shows the Shrine in the viewscreen, with Enlarge opening it large', async () => {
    const shrine = { path: '/w/gerry/index.html', revision: '2', kind: 'html' as const, publishedBy: 'Acolyte Vox-4', updatedAt: at(-1000) }
    await show([running(undefined, { shrine })])
    const viewscreen = document.querySelector('.cult-room .cc-chamber .cc-viewscreen-window') as HTMLElement
    const panel = within(viewscreen).getByRole('region', { name: 'Shrine' })
    expect(panel.getAttribute('data-compact')).toBe('true')
    expect(panel.querySelector('iframe')?.getAttribute('src')).toBe('dm-shrine://shrine/run_1/2')
    fireEvent.click(within(viewscreen).getByRole('button', { name: 'Enlarge' }))
    expect(screen.getByRole('dialog', { name: 'Shrine' }).querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts')
  })

  it('shows "No offering yet" in the viewscreen before any publish', async () => {
    await show([running()])
    const viewscreen = document.querySelector('.cc-viewscreen-window') as HTMLElement
    expect(within(viewscreen).getByRole('status').textContent).toBe('No offering yet')
  })

  it('shows the dark empty room with no active run, and past runs keep only the drawer\'s read-only pipeline', async () => {
    const past = { ...runDetail({ state: 'ended', endReason: 'completed', runningSince: null, endedAt: at(-60_000) }, [MAGOS, FERRUM]) }
    await show([past], [{ ...mail(1, MAGOS, [FERRUM], 'Old order.'), at: at(-120_000) }])
    const room = document.querySelector('.cult-room[data-active="false"]') as HTMLElement
    expect(within(room).getByRole('img', { name: 'Empty chamber: no active run' })).toBeTruthy()
    expect(room.querySelector('.cc-chamber .cc-scene.cc-lights-off')).toBeTruthy()
    expect(room.querySelector('.cc-chamber')?.getAttribute('data-animated')).toBe('false')
    expect(document.querySelector('.cc-magos, .cc-acolyte, .cc-bubble')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Past runs' }))
    const drawer = screen.getByRole('complementary', { name: 'Past runs' })
    expect(drawer.querySelector('[data-slot="past-pipeline"]')).toBeTruthy()
    expect(drawer.querySelector('.cc-chamber')).toBeNull()
  })
})

describe('CultPage live chamber: the run plays in the room', () => {
  it('replays no history, then shows each new mail\'s first line once, as plain text', async () => {
    await show([running()], [{ ...mail(1, MAGOS, [FERRUM], 'Old order.'), at: at(-60_000) }, { ...mail(2, FERRUM, [MAGOS], 'Old report.'), at: at(-30_000) }])
    expect(document.querySelectorAll('.cc-acolyte')).toHaveLength(2)
    expect(document.querySelector('.cc-bubble')).toBeNull()
    await deliver(mail(3, FERRUM, [VOX], '\n<b>Schema</b> first.\nSecond line.'))
    const bubble = bubbleOf('chat_a')!
    expect(bubble.textContent).toBe('<b>Schema</b> first.')
    expect(bubble.querySelector('b')).toBeNull()
    act(() => scheduler.fireIntervals(PIPELINE_POLL_MS))
    await settle()
    expect(document.querySelectorAll('.cc-bubble')).toHaveLength(1)
  })

  it('shows an order to all as one order: its line at the helm and every recipient outlined', async () => {
    await show([running()])
    const order: CultPipelineEntry = { ...mail(3, MAGOS, [FERRUM, VOX], 'Conclude your reports.'), kind: 'order_all', eventKind: 'order_all',
      orderId: 'co_1', messageIds: ['o1', 'o2'] }
    await deliver(order)
    expect(bubbleOf('magos')!.textContent).toBe('Conclude your reports.')
    expect([...document.querySelectorAll('.cc-nameplate[data-outlined="true"]')].map((plate) => plate.textContent)).toEqual(['Acolyte Ferrum-3', 'Acolyte Vox-4'])
  })

  it('phrases a new tool call from a snapshot in the Mechanicus voice', async () => {
    await show([running()])
    act(() => cults.push(running([MAGOS, FERRUM, { ...VOX, activity: { working: true, tool: { name: 'grep', target: 'useChamberLog' }, at: at(1000) } }])))
    await settle()
    expect(bubbleOf('chat_b')!.textContent).toBe('Scrying the noosphere for useChamberLog')
  })
})
