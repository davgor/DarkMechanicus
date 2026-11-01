import type { CreateKanbanCardInput, ListKanbanCardsInput } from '../../../../shared/domain/api'
import type { KanbanBoardView, KanbanCardSummaryView, KanbanCardView, KanbanLane } from '../../../../shared/domain/kanban'
import type { FakeDm } from '../../__mocks__/fakeDm'

export function cardSummary(patch: Partial<KanbanCardSummaryView> = {}): KanbanCardSummaryView {
  return {
    id: 'kc_1',
    key: 'DM-1',
    title: 'A card',
    lane: 'backlog',
    priority: 'normal',
    updatedAt: '2026-03-01T10:00:00.000Z',
    playPending: false,
    openAttempt: null,
    kickBackCount: 0,
    summary: null,
    ...patch
  }
}

export function cardView(patch: Partial<KanbanCardView> = {}): KanbanCardView {
  return {
    ...cardSummary(),
    body: '',
    acceptanceCriteria: [],
    expectedArtifacts: [],
    references: [],
    size: null,
    createdBy: { role: 'desktop', label: 'Desktop' },
    createdAt: '2026-03-01T10:00:00.000Z',
    completedAt: null,
    revision: 1,
    attempts: [],
    ...patch
  }
}

/** The n-th Done card, newest first, approved on 1 March 2026. */
export function doneCard(n: number): KanbanCardSummaryView {
  return cardSummary({
    id: `kc_done_${n}`,
    key: `DM-${100 + n}`,
    title: `Done ${n}`,
    lane: 'done',
    summary: { outcome: `Outcome ${n}`, commits: [], completedAt: '2026-03-01T10:00:00.000Z', approvedBy: 'Desktop' }
  })
}

/**
 * A board held in memory behind `listKanbanCards` and `createKanbanCard`, paging Done the way the
 * service does: `doneLimit` cards from the cursor, which here is the index of the next card.
 */
export class FakeBoard {
  open: KanbanCardSummaryView[] = []
  done: KanbanCardSummaryView[] = []
  private nextKey = 500

  constructor(dm: FakeDm) {
    dm.handlers.listKanbanCards = (input) => this.list(input as ListKanbanCardsInput)
    dm.handlers.createKanbanCard = (input) => this.create(input as CreateKanbanCardInput)
  }

  list(input: ListKanbanCardsInput): KanbanBoardView {
    const start = input.doneCursor === undefined ? 0 : Number(input.doneCursor)
    const limit = input.doneLimit ?? 20
    const end = start + limit
    const inLane = (lane: KanbanLane): KanbanCardSummaryView[] => this.open.filter((card) => card.lane === lane)
    return {
      lanes: {
        backlog: inLane('backlog'),
        in_progress: inLane('in_progress'),
        ready_for_review: inLane('ready_for_review'),
        done: this.done.slice(start, end)
      },
      doneTotal: this.done.length,
      doneNextCursor: end < this.done.length ? String(end) : null
    }
  }

  private create(input: CreateKanbanCardInput): KanbanCardView {
    this.nextKey += 1
    const card = cardView({ id: `kc_new_${this.nextKey}`, key: `DM-${this.nextKey}`, title: input.title, priority: input.priority ?? 'normal' })
    this.open.push(cardSummary({ id: card.id, key: card.key, title: card.title, priority: card.priority }))
    return card
  }
}
