// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { AgentAuthStatus } from '../../../shared/desktop/api'
import type { KanbanAttemptView, KanbanCardView } from '../../../shared/domain/kanban'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView, chatRecord, folderView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import type { OrchestrationHost } from '../epic/orchestration'
import { FakeBoard, cardSummary, cardView } from './__mocks__/fixtures'
import { KanbanBoard } from './KanbanBoard'

afterEach(cleanup)

const folder = folderView({ path: '/a', name: 'alpha' })
const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'ok' }

let dm: FakeDm
let board: FakeBoard
/** The full cards `getKanbanCard` answers, by id. */
let cards: Record<string, KanbanCardView>
/** The chats the host's links opened. */
let opened: string[]

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  board = new FakeBoard(dm)
  cards = {}
  opened = []
  dm.handlers.getKanbanCard = (input) => {
    const cardId = typeof input === 'object' && input !== null && 'cardId' in input ? input.cardId : null
    const card = typeof cardId === 'string' ? cards[cardId] : undefined
    if (card === undefined) throw new Error('no such card')
    return card
  }
})

function host(chats: ChatRecord[] = []): OrchestrationHost {
  return {
    agents: [agentView({ kind: 'claude' })],
    statuses: { claude: SIGNED_IN },
    chats,
    onChatsChanged: () => Promise.resolve(),
    onAddAgent: () => undefined,
    onAgentStatus: () => undefined,
    onOpenChat: (chatId) => opened.push(chatId)
  }
}

/** Puts the card on the board (as its summary) and behind `getKanbanCard` (in full). */
function seed(card: KanbanCardView): void {
  cards[card.id] = card
  const { id, key, title, lane, priority, updatedAt, playPending, openAttempt, kickBackCount, summary } = card
  const row = cardSummary({ id, key, title, lane, priority, updatedAt, playPending, openAttempt, kickBackCount, summary })
  if (lane === 'done') board.done.push(row)
  else board.open.push(row)
}

async function showBoard(chats: ChatRecord[] = []): Promise<void> {
  render(<KanbanBoard folder={folder} refreshToken={0} host={host(chats)} />)
  await settle()
}

async function openCard(key: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${key}`) }))
  await settle()
  return screen.getByRole('complementary', { name: new RegExp(key) })
}

function attempt(patch: Partial<KanbanAttemptView>): KanbanAttemptView {
  return {
    id: 'ka_1',
    cardId: 'kc_a',
    number: 1,
    state: 'submitted',
    machineId: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    progressNote: null,
    outputs: null,
    evidence: null,
    reviewComment: null,
    createdAt: '2026-03-01T10:00:00.000Z',
    submittedAt: null,
    decidedAt: null,
    ...patch
  }
}

describe('KanbanCardPanel Play', () => {
  it.each([
    ['a Backlog card', { lane: 'backlog' }, true],
    ['an In-progress card whose attempt stopped', { lane: 'in_progress', openAttempt: { number: 1, state: 'lease_expired' } }, true],
    ['an In-progress card with no attempt yet', { lane: 'in_progress', playPending: true }, true],
    ['an In-progress card with a running attempt', { lane: 'in_progress', openAttempt: { number: 1, state: 'running' } }, false],
    ['an In-progress card with a claimed attempt', { lane: 'in_progress', openAttempt: { number: 1, state: 'claimed' } }, false],
    ['a Ready-for-review card', { lane: 'ready_for_review', openAttempt: { number: 1, state: 'submitted' } }, false]
  ] as const)('offers Play on %s: %s', async (_name, patch, shown) => {
    seed(cardView({ id: 'kc_a', key: 'DM-7', ...patch }))
    await showBoard()
    const panel = await openCard('DM-7')
    expect(within(panel).queryByRole('button', { name: 'Play' }) !== null).toBe(shown)
  })

  it('hides Play on a Done card', async () => {
    seed(cardView({ id: 'kc_a', key: 'DM-7', lane: 'done', summary: { outcome: 'Shipped', commits: [], completedAt: '2026-03-02T10:00:00.000Z', approvedBy: 'Desktop' } }))
    await showBoard()
    fireEvent.click(screen.getByRole('button', { name: /Show Done/ }))
    const panel = await openCard('DM-7')
    expect(within(panel).queryByRole('button', { name: 'Play' })).toBeNull()
  })

  it('starts the card with the chosen agent and model, then opens the new chat', async () => {
    seed(cardView({ id: 'kc_a', key: 'DM-7', title: 'Fix login' }))
    dm.chats.kanban = {
      play: (_folder, cardId) => Promise.resolve({ ...cards[cardId]!, playPending: true }),
      kickBack: () => Promise.reject(new Error('not here'))
    }
    await showBoard()
    const panel = await openCard('DM-7')
    fireEvent.click(within(panel).getByRole('button', { name: 'Play' }))
    await settle()
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('Model'), { target: { value: 'sonnet' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Start' }))
    await settle()
    expect(dm.chats.callsOf('startKanbanCard')).toEqual([[{ folder: '/a', cardId: 'kc_a', agent: 'claude', model: 'sonnet' }]])
    expect(dm.chats.chats.map((chat) => [chat.id, chat.cardId, chat.title])).toEqual([['chat_new_1', 'kc_a', 'Kanban · DM-7 Fix login']])
    expect(opened).toEqual(['chat_new_1'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

})

describe('KanbanCardPanel Play refused', () => {
  it('keeps the dialog open and says why when Play is refused', async () => {
    seed(cardView({ id: 'kc_a', key: 'DM-7' }))
    dm.chats.kanban = { play: () => Promise.reject(new Error('unused')), kickBack: () => Promise.reject(new Error('unused')) }
    dm.chats.failures.startKanbanCard = { code: 'conflict', message: 'The card already has an open attempt.' }
    await showBoard()
    const panel = await openCard('DM-7')
    fireEvent.click(within(panel).getByRole('button', { name: 'Play' }))
    await settle()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Start' }))
    await settle()
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain('The card already has an open attempt.')
    expect(opened).toEqual([])
  })
})

const reviewCard = (): KanbanCardView =>
  cardView({
    id: 'kc_a',
    key: 'DM-7',
    lane: 'ready_for_review',
    openAttempt: { number: 2, state: 'submitted' },
    kickBackCount: 1,
    acceptanceCriteria: [{ id: 'c1', text: 'Logs in with SSO' }, { id: 'c2', text: 'Shows an error' }],
    attempts: [
      attempt({
        id: 'ka_1',
        number: 1,
        state: 'rejected',
        reviewComment: 'The error page is missing.',
        evidence: { checks: [{ name: 'old check', status: 'failed', detail: 'stale' }], criteria: [], notes: '' }
      }),
      attempt({
        id: 'ka_2',
        number: 2,
        state: 'submitted',
        evidence: {
          checks: [{ name: 'npm test', status: 'passed', detail: '42 tests passed' }],
          criteria: [
            { criterionId: 'c1', met: true, note: 'sso.test.ts' },
            { criterionId: 'c2', met: false, note: 'not verified' }
          ],
          notes: 'Ready for a look.'
        }
      })
    ]
  })

describe('KanbanCardPanel review evidence', () => {
  it("shows the latest attempt's checks, criteria results and notes, with Approve and Kick back", async () => {
    seed(reviewCard())
    await showBoard()
    const panel = await openCard('DM-7')
    const checks = within(panel).getByRole('list', { name: 'Checks' })
    expect(checks.textContent).toContain('npm test')
    expect(checks.textContent).toContain('42 tests passed')
    expect(checks.textContent).not.toContain('old check')
    const criteria = within(panel).getByRole('list', { name: 'Criteria results' })
    expect(within(criteria).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('Logs in with SSO'),
      expect.stringContaining('Shows an error')
    ])
    expect(within(criteria).getByLabelText('met')).toBeTruthy()
    expect(within(criteria).getByLabelText('not met')).toBeTruthy()
    expect(panel.textContent).toContain('Ready for a look.')
    expect(panel.textContent).toContain('The error page is missing.')
    expect(within(panel).getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Kick back' })).toBeTruthy()
  })

})

describe('KanbanCardPanel review actions', () => {
  it('offers no review on a card that is not Ready for review', async () => {
    seed(cardView({ id: 'kc_a', key: 'DM-7', lane: 'in_progress', openAttempt: { number: 1, state: 'running' } }))
    await showBoard()
    const panel = await openCard('DM-7')
    expect(within(panel).queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(within(panel).queryByRole('button', { name: 'Kick back' })).toBeNull()
  })

  it('approves through approveKanbanCard and refreshes the board', async () => {
    seed(reviewCard())
    dm.handlers.approveKanbanCard = () => {
      board.open = []
      return { ...reviewCard(), lane: 'done', openAttempt: null }
    }
    await showBoard()
    const panel = await openCard('DM-7')
    const lists = dm.callsOf('listKanbanCards').length
    fireEvent.click(within(panel).getByRole('button', { name: 'Approve' }))
    await settle()
    expect(dm.callsOf('approveKanbanCard').map((call) => [call.folder, call.input])).toEqual([['/a', { cardId: 'kc_a' }]])
    expect(dm.callsOf('listKanbanCards').length).toBe(lists + 1)
    expect(screen.queryByRole('button', { name: /^DM-7/ })).toBeNull()
  })

})

describe('KanbanCardPanel kick back', () => {
  it('keeps Kick back disabled until a comment is entered, then sends it through kickBackKanbanCard', async () => {
    seed(reviewCard())
    const kicked: string[] = []
    dm.chats.kanban = {
      play: () => Promise.reject(new Error('unused')),
      kickBack: (_folder, cardId, comment) => {
        kicked.push(comment)
        return Promise.resolve({ ...cards[cardId]!, lane: 'in_progress', openAttempt: null, playPending: true })
      }
    }
    await showBoard()
    const panel = await openCard('DM-7')
    const lists = dm.callsOf('listKanbanCards').length
    fireEvent.click(within(panel).getByRole('button', { name: 'Kick back' }))
    const send = within(panel).getByRole('button', { name: 'Send kick back' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(within(panel).getByLabelText('Kick-back comment'), { target: { value: '   ' } })
    expect(send.disabled).toBe(true)
    fireEvent.click(send)
    await settle()
    expect(dm.chats.callsOf('kickBackKanbanCard')).toEqual([])
    fireEvent.change(within(panel).getByLabelText('Kick-back comment'), { target: { value: ' Handle the timeout. ' } })
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    await settle()
    expect(dm.chats.callsOf('kickBackKanbanCard')).toEqual([[{ folder: '/a', cardId: 'kc_a', comment: 'Handle the timeout.' }]])
    expect(kicked).toEqual(['Handle the timeout.'])
    expect(dm.callsOf('listKanbanCards').length).toBe(lists + 1)
    expect(within(panel).queryByRole('button', { name: 'Approve' })).toBeNull()
  })
})

describe('KanbanCardPanel loading', () => {
  it('reads the full card only when it is opened; the list request carries no body', async () => {
    seed(cardView({ id: 'kc_a', key: 'DM-7', body: 'Use the **SSO** flow.', acceptanceCriteria: [{ id: 'c1', text: 'Logs in' }], expectedArtifacts: ['src/sso.ts'] }))
    seed(cardView({ id: 'kc_b', key: 'DM-8', body: 'Other body' }))
    await showBoard()
    expect(dm.callsOf('listKanbanCards').map((call) => call.input)).toEqual([{ doneLimit: 20 }])
    expect(dm.callsOf('getKanbanCard')).toEqual([])
    expect(document.body.textContent).not.toContain('SSO')
    const panel = await openCard('DM-7')
    expect(dm.callsOf('getKanbanCard').map((call) => [call.folder, call.input])).toEqual([['/a', { cardId: 'kc_a' }]])
    expect(within(panel).getByText('SSO')).toBeTruthy()
    expect(within(panel).getByRole('checkbox', { name: 'Logs in' })).toBeTruthy()
    expect(panel.textContent).toContain('src/sso.ts')
    expect(panel.textContent).toContain('Backlog')
  })

})

describe('KanbanCardPanel attachments', () => {
  it("shows the card's reference images, addressed by the folder key, and its references list", async () => {
    seed(
      cardView({
        id: 'kc_a',
        key: 'DM-7',
        references: [{ kind: 'url', label: 'Design doc', location: 'https://example.test/design', hash: null, remoteOnly: true }],
        attachments: [
          { id: 'im_00000000000000000000000001', sha256: 'a'.repeat(64), mime: 'image/png', bytes: 1024, width: 800, height: 600, label: 'login mockup', purpose: 'reference' }
        ]
      })
    )
    seed(cardView({ id: 'kc_b', key: 'DM-8' }))
    await showBoard()
    const panel = await openCard('DM-7')
    const image = within(panel).getByRole('img', { name: 'login mockup' }) as HTMLImageElement
    expect(image.getAttribute('src')).toBe(`dm-attachment://${folder.attachmentKey}/im_00000000000000000000000001`)
    expect(within(panel).getByRole('region', { name: 'References' }).textContent).toContain('https://example.test/design')
    fireEvent.click(screen.getByRole('button', { name: /^DM-8/ }))
    await settle()
    const plain = screen.getByRole('complementary', { name: /DM-8/ })
    expect(within(plain).queryByRole('img')).toBeNull()
    expect(within(plain).queryByRole('region', { name: 'References' })).toBeNull()
  })

})

describe('KanbanCardPanel Done card', () => {
  it('shows a Done card compactly, summary first, with its details below', async () => {
    seed(
      cardView({
        id: 'kc_a',
        key: 'DM-7',
        lane: 'done',
        body: 'The full body.',
        summary: { outcome: 'SSO shipped', commits: ['abcdef1234567'], completedAt: '2026-03-02T10:00:00.000Z', approvedBy: 'Desktop' }
      })
    )
    await showBoard()
    fireEvent.click(screen.getByRole('button', { name: /Show Done/ }))
    const panel = await openCard('DM-7')
    const text = panel.textContent ?? ''
    expect(text).toContain('SSO shipped')
    expect(text).toContain('abcdef1')
    expect(text.indexOf('SSO shipped')).toBeLessThan(text.indexOf('The full body.'))
  })

  it("links to the card's newest chat, the one the last Play started, whatever was active since", async () => {
    seed(cardView({ id: 'kc_a', key: 'DM-7', lane: 'in_progress', openAttempt: { number: 1, state: 'running' } }))
    const chats = [
      chatRecord({ id: 'chat_old', folder: '/a', cardId: 'kc_a', createdAt: '2026-03-01T10:00:00.000Z', updatedAt: '2026-03-04T10:00:00.000Z' }),
      chatRecord({ id: 'chat_new', folder: '/a', cardId: 'kc_a', createdAt: '2026-03-02T10:00:00.000Z', updatedAt: '2026-03-02T10:00:00.000Z' }),
      chatRecord({ id: 'chat_other', folder: '/a', createdAt: '2026-03-03T10:00:00.000Z', updatedAt: '2026-03-03T10:00:00.000Z' })
    ]
    await showBoard(chats)
    const panel = await openCard('DM-7')
    fireEvent.click(within(panel).getByRole('button', { name: 'Open chat' }))
    expect(opened).toEqual(['chat_new'])
  })
})
