/**
 * Read models returned by the command layer to both the desktop renderer and MCP clients.
 * Plain JSON-serializable data only.
 */
import type {
  CapabilityProfile,
  Criterion,
  EpicBranch,
  EpicProvenance,
  PlanBundle,
  ReasoningEffort,
  TicketContent,
  TicketKind,
  TicketSize,
  ToolCapability
} from './bundle'
import type { SprintRetro, TicketTierFacts } from './retro'
import type {
  AttemptKind,
  AttemptState,
  RunState,
  TicketExecutionState,
  WorkStatus
} from './status'

export type SessionRole = 'desktop' | 'planner' | 'orchestrator' | 'worker' | 'reviewer'

export interface CapabilitiesView {
  server: { name: string; version: string }
  apiVersion: number
  schemaVersion: number
  skillsVersion: string
  role: SessionRole
  sessionId: string | null
  capabilities: string[]
  repoRoot: string
  initialized: boolean
}

/**
 * One check of a project's Definition of Done: `name` is what a sprint acceptance node's evidence must be
 * named to report it (matched ignoring case and surrounding spaces), `command` is what the worker runs, and
 * `description` says what passing it shows.
 */
export interface DefinitionOfDoneCheck {
  name: string
  command: string
  description: string
}

export interface ProjectView {
  projectId: string
  name: string
  keyPrefix: string
  repoRoot: string
  createdAt: string
  /** The project's Definition of Done, in order; empty when the project has none. */
  definitionOfDone: DefinitionOfDoneCheck[]
}

export interface RunSummaryView {
  id: string
  state: RunState
  revisionNumber: number
  activeSprintOrdinal: number | null
  sprintCount: number
  pauseReason: string | null
}

export interface EpicSummaryView {
  id: string
  title: string
  status: WorkStatus
  /** Optimistic-concurrency revision for epic-level mutations (status, branch). */
  revision: number
  currentRevisionId: string | null
  currentRevisionNumber: number | null
  hasDraft: boolean
  draftRevision: number | null
  /**
   * True when the draft's content differs from the current saved plan; always true for the draft of
   * a never-saved epic. A draft just opened from the saved plan (Edit draft) is not a change yet.
   */
  draftChanged: boolean
  ticketCount: number
  sprintCount: number
  run: RunSummaryView | null
  branch: EpicBranch | null
  pendingSave: boolean
  conflict: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface EpicOutcome {
  summary: string
  successCriteria: CriterionResult[]
  recordedAt: string
  runId: string | null
}

export interface EpicDetailView extends EpicSummaryView {
  intent: string
  successCriteria: Criterion[]
  ownerRole: string | null
  provenance: EpicProvenance | null
  outcome: EpicOutcome | null
}

export interface ValidationIssue {
  code: string
  message: string
  ticketIds?: string[]
  sprintIds?: string[]
  edge?: { from: string; to: string }
}

export interface ValidationReport {
  valid: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

export type ChangeKind = 'added' | 'removed' | 'edited'

export interface PlanChange {
  kind: ChangeKind
  target: 'epic' | 'ticket' | 'sprint' | 'edge' | 'relation' | 'policies' | 'rationale'
  id: string
  label: string
  detail: string
}

export interface PlanView {
  epicId: string
  view: 'saved' | 'draft'
  revisionId: string | null
  revisionNumber: number | null
  baseRevisionId: string | null
  baseRevisionNumber: number | null
  draftRevision: number | null
  contentHash: string
  bundle: PlanBundle
  readOnly: boolean
  readOnlyReason: string | null
  /** Draft views: differences from the base saved revision. */
  changes: PlanChange[]
  /** Draft views: true when the draft's base is no longer the epic's current saved revision. */
  stale: boolean
}

export interface RevisionSummaryView {
  id: string
  number: number
  state: 'pending' | 'saved' | 'failed'
  contentHash: string
  baseRevisionId: string | null
  createdAt: string
  savedAt: string | null
  ticketCount: number
  isCurrent: boolean
}

export interface TicketLinkView {
  ticketId: string
  key: string
  title: string
  status: WorkStatus | null
  executionState: TicketExecutionState | null
}

export interface TicketSummaryView {
  id: string
  key: string
  title: string
  status: WorkStatus | null
  sprintId: string | null
  sprintOrdinal: number | null
  priority: TicketContent['priority']
  /** Present only on an acceptance node; a work ticket has no kind. */
  kind?: TicketKind
  /** Present only once a planner has sized the ticket. */
  size?: TicketSize
  /** The ticket's `capability.reasoning.effort`; present only when one is set. */
  effort?: ReasoningEffort
  tags: string[]
  optional: boolean
}

export interface TicketDetailView {
  epicId: string
  view: 'saved' | 'draft'
  ticket: TicketContent
  status: WorkStatus | null
  sprintId: string | null
  sprintOrdinal: number | null
  prerequisites: TicketLinkView[]
  dependents: TicketLinkView[]
  relations: { kind: string; ticket: TicketLinkView }[]
  execution: TicketExecutionView | null
  attempts: AttemptView[]
  readOnly: boolean
  readOnlyReason: string | null
}

export type Blocker =
  | { kind: 'prerequisite'; ticketId: string; key: string; state: TicketExecutionState }
  | { kind: 'concurrency'; limit: number }
  | { kind: 'retry_limit'; attempts: number; limit: number }
  | { kind: 'lease_expired'; attemptId: string }
  | { kind: 'run_state'; state: RunState }
  /** A prerequisite sits in a row of `sprintId` whose latest row check (`checkId`) did not pass. */
  | { kind: 'row_check_failed'; sprintId: string; row: number; checkId: string }

export interface PrerequisiteOutcome {
  ticketId: string
  key: string
  state: TicketExecutionState
  acceptedAttemptId: string | null
}

/**
 * The orchestrator's check that one dependency row combined cleanly. A row is the set of a sprint's
 * tickets at the same same-sprint dependency depth, counted from 1.
 */
export interface RowCheckView {
  id: string
  runId: string
  sprintId: string
  row: number
  /** Counts the checks of the run in the order they were recorded; the highest number of a row is its latest. */
  number: number
  /** The commit the row's combined work was checked at. */
  commit: string
  checks: CheckResult[]
  /** True only when every entry of `checks` passed (a skipped or failed entry means the check did not pass). */
  passed: boolean
  recordedBy: string | null
  createdAt: string
}

/** One dependency row of a sprint: its tickets and its latest check (null until one is recorded). */
export interface RowView {
  sprintId: string
  row: number
  tickets: { ticketId: string; key: string }[]
  latestCheck: RowCheckView | null
}

export interface TicketExecutionView {
  ticketId: string
  key: string
  sprintId: string
  /** The ticket's row within its sprint, counted from 1; null for a sprint's acceptance node, which is in no row. */
  row: number | null
  state: TicketExecutionState
  attemptCount: number
  latestAttemptId: string | null
  blockers: Blocker[]
  prerequisites: PrerequisiteOutcome[]
}

export interface WorkerInfo {
  sessionId: string | null
  label: string
  modelId: string | null
  hostId: string | null
  catalogRevision: string | null
  rationale: string | null
  /**
   * The reasoning effort the worker was dispatched at. Null when the claim named none; views always
   * carry it, but a record stored before efforts existed has no such key.
   */
  effort?: ReasoningEffort | null
}

interface ArtifactRef {
  label: string
  location: string
  hash: string | null
  remoteOnly: boolean
}

export interface AttemptOutputs {
  summary: string
  artifacts: ArtifactRef[]
  commits: string[]
  changedFiles: string[]
  branch: string | null
}

export type CheckStatus = 'passed' | 'failed' | 'skipped'

export interface CheckResult {
  name: string
  status: CheckStatus
  detail: string
}

export interface CriterionResult {
  criterionId: string
  met: boolean
  note: string
}

export interface AttemptEvidence {
  checks: CheckResult[]
  criteria: CriterionResult[]
  notes: string
}

export interface AttemptFailure {
  reason: string
  details: string
  retryable: boolean
}

export interface AttemptDecision {
  outcome: 'accepted' | 'rejected'
  notes: string
  reasons: string[]
  decidedBy: string
}

/** What a sprint increment was measured against: the previous sprint's verified increment, or the epic's start commit. */
type IncrementBaseKind = 'previous_increment' | 'epic_start' | 'none'

/**
 * The server's verdict on the increment a sprint's acceptance node named: whether it is one squashed
 * commit on the epic branch. Written when the node's submission arrives; the `increment_merged` gate
 * reads it, and it is never edited afterwards.
 */
export interface SprintIncrement {
  /** The branch the submission named; it must be the epic's integration branch. */
  branch: string
  /** The full commit id when git resolved it, otherwise exactly as named. */
  commit: string
  /** The commit's only parent; null when the commit is unknown or does not have exactly one parent. */
  parent: string | null
  /** What `commit` had to come after. `none`: the epic has no start commit and no earlier sprint has an increment. */
  base: { kind: IncrementBaseKind; commit: string | null }
  passed: boolean
  /** Why it did not pass (one entry per failed check); empty when it passed. */
  reasons: string[]
  /** Every check made, in order; a skipped check could not be made and did not count against the increment. */
  checks: CheckResult[]
  verifiedAt: string
}

/** A sprint's increment with the acceptance-node attempt that named it. */
export interface SprintIncrementView {
  sprintId: string
  sprintOrdinal: number
  /** The sprint's acceptance node. */
  ticketId: string
  key: string
  attemptId: string
  attemptState: AttemptState
  increment: SprintIncrement
}

export interface AttemptView {
  id: string
  runId: string
  ticketId: string
  number: number
  kind: AttemptKind
  state: AttemptState
  fencingToken: number
  worker: WorkerInfo
  revisionId: string
  ticketContentHash: string
  leaseExpiresAt: string | null
  heartbeatAt: string | null
  outputs: AttemptOutputs | null
  evidence: AttemptEvidence | null
  failure: AttemptFailure | null
  decision: AttemptDecision | null
  /** Present only on a submission that named a sprint increment (an acceptance node), with the server's verdict. */
  increment?: SprintIncrement
  createdAt: string
  updatedAt: string
  submittedAt: string | null
  decidedAt: string | null
  reconciledAt: string | null
  superseded: boolean
}

export interface HostModel {
  id: string
  label: string
  reasoningLevels: string[]
  /** Efforts the host can run this model at. Absent or empty: the model declares none, so any effort is accepted. */
  efforts?: ReasoningEffort[]
  modalities: string[]
  contextWindowTokens: number | null
  skills: string[]
  costTier: 'low' | 'normal' | 'high' | null
  latencyTier: 'low' | 'normal' | 'high' | null
}

export interface HostCatalog {
  hostId: string
  hostType: string
  catalogRevision: string
  tools: ToolCapability[]
  canSelectWorkerModel: boolean
  models: HostModel[]
}

export interface HostCatalogView extends HostCatalog {
  id: string
  registeredAt: string
  registeredBy: string | null
}

/** The model and effort to dispatch a ticket's worker at, with the reasons behind the pick. */
export interface CapabilityRecommendation {
  modelId: string
  effort: ReasoningEffort
  reasons: string[]
}

export interface CapabilityMatchView {
  ticketId: string
  catalogId: string
  /** Best fit first: right-sized models lead, over-capable ones trail. */
  eligible: { modelId: string; score: number; reasons: string[] }[]
  rejected: { modelId: string; failures: string[] }[]
  hostFailures: string[]
  unknownRequirements: string[]
  /** The top fit at the ticket's effort, or one tier up after a rejected or failed attempt. Null when no model is eligible. */
  recommended: CapabilityRecommendation | null
}

export interface FollowUpProposal {
  title: string
  body: string
}

export interface SprintReportContent {
  summary: string
  accepted: string[]
  failed: string[]
  blocked: string[]
  changes: { files: string[]; commits: string[] }
  checks: CheckResult[]
  risks: string[]
  followUps: FollowUpProposal[]
  exitCriteria: CriterionResult[]
  epicOutcome: { summary: string; successCriteria: CriterionResult[] } | null
  /** The sprint review and retrospective; null for a report written without one, and for every report saved before retros existed. */
  retro: SprintRetro | null
}

export interface SprintReportView {
  id: string
  runId: string
  sprintId: string
  reportRevision: number
  contentHash: string
  report: SprintReportContent
  /**
   * The sprint's increment as verified when its acceptance node was submitted; read when the report is
   * read, so it is not part of `report` and does not change `contentHash`. Absent when the sprint's
   * acceptance node named no increment.
   */
  increment?: SprintIncrementView
  /**
   * What each ticket of the sprint was planned at and what it took, computed from the run's attempts when
   * the report is read (not written by the reporter, not part of `report` or `contentHash`).
   */
  tierFacts: TicketTierFacts[]
  submittedBy: string | null
  createdAt: string
}

export type GateConditionId =
  | 'report_submitted'
  | 'no_active_leases'
  | 'required_accepted'
  | 'acceptance_accepted'
  | 'increment_merged'
  | 'definition_of_done'
  | 'retro'
  | 'exit_criteria'
  | 'epic_outcome'
  | 'plan_current'
  | 'approval'

export interface GateCondition {
  id: GateConditionId
  label: string
  met: boolean
  detail: string
}

export interface CheckpointView {
  runId: string
  sprintId: string
  sprintOrdinal: number
  sprintCount: number
  isFinalSprint: boolean
  policy: 'human' | 'auto'
  autoContinueAuthorized: boolean
  report: SprintReportView | null
  conditions: GateCondition[]
  /** All non-approval gates are met. */
  gatesMet: boolean
  /** Gates met and the policy's authorization is present (grant or auto-continue). */
  canAdvance: boolean
  approval: { id: string; issuedAt: string; valid: boolean } | null
}

export interface RunCounts {
  accepted: number
  submitted: number
  running: number
  ready: number
  waiting: number
  blocked: number
  failed: number
  needsReconciliation: number
}

export interface RunView {
  id: string
  /** Display-only run number per epic (`runs.number`), e.g. "Run #2". */
  number: number
  epicId: string
  revisionId: string
  revisionNumber: number
  state: RunState
  activeSprintId: string | null
  activeSprintOrdinal: number | null
  sprintCount: number
  host: { label: string; type: string; catalogId: string | null } | null
  skillVersion: string | null
  ownerMachineId: string
  ownedByThisMachine: boolean
  pauseReason: string | null
  autoContinue: boolean
  createdAt: string
  startedAt: string | null
  updatedAt: string
  endedAt: string | null
  counts: RunCounts
  tickets: TicketExecutionView[]
  /** Every row of every sprint, each with its tickets and latest row check. */
  rows: RowView[]
  /** The increment each sprint with an acceptance node named, in sprint order; sprints that named none are left out. */
  increments: SprintIncrementView[]
  attempts: AttemptView[]
  checkpoint: CheckpointView | null
}

export interface ReadinessView {
  runId: string
  sprintId: string | null
  ready: TicketExecutionView[]
  blocked: TicketExecutionView[]
  inFlight: TicketExecutionView[]
  /** The rows of the active sprint, each with its tickets and latest row check. */
  rows: RowView[]
  capacity: { limit: number | null; inUse: number }
}

/** Why a claim went to the orchestrator: the model it named cannot take the ticket on the run's catalog. */
export interface AssignmentFallback {
  requestedModelId: string
  reasons: string[]
}

export interface ExecutionPacket {
  runId: string
  attemptId: string
  claimToken: string
  fencingToken: number
  leaseExpiresAt: string
  heartbeatIntervalSeconds: number
  epic: { id: string; title: string; branch: EpicBranch | null }
  revisionId: string
  sprint: { id: string; ordinal: number; goal: string }
  ticket: TicketContent
  ticketContentHash: string
  /** The reasoning effort this claim was dispatched at, or null when the claim named none. */
  effort: ReasoningEffort | null
  /** Present when the named model could not take the ticket and the orchestrator collected it instead. */
  fallback?: AssignmentFallback
  /**
   * The project's Definition of Done, only on a sprint acceptance node and only when the project has one:
   * the checks its worker must run and report, each by name, as `passed` in the evidence.
   */
  definitionOfDone?: DefinitionOfDoneCheck[]
  predecessors: {
    ticketId: string
    key: string
    title: string
    outputs: AttemptOutputs | null
  }[]
  reporting: {
    heartbeatTool: string
    submitTool: string
    failTool: string
    instructions: string
  }
}

export interface ClaimResultView {
  attempt: AttemptView
  packet: ExecutionPacket
}

export interface ApprovalView {
  id: string
  runId: string
  sprintId: string
  reportId: string
  issuedAt: string
}

/**
 * The steps of approving the retro and the redraft together, in order. A refusal names its step in the error's
 * `details.step` (with `stepNumber`, `savedRevisionId`, `savedRevisionNumber` and `adoptionNeeded`).
 */
export type ApproveWithRedraftStep = 'save' | 'adopt' | 'recompute' | 'approve' | 'advance'

/** What approving the retro and the redraft in one step did, step by step, and the run it left. */
export interface ApproveWithRedraftResultView {
  /** `unchanged` when the draft matched the saved plan, so no new revision was written. */
  save: { status: 'saved' | 'unchanged'; revisionId: string; revisionNumber: number }
  /** Null when the run already executed the saved plan, so there was nothing to adopt. */
  adoption: { revisionId: string; kept: string[]; superseded: string[]; freshBudget: string[] } | null
  /** The grant, bound to the adopted revision and the approved report, and consumed by the advance. */
  approval: ApprovalView
  advance: { outcome: 'advanced' | 'completed'; activeSprintId: string | null }
  run: RunView
}

export interface EventView {
  seq: number
  at: string
  kind: string
  epicId: string | null
  runId: string | null
  ticketId: string | null
  sessionId: string | null
  payload: Record<string, unknown>
}

export interface EventsPage {
  events: EventView[]
  cursor: number
}

export interface StorageStatusView {
  initialized: boolean
  repoRoot: string
  projectId: string | null
  projectName: string | null
  schemaVersion: number | null
  outbox: { pending: number; failed: number; lastError: string | null }
  lastFlushAt: string | null
  /** `repository` is false outside a Git checkout (then `current` is null too, but not because HEAD is detached). */
  branch: { current: string | null; recorded: string | null; changed: boolean; repository: boolean }
  uncommittedRecordFiles: number | null
  conflicts: { epicId: string; message: string }[]
  /** Named profiles whose tracked file changed while a local save waits to be exported. */
  profileConflicts: { name: string; message: string }[]
  sessions: { active: number; byRole: Record<string, number> }
}

export interface SessionView {
  id: string
  role: SessionRole
  label: string
  transport: string
  pid: number | null
  startedAt: string
  lastSeenAt: string
  active: boolean
}

export interface SearchResultView {
  docType: 'epic' | 'ticket' | 'attempt' | 'report' | 'comment'
  docId: string
  epicId: string
  epicTitle: string
  runId: string | null
  ticketId: string | null
  title: string
  snippet: string
}

export interface BranchEpicView {
  branch: string
  epicId: string
  title: string
  status: WorkStatus
  revisionNumber: number | null
  presentLocally: boolean
}

/** An old-style `/board` folder, which is a board item's status: `backlog`, `in-progress` or `done`. */
type BoardFolderName = 'backlog' | 'in-progress' | 'done'

/** A board ticket by its board id (`014.1`), title and file. Board text is data. */
interface BoardTicketRef {
  boardId: string
  title: string
  sourcePath: string
}

/**
 * An open board epic (in backlog or in-progress) and what importing does with it. `new`: the next
 * import creates it. `created`: this import created `epicId`. `imported`: an earlier import created
 * `epicId`, so it is not created again.
 */
export interface BoardOpenEpicView {
  /** Epic number as written in its file names, such as `014`. */
  boardId: string
  /** `standalone`: a ticket without an epic. `orphan`: sub-tickets whose epic file is missing. */
  kind: 'epic' | 'standalone' | 'orphan'
  title: string
  folder: BoardFolderName
  /** The epic's own file; null for orphan sub-tickets. */
  sourcePath: string | null
  /** Every board file the epic was read from, its own file first. */
  sourcePaths: string[]
  /** Open tickets, which the imported draft plan gets. */
  ticketCount: number
  /** Sub-tickets already in `board/done`: listed in the epic intent instead of imported. */
  doneTickets: BoardTicketRef[]
  state: 'new' | 'created' | 'imported'
  /** Null only for `new`. */
  epicId: string | null
}

/** A board epic in `board/done`: it stays in Git history and is never imported. */
interface BoardDoneEpicView {
  boardId: string
  title: string
  sourcePath: string | null
  sourcePaths: string[]
  ticketCount: number
}

/** What importing an old-style `/board` does (a preview) or did (an import). */
export interface BoardImportView {
  /** In board epic number order. */
  open: BoardOpenEpicView[]
  done: BoardDoneEpicView[]
  /** Board files that were not read as part of the board, in path order. */
  skipped: { path: string; reason: string }[]
}

/** A path the board removal leaves where it is, and why. Repository-relative, with forward slashes. */
export interface BoardKeptPathView {
  path: string
  reason: string
}

/** A file that still mentions the board. It is never deleted; the person edits it by hand. */
export interface BoardMentionView {
  path: string
  /** 1-based numbers of the lines that mention the board. */
  lines: number[]
}

/**
 * What removing the old board workflow (`board/` and the board-only skill folders) would delete,
 * before anything is deleted. Every list is in path order.
 */
export interface BoardRemovalView {
  /** Every file the removal deletes, repository-relative with forward slashes. */
  remove: string[]
  kept: BoardKeptPathView[]
  editByHand: BoardMentionView[]
}

/** What the confirmed board removal did. Nothing is committed. */
export interface BoardRemovalResultView {
  removed: string[]
  /** Folders removed because the deletion left them empty, deepest first. */
  removedFolders: string[]
  kept: BoardKeptPathView[]
  editByHand: BoardMentionView[]
}

export interface InitializeResultView {
  projectId: string
  name: string
  keyPrefix: string
  createdFiles: string[]
  alreadyInitialized: boolean
}

export interface FlushResultView {
  flushed: number
  failed: number
  errors: string[]
}

export interface ReconcileResultView {
  /** Epic and run ids, and `profile:<name>` for named profiles. */
  imported: string[]
  unchanged: string[]
  conflicts: { epicId: string; message: string }[]
  /** Named profiles kept local because their tracked file changed while a local save waits to be exported. */
  profileConflicts: { name: string; message: string }[]
  rejected: { path: string; message: string }[]
  branchChanged: boolean
  pausedRuns: string[]
}

export interface SaveResultView {
  status: 'saved' | 'pending' | 'unchanged'
  epicId: string
  revisionId: string
  revisionNumber: number
  contentHash: string
  error: string | null
}

export interface DeleteEpicResultView {
  epicId: string
  title: string
  removedRuns: number
  /** Repository-relative folders that were deleted from the checkout (left for the person to commit). */
  removedPaths: string[]
}

export interface DraftUpdateResultView {
  epicId: string
  draftRevision: number
  refMap: Record<string, string>
  validation: ValidationReport
}

/** A retro leftover the redraft moved to the next sprint. The reason is the retro's. */
export interface RedraftMovedView {
  ticketId: string
  key: string
  title: string
  reason: string
}

/** A ticket that moved along with a leftover because it requires it. `requires` is the display key of the moved ticket it needs. */
export interface RedraftDependentView {
  ticketId: string
  key: string
  title: string
  requires: string
}

/** A retro discovery the redraft added to the next sprint, unsized. `source` is the display key of the ticket it came up on, or null. */
export interface RedraftAddedView {
  ticketId: string
  key: string
  title: string
  source: string | null
}

/** Why a retro entry was left alone: see `RedraftSkippedView`. */
export type RedraftSkipCode =
  | 'acceptance_node'
  | 'not_in_active_sprint'
  | 'already_in_next_sprint'
  | 'not_in_draft'
  | 'already_accepted'
  | 'already_drafted'
  | 'blank_title'

/**
 * A retro entry the redraft left alone, and why. `label` is the ticket's display key (its id when no plan knows
 * a key) for a leftover, and the title for a discovery.
 */
export interface RedraftSkippedView {
  kind: 'leftover' | 'discovery'
  ticketId: string | null
  label: string
  code: RedraftSkipCode
  message: string
}

/** What a redraft did to the draft, or would have done: the same shape for a first pass and a repeat. */
export interface RedraftChangesView {
  /** The retro's sprint, which the leftovers leave: the run's active sprint, with its ordinal in the draft. */
  sprintId: string
  sprintOrdinal: number
  /** The sprint after it in the draft, which now holds what moved and what was added; null when there is none and nothing needed one. */
  nextSprintId: string | null
  nextSprintOrdinal: number | null
  /** True when the redraft added that sprint, because the active sprint was the last one. */
  sprintAdded: boolean
  /** Leftovers moved, in the retro's order. */
  moved: RedraftMovedView[]
  /** Tickets that moved along with a leftover, in the order of the sprint they left. */
  dependentsMoved: RedraftDependentView[]
  /** Discoveries added as tickets, in the retro's order. */
  added: RedraftAddedView[]
  skipped: RedraftSkippedView[]
  /** Dependencies the move removed, in the shape of plan edges (`to` requires `from`): a moved ticket the active sprint's acceptance node required explicitly. */
  droppedDependencies: { from: string; to: string }[]
}

export interface RedraftResultView extends RedraftChangesView {
  epicId: string
  runId: string
  /** The report whose retro drove the redraft: the latest revision for the active sprint. */
  reportId: string
  reportRevision: number
  /** False when the draft was left as it was: a repeat, or a retro with nothing to move or add. */
  changed: boolean
  draftRevision: number
  validation: ValidationReport
}

/** An append-only Markdown note on an epic (`ticketId` null) or one of its tickets. */
export interface CommentView {
  id: string
  epicId: string
  ticketId: string | null
  /** Untrusted Markdown: render it through the safe renderer only. */
  body: string
  /** The session that wrote it (role and label), never caller-supplied. */
  author: { role: SessionRole; label: string }
  createdAt: string
}

/**
 * A named, reusable capability profile (`.darkmechanicus/profiles/<name>.json`): provider-neutral
 * requirements a ticket can start from. Applying one copies it into the ticket.
 */
export interface ProfileView {
  name: string
  description: string
  capability: CapabilityProfile
  /** Optimistic-concurrency revision for saveProfile; kept by this repository's local database. */
  revision: number
  updatedAt: string
}
