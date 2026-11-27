import { deliveryPolicy } from './deliveryPolicySchema'
import { z } from 'zod'
import { nameChatArgsSchema } from '../shared/agents/chatNaming'
import { toolingRecoveryInputSchema } from '../shared/agents/toolingRecovery'
import {
  cultConcludeRunArgsSchema, cultConcludeServiceArgsSchema, cultCreateWorkerTypeArgsSchema, cultDismissArgsSchema, cultOrderAllArgsSchema,
  cultPetitionArgsSchema, cultSummonArgsSchema
} from '../shared/cults/cultControl'
import { REASONING_EFFORTS, TICKET_SIZES } from '../shared/domain/bundle'
import { KNOWLEDGE_EVENTS, type KnowledgeEvent } from './knowledge/events'
import { repositoryName } from './repo/portable'
import { STORAGE_MODES } from './repo/storageMode'
import { AGENT_MAIL_LIMITS } from './services/agentMailStore'
import { MAX_GRANT_MINUTES, MIN_GRANT_MINUTES } from './services/grants'
import {
  ADOPTION_REASON_MIN,
  attachmentPurpose,
  attachmentRef,
  attemptEvidenceInput,
  attemptOutputsInput,
  capabilityProfile,
  commentBody,
  commitHash,
  correctionsInput,
  createCorrectionsInput,
  criterionInput,
  criterionResult,
  definitionOfDoneChecks,
  draftOps,
  entityRef,
  epicBranch,
  experimentEventInput,
  heartbeatProgress,
  hostCatalog,
  idempotencyKey,
  incrementRef,
  incrementRefs,
  LIMITS,
  linearId,
  linearIdentifier,
  linearReadbackPart,
  linearUrl,
  plannedTestCases,
  profileName,
  rowCheckEntries,
  sprintReportInput,
  stableId,
  ticketBudget,
  ticketInput,
  transferRef,
  workStatus
} from './schemas'
import { evidenceRefSchema, measurementSchema } from './space/contract'
import { LEDGER_LIMITS } from './space/ledger'
import {
  ACCUMULATIONS,
  GRADE_SUBJECT_LEVELS,
  HUMAN_INTERVENTIONS,
  HUMAN_REVIEW_ACTIVITIES,
  METRIC_KINDS,
  METRIC_SOURCES,
  METRIC_UNITS,
  REGRESSION_SEVERITIES,
  USAGE_COVERAGES,
  WORKFLOW_CAUSES
} from '../shared/domain/space'
import { OVERHEAD_KINDS } from '../shared/domain/metrics'
import { DEFECT_ATTRIBUTIONS, DEFECT_EVENTS, DISCOVERY_PHASES } from '../shared/domain/performance'
import { HUMAN_RATING_RANGE, MAX_RESCUE_MINUTES, MIN_FEEDBACK_MINUTES } from '../shared/domain/spaceSignals'
import { learningReasonSchema, learningReplacementContentSchema } from '../shared/domain/learnings'
// ─── DM-938 ───
import { LEARNING_DISPOSITIONS } from '../shared/domain/kanban'
import { LEARNING_EVIDENCE_KINDS, LEARNING_LIMITS, learningDraftSchema, type LearningSourceKind } from '../shared/domain/learnings'
// ─── End of DM-938 ───

/**
 * Input schemas for every command that takes input. The Workspace parses raw MCP/IPC payloads
 * with these before any service runs; they are the trust boundary for both entry points.
 */
const view = z.enum(['saved', 'draft'])
const revision = z.number().int().min(0).max(1_000_000_000)
const note = z.string().max(LIMITS.shortText)
/**
 * Why a run adopts a revision: what failed and what the revision changes. Required of every session but the
 * desktop's, which the service enforces (`services/adoption.ts`); stored masked on `run.revision_adopted`.
 */
export const adoptionReason = z
  .string()
  .trim()
  .min(ADOPTION_REASON_MIN)
  .max(LIMITS.shortText)
  .describe('Why you adopt: what failed and what the revision changes (20 or more characters). Required for agents.')
const claimToken = z.string().min(1).max(300)
const leaseSeconds = z.number().int().min(30).max(86_400)
const epicRef = z.strictObject({ epicId: stableId })
const transferAction = z.strictObject({ epicId: stableId, idempotencyKey })
const runRef = z.strictObject({ runId: stableId })
/** The paging of a timeline: entries after the previous page's cursor, at most `limit` of them. */
const timelineWindow = {
  sinceSeq: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional()
}

/** A mail paging window; the service checks it against the mailbox's high-water inside its snapshot. */
const mailWindow = {
  afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('Continue after this sequence: the previous page\'s nextCursor.'),
  throughSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('The first page\'s snapshotHighWater, so later pages skip no arrival.'),
  limit: z.number().int().min(1).max(AGENT_MAIL_LIMITS.pageSize).optional()
}
/** No input at all: an unknown property is refused, never ignored. */
const noInput = z.strictObject({})

/**
 * One reported measurement (`MetricReport`). The schema takes every metric and source kind so the service can refuse
 * human and server ones as `unauthorized` rather than as malformed. Its delivery identity is fixed here: a cumulative
 * report names its `sequence` and no `eventId`; a delta or event names its `eventId` and no `sequence`.
 */
const metricReport = z
  .strictObject({
    metric: z.enum(METRIC_KINDS),
    unit: z.enum(METRIC_UNITS).describe("The metric's fixed unit, stated explicitly (tokens_* in tokens, active_ms in milliseconds)."),
    source: z.strictObject({
      kind: z.enum(METRIC_SOURCES).describe('agent (your own account) or host (telemetry your host read). human and server are refused.'),
      actor: z.string().min(1).max(200).describe('The session, stream or adapter that measured it; the stream a cumulative sequence counts in.')
    }),
    measurement: measurementSchema.describe(
      'observed {value}, estimated {value, method}, or missing {reason}: not_reported, host_unavailable (the host cannot report it) or partial_coverage. Never send 0 for unknown.'
    ),
    accumulation: z.enum(ACCUMULATIONS).describe('delta (adds to the stream), cumulative (the stream total so far) or event.'),
    sequence: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe('Cumulative reports only: the position in the stream. A later sequence never reports less.'),
    eventId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/, 'Use 1-128 letters, digits and . _ : @ -')
      .optional()
      .describe('Delta and event reports only: the source event id, unique within the actor and metric. Resending it is a no-op.'),
    observedAt: z.iso.datetime({ offset: true }).describe('When it was measured, by the source clock (ISO 8601).'),
    attributes: z
      .record(z.string().min(1).max(64), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe('At most 20 short qualifiers such as model or waitKind; no transcripts, paths or secrets.'),
    evidence: z.array(evidenceRefSchema).max(100).optional(),
    cause: z.enum(WORKFLOW_CAUSES).optional(),
    usage: z
      .strictObject({ coverage: z.enum(USAGE_COVERAGES), parentActor: z.string().min(1).max(200).nullable() })
      .optional()
      .describe('Token and active-time metrics: self (this session only) or inclusive (with every child session, counted once).')
  })
  .superRefine((report, ctx) => {
    if (report.accumulation === 'cumulative') {
      if (report.sequence === undefined) {
        ctx.addIssue({ code: 'custom', path: ['sequence'], message: 'A cumulative report names its sequence in the stream' })
      }
      if (report.eventId !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['eventId'], message: 'A cumulative report is identified by its sequence, not an eventId' })
      }
      return
    }
    if (report.eventId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['eventId'], message: `A ${report.accumulation} report names its source eventId` })
    }
    if (report.sequence !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['sequence'], message: `A ${report.accumulation} report is identified by its eventId, not a sequence` })
    }
  })

export const metricReports = z.array(metricReport).min(1).max(LEDGER_LIMITS.perCall)

/**
 * A Kanban card's content: the ticket fields a card shares, with no kind, tags, capability or repository. Its
 * criteria never carry `covers`, which only an acceptance node uses.
 */
import { deliveryIntegration } from './deliveryEvidenceSchema'

const kanbanCardFields = {
  title: ticketInput.shape.title,
  body: ticketInput.shape.body,
  acceptanceCriteria: z.array(criterionInput).max(LIMITS.criteria).optional(),
  expectedArtifacts: ticketInput.shape.expectedArtifacts,
  references: ticketInput.shape.references,
  priority: ticketInput.shape.priority,
  /** Staged reference images (`add_attachment`) to attach; on an edit the list replaces the card's. */
  attachments: z.array(attachmentRef.shape.id).max(LIMITS.attachmentsPerRecord).optional()
}

/** A read's cutoff: a server time (default now, and never later than now). */
const cutoff = z.iso.datetime({ offset: true }).optional()
/** One sprint report revision: its id, and optionally the revision number the caller expects it to be. */
const reportRevisionRef = { reportId: stableId, reportRevision: z.number().int().min(1).max(1_000_000_000).optional() }
/** The person a desktop entry names (the desktop session's label when absent). */
const person = z.string().min(1).max(200).optional()

// ─── DM-938: a sprint learning card's submission ───
/** Snapshot items one learning card can disposition; generous, since a sprint's evidence is not otherwise capped. */
const LEARNING_DISPOSITIONS_MAX = 2_000
/** Drafts one learning card may propose, as `stageLearningDrafts` allows. */
const LEARNING_DRAFTS_MAX = 20
const learningSubmission = z.strictObject({
  dispositions: z
    .array(
      z.strictObject({
        kind: z.enum(LEARNING_EVIDENCE_KINDS as [LearningSourceKind, ...LearningSourceKind[]]),
        sourceId: z.string().min(1).max(LEARNING_LIMITS.sourceIdChars),
        disposition: z.enum(LEARNING_DISPOSITIONS),
        reason: z.string().max(LIMITS.shortText).refine((text) => text.trim() !== '', 'A disposition needs a reason')
      })
    )
    .max(LEARNING_DISPOSITIONS_MAX)
    .describe('Exactly one per item of the packet learning.snapshot: learning, duplicate or not_reusable, each with its reason.'),
  drafts: z.array(learningDraftSchema).max(LEARNING_DRAFTS_MAX).describe('Proposed learnings, staged for review; cite only items disposed as learning.'),
  manifests: z
    .array(z.strictObject({ repo: z.string().min(1).max(255).nullable(), base: commitHash, branch: z.string().min(1).max(255), commit: commitHash }))
    .max(100)
    .describe('One per learning.branches entry: the repository (null in a single repository), base commit, isolated branch and its tip commit.')
})
// ─── End of DM-938 ───

export const COMMAND_SCHEMAS = {
  askHuman: z.strictObject({
    question: z.string().trim().min(1).max(3500),
    responseRequired: z.literal(true).describe('The agent needs this answer to proceed.'),
    humanEngaged: z.literal(false).describe('The human is currently not engaging with this agent in this conversation.'),
    waitId: z.uuid().optional().describe('Native human-wait delivery fence; supplied only by the waiting chat.')
  }),
  getHumanAnswer: z.strictObject({ questionId: z.uuid() }),
  nameChat: nameChatArgsSchema,
  recoverTooling: toolingRecoveryInputSchema,
  // Cult member commands (`src/shared/cults/cultControl.ts`): never a run, a role or a sender; main derives them.
  cultStatus: noInput,
  cultSummonAcolyte: cultSummonArgsSchema,
  cultDismissAcolyte: cultDismissArgsSchema,
  cultListAcolytes: noInput,
  cultPetition: cultPetitionArgsSchema,
  cultOrderAll: cultOrderAllArgsSchema,
  cultConcludeRun: cultConcludeRunArgsSchema,
  cultConcludeService: cultConcludeServiceArgsSchema,
  cultCreateWorkerType: cultCreateWorkerTypeArgsSchema,
  /** `repo`: in a folder of repositories, the repository whose checks these are (required there, refused otherwise). */
  standardizeProjectWork: z.strictObject({
    expectedRevision: z.number().int().positive(),
    includeInProgress: z.boolean(),
    items: z.array(z.strictObject({
      kind: z.enum(['epic', 'sprint', 'ticket', 'kanban']),
      id: stableId,
      epicId: stableId.optional(),
      disposition: z.enum(['updated', 'compliant', 'follow_up']),
      deploymentVerification: z.string().trim().min(1).max(4000).optional(),
      testCases: plannedTestCases.unwrap().min(1).optional(),
      requirements: z.string().trim().min(1).max(32_000).optional(),
      tests: z.array(z.string().trim().min(1).max(4000)).min(1).max(100).optional(),
      acceptanceCriteria: z.array(z.string().trim().min(1).max(4000)).min(1).max(100).optional(),
      reason: z.string().trim().min(1).max(4000)
    })).min(1).max(100).optional()
  }),
  setDeliveryStandards: z.strictObject({ expectedRevision: z.number().int().nonnegative(), policy: deliveryPolicy }),
  setDefinitionOfDone: z.strictObject({ checks: definitionOfDoneChecks, repo: repositoryName.optional() }),
  switchStorageMode: z.strictObject({ mode: z.enum(STORAGE_MODES), confirmed: z.literal(true) }),
  initializeRepository: z.strictObject({
    name: z.string().min(1).max(200).optional(),
    keyPrefix: z.string().regex(/^[A-Z][A-Z0-9]{0,11}$/).optional(),
    /** Where the project's records live: in the repository (default), or in the home directory only. */
    mode: z.enum(STORAGE_MODES).optional(),
    /** `multi_repo`: the folder holds Git repositories as its immediate children (db mode only). */
    layout: z.enum(['single', 'multi_repo']).optional()
  }),
  issueGrant: z.strictObject({
    role: z.enum(['planner', 'orchestrator', 'worker', 'reviewer', 'reader']),
    label: z.string().min(1).max(LIMITS.grantLabel),
    minutes: z.number().int().min(MIN_GRANT_MINUTES).max(MAX_GRANT_MINUTES).optional(),
    allowSave: z.boolean().optional()
  }),
  revokeGrant: z.strictObject({ grantId: stableId }),
  renewGrant: z.strictObject({ grantId: stableId, minutes: z.number().int().min(MIN_GRANT_MINUTES).max(MAX_GRANT_MINUTES) }),
  requestSavePermission: z.strictObject({ reason: z.string().trim().min(1).max(LIMITS.markdown) }),
  decideSavePermission: z.strictObject({
    requestId: stableId,
    decision: z.enum(['approved', 'denied']),
    reason: z.string().trim().min(1).max(LIMITS.markdown)
  }),
  searchHistory: z.strictObject({
    query: z.string().max(500),
    limit: z.number().int().min(1).max(100).optional(),
    epicId: stableId.optional()
  }),
  resolveEpicConflict: z.strictObject({ epicId: stableId, keep: z.enum(['tracked', 'local']) }),
  backupDatabase: z.strictObject({
    targetPath: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,100}\.sqlite$/, "Backups are written to the project's local/backups directory; give a file name only")
      .optional()
  }),
  createEpic: z.strictObject({
    title: z.string().trim().min(1).max(LIMITS.title),
    intent: z.string().max(LIMITS.markdown).optional(),
    successCriteria: z.array(criterionInput).max(LIMITS.criteria).optional(),
    ownerRole: z.string().max(LIMITS.label).nullable().optional(),
    branch: epicBranch.nullable().optional(),
    provenance: z
      .strictObject({ sourceEpicId: stableId, note: note.optional() })
      .nullable()
      .optional(),
    idempotencyKey
  }),
  getEpic: epicRef,
  setEpicStatus: z.strictObject({ epicId: stableId, status: workStatus, expectedRevision: revision.optional() }),
  setEpicBranch: z.strictObject({ epicId: stableId, branch: epicBranch, expectedRevision: revision.optional() }),
  deleteEpic: epicRef,
  importBoard: z.strictObject({ idempotencyKey }),
  getPlan: z.strictObject({ epicId: stableId, view, revisionId: stableId.optional() }),
  openDraft: epicRef,
  updatePlanDraft: z.strictObject({
    epicId: stableId,
    ops: draftOps,
    expectedDraftRevision: revision.optional(),
    idempotencyKey
  }),
  validatePlan: z.strictObject({ epicId: stableId, view }),
  savePlan: z.strictObject({ epicId: stableId, expectedDraftRevision: revision, idempotencyKey }),
  discardPlanDraft: z.strictObject({ epicId: stableId, expectedDraftRevision: revision.optional() }),
  listRevisions: epicRef,
  listTickets: z.strictObject({ epicId: stableId, view }),
  getTicket: z.strictObject({ epicId: stableId, ticketId: entityRef, view }),
  setTicketStatus: z.strictObject({ ticketId: stableId, status: workStatus, expectedRevision: revision.optional() }),
  deleteTicket: z.strictObject({ epicId: stableId, ticketId: stableId }),
  addAttachment: z.strictObject({
    path: z.string().min(1).max(4096),
    label: z.string().max(LIMITS.label),
    purpose: attachmentPurpose
  }),
  uploadAttachment: z.strictObject({
    /** Plain base64 of the image: no `data:` prefix, base64 alphabet only. */
    data: z.string().min(1).max(Math.ceil(LIMITS.attachmentBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'data must be plain base64 with no data: prefix'),
    label: z.string().optional(),
    purpose: attachmentPurpose.optional()
  }),
  getAttachment: z.strictObject({ attachmentId: attachmentRef.shape.id, as: z.enum(['metadata', 'file']) }),
  addComment: z.strictObject({
    epicId: stableId,
    ticketId: stableId.optional(),
    body: commentBody,
    attachments: z.array(attachmentRef.shape.id).max(LIMITS.attachmentsPerRecord).optional(),
    idempotencyKey
  }),
  listComments: z.strictObject({ epicId: stableId, ticketId: stableId.optional() }),
  createKanbanCard: z.strictObject({ ...kanbanCardFields, size: z.enum(TICKET_SIZES).optional(), idempotencyKey }),
  updateKanbanCard: z.strictObject({
    cardId: stableId,
    expectedRevision: revision,
    ...kanbanCardFields,
    title: kanbanCardFields.title.optional(),
    // `null` clears the size.
    size: ticketInput.shape.size,
    idempotencyKey
  }),
  listKanbanCards: z.strictObject({
    doneLimit: z.number().int().min(1).max(100).optional(),
    doneCursor: z.string().min(1).max(200).optional()
  }),
  getKanbanCard: z.strictObject({ cardId: stableId }),
  addKanbanMessage: z.strictObject({
    cardId: stableId,
    body: commentBody,
    attachments: z.array(attachmentRef.shape.id).max(LIMITS.attachmentsPerRecord).optional(),
    idempotencyKey
  }),
  listKanbanMessages: z.strictObject({ cardId: stableId }),
  playKanbanCard: z.strictObject({ cardId: stableId }),
  launchKanbanCards: z.strictObject({ cardIds: z.array(stableId).min(1).describe('Explicit nonempty card IDs; one item launches one card. Duplicates are ignored; no launch-all.') }),
  claimKanbanCard: z.strictObject({ cardId: stableId, leaseSeconds: leaseSeconds.optional(), idempotencyKey }),
  heartbeatKanbanCard: z.strictObject({
    attemptId: stableId,
    claimToken,
    progressNote: z.string().max(LIMITS.progressNote).optional()
  }),
  submitKanbanCard: z.strictObject({
    attemptId: stableId,
    claimToken,
    outputs: attemptOutputsInput,
    evidence: attemptEvidenceInput.optional(),
    // DM-938: required on a sprint learning card, refused on any other card.
    learning: learningSubmission.optional(),
    idempotencyKey
  }),
  failKanbanCard: z.strictObject({
    attemptId: stableId,
    claimToken: claimToken.optional().describe('Workers must provide the token. An orchestrator may omit a lost token to release and requeue a live claim.'),
    reason: z.string().min(1).max(LIMITS.shortText),
    idempotencyKey
  }),
  approveKanbanCard: z.strictObject({ cardId: stableId, idempotencyKey }),
  kickBackKanbanCard: z.strictObject({ cardId: stableId, comment: commentBody, idempotencyKey }),
  deleteKanbanCard: z.strictObject({ cardId: stableId }),
  getProfile: z.strictObject({ name: profileName }),
  saveProfile: z.strictObject({
    name: profileName,
    description: z.string().max(LIMITS.profileDescription).optional(),
    capability: capabilityProfile,
    expectedRevision: revision.optional(),
    idempotencyKey
  }),
  registerHost: hostCatalog,
  matchCapabilities: z.strictObject({ ticketId: stableId, runId: stableId }),
  queueRun: epicRef,
  startRun: z.strictObject({
    epicId: stableId,
    host: z.strictObject({ label: z.string().min(1).max(LIMITS.label), type: z.string().min(1).max(LIMITS.label) }).nullable().optional(),
    hostCatalogId: stableId.nullable().optional(),
    skillVersion: z.string().max(50).nullable().optional(),
    branch: epicBranch.nullable().optional(),
    carryForward: z.array(z.strictObject({ ticketId: stableId, note })).max(LIMITS.tickets).optional(),
    idempotencyKey
  }),
  getRun: z
    .strictObject({ runId: stableId.optional(), epicId: stableId.optional() })
    .refine((input) => input.runId !== undefined || input.epicId !== undefined, 'Give runId or epicId'),
  getReadyTickets: runRef,
  claimTicket: z.strictObject({
    runId: stableId,
    ticketId: stableId,
    worker: z.strictObject({
      label: z.string().min(1).max(LIMITS.label),
      modelId: z.string().max(LIMITS.label).nullable().optional(),
      hostId: z.string().max(LIMITS.label).nullable().optional(),
      catalogRevision: z.string().max(LIMITS.label).nullable().optional(),
      rationale: note.nullable().optional(),
      effort: z.enum(REASONING_EFFORTS).nullable().optional()
    }),
    leaseSeconds: leaseSeconds.optional(),
    idempotencyKey
  }),
  heartbeatAttempt: z.strictObject({
    attemptId: stableId,
    claimToken,
    leaseSeconds: leaseSeconds.optional(),
    progress: heartbeatProgress.optional()
  }),
  submitAttempt: z.strictObject({
    attemptId: stableId,
    claimToken,
    outputs: attemptOutputsInput,
    evidence: attemptEvidenceInput.optional(),
    increment: incrementRef.optional(),
    increments: incrementRefs.optional(),
    idempotencyKey
  }),
  acceptAttempt: z.strictObject({
    integration: deliveryIntegration.optional(),
    attemptId: stableId,
    notes: z.string().max(LIMITS.markdown).optional(),
    criteria: z.array(criterionResult).max(LIMITS.criteria).optional(),
    idempotencyKey
  }),
  rejectAttempt: z.strictObject({
    attemptId: stableId,
    reasons: z.array(note).min(1).max(LIMITS.listItems),
    notes: z.string().max(LIMITS.markdown).optional(),
    idempotencyKey
  }),
  failAttempt: z.strictObject({
    attemptId: stableId,
    claimToken: claimToken.optional(),
    failure: z.strictObject({
      reason: z.string().min(1).max(LIMITS.shortText),
      details: z.string().max(LIMITS.markdown).optional(),
      retryable: z.boolean().optional()
    }),
    idempotencyKey
  }),
  reconcileAttempt: z.strictObject({
    attemptId: stableId,
    resolution: z.enum(['abandon', 'resubmit']),
    outputs: attemptOutputsInput.optional(),
    evidence: attemptEvidenceInput.optional(),
    notes: z.string().max(LIMITS.markdown).optional()
  }),
  carryForwardTicket: z.strictObject({ runId: stableId, ticketId: stableId, note: z.string().min(1).max(LIMITS.shortText) }),
  recordRowCheck: z.strictObject({
    runId: stableId,
    sprintId: stableId,
    row: z.number().int().min(1).max(LIMITS.tickets),
    commit: commitHash,
    checks: rowCheckEntries,
    idempotencyKey
  }),
  pauseRun: z.strictObject({ runId: stableId, reason: note.optional() }),
  resumeRun: runRef,
  cancelRun: z.strictObject({ runId: stableId, reason: note.optional() }),
  takeoverRun: runRef,
  adoptRevision: z.strictObject({
    runId: stableId,
    revisionId: stableId,
    carryForward: z.array(stableId).max(LIMITS.tickets).optional(),
    reason: adoptionReason.optional()
  }),
  recordAttemptMetrics: z.strictObject({
    attemptId: stableId,
    claimToken: claimToken.optional(),
    reports: metricReports
  }),
  recordRunMetrics: z.strictObject({
    runId: stableId,
    sprintId: stableId.optional(),
    overhead: z.enum(OVERHEAD_KINDS),
    reports: metricReports
  }),
  getRunMetrics: z.strictObject({
    runId: stableId,
    attemptId: stableId.optional(),
    includeObservations: z.boolean().optional()
  }),
  getPlannedBaselines: z.strictObject({ epicId: stableId, runId: stableId.optional() }),
  getTicketGrade: z.strictObject({ runId: stableId, ticketId: stableId, cutoff }),
  getSprintGrade: z.strictObject({ runId: stableId, sprintId: stableId, cutoff }),
  getRunGrade: z.strictObject({ runId: stableId, cutoff }),
  getEpicGrade: z.strictObject({ epicId: stableId, cutoff }),
  getReportScorecard: z.strictObject(reportRevisionRef),
  reassessReportScorecard: z.strictObject({ ...reportRevisionRef, cutoff }),
  getSpaceSignals: z.strictObject({ level: z.enum(GRADE_SUBJECT_LEVELS), id: stableId, runId: stableId.optional(), cutoff }),
  getTicketPerformance: z.strictObject({ runId: stableId, ticketId: stableId, cutoff }),
  getEscapedDefects: z.strictObject({ epicId: stableId, cutoff }),
  getRunEfficiency: z.strictObject({ runId: stableId, cutoff, ticketId: stableId.optional() }),
  getRunTiming: z.strictObject({ runId: stableId, ticketId: stableId.optional(), cutoff }),
  getMetricsSummary: z.strictObject({ epicIds: z.array(stableId).max(1_000).optional(), since: cutoff, until: cutoff }),
  recordHumanFeedback: z.strictObject({
    target: z.strictObject({
      epicId: stableId,
      sprintId: stableId.optional(),
      runId: stableId.optional(),
      ticketId: stableId.optional(),
      attemptId: stableId.optional()
    }),
    feedback: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('rating'),
        value: z.number().int().min(HUMAN_RATING_RANGE.min).max(HUMAN_RATING_RANGE.max),
        sharedWithTickets: z.boolean().optional()
      }),
      z.strictObject({
        kind: z.literal('rescue'),
        minutes: z.number().min(MIN_FEEDBACK_MINUTES).max(MAX_RESCUE_MINUTES).optional(),
        intervention: z.enum(HUMAN_INTERVENTIONS),
        cause: z.enum(WORKFLOW_CAUSES)
      }),
      z.strictObject({
        kind: z.literal('planned_review'),
        activity: z.enum(HUMAN_REVIEW_ACTIVITIES),
        minutes: z.number().min(MIN_FEEDBACK_MINUTES).max(MAX_RESCUE_MINUTES).optional()
      })
    ]),
    person,
    idempotencyKey
  }),
  recordEscapedDefects: z.strictObject({
    target: z.strictObject({ epicId: stableId, runId: stableId.optional(), sprintId: stableId.optional() }),
    records: z
      .array(
        z.strictObject({
          defectEvent: z.enum(DEFECT_EVENTS),
          severity: z.enum(REGRESSION_SEVERITIES).optional(),
          attribution: z.enum(DEFECT_ATTRIBUTIONS).optional(),
          discoveryPhase: z.enum(DISCOVERY_PHASES).optional(),
          defectKey: z.string().min(1).max(200).optional(),
          evidence: z.array(evidenceRefSchema).max(100)
        })
      )
      .min(1)
      .max(LEDGER_LIMITS.perCall),
    person,
    idempotencyKey
  }),
  setTicketBudget: z.strictObject({
    epicId: stableId,
    ticketId: stableId,
    budget: ticketBudget.nullable(),
    expectedDraftRevision: revision,
    runId: stableId.optional()
  }),
  redraftNextSprint: runRef,
  previewCorrections: correctionsInput,
  createCorrections: createCorrectionsInput,
  submitSprintReport: z.strictObject({
    runId: stableId,
    sprintId: stableId,
    report: sprintReportInput,
    idempotencyKey
  }),
  getSprintReport: z.strictObject({ runId: stableId, sprintId: stableId.optional() }),
  getRetroFindings: z.strictObject(reportRevisionRef),
  getExperiment: z.strictObject({ experimentId: stableId }),
  recordExperimentEvent: experimentEventInput,
  getCheckpoint: runRef,
  approveCheckpoint: z.strictObject({ runId: stableId, reportId: stableId }),
  advanceSprint: z.strictObject({ runId: stableId, idempotencyKey }),
  approveAndAdvance: z.strictObject({ runId: stableId, reportId: stableId, idempotencyKey }),
  approveWithRedraft: z.strictObject({
    runId: stableId,
    expectedDraftRevision: revision,
    reportId: stableId.optional()
  }),
  authorizeAutoContinue: z.strictObject({ runId: stableId, enabled: z.boolean() }),
  grantRetry: z.strictObject({ runId: stableId, ticketId: stableId }),
  // The service trims both texts and needs at least 20 characters of each; the length is checked here as given.
  retryTicket: z.strictObject({
    runId: stableId,
    ticketId: stableId,
    failureReason: z.string().max(LIMITS.shortText),
    newApproach: z.string().max(LIMITS.shortText)
  }),
  acknowledgeAutoRetry: z.strictObject({ runId: stableId, ticketId: stableId, number: z.number().int().min(1).max(1_000) }),
  listEvents: z.strictObject({
    sinceSeq: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    epicId: stableId.optional(),
    runId: stableId.optional(),
    ticketId: stableId.optional()
  }),
  getAttemptTimeline: z.strictObject({ attemptId: stableId, ...timelineWindow }),
  getRunTimeline: z.strictObject({ runId: stableId, ...timelineWindow }),
  getContext: z
    .strictObject({
      event: z.enum(KNOWLEDGE_EVENTS.map((event) => event.id) as [KnowledgeEvent, ...KnowledgeEvent[]]).optional(),
      topics: z.array(z.string().min(1).max(80)).max(10).optional(),
      paths: z.array(z.string().min(1).max(1000)).max(50).optional(),
      ticketId: stableId.optional(),
      budgetTokens: z.number().int().min(200).max(8000).optional()
    })
    .refine((input) => input.event !== undefined || (input.topics?.length ?? 0) > 0, 'Give event or topics'),
  queueTransfer: transferAction,
  cancelTransfer: transferAction,
  startTransfer: transferAction,
  recordTransferItem: z.strictObject({
    epicId: stableId,
    ref: transferRef,
    linearId,
    identifier: linearIdentifier.optional(),
    url: linearUrl.optional(),
    replace: z.boolean().optional(),
    idempotencyKey
  }),
  getTransfer: epicRef,
  // No idempotencyKey: the service must run its own two transactions, never inside a wrapper's (see the service).
  // The part's size is checked here, before the service merges anything.
  submitTransferReadback: z.strictObject({ epicId: stableId, readback: linearReadbackPart, final: z.boolean() }),
  // Agent mail. No input names the caller's mailbox, and none carries an idempotencyKey: a send retries by its own
  // sender-scoped clientMessageId, and a wake claim is never replayed.
  getAgentIdentity: noInput,
  listAgentPeers: z.strictObject({
    afterId: stableId.optional().describe('The previous page\'s nextAfterId.'),
    limit: z.number().int().min(1).max(AGENT_MAIL_LIMITS.endpointPageSize).optional()
  }),
  sendAgentMessage: z.strictObject({
    to: stableId.describe('The recipient mailbox\'s endpoint id (me_…).'),
    clientMessageId: z
      .string()
      .min(1)
      .max(AGENT_MAIL_LIMITS.clientMessageIdChars)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
      .describe('Your own retry key for this message: the same id and payload replays the original acceptance.'),
    body: z.string().min(1).max(AGENT_MAIL_LIMITS.bodyBytes).describe('1 to 16 KiB of UTF-8 text.'),
    inReplyTo: stableId.optional().describe('A message in your own inbox that the recipient sent; makes this a reply.')
  }),
  readAgentInbox: z.strictObject({ ...mailWindow, unacknowledgedOnly: z.boolean().optional() }),
  acknowledgeAgentMessages: z.strictObject({
    messageIds: z.array(stableId).min(1).max(AGENT_MAIL_LIMITS.ackBatch).describe('1 to 100 ids of messages in your own inbox; all or none are acknowledged.')
  }),
  getAgentMailStatus: z.strictObject(mailWindow),
  // Learnings: reads for every role; retirement and replacement name the revision they read and always say why.
  listLearnings: z.strictObject({
    state: z.enum(['active', 'retired', 'all']).optional(),
    query: z.string().max(LIMITS.shortText).optional(),
    limit: z.number().int().min(1).max(200).optional()
  }),
  getLearning: z.strictObject({ learningId: stableId }),
  getStagedLearningDrafts: z.strictObject({ attemptId: stableId }),
  retireLearning: z.strictObject({ learningId: stableId, expectedRevision: revision, reason: learningReasonSchema, idempotencyKey }),
  replaceLearning: z.strictObject({
    learningId: stableId,
    expectedRevision: revision,
    reason: learningReasonSchema,
    replacement: learningReplacementContentSchema,
    idempotencyKey
  })
}

