// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { folderView, localNoonIso } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import type { OrchestrationHost } from '../epic/orchestration'
import type { UpdateKanbanCardInput } from '../../../shared/domain/api'
import { FakeBoard, cardSummary, cardView, doneCard } from './__mocks__/fixtures'
import { KanbanBoard } from './KanbanBoard'

afterEach(cleanup)

const folder = folderView({ path: '/a', name: 'alpha' })
/** No agents and no chats: these tests are about the lanes, not Play. */
const idleHost: OrchestrationHost = {
  agents: [],
  statuses: {},
  chats: [],
  onChatsChanged: () => undefined,
  onAddAgent: () => undefined,
  onAgentStatus: () => undefined,
  onOpenChat: () => undefined
}

let dm: FakeDm
let board: FakeBoard

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  board = new FakeBoard(dm)
})

function boardAt(token: number, opened: string[] = []): JSX.Element {
  return <KanbanBoard folder={folder} refreshToken={token} host={idleHost} onOpenCard={(id) => opened.push(id)} />
}

async function show(token = 0, opened: string[] = []): Promise<RenderResult> {
  const view = render(boardAt(token, opened))
  await settle()
  return view
}

const lane = (name: RegExp): HTMLElement => screen.getByRole('region', { name })
const doneRows = (): string[] => Array.from(document.querySelectorAll('.kanban-done-row .kanban-key')).map((el) => el.textContent ?? '')

describe('KanbanBoard lanes', () => {
  it('shows the four lanes in order with their counts, Done counting every Done card', async () => {
    board.open = [
      cardSummary({ id: 'kc_a', key: 'DM-1', lane: 'backlog' }),
      cardSummary({ id: 'kc_b', key: 'DM-2', lane: 'backlog' }),
      cardSummary({ id: 'kc_c', key: 'DM-3', lane: 'in_progress' })
    ]
    board.done = Array.from({ length: 25 }, (_, index) => doneCard(index + 1))
    await show()
    const names = screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))
    expect(names).toEqual(['Backlog, 2 cards', 'In progress, 1 card', 'Ready for review, 0 cards', 'Done, 25 cards'])
    expect(dm.callsOf('listKanbanCards').map((call) => [call.folder, call.input])).toEqual([['/a', { doneLimit: 20 }]])
  })

  it('shows a slim card with key, title, priority, attempt badge and kick-backs', async () => {
    board.open = [
      cardSummary({ id: 'kc_a', key: 'DM-7', title: 'Fix login', lane: 'in_progress', priority: 'high', openAttempt: { number: 2, state: 'running' }, kickBackCount: 1 }),
      cardSummary({ id: 'kc_b', key: 'DM-8', title: 'Queued', lane: 'backlog', playPending: true })
    ]
    await show()
    const working = within(lane(/^In progress/)).getByRole('button', { name: /^DM-7/ })
    expect(working.textContent).toContain('Fix login')
    expect(working.textContent).toContain('High')
    expect(working.textContent).toContain('Agent working')
    expect(working.textContent).toContain('1 kick-back')
    expect(within(lane(/^Backlog/)).getByRole('button', { name: /^DM-8/ }).textContent).toContain('Waiting for agent')
  })

  it('names a stopped or failed attempt on its card', async () => {
    board.open = [
      cardSummary({ id: 'kc_a', key: 'DM-7', lane: 'in_progress', openAttempt: { number: 1, state: 'lease_expired' } }),
      cardSummary({ id: 'kc_b', key: 'DM-8', lane: 'in_progress', openAttempt: { number: 1, state: 'failed' } })
    ]
    await show()
    expect(screen.getByRole('button', { name: /^DM-7/ }).textContent).toContain('Agent stopped')
    expect(screen.getByRole('button', { name: /^DM-8/ }).textContent).toContain('Failed')
  })

})

describe('KanbanBoard selection and refresh', () => {
  it('selects a card on click and hands it to the card panel hook', async () => {
    board.open = [cardSummary({ id: 'kc_a', key: 'DM-7' })]
    dm.responses.getKanbanCard = cardView({ id: 'kc_a', key: 'DM-7' })
    const opened: string[] = []
    await show(0, opened)
    const card = screen.getByRole('button', { name: /^DM-7/ })
    expect(card.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(card)
    expect(card.getAttribute('aria-pressed')).toBe('true')
    expect(opened).toEqual(['kc_a'])
  })

  it('refetches the board when the folder event token moves', async () => {
    const view = await show(0)
    expect(screen.queryByText('Late card')).toBeNull()
    board.open = [cardSummary({ id: 'kc_a', key: 'DM-7', title: 'Late card' })]
    view.rerender(boardAt(1))
    await settle()
    expect(screen.getByText('Late card')).toBeTruthy()
  })
})

describe('KanbanBoard refresh failure', () => {
  it('says why the board could not be refreshed and keeps the cards shown', async () => {
    board.open = [cardSummary({ id: 'kc_a', key: 'DM-7', title: 'Still here' })]
    const view = await show(0)
    dm.failures.listKanbanCards = { code: 'internal', message: 'Database locked.' }
    view.rerender(boardAt(1))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('Could not refresh the board: Database locked.')
    expect(screen.getByRole('button', { name: /^DM-7/ }).textContent).toContain('Still here')
  })
})

describe('KanbanBoard Done row without a summary', () => {
  it('shows no outcome and dates the row by its last update', async () => {
    board.done = [cardSummary({ id: 'kc_d', key: 'DM-9', title: 'Bare', lane: 'done', updatedAt: localNoonIso(2026, 4, 5) })]
    await show()
    fireEvent.click(screen.getByRole('button', { name: /Show Done/ }))
    const row = screen.getByRole('button', { name: /^DM-9/ })
    expect(row.querySelector('.kanban-done-outcome')?.textContent).toBe('')
    expect(row.querySelector('.kanban-done-date')?.textContent).toBe('Apr 5, 2026')
  })
})

describe('KanbanBoard Done lane', () => {
  beforeEach(() => {
    board.done = Array.from({ length: 45 }, (_, index) => doneCard(index + 1))
  })

  it('is collapsed by default and opens to the first 20 compact rows', async () => {
    await show()
    const toggle = within(lane(/^Done/)).getByRole('button', { name: /Show Done/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(doneRows()).toEqual([])
    fireEvent.click(toggle)
    expect(doneRows()).toHaveLength(20)
    expect(doneRows()[0]).toBe('DM-101')
    const first = document.querySelector('.kanban-done-row')
    expect(first?.textContent).toContain('Done 1')
    expect(first?.textContent).toContain('Outcome 1')
    expect(first?.textContent).toContain('Mar 1, 2026')
  })

  it('loads the next 20 with Show more, then the rest, and then offers no more', async () => {
    await show()
    fireEvent.click(screen.getByRole('button', { name: /Show Done/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    await settle()
    expect(dm.callsOf('listKanbanCards').at(-1)?.input).toEqual({ doneLimit: 20, doneCursor: '20' })
    expect(doneRows()).toHaveLength(40)
    expect(doneRows()[20]).toBe('DM-121')
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    await settle()
    expect(doneRows()).toHaveLength(45)
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })

  it('keeps the Done rows already shown when an event refreshes the board', async () => {
    const view = await show(0)
    fireEvent.click(screen.getByRole('button', { name: /Show Done/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    await settle()
    view.rerender(boardAt(1))
    await settle()
    expect(dm.callsOf('listKanbanCards').at(-1)?.input).toEqual({ doneLimit: 40 })
    expect(doneRows()).toHaveLength(40)
  })
})

describe('KanbanBoard New card', () => {
  it('creates a Backlog card with the form content, and shows it without a reload', async () => {
    await show()
    fireEvent.click(screen.getByRole('button', { name: 'New card' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: '  Add search  ' } })
    fireEvent.change(within(dialog).getByLabelText('Body'), { target: { value: 'Use **FTS**.' } })
    fireEvent.change(within(dialog).getByLabelText(/Acceptance criteria/), { target: { value: 'Finds by title\n\n Finds by body ' } })
    fireEvent.change(within(dialog).getByLabelText(/Expected artifacts/), { target: { value: 'src/search.ts' } })
    fireEvent.change(within(dialog).getByLabelText('Priority'), { target: { value: 'high' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create card' }))
    await settle()
    expect(dm.callsOf('createKanbanCard').map((call) => [call.folder, call.input])).toEqual([
      ['/a', { title: 'Add search', body: 'Use **FTS**.', acceptanceCriteria: ['Finds by title', 'Finds by body'], expectedArtifacts: ['src/search.ts'], priority: 'high' }]
    ])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(lane(/^Backlog/)).getByRole('button', { name: /^DM-501/ }).textContent).toContain('Add search')
    expect(lane(/^Backlog/).getAttribute('aria-label')).toBe('Backlog, 1 card')
  })

  it('refuses a blank title without calling the server', async () => {
    await show()
    fireEvent.click(screen.getByRole('button', { name: 'New card' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create card' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('Give the card a title.')
    expect(dm.callsOf('createKanbanCard')).toEqual([])
  })

  it('keeps the form open and says why when the server refuses', async () => {
    dm.failures.createKanbanCard = { code: 'invalid_input', message: 'Title too long.' }
    await show()
    fireEvent.click(screen.getByRole('button', { name: 'New card' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'X' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create card' }))
    await settle()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Title too long.')
  })
})

describe('KanbanBoard Edit', () => {
  it('offers Edit only on Backlog cards that never had an attempt', async () => {
    board.open = [
      cardSummary({ id: 'kc_a', key: 'DM-1', title: 'Fresh', lane: 'backlog' }),
      cardSummary({ id: 'kc_b', key: 'DM-2', title: 'Kicked', lane: 'backlog', kickBackCount: 1 }),
      cardSummary({ id: 'kc_c', key: 'DM-3', title: 'Running', lane: 'in_progress', openAttempt: { number: 1, state: 'running' } })
    ]
    await show()
    expect(screen.getAllByRole('button', { name: /^Edit/ }).map((button) => button.getAttribute('aria-label'))).toEqual(['Edit DM-1'])
  })

  it('edits through updateKanbanCard with the current revision and only the changed card', async () => {
    board.open = [cardSummary({ id: 'kc_a', key: 'DM-1', title: 'Fresh' })]
    dm.responses.getKanbanCard = cardView({
      id: 'kc_a',
      key: 'DM-1',
      title: 'Fresh',
      body: 'Old body',
      acceptanceCriteria: [{ id: 'c1', text: 'Works' }],
      revision: 4
    })
    dm.handlers.updateKanbanCard = (input) => {
      const update = input as UpdateKanbanCardInput
      board.open = [cardSummary({ id: 'kc_a', key: 'DM-1', title: update.title })]
      return cardView({ id: 'kc_a', title: update.title, revision: 5 })
    }
    await show()
    fireEvent.click(screen.getByRole('button', { name: 'Edit DM-1' }))
    await settle()
    const dialog = screen.getByRole('dialog')
    expect((within(dialog).getByLabelText('Body') as HTMLTextAreaElement).value).toBe('Old body')
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Renamed' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save card' }))
    await settle()
    expect(dm.callsOf('updateKanbanCard').map((call) => call.input)).toEqual([
      { cardId: 'kc_a', expectedRevision: 4, title: 'Renamed', body: 'Old body', acceptanceCriteria: ['Works'], expectedArtifacts: [], priority: 'normal' }
    ])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: /^DM-1/ }).textContent).toContain('Renamed')
  })
})
