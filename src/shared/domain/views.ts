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
  TicketContent
} from './bundle'
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

export interface ProjectView {
  projectId: string
  name: string
  keyPrefix: string
  repoRoot: string
  createdAt: string
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

export interface PrerequisiteOutcome {
  ticketId: string
  key: string
  state: TicketExecutionState
  acceptedAttemptId: string | null
}

export interface TicketExecutionView {
  ticketId: string
  key: string
  sprintId: string
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

interface CheckResult {
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
  tools: string[]
  canSelectWorkerModel: boolean
  models: HostModel[]
}

export interface HostCatalogView extends HostCatalog {
  id: string
  registeredAt: string
  registeredBy: string | null
}

export interface CapabilityMatchView {
  ticketId: string
  catalogId: string
  eligible: { modelId: string; score: number; reasons: string[] }[]
  rejected: { modelId: string; failures: string[] }[]
  hostFailures: string[]
  unknownRequirements: string[]
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
}

export interface SprintReportView {
  id: string
  runId: string
  sprintId: string
  reportRevision: number
  contentHash: string
  report: SprintReportContent
  submittedBy: string | null
  createdAt: string
}

export type GateConditionId =
  | 'report_submitted'
  | 'no_active_leases'
  | 'required_accepted'
  | 'exit_criteria'
  | 'epic_outcome'
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
  attempts: AttemptView[]
  checkpoint: CheckpointView | null
}

export interface ReadinessView {
  runId: string
  sprintId: string | null
  ready: TicketExecutionView[]
  blocked: TicketExecutionView[]
  inFlight: TicketExecutionView[]
  capacity: { limit: number | null; inUse: number }
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
  docType: 'epic' | 'ticket' | 'attempt' | 'report'
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

export interface DraftUpdateResultView {
  epicId: string
  draftRevision: number
  refMap: Record<string, string>
  validation: ValidationReport
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
