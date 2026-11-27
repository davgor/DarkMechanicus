import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { adoptionReason, metricReports } from '../../core/commandSchemas'
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
  incrementRefs,
  LIMITS,
  rowCheckEntries,
  stableId
} from '../../core/schemas'
import { SKILLS_VERSION } from '../../core/version'
import type { CommandApi } from '../../shared/domain/api'
import { REASONING_EFFORTS, TOOL_CAPABILITIES } from '../../shared/domain/bundle'
import { OVERHEAD_KINDS } from '../../shared/domain/metrics'
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

import { deliveryIntegration } from '../../core/deliveryEvidenceSchema'

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
      'Switches a run to the epic\'s current saved revision. Allowed while the run is running, paused or at a checkpoint, once no attempts are open (wait for in-flight workers to submit, fail or be reconciled; no pause is needed). reason is required: say what failed and what the revision changes; it is recorded masked in the run\'s activity for the person and blocks nothing. Unchanged accepted tickets stay accepted; list changed tickets you want kept in carryForward, the rest need new work. Fails with `run_not_active` (the run is queued or ended), `conflict` (open attempts, not the current saved revision, or a changed ticket in a passed sprint), `invalid_input` (reason missing or shorter than 20 characters), or `run_not_owned`.',
    kind: 'write',
    input: { runId, revisionId, carryForward: z.array(ticketId).max(LIMITS.tickets).optional(), reason: adoptionReason },
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
      'Server-computed readiness for the active sprint: ready, blocked (blockers: prerequisite, row_check_failed, delivery_pending, concurrency, retry_limit, lease_expired, run_state) and in-flight tickets, each with its row, plus the sprint\'s rows with their tickets and latest row check, and capacity. delivery_pending holds a sprint\'s claims until an earlier sprint that declares a delivery has a passing record_delivery check or the person waived it in the desktop app. The acceptance node of a sprint is blocked until every other required ticket of that sprint is accepted, and lists them as its prerequisites. Only ready tickets can be claimed; readiness cannot be bypassed.',
    kind: 'read',
    input: { runId },
    run: (api, input) => api.getReadyTickets(input)
  })
]

const ATTEMPT_TOOLS = [
  defineTool({
    name: 'claim_ticket',
    description:
      'Claims a ready ticket: creates an attempt with a lease and returns a claimToken plus a bounded execution packet (pinned ticket, acceptance criteria, predecessor outputs, epic branch, reporting contract). Record who does the work: worker label, modelId, hostId, catalogRevision, a rationale, and the effort (low, medium, high) you dispatch the worker at; the effort is recorded on the attempt, returned in the execution packet, and kept in run history. Keep the claimToken secret; give it only to the worker doing this ticket. The claimToken is shown once: repeating the call with the same idempotencyKey returns the same attempt and packet with claimToken null, and a lost token cannot be recovered. If no worker got it, free the ticket with fail_attempt without a claimToken (it uses one try); otherwise wait for the lease to expire and reconcile_attempt. Then claim it again with a new idempotencyKey; the old key keeps replaying the lost claim. If the named model cannot take the ticket on the run\'s catalog (it fails a hard requirement, the host lacks a required tool, or the model is unknown), the claim still succeeds: the orchestrator collects the ticket, the attempt is recorded as "Orchestrator (fallback)" with no model and the reasons in its rationale, and the packet carries `fallback` { requestedModelId, reasons }. Fails with `unmet_prerequisite`, `already_claimed`, `capacity_exceeded`, `retry_limit_reached`, `needs_reconciliation`, or `unsupported_capability` (the model does not declare the effort).',
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
      'Submits the result of a claimed attempt: outputs (summary, artifacts, commits, changedFiles, branch) and evidence (checks with results, per-criterion met or not met with notes). Submission does not complete the ticket or unlock dependents; it waits for accept_attempt or reject_attempt. The acceptance node of a sprint also names the sprint increment, increment { branch, commit }: the commit that landed the sprint on the epic branch. With the configured Dark Mechanicus Ticket standards the increment must contain all accepted ticket commits already integrated into the epic branch. Under legacy squash policy it must be one squashed commit (exactly one parent) reachable from the epic branch, not part of the previous sprint\'s increment (for sprint 1: after the epic start commit), and none of the commits recorded by the sprint\'s accepted work may be reachable from the epic branch, which proves the sprint was squashed and not merged. The server verifies that against the repository when the submission arrives and records the verdict on the attempt (increment: passed, reasons, checks), whether it passed or not. A failed verdict does not reject the submission, but the checkpoint\'s increment_merged gate stays unmet until a submission whose increment passed is accepted, so reject a failed one with its reasons and resubmit. A work ticket that names an increment is refused with `invalid_input`, and an acceptance node that names none leaves the gate unmet.',
    kind: 'write',
    input: {
      attemptId,
      claimToken,
      outputs: attemptOutputsInput,
      evidence: attemptEvidenceInput.optional(),
      increment: incrementRef
        .optional()
        .describe('Acceptance nodes of a single repository only. The epic branch and the commit (7 to 64 hex digits) that landed the sprint on it as one squashed commit.'),
      increments: incrementRefs
        .optional()
        .describe(
          'Acceptance nodes of a folder of repositories only, instead of increment: one { repo, branch, commit } per repository the sprint touched (the packet\'s repositories), each verified against that repository\'s history. One failed repository fails the increment; a missing, untouched, unknown or duplicate repository is refused with `invalid_input`.'
        ),
      idempotencyKey
    },
    run: (api, input) => api.submitAttempt(input)
  }),
  defineTool({
    name: 'accept_attempt',
    description:
      'Accepts a submitted attempt after independently verifying each acceptance criterion against the evidence. Under the Dark Mechanicus Ticket standards, pass integration { branch, commit, verification } naming the integrated revision on the bound epic branch and how you verified it. For custom standards record in notes how you verified their requirements. Review the worker’s named tests and coverage first. Completes the ticket and unlocks its dependents. Pass your own per-criterion results in criteria.',
    kind: 'write',
    input: {
      integration: deliveryIntegration.optional(),
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
  }),
  defineTool({
    name: 'record_delivery',
    description:
      'Records a check that a sprint\'s accepted increment was delivered, for a sprint that declares a delivery (target branch, release, verifyInstalled). Run it after the delivering sprint\'s checkpoint approval, once its increment is merged, released and installed, and after `git fetch origin --tags` so the server sees the target branch and tags. The server verifies the claim against the code repository itself, read-only: Delivered commit exists; On the target branch (origin/<target>); Carries the increment (directly or squash-merged); with release, Release tag (the tag contains the commit) and Release version (the tagged package.json version matches the tag); with verifyInstalled, Installed app version (the installed app runs that release or later, as the desktop app observed it on this machine, else as this session\'s server reports it). Add your own observations (for example gh run results) as checks; they are stored after the server\'s. A check that could not be made counts as failed, and a skipped entry is a failed one. A failed verdict is stored and returned, not thrown: fix the cause and record again, never rerun CI to get green. The newest check of the sprint decides; until one passes, the next sprint\'s claims are held (blocker delivery_pending). The person can waive the check in the desktop app. Refusals: unauthorized (not the orchestrator), run_not_owned, run_not_active (the run is not active, or completed with a sprint that is not its last), not_found (sprint not in the pinned plan), unauthorized_transition (the sprint has not passed its checkpoint), invalid_input (the sprint declares no delivery, a folder of repositories, or no accepted passing increment), conflict (the increment or code checkout changed during verification).',
    kind: 'write',
    input: {
      runId,
      sprintId,
      commit: commitHash.describe('Commit hash (7 to 64 hex digits) on the target branch that carries the sprint\'s increment.'),
      releaseTag: z.string().regex(/^v\d+\.\d+\.\d+$/).optional().describe('The release tag (vMAJOR.MINOR.PATCH) that contains the commit; needed when the sprint declares release.'),
      observedInstalledVersion: z
        .string()
        .regex(/^\d+\.\d+\.\d+$/)
        .optional()
        .describe('The installed app version you observed (MAJOR.MINOR.PATCH); it must equal the version the server reads.'),
      checks: rowCheckEntries
        .optional()
        .describe('Your own observations (for example the release workflow\'s gh run): name, status (passed, failed or skipped) and detail.'),
      idempotencyKey
    },
    run: (api, input) => api.recordDelivery(input)
  })
]

const METRIC_TOOLS = [
  defineTool({
    name: 'record_attempt_metrics',
    description:
      'Records measured usage of one attempt: tokens (tokens_input, tokens_cached_input, tokens_output, tokens_reasoning, tokens_total, in tokens), active_ms (milliseconds of active execution, never elapsed or waiting time), corrective_effort_ms, wait_ms, activity_volume, escaped_defect or coordination_defect. A worker passes its claimToken and may report only its own live attempt (another attempt\'s id fails with `stale_claim`, an expired lease with `expired_claim`); report before submitting. An orchestrator or the MCP host it runs may omit the token for any attempt of a run it owns, so a host without a built-in chat adapter can supply actual usage. Each report states its unit and source (agent or host); human ratings, rescue time, planned review or playtesting time (human_review_minutes: a person\'s, human-only) and server-derived measures such as verification and handoff_check fail with `unauthorized`. Delivery is retry-safe: a cumulative report carries its stream sequence (the stream is source.actor), a delta or event its source eventId; resending the same identity changes nothing (listed as unchanged), and the same identity with another value fails with `conflict`. When the agent and its host both report the same delivery (same actor and eventId or sequence), it is counted once and the host\'s report wins. A stream never mixes delta and cumulative, and a cumulative total never goes down. When your host cannot measure a metric, report measurement {state: missing, reason: host_unavailable}; never send 0 for unknown. A coordination_defect must cite a run record in its evidence (an attempt, run, check, report, comment or observation), and one marked as a clarification (attribute kind: clarification) fails with `invalid_input`: a purposeful clarification is not a coordination failure. An escaped_defect record (a defect found after its origin was accepted) names attributes defectEvent (report, duplicate, reassessment, fix, withdrawal), and a report also severity, attribution (attributed, candidate, unassigned) and discoveryPhase, with evidence detail "source build" on the commit it was found in and "origin" on the origin ticket (and, when attributed, its accepted attempt); a later record cites a report with detail "defect". Anything else fails with `invalid_input`. A worker may only add candidate or unassigned reports: an attributed report and every later record change what is charged, so they fail with `unauthorized` unless the session holds attempt.review (an orchestrator), and the attribute authority is set by the server. All reports are stored or none.',
    kind: 'idempotent',
    input: {
      attemptId,
      claimToken: claimToken.optional().describe('The attempt\'s claim token. Required for workers; an orchestrator of the run may omit it.'),
      reports: metricReports.describe('One to 500 reports, stored atomically.')
    },
    run: (api, input) => api.recordAttemptMetrics(input)
  }),
  defineTool({
    name: 'record_run_metrics',
    description:
      'Orchestrator and reviewer only. Records overhead no single attempt owns (orchestration, review or verification tokens and active time, or unattributed usage your host read but could not tie to one attempt through a session link) in the run\'s own bucket, or the bucket of one sprint of the run when sprintId is given, so it is counted once in run totals and never charged to a worker\'s attempt. Each overhead kind is its own bucket: the same actor and eventId under another kind is another delivery. Reports follow the rules of record_attempt_metrics: explicit unit, source agent or host, a sequence for cumulative and an eventId for delta or event reports, retry-safe and atomic; usage nested under an inclusive report elsewhere in the run counts once. Human feedback and server-derived measures fail with `unauthorized`; the run must belong to this machine (`run_not_owned` otherwise).',
    kind: 'idempotent',
    input: {
      runId,
      sprintId: sprintId.optional().describe('A sprint of the run, to keep its overhead in that sprint\'s bucket.'),
      overhead: z.enum(OVERHEAD_KINDS).describe('What the overhead was spent on: orchestration, review, verification, or unattributed (no session link to one attempt).'),
      reports: metricReports.describe('One to 500 reports, stored atomically.')
    },
    run: (api, input) => api.recordRunMetrics(input)
  }),
  defineTool({
    name: 'get_run_metrics',
    description:
      'Reads a run\'s reported usage with its coverage. For each executing attempt (every claimed work attempt, whatever became of it; carry-forward attempts are listed apart and carry none) and for the run overhead bucket (also per overhead kind in overheadByKind, so unattributed usage is shown apart): each token metric in tokens and active_ms in milliseconds, with coverage observed, estimated, partial (some of it reported missing, so the value is a lower bound, or null when a stream still growing has reported no number yet), unavailable (the host said it cannot report it) or unreported, and the value (null when nothing numeric was reported; unknown is never zero). Totals are observed or estimated only when every executing attempt reported fully and the overhead bucket holds no gap; otherwise they are missing (partial_coverage, host_unavailable or not_reported) and reportedValue is only a lower bound. overheadCoverage unreported means the total counts no overhead because none was reported. Cumulative streams count their latest report, deltas add up, a delivery sent by both an agent and its host counts once (the host\'s), and usage nested under an inclusive parent anywhere in the run counts once. includeObservations adds the stored observations with their provenance (source, actor, sourceEvent or sequence, observedAt, recordedAt, evidence), at most 2,000.',
    kind: 'read',
    input: {
      runId,
      attemptId: attemptId.optional().describe('Lists only this attempt\'s observations; the usage tables always cover the whole run.'),
      includeObservations: z.boolean().optional()
    },
    run: (api, input) => api.getRunMetrics(input)
  }),
  defineTool({
    name: 'get_planned_baselines',
    description:
      'Reads each ticket\'s planned budget (tokens in tokens, active time in milliseconds) as frozen baseline versions. A ticket\'s budget is edited in the draft (update_ticket budget) and frozen as a new version, with a bl_ baseline id, when the plan is saved, at the server\'s save time. With runId, budgets are pinned to the run: a dispatched ticket uses the version of the revision it was first claimed under (state frozen), an undispatched one the version of the run\'s revision (state planned). Later saves are listed as prospective versions and never change a dispatched ticket\'s baseline; draft shows an unsaved change against the epic\'s current saved revision. Without runId, the epic\'s current saved revision is used.',
    kind: 'read',
    input: { epicId, runId: runId.optional().describe('Pins the budgets to this run\'s dispatches and revision.') },
    run: (api, input) => api.getPlannedBaselines(input)
  })
]

export function registerExecutionTools(server: McpServer, api: CommandApi): void {
  registerTools(server, api, [...SETUP_TOOLS, ...ATTEMPT_TOOLS, ...RUN_CONTROL_TOOLS, ...METRIC_TOOLS])
}
