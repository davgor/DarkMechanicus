import { z } from 'zod'
import {
  attemptEvidenceInput,
  attemptOutputsInput,
  capabilityProfile,
  commentBody,
  criterionInput,
  criterionResult,
  draftOps,
  entityRef,
  epicBranch,
  hostCatalog,
  idempotencyKey,
  LIMITS,
  profileName,
  sprintReportInput,
  stableId,
  workStatus
} from './schemas'

/**
 * Input schemas for every command that takes input. The Workspace parses raw MCP/IPC payloads
 * with these before any service runs; they are the trust boundary for both entry points.
 */
const view = z.enum(['saved', 'draft'])
const revision = z.number().int().min(0).max(1_000_000_000)
const note = z.string().max(LIMITS.shortText)
const claimToken = z.string().min(1).max(300)
const leaseSeconds = z.number().int().min(30).max(86_400)
const epicRef = z.strictObject({ epicId: stableId })
const runRef = z.strictObject({ runId: stableId })

export const COMMAND_SCHEMAS = {
  initializeRepository: z.strictObject({
    name: z.string().min(1).max(200).optional(),
    keyPrefix: z.string().regex(/^[A-Z][A-Z0-9]{0,11}$/).optional()
  }),
  searchHistory: z.strictObject({
    query: z.string().max(500),
    limit: z.number().int().min(1).max(100).optional(),
    epicId: stableId.optional()
  }),
  backupDatabase: z.strictObject({
    targetPath: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,100}\.sqlite$/, 'Backups are written to .darkmechanicus/local/backups; give a file name only')
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
  addComment: z.strictObject({ epicId: stableId, ticketId: stableId.optional(), body: commentBody, idempotencyKey }),
  listComments: z.strictObject({ epicId: stableId, ticketId: stableId.optional() }),
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
      rationale: note.nullable().optional()
    }),
    leaseSeconds: leaseSeconds.optional(),
    idempotencyKey
  }),
  heartbeatAttempt: z.strictObject({ attemptId: stableId, claimToken, leaseSeconds: leaseSeconds.optional() }),
  submitAttempt: z.strictObject({
    attemptId: stableId,
    claimToken,
    outputs: attemptOutputsInput,
    evidence: attemptEvidenceInput.optional(),
    idempotencyKey
  }),
  acceptAttempt: z.strictObject({
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
  pauseRun: z.strictObject({ runId: stableId, reason: note.optional() }),
  resumeRun: runRef,
  cancelRun: z.strictObject({ runId: stableId, reason: note.optional() }),
  takeoverRun: runRef,
  adoptRevision: z.strictObject({
    runId: stableId,
    revisionId: stableId,
    carryForward: z.array(stableId).max(LIMITS.tickets).optional()
  }),
  submitSprintReport: z.strictObject({
    runId: stableId,
    sprintId: stableId,
    report: sprintReportInput,
    idempotencyKey
  }),
  getSprintReport: z.strictObject({ runId: stableId, sprintId: stableId.optional() }),
  getCheckpoint: runRef,
  approveCheckpoint: z.strictObject({ runId: stableId, reportId: stableId }),
  advanceSprint: z.strictObject({ runId: stableId, idempotencyKey }),
  approveAndAdvance: z.strictObject({ runId: stableId, reportId: stableId, idempotencyKey }),
  authorizeAutoContinue: z.strictObject({ runId: stableId, enabled: z.boolean() }),
  grantRetry: z.strictObject({ runId: stableId, ticketId: stableId }),
  listEvents: z.strictObject({
    sinceSeq: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    epicId: stableId.optional(),
    runId: stableId.optional()
  })
}

