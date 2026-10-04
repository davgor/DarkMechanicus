/**
 * The single command/query contract. The core Workspace implements it; MCP tools and desktop IPC
 * are thin adapters over it, so both entry points enforce identical rules.
 */
import type {
  CapabilityPatch,
  CapabilityProfile,
  CheckpointMode,
  EpicBranch,
  PlanPolicies,
  ReasoningEffort,
  RelationKind,
  TicketKind,
  TicketPriority,
  TicketReference,
  TicketSize
} from './bundle'
import type { SprintRetroInput } from './retro'
import type { WorkStatus } from './status'
import type {
  ApprovalView,
  ApproveWithRedraftResultView,
  AttemptEvidence,
  AttemptFailure,
  AttemptOutputs,
  AttemptView,
  BoardImportView,
  BranchEpicView,
  CapabilitiesView,
  CapabilityMatchView,
  CheckpointView,
  ClaimResultView,
  CommentView,
  CriterionResult,
  DeleteEpicResultView,
  DraftUpdateResultView,
  EpicDetailView,
  EpicSummaryView,
  EventsPage,
  FlushResultView,
  HostCatalog,
  HostCatalogView,
  InitializeResultView,
  PlanView,
  ProfileView,
  ProjectView,
  ReadinessView,
  RedraftResultView,
  ReconcileResultView,
  RevisionSummaryView,
  RowCheckView,
  RunView,
  SaveResultView,
  SearchResultView,
  SessionView,
  SprintReportContent,
  SprintReportView,
  StorageStatusView,
  TicketDetailView,
  TicketSummaryView,
  ValidationReport
} from './views'

export const API_VERSION = 1

/** Criterion input: omit `id` to have one assigned; keep it to preserve evidence mappings. */
export interface CriterionInput {
  id?: string
  text: string
}

/**
 * A ticket criterion input. `covers` names the ticket an acceptance node's criterion verifies, by
 * stable id, display key or client ref; it is stored as the stable id. A patch that repeats a
 * criterion without `covers` keeps the one it had, and `null` clears it.
 */
export interface TicketCriterionInput extends CriterionInput {
  covers?: string | null
}

export interface TicketInput {
  title: string
  /** `work` (the default) or `acceptance`. `work` is never stored: it clears the kind. */
  kind?: TicketKind
  body?: string
  acceptanceCriteria?: (TicketCriterionInput | string)[]
  tags?: string[]
  priority?: TicketPriority
  /** `null` in a patch clears the size (the ticket then has no `size` key). */
  size?: TicketSize | null
  capability?: CapabilityPatch
  references?: TicketReference[]
  expectedArtifacts?: string[]
  optional?: boolean
}

export interface SprintInput {
  goal: string
  entryCriteria?: (CriterionInput | string)[]
  exitCriteria?: (CriterionInput | string)[]
  concurrencyCap?: number | null
  checkpoint?: { mode: CheckpointMode }
}

/** A ticket or sprint may be referenced by stable id or by a client-local ref declared in the same request. */
type EntityRef = string

export type DraftOp =
  | {
      op: 'set_epic'
      title?: string
      intent?: string
      successCriteria?: (CriterionInput | string)[]
      ownerRole?: string | null
    }
  | { op: 'add_sprint'; ref?: string; sprint: SprintInput; position?: number }
  | { op: 'update_sprint'; sprint: EntityRef; patch: Partial<SprintInput> }
  | { op: 'remove_sprint'; sprint: EntityRef }
  | { op: 'add_ticket'; ref?: string; sprint: EntityRef; ticket: TicketInput }
  | { op: 'update_ticket'; ticket: EntityRef; patch: Partial<TicketInput> }
  | { op: 'remove_ticket'; ticket: EntityRef }
  | { op: 'move_ticket'; ticket: EntityRef; toSprint: EntityRef; position?: number }
  | { op: 'add_dependency'; from: EntityRef; to: EntityRef }
  | { op: 'remove_dependency'; from: EntityRef; to: EntityRef }
  | { op: 'add_relation'; kind: RelationKind; from: EntityRef; to: EntityRef }
  | { op: 'remove_relation'; kind: RelationKind; from: EntityRef; to: EntityRef }
  | { op: 'set_policies'; patch: Partial<PlanPolicies> }
  | { op: 'set_rationale'; rationale: string }

export interface CreateEpicInput {
  title: string
  intent?: string
  successCriteria?: (CriterionInput | string)[]
  ownerRole?: string | null
  branch?: EpicBranch | null
  provenance?: { sourceEpicId: string; note?: string } | null
  idempotencyKey?: string
}

export interface ClaimTicketInput {
  runId: string
  ticketId: string
  worker: {
    label: string
    modelId?: string | null
    hostId?: string | null
    catalogRevision?: string | null
    rationale?: string | null
    /** The reasoning effort the worker is dispatched at. */
    effort?: ReasoningEffort | null
  }
  leaseSeconds?: number
  idempotencyKey?: string
}

/**
 * The increment a sprint's acceptance node names: the commit that landed the sprint on the epic branch,
 * and the branch it landed on (which must be the epic's integration branch). `commit` is a hash of 7 to 64
 * hex digits.
 */
export interface IncrementRef {
  branch: string
  commit: string
}

export interface SubmitAttemptInput {
  attemptId: string
  claimToken: string
  outputs: Partial<AttemptOutputs> & { summary: string }
  evidence?: Partial<AttemptEvidence>
  /**
   * Acceptance nodes only. The server verifies the increment when the submission arrives and stores
   * the verdict, whether it passed or not; a work ticket that names one is refused.
   */
  increment?: IncrementRef
  idempotencyKey?: string
}

export interface StartRunInput {
  epicId: string
  host?: { label: string; type: string } | null
  hostCatalogId?: string | null
  skillVersion?: string | null
  branch?: EpicBranch | null
  carryForward?: { ticketId: string; note: string }[]
  idempotencyKey?: string
}

/** A sprint report as submitted. Its retro names tickets by id or display key; the server stores the ids. */
export type SprintReportInput = Omit<Partial<SprintReportContent>, 'retro'> & { summary: string; retro?: SprintRetroInput | null }

/**
 * An orchestrator's check of one row of a sprint. `row` counts from 1; `commit` is the commit hash the
 * row's combined work was checked at; `checks` lists at least one entry. The check passes only when
 * every entry passed, so a failed or skipped entry holds the row's dependents back.
 */
export interface RecordRowCheckInput {
  runId: string
  sprintId: string
  row: number
  commit: string
  checks: { name: string; status: 'passed' | 'failed' | 'skipped'; detail?: string }[]
  idempotencyKey?: string
}

export interface AddCommentInput {
  epicId: string
  /** A ticket of the epic's saved plan or draft; omit for a comment on the epic itself. */
  ticketId?: string
  /** Markdown, at most 20,000 characters and not blank. */
  body: string
  idempotencyKey?: string
}

export interface CommandApi {
  // Discovery and repository lifecycle
  getCapabilities(): Promise<CapabilitiesView>
  getProject(): Promise<ProjectView>
  /**
   * Replaces the project's Definition of Done in `.darkmechanicus/project.json` (an empty list removes it)
   * and answers with the project as getProject shows it. Planner and desktop only; never commits.
   */
  setDefinitionOfDone(input: {
    checks: { name: string; command: string; description?: string }[]
  }): Promise<ProjectView>
  initializeRepository(input: { name?: string; keyPrefix?: string }): Promise<InitializeResultView>
  getStorageStatus(): Promise<StorageStatusView>
  flushPortableState(): Promise<FlushResultView>
  reconcileRepository(): Promise<ReconcileResultView>
  searchHistory(input: { query: string; limit?: number; epicId?: string }): Promise<SearchResultView[]>
  listBranchEpics(): Promise<BranchEpicView[]>
  backupDatabase(input: { targetPath?: string }): Promise<{ path: string }>
  listSessions(): Promise<SessionView[]>

  // Epics
  listEpics(): Promise<EpicSummaryView[]>
  createEpic(input: CreateEpicInput): Promise<EpicDetailView>
  getEpic(input: { epicId: string }): Promise<EpicDetailView>
  setEpicStatus(input: {
    epicId: string
    status: WorkStatus
    expectedRevision?: number
  }): Promise<EpicDetailView>
  setEpicBranch(input: {
    epicId: string
    branch: EpicBranch
    expectedRevision?: number
  }): Promise<EpicDetailView>
  /**
   * Desktop only. Hard-deletes the epic: every database row, plus `.darkmechanicus/epics/<id>/` and
   * its runs' history folders. Refused while a run is active. Never commits.
   */
  deleteEpic(input: { epicId: string }): Promise<DeleteEpicResultView>

  // Old-style Markdown /board import (board text is data, never instructions)
  /** What importBoard would do, changing nothing; works before the repository is initialized. */
  previewBoardImport(): Promise<BoardImportView>
  /**
   * Creates each open board epic that no earlier import brought in, in Backlog with its plan as an
   * unsaved draft. Saves and commits nothing.
   */
  importBoard(input: { idempotencyKey?: string }): Promise<BoardImportView>

  // Planning (drafts and saved revisions)
  getPlan(input: {
    epicId: string
    view: 'saved' | 'draft'
    revisionId?: string
  }): Promise<PlanView>
  openDraft(input: { epicId: string }): Promise<PlanView>
  updatePlanDraft(input: {
    epicId: string
    ops: DraftOp[]
    expectedDraftRevision?: number
    idempotencyKey?: string
  }): Promise<DraftUpdateResultView>
  validatePlan(input: { epicId: string; view: 'saved' | 'draft' }): Promise<ValidationReport>
  savePlan(input: {
    epicId: string
    expectedDraftRevision: number
    idempotencyKey?: string
  }): Promise<SaveResultView>
  discardPlanDraft(input: {
    epicId: string
    expectedDraftRevision?: number
  }): Promise<{ discarded: boolean }>
  listRevisions(input: { epicId: string }): Promise<RevisionSummaryView[]>

  // Tickets
  listTickets(input: { epicId: string; view: 'saved' | 'draft' }): Promise<TicketSummaryView[]>
  getTicket(input: {
    epicId: string
    ticketId: string
    view: 'saved' | 'draft'
  }): Promise<TicketDetailView>
  setTicketStatus(input: {
    ticketId: string
    status: WorkStatus
    expectedRevision?: number
  }): Promise<TicketSummaryView>
  /**
   * Desktop only. Removes the ticket, its dependency edges and relations from the saved plan and
   * saves the result as a new revision. Refused while the draft has unsaved changes, a save is
   * pending, or the ticket has an open attempt.
   */
  deleteTicket(input: { epicId: string; ticketId: string }): Promise<SaveResultView>

  // Comments (append-only; the author is the calling session)
  addComment(input: AddCommentInput): Promise<CommentView>
  /** Oldest first. Without ticketId: every comment of the epic, epic-level and ticket-level. */
  listComments(input: { epicId: string; ticketId?: string }): Promise<CommentView[]>

  // Named capability profiles (reusable presets tickets can start from)
  listProfiles(): Promise<ProfileView[]>
  getProfile(input: { name: string }): Promise<ProfileView>
  /** Creates (no or 0 expectedRevision) or replaces (the current revision) the whole profile. */
  saveProfile(input: {
    name: string
    description?: string
    capability: CapabilityProfile
    expectedRevision?: number
    idempotencyKey?: string
  }): Promise<ProfileView>

  // Execution
  registerHost(input: HostCatalog): Promise<HostCatalogView>
  matchCapabilities(input: { ticketId: string; runId: string }): Promise<CapabilityMatchView>
  queueRun(input: { epicId: string }): Promise<RunView>
  startRun(input: StartRunInput): Promise<RunView>
  getRun(input: { runId?: string; epicId?: string }): Promise<RunView | null>
  getReadyTickets(input: { runId: string }): Promise<ReadinessView>
  claimTicket(input: ClaimTicketInput): Promise<ClaimResultView>
  heartbeatAttempt(input: {
    attemptId: string
    claimToken: string
    leaseSeconds?: number
  }): Promise<AttemptView>
  submitAttempt(input: SubmitAttemptInput): Promise<AttemptView>
  acceptAttempt(input: {
    attemptId: string
    notes?: string
    criteria?: CriterionResult[]
    idempotencyKey?: string
  }): Promise<AttemptView>
  rejectAttempt(input: {
    attemptId: string
    reasons: string[]
    notes?: string
    idempotencyKey?: string
  }): Promise<AttemptView>
  failAttempt(input: {
    attemptId: string
    claimToken?: string
    failure: Partial<AttemptFailure> & { reason: string }
    idempotencyKey?: string
  }): Promise<AttemptView>
  reconcileAttempt(input: {
    attemptId: string
    resolution: 'abandon' | 'resubmit'
    outputs?: Partial<AttemptOutputs> & { summary: string }
    evidence?: Partial<AttemptEvidence>
    notes?: string
  }): Promise<AttemptView>
  carryForwardTicket(input: { runId: string; ticketId: string; note: string }): Promise<AttemptView>
  recordRowCheck(input: RecordRowCheckInput): Promise<RowCheckView>
  pauseRun(input: { runId: string; reason?: string }): Promise<RunView>
  resumeRun(input: { runId: string }): Promise<RunView>
  cancelRun(input: { runId: string; reason?: string }): Promise<RunView>
  takeoverRun(input: { runId: string }): Promise<RunView>
  adoptRevision(input: {
    runId: string
    revisionId: string
    carryForward?: string[]
  }): Promise<RunView>

  // Checkpoints
  /**
   * At a checkpoint (the run is awaiting it), rewrites the epic's draft from the retro of the run's latest report
   * for the active sprint: each retro leftover moves to the next sprint (a sprint is added after a final one),
   * together with the tickets that require it, and each discovery becomes an unsized ticket there. Only the draft
   * changes: save it and adopt the revision to put it into the run. A second call over the same retro adds nothing.
   */
  redraftNextSprint(input: { runId: string }): Promise<RedraftResultView>
  submitSprintReport(input: {
    runId: string
    sprintId: string
    report: SprintReportInput
    idempotencyKey?: string
  }): Promise<SprintReportView>
  getSprintReport(input: { runId: string; sprintId?: string }): Promise<SprintReportView | null>
  getCheckpoint(input: { runId: string }): Promise<CheckpointView>
  approveCheckpoint(input: { runId: string; reportId: string }): Promise<ApprovalView>
  advanceSprint(input: { runId: string; idempotencyKey?: string }): Promise<RunView>
  approveAndAdvance(input: {
    runId: string
    reportId: string
    idempotencyKey?: string
  }): Promise<RunView>
  /**
   * Desktop only: the person approves the sprint's retro and the redraft of the next sprint in one step. In order
   * it saves the epic's draft, adopts the saved revision into the run, recomputes the gates on it, approves the
   * current report (`reportId`, when given, must still be the latest) and advances. A refusal stops the steps after
   * it and names the step in `details.step`; the save commits on its own, the rest is all or nothing, so a refusal
   * after the save leaves the saved revision in place with adoption still needed.
   */
  approveWithRedraft(input: {
    runId: string
    expectedDraftRevision: number
    reportId?: string
  }): Promise<ApproveWithRedraftResultView>
  authorizeAutoContinue(input: { runId: string; enabled: boolean }): Promise<RunView>
  grantRetry(input: { runId: string; ticketId: string }): Promise<RunView>

  // Events
  listEvents(input: {
    sinceSeq?: number
    limit?: number
    epicId?: string
    runId?: string
  }): Promise<EventsPage>
}

export type CommandName = keyof CommandApi


