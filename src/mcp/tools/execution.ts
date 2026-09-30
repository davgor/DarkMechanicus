import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DomainError } from '../../core/errors'
import {
  attemptEvidenceInput,
  attemptOutputsInput,
  criterionResult,
  epicBranch,
  hostCatalog,
  LIMITS,
  stableId
} from '../../core/schemas'
import { SKILLS_VERSION } from '../../core/version'
import type { CommandApi } from '../../shared/domain/api'
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
    rationale: note.nullable().optional()
  }),
  leaseSeconds: leaseSeconds.optional(),
  idempotencyKey
}

const RUN_CONTROL_TOOLS = [
  defineTool({
    name: 'pause_run',
    description: 'Stops new claims on a run; open attempts may still report. Resume with resume_run.',
    kind: 'idempotent',
    input: { runId, reason: note.optional() },
    run: (api, input) => api.pauseRun(input)
  }),
  defineTool({
    name: 'resume_run',
    description:
      'Resumes a paused run, including a run paused by a branch change once reconcile_repository has run.',
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
      'Registers the models and tools this host can really use, so ticket capability profiles can be matched. Call before start_run, and again with a new catalogRevision when the catalog changes. Do not list models you cannot use.',
    kind: 'write',
    input: hostCatalog.shape,
    run: (api, input) => api.registerHost(input)
  }),
  defineTool({
    name: 'match_capabilities',
    description:
      'Matches a ticket\'s capability profile against the host catalog: eligible models with scores and reasons, rejected models with failures, host failures, and unknownRequirements. Hard constraints filter, preferences only rank. Never treat unknownRequirements as satisfied: ask or escalate.',
    kind: 'read',
    input: { ticketId, runId },
    run: (api, input) => api.matchCapabilities(input)
  }),
  defineTool({
    name: 'start_run',
    description:
      'Starts execution of the epic\'s current SAVED revision (or picks up a run a person queued in the desktop app) and activates sprint 1. One active run per epic. Binds the epic feature branch. Fails with `completed_epic`, `active_run_exists`, or `branch_changed`.',
    kind: 'write',
    input: START_RUN_INPUT,
    run: (api, input) => api.startRun({ ...input, skillVersion: input.skillVersion ?? SKILLS_VERSION })
  }),
  defineTool({
    name: 'get_run',
    description:
      'Returns a run by runId, or the active (else latest) run of an epicId, with per-ticket execution states, attempts, counts, and checkpoint status. Data is null when the epic has never run. Give runId or epicId.',
    kind: 'read',
    input: GET_RUN_INPUT,
    run: getRun
  }),
  defineTool({
    name: 'get_ready_tickets',
    description:
      'Server-computed readiness for the active sprint: ready, blocked (blockers: prerequisite, concurrency, retry_limit, lease_expired, run_state) and in-flight tickets, plus capacity. Only ready tickets can be claimed; readiness cannot be bypassed.',
    kind: 'read',
    input: { runId },
    run: (api, input) => api.getReadyTickets(input)
  })
]

const ATTEMPT_TOOLS = [
  defineTool({
    name: 'claim_ticket',
    description:
      'Claims a ready ticket: creates an attempt with a lease and returns a claimToken plus a bounded execution packet (pinned ticket, acceptance criteria, predecessor outputs, epic branch, reporting contract). Record who does the work: worker label, modelId, hostId, catalogRevision, and a rationale. Keep the claimToken secret; give it only to the worker doing this ticket. Fails with `unmet_prerequisite`, `already_claimed`, `capacity_exceeded`, `retry_limit_reached`, `needs_reconciliation`, or `unsupported_capability`.',
    kind: 'write',
    input: CLAIM_TICKET_INPUT,
    run: (api, input) => api.claimTicket(input)
  }),
  defineTool({
    name: 'heartbeat_attempt',
    description:
      'Extends the lease of your claim while work continues; call it at the packet\'s heartbeatIntervalSeconds. Writes from an expired or superseded claim fail with `expired_claim` or `stale_claim`.',
    kind: 'idempotent',
    input: { attemptId, claimToken, leaseSeconds: leaseSeconds.optional() },
    run: (api, input) => api.heartbeatAttempt(input)
  }),
  defineTool({
    name: 'submit_attempt',
    description:
      'Submits the result of a claimed attempt: outputs (summary, artifacts, commits, changedFiles, branch) and evidence (checks with results, per-criterion met or not met with notes). Submission does not complete the ticket or unlock dependents; it waits for accept_attempt or reject_attempt.',
    kind: 'write',
    input: {
      attemptId,
      claimToken,
      outputs: attemptOutputsInput,
      evidence: attemptEvidenceInput.optional(),
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
  })
]

export function registerExecutionTools(server: McpServer, api: CommandApi): void {
  registerTools(server, api, [...SETUP_TOOLS, ...ATTEMPT_TOOLS, ...RUN_CONTROL_TOOLS])
}
