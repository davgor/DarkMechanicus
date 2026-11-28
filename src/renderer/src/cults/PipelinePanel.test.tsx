// @vitest-environment jsdom
/**
 * The pipeline panel over the fake cults backend: names, roles and roster colours, a departed member still named, the
 * member filter, bodies as literal text, live appends, a grouped `order_all` as `<Magos> → all (N)` with its recipients,
 * and a past run read-only.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CultPipelineEntry, PipelineMember } from '../../../shared/cults/cultApi'
import { FakeCults, memberDetail, runDetail } from '../__mocks__/fakeCults'
import { FakeDm } from '../__mocks__/fakeDm'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { memberColor } from './memberColors'
import { PipelinePanel } from './PipelinePanel'
import { PIPELINE_POLL_MS } from './useCultPipeline'

let cults: FakeCults
let scheduler: ManualScheduler

const MAGOS = memberDetail()
const FERRUM = memberDetail({ chatId: 'chat_a', role: 'acolyte', displayName: 'Acolyte Ferrum-3', joinedAt: '2026-11-27T12:01:00.000Z' })
const VOX = memberDetail({ chatId: 'chat_b', role: 'acolyte', displayName: 'Acolyte Vox-4', joinedAt: '2026-11-27T12:02:00.000Z', state: 'dismissed', leftAt: '2026-11-27T12:05:00.000Z' })
const RUN = runDetail({}, [MAGOS, FERRUM, VOX])
const as = (member: typeof MAGOS): PipelineMember => ({ chatId: member.chatId, displayName: member.displayName, role: member.role })

function entry(seq: number, patch: Partial<CultPipelineEntry>): CultPipelineEntry {
  return {
    seq, at: new Date(Date.UTC(2026, 10, 27, 12, 0, seq)).toISOString(), kind: 'message', eventKind: null, sender: as(MAGOS), recipients: [as(FERRUM)],
    orderId: null, messageIds: [`mm_${seq}`], inReplyTo: null, text: '', truncated: false, ...patch
  }
}

const HTML = '<img src=x onerror="alert(1)"><b>bold</b> **not markdown**'

beforeEach(() => {
  const dm = new FakeDm()
  cults = new FakeCults()
  dm.cults = cults
  window.dm = dm
  scheduler = new ManualScheduler()
  cults.pipelines = {
    run_1: [
      entry(1, { kind: 'event', eventKind: 'summoned', recipients: [], messageIds: [], text: 'Magos Vettius was summoned.' }),
      entry(2, { text: 'Draft the shrine layout.' }),
      entry(3, { sender: as(FERRUM), recipients: [as(MAGOS)], text: HTML }),
      entry(4, { sender: as(VOX), recipients: [as(FERRUM)], text: 'My notes before I go.' }),
      entry(5, { kind: 'event', eventKind: 'paused', sender: null, recipients: [], messageIds: [], text: 'The run was paused.' })
    ]
  }
})

afterEach(() => cleanup())

const rows = (): HTMLElement[] => within(screen.getByRole('list', { name: 'Pipeline entries' })).getAllByRole('listitem').filter((item) => item.dataset['seq'] !== undefined)
const nameIn = (row: HTMLElement, name: string): HTMLElement => within(row).getAllByText(name)[0]!.closest('.cult-pipe-member') as HTMLElement

async function show(live: ManualScheduler | null = scheduler): Promise<void> {
  render(<PipelinePanel run={RUN} live={live} />)
  await settle()
}

describe('PipelinePanel', () => {
  it('names each sender and recipient with role and roster colour, keeps a departed member named, and shows run events', async () => {
    await show()
    const [summoned, order, reply, departed, paused] = rows()
    expect(within(summoned!).getByText('summoned')).toBeTruthy()
    expect(within(order!).getByText('Magos')).toBeTruthy()
    expect(within(order!).getByText('Acolyte')).toBeTruthy()
    expect(nameIn(order!, 'Magos Vettius').style.getPropertyValue('--member-color')).toBe('var(--primary)')
    expect(nameIn(order!, 'Acolyte Ferrum-3').style.getPropertyValue('--member-color')).toBe(memberColor(0))
    expect(within(reply!).getAllByText(/Ferrum-3|Vettius/).map((node) => node.textContent)).toEqual(['Acolyte Ferrum-3', 'Magos Vettius'])
    expect(nameIn(departed!, 'Acolyte Vox-4').textContent).toContain('left')
    expect(nameIn(departed!, 'Acolyte Vox-4').style.getPropertyValue('--member-color')).toBe(memberColor(1))
    expect(within(paused!).getByText('Run')).toBeTruthy()
    expect(within(paused!).getByText('The run was paused.')).toBeTruthy()
  })

  it('renders a body holding HTML and Markdown as its literal text', async () => {
    await show()
    const text = rows()[2]!.querySelector('.cult-pipe-text') as HTMLElement
    expect(text.textContent).toBe(HTML)
    expect(text.children).toHaveLength(0)
    expect(document.querySelector('.cult-pipeline img, .cult-pipeline b')).toBeNull()
  })

  it('filters by member, as sender or recipient', async () => {
    await show()
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by member' }), { target: { value: 'chat_b' } })
    expect(rows().map((row) => row.dataset['seq'])).toEqual(['4'])
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by member' }), { target: { value: 'chat_a' } })
    expect(rows().map((row) => row.dataset['seq'])).toEqual(['2', '3', '4'])
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by member' }), { target: { value: '' } })
    expect(rows()).toHaveLength(5)
  })
})

describe('PipelinePanel live and past', () => {
  it('appends new entries live, a grouped order_all reading Magos → all (N) that expands to its recipients', async () => {
    await show()
    cults.pipelines.run_1!.push(entry(7, {
      kind: 'order_all', eventKind: 'order_all', orderId: 'co_1', messageIds: ['mm_a', 'mm_b'], recipients: [as(FERRUM), as(VOX)], text: 'Conclude your reports.'
    }))
    act(() => scheduler.fireIntervals(PIPELINE_POLL_MS))
    await settle()
    expect(rows().map((row) => row.dataset['seq'])).toEqual(['1', '2', '3', '4', '5', '7'])
    const order = rows().at(-1)!
    expect(order.querySelector('.cult-pipe-meta')?.textContent).toContain('Magos Vettius')
    expect(within(order).getByText('→ all (2)')).toBeTruthy()
    expect(within(order).getByText('Conclude your reports.')).toBeTruthy()
    const recipients = within(order).getByText('Recipients of order co_1').closest('details') as HTMLElement
    expect(within(recipients).getAllByRole('listitem').map((item) => item.querySelector('.cult-pipe-name')?.textContent)).toEqual(['Acolyte Ferrum-3', 'Acolyte Vox-4'])
  })

  it('shows the whole body of a preview on request', async () => {
    cults.pipelines.run_1 = [entry(1, { text: 'short', truncated: true })]
    const pipeline = cults.pipeline
    cults.pipeline = (runId, request) => (request.full === true ? Promise.resolve({ ok: true, data: { entries: [entry(1, { text: 'short and the rest' })], nextAfterSeq: 1, hasMore: false } }) : pipeline(runId, request))
    await show()
    fireEvent.click(screen.getByRole('button', { name: 'Show whole message' }))
    await settle()
    expect(screen.getByText('short and the rest')).toBeTruthy()
  })

  it('reads a past run once, read-only: no poll, no listener', async () => {
    await show(null)
    expect(rows()).toHaveLength(5)
    expect(scheduler.intervals()).toEqual([])
    expect(cults.listenerCount).toBe(0)
    expect(screen.getByRole('region', { name: 'Pipeline' }).dataset['live']).toBe('false')
  })
})

/** Gives the list a fixed box (jsdom lays out nothing) with a scroll position the test moves. */
function sizeList(scrollHeight: number, clientHeight: number): HTMLElement {
  const list = screen.getByRole('list', { name: 'Pipeline entries' })
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: clientHeight })
  return list
}

describe('PipelinePanel states and labels', () => {
  it('shows main’s refusal as an alert', async () => {
    cults.pipeline = () => Promise.resolve({ ok: false, error: { code: 'internal', message: 'Run log unreadable.' } })
    await show()
    expect(screen.getByRole('alert').textContent).toBe('Run log unreadable.')
    expect(screen.getByText('Nothing has happened in this run yet.')).toBeTruthy()
  })

  it('says so when the chosen member has no entries', async () => {
    cults.pipelines.run_1 = [entry(1, {})]
    await show()
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by member' }), { target: { value: 'chat_b' } })
    expect(screen.getByText('No entries for this member.')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Pipeline entries' })).toBeNull()
  })

  it('offers Jump to newest once scrolled up, and scrolls to the bottom when used', async () => {
    await show()
    const list = sizeList(1000, 200)
    list.scrollTop = 300
    fireEvent.scroll(list)
    fireEvent.click(screen.getByRole('button', { name: 'Jump to newest' }))
    expect(list.scrollTop).toBe(1000)
    expect(screen.queryByRole('button', { name: 'Jump to newest' })).toBeNull()
    list.scrollTop = 790
    fireEvent.scroll(list)
    expect(screen.queryByRole('button', { name: 'Jump to newest' })).toBeNull()
  })

  it('mutes a sender outside the run, and labels a reply, an unnamed event and an order with no id', async () => {
    const stranger: PipelineMember = { chatId: 'chat_x', displayName: 'Acolyte Stray-9', role: 'acolyte' }
    cults.pipelines.run_1 = [
      entry(1, { sender: stranger, recipients: [], inReplyTo: 'mm_0' }),
      entry(2, { kind: 'event', eventKind: null, recipients: [], messageIds: [] }),
      entry(3, { kind: 'order_all', eventKind: 'order_all', orderId: null, recipients: [as(FERRUM)] })
    ]
    await show()
    const [reply, event, order] = rows()
    expect(nameIn(reply!, 'Acolyte Stray-9').style.getPropertyValue('--member-color')).toBe('var(--muted)')
    expect(reply!.querySelector('.cult-pipe-kind')?.textContent).toBe('reply')
    expect(event!.querySelector('.cult-pipe-kind')?.textContent).toBe('event')
    expect(order!.querySelector('summary')?.textContent).toBe('Recipients of order ')
  })
})
