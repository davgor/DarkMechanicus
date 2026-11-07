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
import type { AttemptTimelineView, RunTimelineView, TimelineWindow } from './activity'
import type { SprintRetroInput } from './retro'
import type {
  RecordTransferItemInput,
  StartedTransferView,
  SubmitTransferReadbackInput,
  TransferActionInput,
  TransferItemView,
  TransferReadbackResult,
  TransferView
} from './transfer'
import type { DeleteKanbanCardResultView, KanbanAttemptView, KanbanBoardView, KanbanCardView, KanbanPacket } from './kanban'
import type { WorkStatus } from './status'
import type {
  ApprovalView,
  ApproveWithRedraftResultView,
  AttachmentFileView,
  AttachmentPurpose,
  AttachmentView,
  AttemptEvidenceSubmission,
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
  EpicConflictChoice,
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
  RepositoryView,
  ResolveEpicConflictView,
  RevisionSummaryView,
  RowCheckView,
  RunView,
  SaveResultView,
  SearchResultView,
  GrantableRole,
  GrantView,
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
  /**
   * The repository of a folder of repositories the ticket targets; the server keeps the title prefixed with
   * `<repo> - `. `null` in a patch clears it (the title then keeps only its description).
   */
  repo?: string | null
  capability?: CapabilityPatch
  references?: TicketReference[]
  expectedArtifacts?: string[]
  optional?: boolean
  /** Staged image ids (or ones the ticket already owns) to show as references, at most 20; `[]` removes them all. */
  attachments?: string[]
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
 * hex digits. In a folder of repositories, `repo` names the child repository the commit is in.
 */
export interface IncrementRef {
  branch: string
  commit: string
  repo?: string
}

export interface HeartbeatAttemptInput {
  attemptId: string
  claimToken: string
  leaseSeconds?: number
  /** A short working note shown with the attempt; kept locally, never exported with the run history. */
  progress?: { note: string; step?: string }
}

export interface SubmitAttemptInput {
  attemptId: string
  claimToken: string
  outputs: Partial<AttemptOutputs> & { summary: string }
  evidence?: AttemptEvidenceSubmission
  /**
   * Acceptance nodes only. The server verifies the increment when the submission arrives and stores
   * the verdict, whether it passed or not; a work ticket that names one is refused. A single repository only.
   */
  increment?: IncrementRef
  /**
   * Acceptance nodes of a folder of repositories only, instead of `increment`: one increment per repository the
   * sprint touched, each with its `repo`. Each is verified against that repository's history and stored with its
   * verdict; one that fails fails the node's increment.
   */
  increments?: IncrementRef[]
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

/** An image from a local path the caller's machine can read. Its size, type and dimensions come from the file itself. */
interface AddAttachmentInput {
  /** Absolute, or relative to the caller's working folder. Must sit in an allowed folder (see the attachments intake). */
  path: string
  label: string
  purpose: AttachmentPurpose
}

/** An image's bytes sent by the desktop app (never a path). */
interface UploadAttachmentInput {
  /** Plain base64 of a PNG or JPEG: no `data:` prefix. */
  data: string
  /** Defaults to "Pasted image"; cut to the label limit. */
  label?: string
  /** Defaults to `reference`. */
  purpose?: AttachmentPurpose
}

interface GetAttachmentInput {
  attachmentId: string
  /** `file` writes the bytes to a temporary file and returns its path too. */
  as: 'metadata' | 'file'
}

export interface AddCommentInput {
  epicId: string
  /** A ticket of the epic's saved plan or draft; omit for a comment on the epic itself. */
  ticketId?: string
  /** Markdown, at most 20,000 characters and not blank. */
  body: string
  /** Staged image ids (`addAttachment`) to attach, at most 20; either purpose. */
  attachments?: string[]
  idempotencyKey?: string
}

/** A new Kanban card's content. It always starts in Backlog; the key and author come from the server. */
export interface CreateKanbanCardInput {
  title: string
  /** Markdown; empty when omitted. */
  body?: string
  /** Omit a criterion's `id` to have `c<n>` assigned. */
  acceptanceCriteria?: (CriterionInput | string)[]
  expectedArtifacts?: string[]
  references?: TicketReference[]
  /** `normal` when omitted. */
  priority?: TicketPriority
  size?: TicketSize
  /** Staged image ids (`addAttachment`) to attach as references, at most 20; `purpose: 'evidence'` is refused. */
  attachments?: string[]
  idempotencyKey?: string
}

/** An edit of a Backlog card that was never claimed: only the fields given change; `size: null` clears the size. */
export interface UpdateKanbanCardInput extends Partial<Omit<CreateKanbanCardInput, 'size' | 'idempotencyKey'>> {
  cardId: string
  /** The card's current `revision`; another value is refused with `conflict`. */
  expectedRevision: number
  size?: TicketSize | null
  idempotencyKey?: string
}

/** One page of the board: every open card, and Done from `doneCursor` (the start when omitted), `doneLimit` cards at most. */
export interface ListKanbanCardsInput {
  /** 1 to 100; 20 when omitted. */
  doneLimit?: number
  /** A previous page's `doneNextCursor`. */
  doneCursor?: string
}

/** Queues only explicitly named cards for an external orchestrator; duplicates are ignored. */
export interface LaunchKanbanCardsInput {
  /** Nonempty list; use one id for a single-card launch. No implicit launch-all. */
  cardIds: string[]
}

/** Claims a card queued by desktop Play or an authorized orchestrator launch. */
export interface ClaimKanbanCardInput {
  cardId: string
  /** 30 to 86,400 seconds; 900 when omitted. */
  leaseSeconds?: number
  idempotencyKey?: string
}

/** Keeps a card's claim alive for another lease of the length it was claimed with. */
export interface HeartbeatKanbanCardInput {
  attemptId: string
  claimToken: string
  /** At most 280 characters, shown with the attempt until the next note; a claim token in it is masked. */
  progressNote?: string
}

/** Reports a card's result, which moves it to Ready for review: the same outputs and evidence as `submitAttempt`. */
export interface SubmitKanbanCardInput {
  attemptId: string
  claimToken: string
  outputs: Partial<AttemptOutputs> & { summary: string }
  evidence?: AttemptEvidenceSubmission
  idempotencyKey?: string
}

export interface FailKanbanCardInput {
  attemptId: string
  claimToken: string
  reason: string
  idempotencyKey?: string
}

/** Sends a card in Ready for review back to In progress with a pending Play; the next claim lists the comment. */
export interface KickBackKanbanCardInput {
  cardId: string
  /** Markdown, 1 to 20,000 characters and not blank. */
  comment: string
  idempotencyKey?: string
}

export interface CommandApi {
  // Discovery and repository lifecycle
  getCapabilities(): Promise<CapabilitiesView>
  getProject(): Promise<ProjectView>
  /**
   * Replaces the project's Definition of Done in `.darkmechanicus/project.json` (an empty list removes it)
   * and answers with the project as getProject shows it. Planner and desktop only; never commits. In a folder
   * of repositories `repo` is required and names the repository whose checks these are; a single repository refuses it.
   */
  setDefinitionOfDone(input: {
    checks: { name: string; command: string; description?: string }[]
    repo?: string
  }): Promise<ProjectView>
  initializeRepository(input: {
    name?: string
    keyPrefix?: string
    /** `repo` (default) keeps records in the repository; `db` keeps them only in the home directory. */
    mode?: 'repo' | 'db'
    /**
     * `multi_repo` sets up a folder whose immediate children are Git repositories: db mode only (the default for
     * it), refused when the folder sits inside a Git repository or holds none. The children are recorded.
     */
    layout?: 'single' | 'multi_repo'
  }): Promise<InitializeResultView>
  /**
   * Re-detects the child repositories of a folder of repositories: appends new ones, marks vanished ones missing
   * (never removing them), and answers with the whole list. Refused for a single-repository project.
   */
  rescanRepositories(): Promise<RepositoryView[]>
  getStorageStatus(): Promise<StorageStatusView>
  /** Person-confirmed desktop-only migration; never exposed as an agent MCP tool. */
  switchStorageMode(input: { mode: 'repo' | 'db'; confirmed: true }): Promise<{ mode: 'repo' | 'db'; projectDir: string; cleanupPending: boolean }>
  flushPortableState(): Promise<FlushResultView>
  reconcileRepository(): Promise<ReconcileResultView>
  /**
   * Desktop only; no MCP tool offers it. Settles an epic whose tracked records changed (another machine's save or
   * state change, pulled or checked out) while this machine's changes to it wait to be exported, which neither a
   * reconcile nor a flush will apply over the other. `tracked` drops the epic's waiting state export and any waiting
   * save (its revision is marked failed; the draft stays), then imports the tracked records; `local` writes this
   * machine's records over them. Refused (`conflict`) when there is no such conflict, during a Linear transfer hold,
   * or when the chosen side cannot be applied, leaving everything as it was. Never commits.
   */
  resolveEpicConflict(input: { epicId: string; keep: EpicConflictChoice }): Promise<ResolveEpicConflictView>
  searchHistory(input: { query: string; limit?: number; epicId?: string }): Promise<SearchResultView[]>
  listBranchEpics(): Promise<BranchEpicView[]>
  backupDatabase(input: { targetPath?: string }): Promise<{ path: string }>
  listSessions(): Promise<SessionView[]>
  /**
   * Issues a role for an agent session to present. The token comes back once and is never stored
   * in readable form; only a person at the desktop may call it.
   */
  issueGrant(input: {
    role: GrantableRole
    label: string
    minutes?: number
    allowSave?: boolean
  }): Promise<{ grant: GrantView; token: string }>
  listGrants(): Promise<GrantView[]>
  revokeGrant(input: { grantId: string }): Promise<GrantView>
  /** Moves a usable grant's expiry to `minutes` from now; only the desktop may call it, for a chat terminal still running on it. */
  renewGrant(input: { grantId: string; minutes: number }): Promise<GrantView>

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

  // Image attachments (PNG or JPEG). A staged image is claimed by the record it is attached to.
  /** Refused on the desktop transport. Stages the image as read from an allowed folder and returns its metadata. */
  addAttachment(input: AddAttachmentInput): Promise<AttachmentView>
  /** Desktop only: stages the image from base64 bytes the app read; refused on every other transport. */
  uploadAttachment(input: UploadAttachmentInput): Promise<AttachmentView>
  getAttachment(input: GetAttachmentInput): Promise<AttachmentView | AttachmentFileView>

  // Comments (append-only; the author is the calling session)
  addComment(input: AddCommentInput): Promise<CommentView>
  /** Oldest first. Without ticketId: every comment of the epic, epic-level and ticket-level. */
  listComments(input: { epicId: string; ticketId?: string }): Promise<CommentView[]>

  // Kanban cards (isolated tickets on the folder's board)
  /** Adds a card to Backlog with the next key of the project's ticket sequence. Person, planner and orchestrator. */
  createKanbanCard(input: CreateKanbanCardInput): Promise<KanbanCardView>
  /** Edits a card in Backlog that has never been claimed; otherwise `invalid_state`. */
  updateKanbanCard(input: UpdateKanbanCardInput): Promise<KanbanCardView>
  /**
   * The board: slim summaries of each lane, never a body, criteria or evidence. Open lanes by priority, then
   * age; Done newest first and paged.
   */
  listKanbanCards(input: ListKanbanCardsInput): Promise<KanbanBoardView>
  /** The full card, with its body, criteria and every attempt. */
  getKanbanCard(input: { cardId: string }): Promise<KanbanCardView>
  /**
   * The person presses Play: a pending play an orchestrator's claim consumes. Backlog, or In progress with no
   * open attempt; pressing it again changes nothing. Human-only.
   */
  playKanbanCard(input: { cardId: string }): Promise<KanbanCardView>
  /** Atomically queues named playable cards without spawning chats. Orchestrator only; pending retries are no-ops. */
  launchKanbanCards(input: LaunchKanbanCardsInput): Promise<KanbanCardView[]>
  /**
   * Claims a card with a pending Play (`play_required` without one, `already_claimed` while an attempt is open) and
   * moves it to In progress. The packet's claim token is returned once. Orchestrator only.
   */
  claimKanbanCard(input: ClaimKanbanCardInput): Promise<KanbanPacket>
  heartbeatKanbanCard(input: HeartbeatKanbanCardInput): Promise<KanbanAttemptView>
  /** Moves the card to Ready for review. */
  submitKanbanCard(input: SubmitKanbanCardInput): Promise<KanbanAttemptView>
  /** The attempt fails and the card stays In progress, where a person can press Play again. */
  failKanbanCard(input: FailKanbanCardInput): Promise<KanbanAttemptView>
  /** Moves a card in Ready for review to Done with its compact summary. Human-only. */
  approveKanbanCard(input: { cardId: string; idempotencyKey?: string }): Promise<KanbanCardView>
  /** Rejects the submission with the comment (see `KickBackKanbanCardInput`). Human-only. */
  kickBackKanbanCard(input: KickBackKanbanCardInput): Promise<KanbanCardView>
  /**
   * Permanently removes a card, its attempts and events, and its tracked folder. Refused while an attempt is
   * claimed, running or submitted. Human-only.
   */
  deleteKanbanCard(input: { cardId: string }): Promise<DeleteKanbanCardResultView>

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
  heartbeatAttempt(input: HeartbeatAttemptInput): Promise<AttemptView>
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
    evidence?: AttemptEvidenceSubmission
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

  // Activity timelines
  /**
   * One attempt's story in time order: the claim, its alive span (heartbeats collapsed), progress notes, comments
   * made while it was open, submission, decision, failure, lease expiry and reconciliation. `sinceSeq` is the
   * `cursor` of the previous page (0 or absent: everything). Keep polling while `isLive`; the alive span comes
   * again by id while the attempt holds a lease, so the client replaces it.
   */
  getAttemptTimeline(input: { attemptId: string } & TimelineWindow): Promise<AttemptTimelineView>
  /** A run's story grouped by the session that did each thing; paged with `sinceSeq` like an attempt timeline. */
  getRunTimeline(input: { runId: string } & TimelineWindow): Promise<RunTimelineView>

  // Linear transfer of a saved epic
  /**
   * Desktop only: the person authorizes the transfer of the epic's current saved revision to a Linear project.
   * Refused for a completed epic, an active run, a never-saved plan, unsaved draft changes and an open transfer.
   */
  queueTransfer(input: TransferActionInput): Promise<TransferView>
  /** Desktop only: withdraws the authorization; the recorded items are cleared, what is in Linear stays. */
  cancelTransfer(input: TransferActionInput): Promise<TransferView>
  /** Starts a queued transfer or resumes one in progress: the stored packet, what is recorded and what remains. */
  startTransfer(input: TransferActionInput): Promise<StartedTransferView>
  /** Records the Linear item created (or adopted) for one packet ref; the same values again change nothing. */
  recordTransferItem(input: RecordTransferItemInput): Promise<TransferItemView>
  /** Where the epic's transfer stands; `not_started` with the packet the saved revision builds when none exists. */
  getTransfer(input: { epicId: string }): Promise<TransferView>
  /**
   * One part of the Linear read-back; parts accumulate until `final`, which compares them with the packet and
   * completes the epic on a full match or stores and returns the mismatches.
   */
  submitTransferReadback(input: SubmitTransferReadbackInput): Promise<TransferReadbackResult>
}

export type CommandName = keyof CommandApi


