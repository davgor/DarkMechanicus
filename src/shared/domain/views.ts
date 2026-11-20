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
import type { AgentMailboxStatus } from './agentMail'
import type { CorrectiveCause } from './efficiency'
import type { ExperimentOutcome } from './experiments'
import type { SprintRetro, TicketTierFacts } from './retro'
import type { EvidenceRef, GradeLetter, GradeOutcome, GradeStatus, GradeStatusReason, SpaceComponent } from './space'
import type { ScorecardSummary } from './spaceGrades'
import type { EpicTransferOutcome } from './transfer'
import type {
  AttemptKind,
  AttemptState,
  RunState,
  TicketExecutionState,
  WorkStatus
} from './status'

/**
 * `reader` observes and nothing else. It is what a `dm` CLI invocation runs as until a person
 * grants it a role, so reading the plan needs no ceremony while changing anything needs a grant.
 */
export type SessionRole = 'desktop' | 'planner' | 'orchestrator' | 'worker' | 'reviewer' | 'reader'

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
  /**
   * Whether this session has a usable agent mailbox right now. A role holding `mail.use` is not enough: the mailbox
   * belongs to a desktop-bound `dm` CLI grant, so an MCP (stdio) session always reads `{ bound: false }`.
   */
  mailbox: AgentMailboxStatus
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

/** One child repository of a folder of repositories; `missing` when its folder was not found at the last scan. */
export interface RepositoryView {
  name: string
  missing: boolean
  /** This repository's own Definition of Done, in order; absent when it has none. */
  definitionOfDone?: DefinitionOfDoneCheck[]
}

export interface ProjectView {
  projectId: string
  name: string
  keyPrefix: string
  repoRoot: string
  createdAt: string
  /** The project's Definition of Done, in order; empty when the project has none. */
  definitionOfDone: DefinitionOfDoneCheck[]
  /** The child repositories of a folder of repositories, in recorded order; null for a single repository. */
  repositories: RepositoryView[] | null
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
  /**
   * A folder of repositories only: the epic branch as bound in each repository its runs' saved plans named, each
   * with its own start commit. Absent for a single-repository epic and before any repository was bound.
   */
  repositoryBranches?: EpicBranch[]
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
  /** Present when a verified Linear transfer completed the epic (then `runId` is null). */
  transfer?: EpicTransferOutcome
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
  /** The orchestrator's own retries of this ticket (`retry_ticket`) in this epic's runs on this machine, oldest first. */
  autoRetries: AutoRetryView[]
  readOnly: boolean
  readOnlyReason: string | null
}

/**
 * One extra attempt the orchestrator gave a ticket at its retry limit (`retry_ticket`): why the ticket failed and
 * what it does differently this time. `acknowledgedAt` records that the person read it; it never gates anything.
 */
export interface AutoRetryView {
  runId: string
  runNumber: number
  ticketId: string
  /** 1 for the run's first orchestrator retry of this ticket, 2 for the second, and so on. */
  number: number
  failureReason: string
  newApproach: string
  at: string
  acknowledgedAt: string | null
}

/** What `retry_ticket` did: the retry's number, how many more the plan allows, and the run as it now stands. */
export interface RetryTicketResult {
  autoRetry: number
  autoRetriesLeft: number
  run: RunView
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
  /** The images the submission claimed as evidence. Absent on records written before attachments existed. */
  attachments?: AttachmentRef[]
}

/** Evidence as a submission names it: its images by their staged ids; the server stores their references. */
export type AttemptEvidenceSubmission = Omit<Partial<AttemptEvidence>, 'attachments'> & { attachments?: string[] }

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
  /**
   * The reviewer's own per-criterion results, as passed when accepting (also merged into the evidence). Every
   * acceptance recorded since reviewers' results are kept writes it (empty when none were passed); it is absent on
   * rejections and on acceptances recorded before, whose criteria cannot be told apart from the worker's.
   */
  criteria?: CriterionResult[]
  /**
   * A sprint acceptance node's acceptance only: the Definition of Done check names it was accepted against, frozen
   * at the decision, so a later change to the Definition of Done never rewrites how it was verified.
   */
  requiredChecks?: string[]
}

/** What a sprint increment was measured against: the previous sprint's verified increment, or the epic's start commit. */
type IncrementBaseKind = 'previous_increment' | 'epic_start' | 'none'

/**
 * The server's verdict on the increment a sprint's acceptance node named: whether it is one squashed
 * commit on the epic branch. Written when the node's submission arrives; the `increment_merged` gate
 * reads it, and it is never edited afterwards. In a folder of repositories the node stores one per touched
 * repository (an array in `attempts.increment_json`), each with its `repo`.
 */
export interface SprintIncrement {
  /** In a folder of repositories only: the child repository the increment was verified in. */
  repo?: string
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

/** A sprint's increment with the acceptance-node attempt that named it; in a folder of repositories, one per repository. */
export interface SprintIncrementView {
  sprintId: string
  sprintOrdinal: number
  /** In a folder of repositories only: the child repository this increment was verified in. */
  repo?: string
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
  /**
   * Present only on an acceptance node's submission in a folder of repositories: the verdict of each touched
   * repository's increment, in name order. The node's increment passed only when every one passed.
   */
  increments?: SprintIncrement[]
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
   * acceptance node named no increment, and always absent in a folder of repositories (see `increments`).
   */
  increment?: SprintIncrementView
  /**
   * In a folder of repositories only (never set for a single repository): the sprint's increments, one per
   * repository its acceptance node verified, in repository name order. Read like `increment`, outside `report`
   * and the content hash; absent when the node named none.
   */
  increments?: SprintIncrementView[]
  /**
   * What each ticket of the sprint was planned at and what it took, computed from the run's attempts when
   * the report is read (not written by the reporter, not part of `report` or `contentHash`).
   */
  tierFacts: TicketTierFacts[]
  /**
   * The scorecard frozen with this revision when it was submitted, at a glance (the whole snapshot is read with
   * `getReportScorecard`). Stored, never recomputed, so unlike `tierFacts` it never changes after submission. Absent
   * for a report submitted before scorecards were frozen: it stays ungraded.
   */
  scorecard?: ScorecardSummary
  /**
   * The outcome of each experiment of the retro, in the retro's order: its corrective work and its measured results
   * set against the frozen baseline, target and guardrails (`getExperiment`'s `outcome`). Added only by
   * `getSprintReport` (the checkpoint's and the run's reads leave it out), from later events and the stored frozen
   * scorecards; never part of `report` or `contentHash`; absent without experiments.
   */
  experimentOutcomes?: ExperimentOutcome[]
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
  /**
   * The run's state. A run that ended (`canceled`, `failed`, `completed`) has nothing to approve: its `approval`
   * condition is unmet and says so, and `canAdvance` is false.
   */
  runState: RunState
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
  /** Server-computed facts for the active sprint, including all attempts; empty without an active sprint. */
  activeSprintTierFacts: TicketTierFacts[]
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

/** A repository of a folder of repositories as an execution packet names it: where it is and its bound epic branch. */
export interface PacketRepository {
  name: string
  /** The absolute path `<project root>/<name>`. */
  path: string
  branch: EpicBranch
  /**
   * On an acceptance node's `repositories` only: this repository's Definition of Done, each check reported as
   * `<name>: <check name>`. Absent when the repository has none, and on a work ticket's `repository`.
   */
  definitionOfDone?: DefinitionOfDoneCheck[]
}

export interface ExecutionPacket {
  runId: string
  attemptId: string
  /**
   * The claim token, `<attemptId>.<secret>`, returned once: null when the claim is an idempotent replay,
   * because no copy of it is kept to return again. A lost token is gone; the attempt is failed or reconciled.
   */
  claimToken: string | null
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
  /** In a folder of repositories, on a work ticket only: the repository it targets. Absent for a single repository. */
  repository?: PacketRepository
  /**
   * In a folder of repositories, on a sprint acceptance node only: the sprint's touched repositories (those its
   * accepted work tickets target), in name order. Absent for a single repository.
   */
  repositories?: PacketRepository[]
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
  /** The project's storage mode and where its database lives. */
  storage: StorageLocationView & { databasePath: string }
  projectId: string | null
  projectName: string | null
  schemaVersion: number | null
  /** `failedEntries` lists up to 20 failed rows of every kind, and is omitted when none failed. */
  outbox: {
    pending: number
    failed: number
    lastError: string | null
    failedEntries?: { kind: string; entityId: string; attempts: number; lastError: string | null }[]
  }
  /** Images attached to a record; `bytes` includes the ones whose bytes are missing. Always returned by `get_storage_status`. */
  attachments?: { count: number; bytes: number; missing: number }
  lastFlushAt: string | null
  /** `repository` is false outside a Git checkout (then `current` is null too, but not because HEAD is detached). */
  branch: { current: string | null; recorded: string | null; changed: boolean; repository: boolean }
  /** Uncommitted record files in the checkout; null outside Git, and always null in `db` mode. */
  uncommittedRecordFiles: number | null
  /**
   * `resolvable` marks an epic whose tracked records changed while its local changes wait to be exported: neither
   * side is applied until the person picks one with `resolveEpicConflict`.
   */
  conflicts: { epicId: string; message: string; resolvable: boolean }[]
  /** Named profiles whose tracked file changed while a local save waits to be exported. */
  profileConflicts: { name: string; message: string }[]
  /**
   * Kanban cards whose tracked records disagree with this database: a card record that changed while a local edit
   * waits to be exported, or an event file that differs from the event held here (events are never rewritten).
   */
  kanbanConflicts: { cardId: string; message: string }[]
  sessions: { active: number; byRole: Record<string, number> }
}

/** Roles a person may delegate. Never `desktop`: that is the person's own seat, not a role to hand out. */
export type GrantableRole = Exclude<SessionRole, 'desktop'>

/** A role a person delegated to an agent session, as the desktop and the CLI report it. */
export interface GrantView {
  id: string
  role: GrantableRole
  /** Only a planner or orchestrator grant can carry it. */
  allowSave: boolean
  label: string
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  lastUsedAt: string | null
  /** Neither revoked nor expired, as of the moment it was read. */
  active: boolean
}

export interface SessionView {
  id: string
  role: SessionRole
  label: string
  transport: string
  pid: number | null
  /** The grant this session's role came from, for a `cli` session that presented one. */
  grantId: string | null
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

/**
 * How a project stores its records. `repo`: files in `.darkmechanicus/`, tracked by Git, so the
 * plan travels with the code. `db`: one machine-local database in the Dark Mechanicus home
 * directory, with nothing written into the repository at all.
 */
export type StorageMode = 'repo' | 'db'

/** Where a project keeps its records: in the repository, or in the Dark Mechanicus home directory. */
export interface StorageLocationView {
  mode: StorageMode
  /** Absolute directory holding the project: `<repo>/.darkmechanicus`, or the home-directory project. */
  projectDir: string
}

export interface InitializeResultView {
  projectId: string
  name: string
  keyPrefix: string
  /** Created files, shown relative to `storage.projectDir`'s parent in repo mode and to it in db mode. */
  createdFiles: string[]
  alreadyInitialized: boolean
  storage: StorageLocationView
}

export interface FlushResultView {
  flushed: number
  failed: number
  errors: string[]
}

export interface ReconcileResultView {
  /** Epic and run ids, `profile:<name>` for named profiles, and `kanban:<cardId>` for Kanban cards. */
  imported: string[]
  unchanged: string[]
  conflicts: { epicId: string; message: string }[]
  /** Named profiles kept local because their tracked file changed while a local save waits to be exported. */
  profileConflicts: { name: string; message: string }[]
  /** Kanban cards whose tracked records disagree with this database; the local card is kept. */
  kanbanConflicts: { cardId: string; message: string }[]
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

/** The side a person keeps when an epic's tracked records changed while its local changes wait to be exported. */
export type EpicConflictChoice = 'tracked' | 'local'

export interface ResolveEpicConflictView {
  epicId: string
  kept: EpicConflictChoice
  /** Saves that were still waiting to be written, dropped by keeping the tracked records (marked `failed`; the draft stays). */
  abandonedRevisionIds: string[]
  /**
   * `local` only: why this machine's records are not written yet (null once they are). The choice stands: every
   * flush retries the write over exactly the tracked records the person chose to replace.
   */
  error: string | null
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
  /** The images attached to the comment; absent when it has none. */
  attachments?: AttachmentRef[]
}

/** Why a person or agent attached an image: a screenshot as proof, or a mockup to work from. */
export type AttachmentPurpose = 'evidence' | 'reference'

export type AttachmentMime = 'image/png' | 'image/jpeg'

/** The kinds of record an attachment can belong to. */
export type AttachmentOwnerKind = 'attempt' | 'kanban_attempt' | 'kanban_message' | 'comment' | 'kanban_card' | 'ticket'

export interface AttachmentOwner {
  kind: AttachmentOwnerKind
  id: string
}

/** A record's reference to one image: its metadata, never the bytes (those are read from the store). */
export interface AttachmentRef {
  id: string
  sha256: string
  mime: AttachmentMime
  bytes: number
  width: number
  height: number
  label: string
  purpose: AttachmentPurpose
  /** Set only by read views when this database holds no bytes for the image; never stored or hashed. */
  missing?: true
}

/** One stored image. `owner` is null while the image is staged, waiting for a record to claim it. */
export interface AttachmentView extends Omit<AttachmentRef, 'missing'> {
  owner: AttachmentOwner | null
  /** True when a repository import could not find the file that holds the bytes. */
  missing: boolean
  createdBy: { role: SessionRole; label: string }
  createdAt: string
}

/** An image's metadata plus the absolute path of a temporary copy of its bytes (`getAttachment` with `as: 'file'`). */
export interface AttachmentFileView extends AttachmentView {
  path: string
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

// ---------------------------------------------------------------------------------------------------------------
// Project metrics summary

/**
 * The project metrics summary (`getMetricsSummary`): one read model for the Metrics dashboard and the MCP metrics
 * tools, built from the scorecard read models (`epicAggregate`, `sprintAggregate`, frozen report scorecards,
 * `getRunMetrics`, `projectRunTiming`). Nothing is regraded here and no letter is averaged: each grade is the core's,
 * and every total is recomputed from raw measures. A number that is not known is null with a reason, never zero.
 */
export interface GetMetricsSummaryInput {
  /** Only these epics (each must exist; one created after the cutoff is left out); every epic existing at the cutoff when absent. */
  epicIds?: string[]
  /**
   * Observation window start (ISO 8601). It filters rows and trend entries only: epics with no run active at or after
   * it, and sprints that ended before it, are left out. Grades and measures are still read over the whole history up
   * to the cutoff.
   */
  since?: string
  /** The observation cutoff (ISO 8601; default now, never later): only records stored and epics created by then are read. */
  until?: string
}

/**
 * One summed measure. `observed`/`estimated` carry a value; `missing` carries null and why (`reason`), with
 * `lowerBound` the part that was reported, if any. A missing measure is never read as zero.
 */
export interface SummaryMeasure {
  state: 'observed' | 'estimated' | 'missing'
  value: number | null
  reason: string | null
  lowerBound: number | null
}

/**
 * A row's grade status: the grade's own (`final`, `provisional`, `ungraded`), or `failed` when a confirmed mandatory
 * failure decided it, or `in_progress` while the subject's work is still running at the cutoff (its live grade can
 * still change).
 */
export type SummaryGradeStatus = 'final' | 'provisional' | 'ungraded' | 'in_progress' | 'failed'

/** A grade at a glance, exactly as the core computed (or froze) it. */
export interface SummaryGrade {
  status: SummaryGradeStatus
  /** The grade's own status, which the distribution counts. */
  gradeStatus: GradeStatus
  outcome: GradeOutcome
  statusReasons: GradeStatusReason[]
  score: number | null
  displayScore: string | null
  letter: GradeLetter | null
  /** The share of base weight that was scored, 0–1. */
  coverage: number
  /** The graded input's hash; null for an epic with no saved plan, which has no input to grade. */
  inputHash: string | null
  policy: { policyId: string; version: number; hash: string }
}

/** A field the summary could not give, and why. */
export interface UnavailableField {
  field: string
  reason: string
}

/** Token usage by category, as reported. Categories overlap (cached input inside input, reasoning inside output), so they are never summed. */
export interface SummaryTokens {
  input: SummaryMeasure
  cachedInput: SummaryMeasure
  output: SummaryMeasure
  reasoning: SummaryMeasure
  /**
   * The reported `tokens_total` of the scorecard's measured scopes (what K compares), never derived from the
   * overlapping categories.
   */
  total: SummaryMeasure
}

export interface SummaryTime {
  /** Sum of the runs' window elapsed time (runs do not overlap within an epic). */
  elapsedMs: SummaryMeasure
  /** Active time (T's actual, overhead included, waits excluded) of the scorecard's measured scopes. */
  activeMs: SummaryMeasure
  /**
   * The waits shown beside active time (never counted in it), summed per wait class over the scope's tickets, as
   * T's actual reports them: parallel tickets wait at once, so this can exceed the elapsed time.
   */
  waitingMs: SummaryMeasure
  /** Every actor's activity summed (E's denominator). */
  effortMs: SummaryMeasure
}

export interface SummaryCoverage {
  /** Executed attempts in the measured scopes. */
  attempts: number
  /** Executed attempts that reported no tokens, and no active time. */
  unreportedTokenAttempts: number
  unreportedTimeAttempts: number
  /** Classified effort over effort, 0–1; null when unknown. */
  classificationCoverage: number | null
  unavailable: UnavailableField[]
}

export interface MetricsSummaryEpicRow {
  epicId: string
  title: string
  /** The epic's status now (lifecycle status is not kept per instant). */
  status: WorkStatus
  /** Runs created by the cutoff, and those whose E, T and K the grade summed (and whose token categories are shown). */
  runIds: string[]
  measuredRunIds: string[]
  /** Sprints of the plan revision saved last by the cutoff. */
  sprintCount: number
  grade: SummaryGrade
  tokens: SummaryTokens
  time: SummaryTime
  /** Corrective ms over classified (corrective + productive) ms, 0–1, as E reads it. */
  correctiveShare: SummaryMeasure
  coverage: SummaryCoverage
}

/**
 * Project totals, each recomputed from the raw measures of the epics that executed work (never from their scores or
 * letters). An epic whose runs executed nothing, or with no run or plan, keeps its row but adds nothing here.
 */
export interface MetricsSummaryTotals {
  /** How many epics were summed, and which. */
  epics: number
  measuredEpicIds: string[]
  tokens: SummaryTokens
  time: SummaryTime
  correctiveShare: SummaryMeasure
  coverage: SummaryCoverage
}

/**
 * Why a trend entry is not compared with the one before it (`not_scored`: either grade has no score;
 * `cohort_unknown`: either sprint has no ticket or a ticket without a size, so no cohort can vouch for it;
 * `cross_epic`: the entry before is another epic's and the policy or the cohort cannot vouch for comparing them).
 */
export type TrendIncomparability =
  | 'first_entry'
  | 'policy_changed'
  | 'cohort_changed'
  | 'cohort_unknown'
  | 'cross_epic'
  | 'window_open'
  | 'window_basis_changed'
  | 'not_scored'

/** How a summary names a ticket, so a reader needs no plan read. */
export interface SummaryTicketRef {
  ticketId: string
  /** From the epic's plan saved last by the cutoff, else the newest revision a run was pinned to; null when no plan holds it. */
  key: string | null
  title: string | null
  /** Null while the plan saved last by the cutoff holds the ticket; else the number of the older revision it was named from. */
  removedAfterRevision: number | null
}

/**
 * One sprint's grade in the trend. A sprint with a submitted report reads the scorecard frozen with its latest
 * revision (`frozen_report`; never regraded); a report from before scorecards stays ungraded (`legacy_report`); a
 * sprint without a report reads its live grade at the cutoff (`live`), and only when the run executed work in it (a
 * run that only activated it adds no entry).
 */
export interface MetricsSummaryTrendEntry {
  epicId: string
  runId: string
  /** The run's number in its epic (`Run #N`). */
  runNumber: number
  sprintId: string
  ordinal: number | null
  source: 'frozen_report' | 'legacy_report' | 'live'
  report: { reportId: string; reportRevision: number } | null
  /** Null for a legacy report (nothing was frozen). */
  grade: SummaryGrade | null
  /**
   * The planned cohort keys (`workType/size/risk`) of the sprint's work tickets (overhead tickets such as acceptance
   * nodes left out, by the role the scorecards froze for them), sorted; `unsized` for a ticket without a size.
   */
  cohort: string[]
  /** How many of the sprint's tickets hold each cohort key, by key: two cohorts compare only when these are equal. */
  cohortTickets: { key: string; tickets: number }[]
  window: { from: string | null; to: string; closed: boolean; basis: 'report_cutoff' | 'live_cutoff' }
  /**
   * Compared only with the entry before it, and only when both were scored and share the policy, a known cohort
   * (every ticket sized, the same ticket count per key) and a closed window of the same basis; otherwise `comparable`
   * is false with the reasons and `scoreDelta` is null. `previous.epicId` differs from `epicId` across epics.
   */
  comparison: {
    previous: { epicId: string; runId: string; runNumber: number; sprintId: string } | null
    comparable: boolean
    reasons: TrendIncomparability[]
    scoreDelta: number | null
  }
}

/** A component scored below 100 among the lowest of the project, with what it rests on (a full score is no gap). */
export interface SummaryComponentGap {
  epicId: string
  component: SpaceComponent
  score: number
  rule: string
  evidence: EvidenceRef[]
  ticketIds: string[]
  /** The tickets of `ticketIds`, named. */
  tickets: SummaryTicketRef[]
}

/** A confirmed failure of a counted outcome. */
export interface SummaryFailureGap {
  epicId: string
  runId: string
  runNumber: number
  ticketId: string
  ticket: SummaryTicketRef
  attemptId: string | null
  reason: string
  evidence: EvidenceRef[]
}

/** Corrective (rework) effort by cause, with the observations it was classified by and the tickets it was spent on. */
export interface SummaryReworkGap {
  epicId: string
  cause: CorrectiveCause
  ms: number
  evidence: EvidenceRef[]
  ticketIds: string[]
  /** The tickets of `ticketIds`, named. */
  tickets: SummaryTicketRef[]
}

export interface MetricsSummaryView {
  policy: { policyId: string; version: number; hash: string }
  /** The observation window: `since` as asked (null when absent) and the cutoff every read used (server time). */
  window: { since: string | null; cutoff: string }
  epics: MetricsSummaryEpicRow[]
  totals: MetricsSummaryTotals
  /** Epic rows by status, and by the grade's own status (final, provisional and ungraded each counted). */
  distribution: { byStatus: Record<SummaryGradeStatus, number>; byGradeStatus: Record<GradeStatus, number> }
  /** Sprint grades ordered by end time (sprints still running last). */
  trend: MetricsSummaryTrendEntry[]
  gaps: { lowestComponents: SummaryComponentGap[]; failures: SummaryFailureGap[]; rework: SummaryReworkGap[] }
  coverage: { epics: number; gradedEpics: number; ungradedEpics: number; unavailable: (UnavailableField & { epicId: string | null })[] }
}
