import type { TicketCriterion, TicketPriority, TicketReference, TicketSize } from './bundle'
import type { AttachmentRef, AttemptEvidence, AttemptOutputs, DefinitionOfDoneCheck, SessionRole } from './views'
import type { LearningDraft, LearningEvidenceSnapshot, LearningIntegrationSummaryView, LearningSourceKind } from './learnings'

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
export const KANBAN_EDITABLE_FIELDS = ['title', 'body', 'acceptanceCriteria', 'expectedArtifacts', 'references', 'priority', 'size', 'attachments'] as const

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
  deliveryRequirements?: import('./standardization').StandardizationPatch & { revision: number }
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
  /** The reference images the card carries, oldest id first; omitted when it has none. */
  attachments?: AttachmentRef[]
  attempts: KanbanAttemptView[]
  /** DM-943: present only on a generated sprint learning card; an ordinary card's view never has it. */
  learning?: KanbanLearningReviewView
}

/** One append-only conversation message on a card. */
export interface KanbanMessageView {
  id: string
  body: string
  /** The writing session, never caller-supplied. */
  authorRole: SessionRole
  authorLabel: string
  createdAt: string
  /** The images attached to the message; absent when it has none. */
  attachments?: AttachmentRef[]
}

/** What a claim hands the agent that carries a card. */
export interface KanbanPacket {
  deliveryStandards?: { revision: number; prompt?: string }
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
    /** Reference images of the card (fetch each with get_attachment); omitted when it has none. */
    attachments?: AttachmentRef[]
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
  /** DM-938: present only on a generated sprint learning card; an ordinary card's packet never has it. */
  learning?: KanbanLearningPacket
}

// ─── DM-938: sprint learning card packets and submissions ──────────────────────────────────────────────────────────

/** How a learning card classifies one snapshot item: the source of a learning, a duplicate, or nothing reusable. */
export const LEARNING_DISPOSITIONS = ['learning', 'duplicate', 'not_reusable'] as const
type LearningDisposition = (typeof LEARNING_DISPOSITIONS)[number]

/** The isolated branch a learning card codifies guardrails on in one affected repository, rooted at its increment. */
interface KanbanLearningBranch {
  /** The child repository of a folder of repositories; null in a single repository. */
  repo: string | null
  /** The completed sprint increment the branch starts from, as the link recorded it. */
  base: { branch: string; commit: string; attemptId: string }
  /** Deterministic per card and repository: `learnings/<cardKey>/<repo|root>`. */
  branch: string
  /** How to create the branch in its own worktree without touching the coordinating checkout. */
  instruction: string
}

/** A generated sprint learning card's extra packet section: the immutable link row, as stored. */
export interface KanbanLearningPacket {
  runId: string
  sprintId: string
  checkpointId: string | null
  /** `contentHash` of the stored snapshot. */
  evidenceHash: string
  /** The immutable evidence snapshot stored when the card was generated; null for a link written before snapshots. */
  snapshot: LearningEvidenceSnapshot | null
  /** One isolated branch per affected repository, in the link's repository order. */
  branches: KanbanLearningBranch[]
  /** What a submission must carry in `learning`. */
  reporting: string
}

/** One snapshot item's classification, with the reason that justifies it. */
export interface LearningItemDisposition {
  kind: LearningSourceKind
  sourceId: string
  disposition: LearningDisposition
  reason: string
}

/** What a learning card says it committed in one repository: its recorded base, its isolated branch and the tip. */
export interface LearningBranchManifest {
  repo: string | null
  base: string
  branch: string
  commit: string
}

/** A learning card submission's `learning` block. Refused on an ordinary card; required on a learning card. */
export interface KanbanLearningSubmission {
  /** Exactly one per snapshot item. */
  dispositions: LearningItemDisposition[]
  /** Proposed learnings, staged for the person's review; each cites only items disposed as `learning`. */
  drafts: LearningDraft[]
  /** Exactly one per affected repository of the packet's `learning.branches`. */
  manifests: LearningBranchManifest[]
}

/** One verified manifest as the server stored it with the submission's evidence. */
export interface VerifiedLearningManifest extends LearningBranchManifest {
  passed: boolean
  checks: { name: string; status: 'passed' | 'failed' | 'skipped'; detail: string }[]
}

/** What a learning card's submitted evidence records under `learning`. */
export interface LearningSubmissionEvidence {
  snapshotHash: string
  dispositions: LearningItemDisposition[]
  /** `StagedLearningDraftsView.draftsHash` of the drafts staged with the submission. */
  draftsHash: string
  manifests: VerifiedLearningManifest[]
}

/**
 * DM-943: what a person reviews on a sprint learning card besides its attempts: the immutable link (provenance,
 * snapshot and isolated branches), the newest integration operation and the publication, if any.
 */
export interface KanbanLearningReviewView {
  runId: string
  sprintId: string
  reportId: string
  revisionId: string | null
  checkpointId: string | null
  evidenceHash: string
  /** The immutable evidence snapshot; null for a link written before snapshots. */
  snapshot: LearningEvidenceSnapshot | null
  branches: Omit<KanbanLearningBranch, 'instruction'>[]
  /** The card's newest integration operation; null before the person approved it on this clone. */
  integration: LearningIntegrationSummaryView | null
  /** Set once the approved drafts were published as active learning records. */
  publication: { attemptId: string; draftsHash: string; recordIds: string[]; publishedAt: string } | null
}

// ─── End of DM-938 ─────────────────────────────────────────────────────────────────────────────────────────────────

/** What deleting a Kanban card removed. */
export interface DeleteKanbanCardResultView {
  cardId: string
  key: string
  title: string
  /** Repository-relative folders removed from the checkout (left for the person to commit). */
  removedPaths: string[]
}
