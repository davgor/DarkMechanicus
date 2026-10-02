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
  RelationKind,
  TicketPriority,
  TicketReference
} from './bundle'
import type { WorkStatus } from './status'
import type {
  ApprovalView,
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
  ReconcileResultView,
  RevisionSummaryView,
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

export interface TicketInput {
  title: string
  body?: string
  acceptanceCriteria?: (CriterionInput | string)[]
  tags?: string[]
  priority?: TicketPriority
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
  }
  leaseSeconds?: number
  idempotencyKey?: string
}

export interface SubmitAttemptInput {
  attemptId: string
  claimToken: string
  outputs: Partial<AttemptOutputs> & { summary: string }
  evidence?: Partial<AttemptEvidence>
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

export type SprintReportInput = Partial<SprintReportContent> & { summary: string }

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


