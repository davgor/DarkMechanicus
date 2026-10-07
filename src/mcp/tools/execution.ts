import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DomainError } from '../../core/errors'
import {
  attemptEvidenceInput,
  attemptOutputsInput,
  commitHash,
  criterionResult,
  epicBranch,
  heartbeatProgress,
  hostCatalog,
  incrementRef,
  LIMITS,
  rowCheckEntries,
  stableId
} from '../../core/schemas'
import { SKILLS_VERSION } from '../../core/version'
import type { CommandApi } from '../../shared/domain/api'
import { REASONING_EFFORTS, TOOL_CAPABILITIES } from '../../shared/domain/bundle'
import { defineTool, registerTools } from './define'
import {
  attemptId,
  claimToken,
  epicId,
  idempotencyKey,
  leaseSeconds,
  markdown,
  note,
  revisionId,
  runId,
  sprintId,
  ticketId
} from './params'

const optionalLabel = z.string().max(LIMITS.label).nullable().optional()

const START_RUN_INPUT = {
  epicId,
  host: z
    .strictObject({ label: z.string().min(1).max(LIMITS.label), type: z.string().min(1).max(LIMITS.label) })
    .nullable()
    .optional()
    .describe('Label and type of the agent host running this orchestration.'),
  hostCatalogId: stableId.nullable().optional().describe('Catalog id returned by register_host.'),
  skillVersion: z
    .string()
    .max(50)
    .nullable()
    .optional()
    .describe('Version of the skills you follow; defaults to the version this server ships.'),
  branch: epicBranch.nullable().optional().describe('Epic feature branch; defaults to the current checkout branch and HEAD.'),
  carryForward: z
    .array(z.strictObject({ ticketId, note }))
    .max(LIMITS.tickets)
    .optional()
    .describe('Tickets completed by an earlier run that stay valid, each with a note.'),
  idempotencyKey
}

const GET_RUN_INPUT = { runId: runId.optional(), epicId: epicId.optional() }

function getRun(api: CommandApi, input: z.output<z.ZodObject<typeof GET_RUN_INPUT>>): Promise<unknown> {
  if (input.runId === undefined && input.epicId === undefined) {
    throw new DomainError('invalid_input', 'Give runId or epicId.')
  }
  return api.getRun(input)
}

const CLAIM_TICKET_INPUT = {
  runId,
  ticketId,
  worker: z.strictObject({
    label: z.string().min(1).max(LIMITS.label),
    modelId: optionalLabel,
    hostId: optionalLabel,
    catalogRevision: optionalLabel,
    rationale: note.nullable().optional(),
    effort: z
      .enum(REASONING_EFFORTS)
      .nullable()
      .optional()
      .describe(
        'Reasoning effort (low, medium, high) the worker is dispatched at. Refused when the model declares efforts and this is not one of them.'
      )
  }),
  leaseSeconds: leaseSeconds.optional(),
  idempotencyKey
}

const HEARTBEAT_PROGRESS = z
  .strictObject({
    note: heartbeatProgress.shape.note.describe(
      `What you did or are doing, in a sentence or two (at most ${LIMITS.progressNote} characters).`
    ),
    step: heartbeatProgress.shape.step.describe(
      `Optional short label for the phase of work, such as "testing" (at most ${LIMITS.progressStep} characters).`
    )
  })
  .describe('Optional progress note that shows what you are doing; it is stored with this attempt.')

const HEARTBEAT_LEASE = leaseSeconds.describe(
  'Lease length in seconds from now; omit to keep the length of the lease the claim holds (what claim_ticket or your last heartbeat granted).'
)

const RUN_CONTROL_TOOLS = [
  defineTool({
    name: 'pause_run',
    description:
      'Stops new claims on a run; open attempts may still report. Resume with resume_run. The reason "signed_out" is reserved for the desktop app and fails with unauthorized here.',
    kind: 'idempotent',
    input: { runId, reason: note.optional() },
    run: (api, input) => api.pauseRun(input)
  }),
  defineTool({
    name: 'resume_run',
    description:
      'Resumes a paused run, including a run paused by a branch change once reconcile_repository has run. A run paused with the reason "signed_out" (its agent was signed out) is not yours to resume: the person resumes it in the desktop app, and this fails with unauthorized.',
    kind: 'idempotent',
    input: { runId },
    run: (api, input) => api.resumeRun(input)
  }),
  defineTool({
    name: 'cancel_run',
    description:
      'Cancels the run and its open attempts. Terminal and destructive: use only when a person asks for it or the run cannot continue.',
    kind: 'destructive',
    input: { runId, reason: note.optional() },
    run: (api, input) => api.cancelRun(input)
  }),
  defineTool({
    name: 'takeover_run',
    description:
      'Takes ownership of a run imported from another machine; until then execution commands fail with `run_not_owned`. Marks leased attempts lease_expired (each needs reconcile_attempt) and pauses the run.',
    kind: 'idempotent',
    input: { runId },
    run: (api, input) => api.takeoverRun(input)
  }),
  defineTool({
    name: 'adopt_revision',
    description:
      'Switches a run to a newer saved revision. Allowed only at a checkpoint or while paused, with no open attempts. Unchanged accepted tickets stay accepted; list changed tickets you want kept in carryForward, the rest need new work.',
    kind: 'write',
    input: { runId, revisionId, carryForward: z.array(ticketId).max(LIMITS.tickets).optional() },
    run: (api, input) => api.adoptRevision(input)
  })
]

const SETUP_TOOLS = [
  defineTool({
    name: 'register_host',
    description:
      `Registers the models and tools this host can really use, so ticket capability profiles can be matched. List tools by the names capability profiles require: ${TOOL_CAPABILITIES.join(', ')}; any other name is refused with \`invalid_input\`. Returns the catalog id to pass as hostCatalogId to start_run. Call it before start_run, and again with a new catalogRevision when the catalog changes. Do not list models you cannot use. A model may list the efforts (low, medium, high) it can run at in efforts; a claim at an effort the model does not list is refused, and a model that lists none accepts any effort.`,
    kind: 'write',
    input: hostCatalog.shape,
    run: (api, input) => api.registerHost(input)
  }),
  defineTool({
    name: 'match_capabilities',
    description:
      'Matches a ticket\'s capability profile against the host catalog of the run: eligible models best fit first, with scores and reasons (the model that fits the ticket leads; extra reasoning depth costs points, and on equal scores the cheaper cost tier comes first), rejected models with failures, host failures, and unknownRequirements. recommended is the model and effort to dispatch at, with reasons: the top fit at the ticket\'s effort (else low for micro and small tickets, medium for medium, high for large), or, after a rejected or failed attempt on the ticket in this run, the cheapest eligible model one tier above the last attempt\'s model (the same model at a higher effort when nothing sits above it). recommended is null when no model is eligible. Hard constraints filter, preferences only rank. Never treat unknownRequirements as satisfied: ask or escalate.',
    kind: 'read',
    input: { ticketId, runId },
    run: (api, input) => api.matchCapabilities(input)
  }),
  defineTool({
    name: 'start_run',
    description:
      'Starts execution of the epic\'s current SAVED revision (or picks up a run a person queued in the desktop app) and activates sprint 1. One active run per epic. Binds the epic feature branch: the branch you pass, else the current checkout branch and HEAD. Fails with `completed_epic`, `active_run_exists`, or `branch_changed`.',
    kind: 'write',
    input: START_RUN_INPUT,
    run: (api, input) => api.startRun({ ...input, skillVersion: input.skillVersion ?? SKILLS_VERSION })
  }),
  defineTool({
    name: 'get_run',
    description:
      'Returns a run by runId, or the active (else latest) run of an epicId, with per-ticket execution states (each with its row), the rows of every sprint with their tickets and latest row check, the increment the acceptance node of each sprint named (increments: commit, parent, whether it passed verification and why not), attempts, counts, and checkpoint status. The acceptance node of a sprint is listed with every other required ticket of that sprint as its prerequisites. Data is null when the epic has never run. Give runId or epicId.',
    kind: 'read',
    input: GET_RUN_INPUT,
    run: getRun
  }),
  defineTool({
    name: 'get_ready_tickets',
    description:
      'Server-computed readiness for the active sprint: ready, blocked (blockers: prerequisite, row_check_failed, concurrency, retry_limit, lease_expired, run_state) and in-flight tickets, each with its row, plus the sprint\'s rows with their tickets and latest row check, and capacity. The acceptance node of a sprint is blocked until every other required ticket of that sprint is accepted, and lists them as its prerequisites. Only ready tickets can be claimed; readiness cannot be bypassed.',
    kind: 'read',
    input: { runId },
    run: (api, input) => api.getReadyTickets(input)
  })
]

const ATTEMPT_TOOLS = [
  defineTool({
    name: 'claim_ticket',
    description:
      'Claims a ready ticket: creates an attempt with a lease and returns a claimToken plus a bounded execution packet (pinned ticket, acceptance criteria, predecessor outputs, epic branch, reporting contract). Record who does the work: worker label, modelId, hostId, catalogRevision, a rationale, and the effort (low, medium, high) you dispatch the worker at; the effort is recorded on the attempt, returned in the execution packet, and kept in run history. Keep the claimToken secret; give it only to the worker doing this ticket. If the named model cannot take the ticket on the run\'s catalog (it fails a hard requirement, the host lacks a required tool, or the model is unknown), the claim still succeeds: the orchestrator collects the ticket, the attempt is recorded as "Orchestrator (fallback)" with no model and the reasons in its rationale, and the packet carries `fallback` { requestedModelId, reasons }. Fails with `unmet_prerequisite`, `already_claimed`, `capacity_exceeded`, `retry_limit_reached`, `needs_reconciliation`, or `unsupported_capability` (the model does not declare the effort).',
    kind: 'write',
    input: CLAIM_TICKET_INPUT,
    run: (api, input) => api.claimTicket(input)
  }),
  defineTool({
    name: 'heartbeat_attempt',
    description:
      'Extends the lease of your claim while work continues; call it at the packet\'s heartbeatIntervalSeconds. Without leaseSeconds, the lease is extended by the length of the lease the claim holds (what claim_ticket or your last heartbeat granted, not the plan default), so a long claim stays long; pass leaseSeconds to change that length. Add `progress` { note, step? } to show your work: a short note (at most 280 characters) with an optional step label such as "testing". Notes are local working data: the server keeps the last 200 per attempt, never exports them with the run history, and masks anything shaped like a claim token before storing a note. A refused heartbeat stores no note. Writes from an expired or superseded claim fail with `expired_claim` or `stale_claim`.',
    kind: 'idempotent',
    input: { attemptId, claimToken, leaseSeconds: HEARTBEAT_LEASE.optional(), progress: HEARTBEAT_PROGRESS.optional() },
    run: (api, input) => api.heartbeatAttempt(input)
  }),
  defineTool({
    name: 'submit_attempt',
    description:
      'Submits the result of a claimed attempt: outputs (summary, artifacts, commits, changedFiles, branch) and evidence (checks with results, per-criterion met or not met with notes). Submission does not complete the ticket or unlock dependents; it waits for accept_attempt or reject_attempt. The acceptance node of a sprint also names the sprint increment, increment { branch, commit }: the commit that landed the sprint on the epic branch. It must be one squashed commit (exactly one parent) reachable from the epic branch, not part of the previous sprint\'s increment (for sprint 1: after the epic start commit), and none of the commits recorded by the sprint\'s accepted work may be reachable from the epic branch, which proves the sprint was squashed and not merged. The server verifies that against the repository when the submission arrives and records the verdict on the attempt (increment: passed, reasons, checks), whether it passed or not. A failed verdict does not reject the submission, but the checkpoint\'s increment_merged gate stays unmet until a submission whose increment passed is accepted, so reject a failed one with its reasons and resubmit. A work ticket that names an increment is refused with `invalid_input`, and an acceptance node that names none leaves the gate unmet.',
    kind: 'write',
    input: {
      attemptId,
      claimToken,
      outputs: attemptOutputsInput,
      evidence: attemptEvidenceInput.optional(),
      increment: incrementRef
        .optional()
        .describe('Acceptance nodes only. The epic branch and the commit (7 to 64 hex digits) that landed the sprint on it as one squashed commit.'),
      idempotencyKey
    },
    run: (api, input) => api.submitAttempt(input)
  }),
  defineTool({
    name: 'accept_attempt',
    description:
      'Accepts a submitted attempt after independently verifying each acceptance criterion against the evidence. Completes the ticket and unlocks its dependents. Pass your own per-criterion results in criteria.',
    kind: 'write',
    input: {
      attemptId,
      notes: markdown.optional(),
      criteria: z.array(criterionResult).max(LIMITS.criteria).optional(),
      idempotencyKey
    },
    run: (api, input) => api.acceptAttempt(input)
  }),
  defineTool({
    name: 'reject_attempt',
    description:
      'Rejects a submitted attempt with actionable reasons (what is missing or wrong, and how to fix it). The ticket stays retryable until the retry limit.',
    kind: 'write',
    input: {
      attemptId,
      reasons: z.array(z.string().min(1).max(LIMITS.shortText)).min(1).max(LIMITS.listItems),
      notes: markdown.optional(),
      idempotencyKey
    },
    run: (api, input) => api.rejectAttempt(input)
  }),
  defineTool({
    name: 'fail_attempt',
    description:
      'Reports that the attempt failed or is blocked (reason, details, retryable) instead of submitting incomplete work. Dependents stay blocked; when retries are exhausted the plan\'s onTicketFailure policy applies. The claim holder passes claimToken.',
    kind: 'write',
    input: {
      attemptId,
      claimToken: claimToken.optional(),
      failure: z.strictObject({
        reason: z.string().min(1).max(LIMITS.shortText),
        details: markdown.optional(),
        retryable: z.boolean().optional()
      }),
      idempotencyKey
    },
    run: (api, input) => api.failAttempt(input)
  }),
  defineTool({
    name: 'reconcile_attempt',
    description:
      'Resolves an attempt whose lease expired (execution is uncertain, not failed). Inspect the branch and workspace first, then "abandon" (treat as not done; the ticket can be claimed again) or "resubmit" with outputs and evidence for work that finished. Required before any retry of that ticket.',
    kind: 'write',
    input: {
      attemptId,
      resolution: z.enum(['abandon', 'resubmit']),
      outputs: attemptOutputsInput.optional(),
      evidence: attemptEvidenceInput.optional(),
      notes: markdown.optional()
    },
    run: (api, input) => api.reconcileAttempt(input)
  }),
  defineTool({
    name: 'carry_forward_ticket',
    description:
      'Records that a ticket completed by an earlier run remains valid in this run, with an explicit note. Use it after adopt_revision for changed tickets, or when re-running over completed work.',
    kind: 'write',
    input: { runId, ticketId, note: z.string().min(1).max(LIMITS.shortText) },
    run: (api, input) => api.carryForwardTicket(input)
  }),
  defineTool({
    name: 'record_row_check',
    description:
      'Records your check that one row of a sprint combined cleanly. A row is the tickets of a sprint at the same same-sprint dependency depth: row 1 has no same-sprint prerequisites, and get_run and get_ready_tickets list every ticket\'s row and each row\'s tickets and latest check. Integrate the row\'s accepted work, run the checks on the combined result, then record them with the commit they ran at. The check passes only when every entry in checks has status passed; a failed or skipped entry fails it. While a row\'s latest check has not passed, every ticket that requires a ticket of that row is held back (state waiting, blocker row_check_failed), and a later passing check clears the hold. Other tickets stay claimable: there is no barrier between rows. Fails with `not_found` (the sprint is not in the run\'s plan), `invalid_input` (the sprint has no such row), `run_not_owned`, or `run_not_active`.',
    kind: 'write',
    input: {
      runId,
      sprintId,
      row: z.number().int().min(1).max(LIMITS.tickets).describe('Row number within the sprint, counted from 1.'),
      commit: commitHash.describe('Commit hash (7 to 64 hex digits) the row\'s combined work was checked at.'),
      checks: rowCheckEntries.describe('What you ran on the combined work: name, status (passed, failed or skipped) and detail. At least one entry.'),
      idempotencyKey
    },
    run: (api, input) => api.recordRowCheck(input)
  })
]

export function registerExecutionTools(server: McpServer, api: CommandApi): void {
  registerTools(server, api, [...SETUP_TOOLS, ...ATTEMPT_TOOLS, ...RUN_CONTROL_TOOLS])
}
