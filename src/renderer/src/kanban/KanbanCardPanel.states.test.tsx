// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { AgentAuthStatus } from '../../../shared/desktop/api'
import type { KanbanAttemptView, KanbanCardView, KanbanDoneSummary } from '../../../shared/domain/kanban'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView, chatRecord } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import type { OrchestrationHost } from '../epic/orchestration'
import { cardView } from './__mocks__/fixtures'
import { KanbanCardPanel } from './KanbanCardPanel'

afterEach(cleanup)

const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'ok' }

let dm: FakeDm
/** The full cards `getKanbanCard` answers, by id. */
let cards: Record<string, KanbanCardView>
/** The chats the host's links opened. */
let opened: string[]
/** How often the panel told the board the card changed. */
let changes: number

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  cards = {}
  opened = []
  changes = 0
  dm.handlers.getKanbanCard = (input) => {
    const cardId = typeof input === 'object' && input !== null && 'cardId' in input ? input.cardId : null
    const card = typeof cardId === 'string' ? cards[cardId] : undefined
    if (card === undefined) throw new Error('no such card')
    return card
  }
})

function host(chats: ChatRecord[]): OrchestrationHost {
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

function panelAt(cardId: string, token = 0, chats: ChatRecord[] = []): JSX.Element {
  return (
    <KanbanCardPanel
      folderPath="/a"
      folderKey="00000000000000000000000000000001"
      cardId={cardId}
      refreshToken={token}
      host={host(chats)}
      onChanged={() => {
        changes += 1
      }}
      onClose={() => undefined}
    />
  )
}

async function show(cardId: string, token = 0, chats: ChatRecord[] = []): Promise<RenderResult> {
  const view = render(panelAt(cardId, token, chats))
  await settle()
  return view
}

const panel = (): HTMLElement => screen.getByRole('complementary')
const title = (): string | null => screen.queryByRole('heading', { level: 2 })?.textContent ?? null

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

describe('KanbanCardPanel read failures', () => {
  it('says why the card could not be read, instead of a loading note', async () => {
    await show('kc_missing')
    expect(within(panel()).getByRole('alert').textContent).toBe('Could not read the card: no such card')
    expect(panel().textContent).not.toContain('Loading the card')
    expect(panel().getAttribute('aria-label')).toBe('Card')
  })

  it('keeps the card on screen when a refetch fails', async () => {
    cards.kc_a = cardView({ id: 'kc_a', key: 'DM-7', title: 'Fix login' })
    const view = await show('kc_a')
    delete cards.kc_a
    view.rerender(panelAt('kc_a', 1))
    await settle()
    expect(within(panel()).getByRole('alert').textContent).toBe('Could not read the card: no such card')
    expect(title()).toBe('Fix login')
    expect(panel().getAttribute('aria-label')).toBe('DM-7 Fix login')
  })

  it('drops the previous card when the next one cannot be read', async () => {
    cards.kc_a = cardView({ id: 'kc_a', key: 'DM-7', title: 'Fix login' })
    const view = await show('kc_a')
    view.rerender(panelAt('kc_b'))
    expect(title()).toBeNull()
    expect(panel().textContent).toContain('Loading the card')
    await settle()
    expect(within(panel()).getByRole('alert').textContent).toBe('Could not read the card: no such card')
    expect(title()).toBeNull()
    expect(panel().getAttribute('aria-label')).toBe('Card')
  })
})

describe('KanbanCardPanel stale reads', () => {
  it('ignores the answer for a card opened before the current one', async () => {
    cards.kc_a = cardView({ id: 'kc_a', key: 'DM-7', title: 'First card' })
    cards.kc_b = cardView({ id: 'kc_b', key: 'DM-8', title: 'Second card' })
    const hold = dm.holdNext('getKanbanCard')
    const view = render(panelAt('kc_a'))
    view.rerender(panelAt('kc_b'))
    await settle()
    expect(title()).toBe('Second card')
    hold.resolve()
    await settle()
    expect(title()).toBe('Second card')
    expect(dm.callsOf('getKanbanCard').map((call) => call.input)).toEqual([{ cardId: 'kc_a' }, { cardId: 'kc_b' }])
  })

  it('ignores a failure for a card opened before the current one', async () => {
    cards.kc_b = cardView({ id: 'kc_b', key: 'DM-8', title: 'Second card' })
    const hold = dm.holdNext('getKanbanCard')
    const view = render(panelAt('kc_missing'))
    view.rerender(panelAt('kc_b'))
    await settle()
    hold.resolve()
    await settle()
    expect(title()).toBe('Second card')
    expect(within(panel()).queryByRole('alert')).toBeNull()
  })
})

describe('KanbanCardPanel Play without a chat', () => {
  it('shows why no chat started and opens none', async () => {
    cards.kc_a = cardView({ id: 'kc_a', key: 'DM-7', title: 'Fix login' })
    dm.chats.kanban = {
      play: (_folder, cardId) => Promise.resolve({ ...cards[cardId]!, lane: 'in_progress', playPending: true }),
      kickBack: () => Promise.reject(new Error('unused'))
    }
    dm.chats.kanbanProblem = 'The agent could not be started.'
    await show('kc_a')
    fireEvent.click(within(panel()).getByRole('button', { name: 'Play' }))
    await settle()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Start' }))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(panel()).getByRole('status').textContent).toBe('The agent could not be started.')
    expect(panel().textContent).toContain('In progress')
    expect(opened).toEqual([])
    expect(changes).toBe(1)
  })
})

describe('KanbanCardPanel review and chat link', () => {
  it('says why an approval failed and keeps the review controls', async () => {
    cards.kc_a = cardView({ id: 'kc_a', key: 'DM-7', lane: 'ready_for_review', openAttempt: { number: 1, state: 'submitted' } })
    dm.failures.approveKanbanCard = { code: 'conflict', message: 'The card moved on.' }
    await show('kc_a')
    const review = within(panel()).getByRole('region', { name: 'Review' })
    fireEvent.click(within(review).getByRole('button', { name: 'Approve' }))
    await settle()
    expect(within(review).getByRole('alert').textContent).toBe('The card moved on.')
    expect(within(review).getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(changes).toBe(0)
  })

  it('links to the newest chat when it is listed before older ones', async () => {
    cards.kc_a = cardView({ id: 'kc_a', key: 'DM-7', lane: 'in_progress', openAttempt: { number: 1, state: 'running' } })
    const chats = [
      chatRecord({ id: 'chat_old', folder: '/a', cardId: 'kc_a', createdAt: '2026-03-01T10:00:00.000Z', updatedAt: '2026-03-05T10:00:00.000Z' }),
      chatRecord({ id: 'chat_new', folder: '/a', cardId: 'kc_a', createdAt: '2026-03-03T10:00:00.000Z', updatedAt: '2026-03-03T10:00:00.000Z' })
    ]
    await show('kc_a', 0, chats)
    fireEvent.click(within(panel()).getByRole('button', { name: 'Open chat' }))
    expect(opened).toEqual(['chat_new'])
  })
})

describe('KanbanCardPanel decided attempts', () => {
  const approved: KanbanDoneSummary = { outcome: 'Shipped', commits: [], completedAt: '2026-03-02T10:00:00.000Z', approvedBy: 'Avery' }
  it.each([
    ['names the approver from the Done summary', approved, 'by Avery'],
    ['names the reviewer when the card has no summary', null, 'by the reviewer']
  ])('%s', async (_name, summary, decider) => {
    cards.kc_a = cardView({ id: 'kc_a', key: 'DM-7', lane: 'done', summary, attempts: [attempt({ state: 'accepted', decidedAt: '2026-03-02T10:00:00.000Z' })] })
    await show('kc_a')
    const attempts = within(panel()).getByRole('region', { name: 'Attempts' })
    expect(attempts.textContent).toContain(decider)
  })

  it('shows evidence without checks, criteria or notes as just its source', async () => {
    cards.kc_a = cardView({
      id: 'kc_a',
      key: 'DM-7',
      lane: 'ready_for_review',
      openAttempt: { number: 1, state: 'submitted' },
      attempts: [attempt({ evidence: { checks: [], criteria: [], notes: '   ' } })]
    })
    await show('kc_a')
    expect(panel().textContent).toContain('FROM ATTEMPT #1')
    expect(within(panel()).queryByRole('list', { name: 'Checks' })).toBeNull()
    expect(within(panel()).queryByRole('list', { name: 'Criteria results' })).toBeNull()
    expect(panel().textContent).not.toContain('NOTES')
  })

  it('shows the evidence images as thumbnails and the output artifacts, addressed by the folder key', async () => {
    cards.kc_a = cardView({
      id: 'kc_a',
      key: 'DM-7',
      lane: 'ready_for_review',
      openAttempt: { number: 1, state: 'submitted' },
      attempts: [
        attempt({
          evidence: {
            checks: [],
            criteria: [],
            notes: '',
            attachments: [{ id: 'im_00000000000000000000000009', sha256: 'b'.repeat(64), mime: 'image/png', bytes: 10, width: 320, height: 200, label: 'terminal', purpose: 'evidence' }]
          },
          outputs: { summary: '', artifacts: [{ label: 'Report', location: 'https://example.com/r', hash: null, remoteOnly: true }], commits: [], changedFiles: [], branch: null }
        })
      ]
    })
    await show('kc_a')
    const gallery = within(panel()).getByRole('list', { name: 'Attachments' })
    const image = within(gallery).getByRole('img', { name: 'terminal' }) as HTMLImageElement
    expect(image.getAttribute('src')).toBe('dm-attachment://00000000000000000000000000000001/im_00000000000000000000000009')
    expect(within(panel()).getByRole('region', { name: 'Artifacts' }).textContent).toContain('Report')
  })
})

describe('KanbanCardPanel attempts of a card kicked back once', () => {
  const kickedBack = (): KanbanCardView =>
    cardView({
      id: 'kc_a',
      key: 'DM-7',
      lane: 'ready_for_review',
      openAttempt: { number: 2, state: 'submitted' },
      kickBackCount: 1,
      attempts: [
        attempt({ id: 'ka_1', number: 1, state: 'rejected', reviewComment: 'The error page is missing.', decidedAt: '2026-03-02T10:00:00.000Z' }),
        attempt({ id: 'ka_2', number: 2, state: 'submitted' })
      ]
    })

  it('shows the kicked-back attempt rejected by the reviewer, and the submitted one undecided', async () => {
    cards.kc_a = kickedBack()
    await show('kc_a')

    const items = within(within(panel()).getByRole('region', { name: 'Attempts' })).getAllByRole('listitem').filter((item) => item.getAttribute('aria-label')?.startsWith('Attempt'))
    expect(items.map((item) => [item.getAttribute('aria-label'), item.textContent?.includes('Rejected by the reviewer')])).toEqual([
      ['Attempt #2', false],
      ['Attempt #1', true]
    ])
  })

  it('offers no Accept or Reject in the attempt list: the card is approved or kicked back with the panel\'s own controls', async () => {
    cards.kc_a = kickedBack()
    await show('kc_a')

    const attempts = within(panel()).getByRole('region', { name: 'Attempts' })
    expect(within(attempts).queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(within(attempts).queryByRole('button', { name: 'Reject' })).toBeNull()
    expect(within(panel()).getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(within(panel()).getByRole('button', { name: 'Kick back' })).toBeTruthy()
  })
})
