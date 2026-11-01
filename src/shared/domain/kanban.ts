import type { TicketCriterion, TicketPriority, TicketReference, TicketSize } from './bundle'
import type { AttemptEvidence, AttemptOutputs, DefinitionOfDoneCheck, SessionRole } from './views'

/** The board's lanes, left to right. A card moves between them only through its transitions, never by hand. */
export const KANBAN_LANES = ['backlog', 'in_progress', 'ready_for_review', 'done'] as const
export type KanbanLane = (typeof KANBAN_LANES)[number]

export const KANBAN_LANE_LABELS: Record<KanbanLane, string> = {
  backlog: 'Backlog',
  in_progress: 'In progress',
  ready_for_review: 'Ready for review',
  done: 'Done'
}

/** A card attempt's states. Unlike plan attempts there is no `canceled`: a card is never deleted mid-attempt. */
export const KANBAN_ATTEMPT_STATES = [
  'claimed',
  'running',
  'submitted',
  'accepted',
  'rejected',
  'failed',
  'lease_expired'
] as const
export type KanbanAttemptState = (typeof KANBAN_ATTEMPT_STATES)[number]

/** Attempts in these states occupy the card: at most one of them exists per card. */
export const KANBAN_OPEN_ATTEMPT_STATES: readonly KanbanAttemptState[] = ['claimed', 'running', 'submitted']

/** The fields an edit may change, in the order the `updated` event lists them. */
export const KANBAN_EDITABLE_FIELDS = ['title', 'body', 'acceptanceCriteria', 'expectedArtifacts', 'references', 'priority', 'size'] as const

/** The compact record an approved card keeps in Done. */
export interface KanbanDoneSummary {
  /** At most 280 characters. */
  outcome: string
  commits: string[]
  completedAt: string
  approvedBy: string
}

/** A card as the board shows it. Never carries the body, criteria, evidence or any claim secret. */
export interface KanbanCardSummaryView {
  id: string
  /** Display key from the project's ticket sequence, such as `DM-42`. */
  key: string
  title: string
  lane: KanbanLane
  priority: TicketPriority
  updatedAt: string
  /** A person pressed Play (or kicked the card back) and no claim has consumed it yet. */
  playPending: boolean
  openAttempt: { number: number; state: KanbanAttemptState } | null
  kickBackCount: number
  /** Present once the card is approved to Done. */
  summary: KanbanDoneSummary | null
}

/** One folder's board: the cards of each lane, with Done paged newest first. */
export interface KanbanBoardView {
  lanes: Record<KanbanLane, KanbanCardSummaryView[]>
  /** Every Done card, including those beyond this page. */
  doneTotal: number
  /** Pass as `doneCursor` for the next page of Done; null when there is none. */
  doneNextCursor: string | null
}

/** One attempt at a card. The claim secret never appears here. */
export interface KanbanAttemptView {
  id: string
  cardId: string
  number: number
  state: KanbanAttemptState
  machineId: string | null
  leaseExpiresAt: string | null
  heartbeatAt: string | null
  progressNote: string | null
  outputs: AttemptOutputs | null
  evidence: AttemptEvidence | null
  /** The person's kick-back comment, when this attempt was kicked back. */
  reviewComment: string | null
  createdAt: string
  submittedAt: string | null
  decidedAt: string | null
}

/** A card with its full content and every attempt, oldest first. */
export interface KanbanCardView extends KanbanCardSummaryView {
  body: string
  acceptanceCriteria: TicketCriterion[]
  expectedArtifacts: string[]
  references: TicketReference[]
  size: TicketSize | null
  createdBy: { role: SessionRole; label: string }
  createdAt: string
  completedAt: string | null
  /** Increases with every change to the card; pass it as `expectedRevision` to edit the card. */
  revision: number
  attempts: KanbanAttemptView[]
}

/** What a claim hands the agent that carries a card. */
export interface KanbanPacket {
  cardId: string
  key: string
  attemptId: string
  /** `<attemptId>.<secret>`, returned once: null on an idempotent replay, since no copy is kept. */
  claimToken: string | null
  leaseExpiresAt: string
  heartbeatIntervalSeconds: number
  card: {
    title: string
    body: string
    acceptanceCriteria: TicketCriterion[]
    expectedArtifacts: string[]
    references: TicketReference[]
    priority: TicketPriority
    size: TicketSize | null
  }
  /** The checkout's current branch; cards work on it directly. Null when it cannot be read. */
  branch: string | null
  /** Every earlier kick-back comment, oldest first. */
  reviewComments: string[]
  reporting: {
    heartbeatTool: string
    submitTool: string
    failTool: string
    instructions: string
  }
  /** The project's Definition of Done, each check to be reported by name; empty when the project has none. */
  definitionOfDone: DefinitionOfDoneCheck[]
}
