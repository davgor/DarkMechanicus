// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentAuthStatus } from '../../../shared/desktop/api'
import type { KanbanCardView } from '../../../shared/domain/kanban'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView, folderView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import type { OrchestrationHost } from '../epic/orchestration'
import { FakeBoard, cardSummary, cardView } from './__mocks__/fixtures'
import { KanbanBoard } from './KanbanBoard'

afterEach(cleanup)

const folder = folderView({ path: '/a', name: 'alpha' })
const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'ok' }

let dm: FakeDm
let board: FakeBoard
let cards: Record<string, KanbanCardView>

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  board = new FakeBoard(dm)
  cards = {}
  dm.handlers.getKanbanCard = (input) => {
    const cardId = typeof input === 'object' && input !== null && 'cardId' in input ? input.cardId : null
    const card = typeof cardId === 'string' ? cards[cardId] : undefined
    if (card === undefined) throw new Error('no such card')
    return card
  }
  dm.handlers.deleteKanbanCard = (input) => {
    const cardId = (input as { cardId: string }).cardId
    board.open = board.open.filter((card) => card.id !== cardId)
    delete cards[cardId]
    return { cardId, key: 'DM-7', title: 'Fix login', removedPaths: [] }
  }
})

const host: OrchestrationHost = {
  agents: [agentView({ kind: 'claude' })],
  statuses: { claude: SIGNED_IN },
  chats: [],
  onChatsChanged: () => Promise.resolve(),
  onAddAgent: () => undefined,
  onAgentStatus: () => undefined,
  onOpenChat: () => undefined
}

function seed(card: KanbanCardView): void {
  cards[card.id] = card
  const { id, key, title, lane, priority, updatedAt, playPending, openAttempt, kickBackCount, summary } = card
  board.open.push(cardSummary({ id, key, title, lane, priority, updatedAt, playPending, openAttempt, kickBackCount, summary }))
}

async function openCard(): Promise<HTMLElement> {
  render(<KanbanBoard folder={folder} refreshToken={0} host={host} />)
  await settle()
  fireEvent.click(screen.getByRole('button', { name: /^DM-7/ }))
  await settle()
  return screen.getByRole('complementary', { name: /DM-7/ })
}

describe('deleting a Kanban card from its panel', () => {
  it('asks for confirmation, and Keep leaves the card alone', async () => {
    seed(cardView({ id: 'kc_a', key: 'DM-7', title: 'Fix login' }))
    const panel = await openCard()

    fireEvent.click(within(panel).getByRole('button', { name: 'Delete…' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Delete DM-7' }))
    expect(dialog.getByText(/cannot be undone/)).toBeTruthy()
    expect(dm.callsOf('deleteKanbanCard')).toEqual([])
    fireEvent.click(dialog.getByRole('button', { name: 'Keep' }))
    await settle()

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(dm.callsOf('deleteKanbanCard')).toEqual([])
    expect(screen.getByRole('complementary', { name: /DM-7/ })).toBeTruthy()
  })

  it('deletes after confirming, closes the panel and removes the card from its lane', async () => {
    seed(cardView({ id: 'kc_a', key: 'DM-7', title: 'Fix login' }))
    const panel = await openCard()

    fireEvent.click(within(panel).getByRole('button', { name: 'Delete…' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete card' }))
    await settle()

    expect(dm.callsOf('deleteKanbanCard').map((call) => [call.folder, call.input])).toEqual([['/a', { cardId: 'kc_a' }]])
    expect(screen.queryByRole('complementary', { name: /DM-7/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^DM-7/ })).toBeNull()
  })

  it('keeps the dialog open and says why when the delete is refused', async () => {
    seed(cardView({ id: 'kc_a', key: 'DM-7', title: 'Fix login' }))
    dm.failures.deleteKanbanCard = { code: 'invalid_state', message: 'DM-7 has attempt #1 in state running, so it cannot be deleted.' }
    const panel = await openCard()

    fireEvent.click(within(panel).getByRole('button', { name: 'Delete…' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete card' }))
    await settle()

    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain('cannot be deleted')
    expect(screen.getByRole('complementary', { name: /DM-7/ })).toBeTruthy()
  })

})

describe('deleting a Kanban card with an attempt in flight', () => {
  it.each([
    ['claimed', 'in_progress', /Attempt #1 is claimed/],
    ['running', 'in_progress', /Attempt #1 is running/],
    ['submitted', 'ready_for_review', /waiting for your review/]
  ] as const)('disables Delete and explains why while an attempt is %s', async (state, lane, reason) => {
    seed(cardView({ id: 'kc_a', key: 'DM-7', lane, openAttempt: { number: 1, state } }))
    const panel = await openCard()

    const button = within(panel).getByRole('button', { name: 'Delete…' })

    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(within(panel).getByRole('note').textContent).toMatch(reason)
    fireEvent.click(button)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(dm.callsOf('deleteKanbanCard')).toEqual([])
  })

  it('offers Delete on a card whose attempt lease lapsed', async () => {
    seed(cardView({ id: 'kc_a', key: 'DM-7', lane: 'in_progress', openAttempt: { number: 1, state: 'lease_expired' } }))
    const panel = await openCard()
    expect((within(panel).getByRole('button', { name: 'Delete…' }) as HTMLButtonElement).disabled).toBe(false)
    expect(within(panel).queryByRole('note')).toBeNull()
  })
})
