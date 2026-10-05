// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActivityEntry, AttemptTimelineView } from '../../../shared/domain/activity'
import type { AttemptState } from '../../../shared/domain/status'
import { FakeDm } from '../__mocks__/fakeDm'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { attempt } from '../epic/__mocks__/fixtures'
import { ActivityTab } from './ActivityTab'

let dm: FakeDm
let scheduler: ManualScheduler
let requests: unknown[]
let chosen: string[]

beforeEach(() => {
  scheduler = new ManualScheduler()
  requests = []
  chosen = []
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

const BASE = { sessionId: 'ss_w', attemptId: 'at_202_2', ticketId: 'tk_202' }

function claim(): ActivityEntry {
  const worker = { label: 'worker-a', modelId: 'model-large', hostId: 'claude-code', effort: null, rationale: null }
  return { ...BASE, kind: 'claim', id: 'claim:at_202_2', at: '2026-09-30T11:00:00.000Z', number: 2, worker }
}

function alive(until: string): ActivityEntry {
  return { ...BASE, kind: 'alive', id: 'alive:at_202_2', at: '2026-09-30T11:00:30.000Z', until, leaseExpiresAt: null, active: true }
}

function note(seq: number, text: string): ActivityEntry {
  return { ...BASE, kind: 'note', id: `event:${seq}`, at: `2026-09-30T11:0${seq}:00.000Z`, text, step: null }
}

function page(entries: ActivityEntry[], cursor: number, state: AttemptState = 'running'): AttemptTimelineView {
  const isLive = state === 'running' || state === 'claimed' || state === 'submitted'
  return { attemptId: 'at_202_2', runId: 'rn_2', ticketId: 'tk_202', state, isLive, cursor, entries, sessions: [] }
}

function serve(...pages: AttemptTimelineView[]): void {
  dm.handlers.getAttemptTimeline = (input) => {
    requests.push(input)
    return pages.length > 1 ? pages.shift() : pages[0]
  }
}

const ATTEMPTS = [attempt('DM-202', 1, 'failed'), attempt('DM-202', 2, 'running')]

function renderTab(patch: Partial<Parameters<typeof ActivityTab>[0]> = {}): ReturnType<typeof render> {
  return render(
    <ActivityTab
      folderPath="/repo"
      attempts={ATTEMPTS}
      attemptId="at_202_2"
      onChoose={(id) => chosen.push(id)}
      onOpenChat={() => undefined}
      scheduler={scheduler}
      {...patch}
    />
  )
}

async function poll(): Promise<void> {
  act(() => scheduler.fireIntervals())
  await settle()
}

function rows(): string[] {
  return within(screen.getByRole('log', { name: 'Attempt timeline' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '')
}

describe('Activity tab timeline', () => {
  it('shows the claim, the alive span as one line and the notes, oldest first', async () => {
    serve(page([claim(), alive('2026-09-30T11:20:00.000Z'), note(1, 'Reading the code'), note(2, 'Wrote the tests')], 9))
    renderTab()
    expect(await screen.findByText('Claimed by worker-a')).toBeTruthy()
    const lines = rows()
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('Claimed by worker-a')
    expect(lines[1]).toMatch(/^Working since \d\d:\d\d, last seen \d\d:\d\d$/)
    expect(lines[2]).toContain('Reading the code')
    expect(lines[3]).toContain('Wrote the tests')
    expect(requests).toEqual([{ attemptId: 'at_202_2', sinceSeq: 0, limit: 200 }])
  })

  it('shows what workers and people wrote as plain text, never as markup', async () => {
    const hostile = '<img src=x onerror="alert(1)"> **bold** [link](https://example.com)'
    serve(page([claim(), note(1, hostile)], 3))
    const { container } = renderTab()
    expect((await screen.findByText(hostile)).tagName).toBe('P')
    expect(container.querySelector('img, strong, a')).toBe(null)
  })

  it('names the attempt and its state', async () => {
    serve(page([claim()], 1))
    renderTab()
    await screen.findByText('Claimed by worker-a')
    expect(screen.getByText('Attempt #2').textContent).toBe('Attempt #2')
    expect(screen.getByText('RUNNING').closest('.ew-pill')).not.toBe(null)
    expect(screen.queryByRole('status')).toBe(null)
  })
})

describe('Activity tab while the attempt is open', () => {
  it('adds new entries on each poll without a reload and grows the alive line in place', async () => {
    serve(
      page([claim(), alive('2026-09-30T11:05:00.000Z'), note(1, 'First note')], 4),
      page([alive('2026-09-30T11:20:00.000Z'), note(2, 'Second note')], 6)
    )
    renderTab()
    await screen.findByText('First note')
    expect(scheduler.intervals()).toEqual([1500])
    expect(screen.queryByText('Second note')).toBe(null)
    await poll()
    expect(await screen.findByText('Second note')).toBeTruthy()
    expect(rows()).toHaveLength(4)
    expect(rows()[1]).toMatch(/last seen \d\d:\d\d$/)
    expect(requests).toEqual([
      { attemptId: 'at_202_2', sinceSeq: 0, limit: 200 },
      { attemptId: 'at_202_2', sinceSeq: 4, limit: 200 }
    ])
  })

  it('stops polling once the attempt closes and says how it ended', async () => {
    const decision: ActivityEntry = {
      ...BASE,
      kind: 'decision',
      id: 'event:3',
      at: '2026-09-30T11:30:00.000Z',
      outcome: 'rejected',
      reasons: ['No test'],
      notes: '',
      decidedBy: 'orchestrator'
    }
    serve(page([claim(), note(1, 'Working')], 3), page([decision], 5, 'rejected'))
    renderTab()
    await screen.findByText('Working')
    await poll()
    expect(await screen.findByText('Attempt ended: Rejected')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Rejected by orchestrator: No test')
    expect(scheduler.intervals()).toEqual([])
    await poll()
    expect(requests).toHaveLength(2)
  })

  it('does not poll an attempt that has already ended, and still shows its history', async () => {
    serve(page([claim(), note(1, 'Done')], 3, 'accepted'))
    renderTab()
    expect(await screen.findByText('Attempt ended: Accepted')).toBeTruthy()
    expect(scheduler.intervals()).toEqual([])
    expect(rows()).toHaveLength(2)
  })
})

describe('Activity tab scrolling', () => {
  function fitLog(log: HTMLElement): void {
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 600 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 })
  }

  it('follows the newest row until the person scrolls up, then offers a way back', async () => {
    serve(page([claim(), note(1, 'One')], 3), page([note(2, 'Two')], 4), page([note(3, 'Three')], 5))
    renderTab()
    await screen.findByText('One')
    const log = screen.getByRole('log', { name: 'Attempt timeline' })
    fitLog(log)
    await poll()
    await screen.findByText('Two')
    expect(log.scrollTop).toBe(600)
    log.scrollTop = 100
    fireEvent.scroll(log)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy()
    await poll()
    await screen.findByText('Three')
    expect(log.scrollTop).toBe(100)
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(log.scrollTop).toBe(600)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBe(null)
  })

  it('follows again once the person scrolls back to the end', async () => {
    serve(page([claim()], 2), page([note(1, 'One')], 3))
    renderTab()
    await screen.findByText('Claimed by worker-a')
    const log = screen.getByRole('log', { name: 'Attempt timeline' })
    fitLog(log)
    log.scrollTop = 0
    fireEvent.scroll(log)
    log.scrollTop = 400
    fireEvent.scroll(log)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBe(null)
    await poll()
    await screen.findByText('One')
    expect(log.scrollTop).toBe(600)
  })
})

describe('Activity tab attempts', () => {
  it('shows the ticket\'s latest attempt when none was asked for', async () => {
    serve(page([claim()], 1))
    renderTab({ attemptId: null })
    await screen.findByText('Claimed by worker-a')
    expect(requests).toEqual([{ attemptId: 'at_202_2', sinceSeq: 0, limit: 200 }])
  })

  it('lets the person pick another attempt of the ticket', async () => {
    serve(page([claim()], 1))
    renderTab()
    await screen.findByText('Claimed by worker-a')
    const picker = screen.getByRole('combobox', { name: 'Attempt' }) as HTMLSelectElement
    expect(Array.from(picker.options).map((option) => option.textContent)).toEqual(['#2 · worker-a · running', '#1 · worker-a · failed'])
    fireEvent.change(picker, { target: { value: 'at_202_1' } })
    expect(chosen).toEqual(['at_202_1'])
  })

  it('follows the attempt it is given when the ticket has not listed it yet', async () => {
    serve(page([claim()], 1))
    renderTab({ attempts: [], attemptId: 'at_202_2' })
    await screen.findByText('Claimed by worker-a')
    expect(screen.getByText('RUNNING')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBe(null)
  })

  it('says so when the ticket has no attempts', () => {
    renderTab({ attempts: [], attemptId: null })
    expect(screen.getByText('No attempts yet.')).toBeTruthy()
    expect(requests).toEqual([])
  })

  it('starts over for another attempt', async () => {
    serve(page([claim(), note(1, 'Mine')], 3))
    const view = renderTab()
    await screen.findByText('Mine')
    serve({ ...page([note(7, 'Theirs')], 8, 'failed'), attemptId: 'at_202_1' })
    view.rerender(
      <ActivityTab folderPath="/repo" attempts={ATTEMPTS} attemptId="at_202_1" onChoose={() => undefined} onOpenChat={() => undefined} scheduler={scheduler} />
    )
    expect(await screen.findByText('Theirs')).toBeTruthy()
    expect(screen.queryByText('Mine')).toBe(null)
  })
})

describe('Activity tab loading and failure', () => {
  it('says it is loading until the first page arrives', async () => {
    serve(page([claim()], 1))
    renderTab()
    expect(screen.getByText('Loading activity…')).toBeTruthy()
    await screen.findByText('Claimed by worker-a')
    expect(screen.queryByText('Loading activity…')).toBe(null)
  })

  it('shows a failure, and carries on when the next poll works', async () => {
    dm.failures.getAttemptTimeline = { code: 'internal', message: 'The record is unreadable.' }
    renderTab()
    expect((await screen.findByRole('alert')).textContent).toBe('The record is unreadable.')
    delete dm.failures.getAttemptTimeline
    serve(page([claim()], 1))
    await poll()
    expect(await screen.findByText('Claimed by worker-a')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBe(null)
  })
})
