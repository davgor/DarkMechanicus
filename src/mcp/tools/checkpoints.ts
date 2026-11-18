import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { correctionsInput, createCorrectionsInput, experimentEventInput, sprintReportInput, stableId } from '../../core/schemas'
import type { CommandApi } from '../../shared/domain/api'
import { defineTool, registerTools } from './define'
import { epicId, idempotencyKey, runId, sprintId } from './params'

const CHECKPOINT_TOOLS = [
  defineTool({
    name: 'submit_sprint_report',
    description:
      'Submits the report for the run\'s active sprint: summary, accepted/failed/blocked work, changes (files, commits), checks, risks, follow-up proposals, a result for every exit criterion, and a retro (the sprint review and retrospective). On the final sprint also give epicOutcome with a result for every epic success criterion. The retro holds delivered { ticket, demo, evidence } (what to look at and where), wentWell, wentPoorly, actions (process changes for the next sprint), discoveries { title, body, ticket? } (new work found), leftovers { ticket, reason } (required work not accepted), and tierFit { ticket, verdict: right_sized | oversized | undersized, note } (were the developers sized right). It may also hold experiments, structured improvement experiments beside the prose actions (start from get_retro_findings on an earlier revision), each with every field required: source (the grade it was drawn from: { subject: { level: sprint | run | epic | ticket, id } } names a grade of the scorecard this very submission freezes, so one submission carries the experiments and their scorecard; { reportId, assessmentId } names a grade of an earlier report revision\'s scorecard), concern (the kind of gap, as you judge it: code_defect | plan_context | orchestration_tooling | unavailable_evidence), issue { summary, evidence: [{ kind, id, detail? }] } (a detail is one line with no token, credential or machine path), hypothesis (a hypothesis, not a proven cause), destination { kind: source_repository, repository? (only in a folder of repositories) } or { kind: darkmechanicus_source }, proposedWork [{ title, body?, size? (micro | small | medium | large) }] (work can be scheduled only once every item is sized and its body says what changes), baseline { measure, unit } (the server reads the value from the grade; a unit that is not the measure\'s is refused; E.productive_ms is never decreased: productive effort includes valid exploration), expectedChange { direction: increase | decrease, amount, unit (the baseline\'s or percent) }, guardrails [{ measure, unit, comparator: at_least | at_most, threshold }] and window { basis: sprints | runs | tickets, count }. The server mints each experiment\'s id; give id only to restate an experiment of an earlier revision of this sprint\'s report, citing its original source by { reportId, assessmentId }. An experiment a later revision leaves out is withdrawn. A ticket is a ticket id or display key such as DM-12; one the run\'s plan does not have is refused with `invalid_input`. A sprint with an acceptance node cannot advance until its latest report includes a retro with something in it. The run then waits at the checkpoint (no new claims). A new report revision invalidates any earlier approval and must carry the retro again.',
    kind: 'write',
    input: { runId, sprintId, report: sprintReportInput, idempotencyKey },
    run: (api, input) => api.submitSprintReport(input)
  }),
  defineTool({
    name: 'redraft_next_sprint',
    description:
      'At a checkpoint (the run is awaiting it), rewrites the epic DRAFT from the retro of the run\'s latest report for the active sprint. Each retro leftover moves from the active sprint to the next one, ahead of that sprint\'s acceptance node, together with the tickets of the active sprint that require it, so every prerequisite stays in the same or an earlier sprint; a sprint with its own acceptance node is added after the active one when it is the final sprint. Each discovery is added to the next sprint as an unsized ticket whose references name the ticket it came up on. The acceptance node of the active sprint never moves. A leftover that is an acceptance node, is not in the active sprint, is not in the draft, or was accepted since the report is skipped with a reason, and so is a discovery whose title a ticket already has. Calling it again over the same retro adds nothing (changed is false). Only the draft changes: refine it with update_plan_draft (size and describe the new tickets, set their criteria), check it with validate_plan, then save_plan and adopt_revision; a moved leftover then starts its new sprint with a fresh retry budget. Returns moved, dependentsMoved, added, skipped, droppedDependencies, the sprint ids and ordinals, changed, the draftRevision and the validation. Fails with `run_not_active` (the run is not awaiting its checkpoint), `not_found` (no report for the active sprint), `conflict` (the report has no retro), `run_not_owned`, or `completed_epic`.',
    kind: 'idempotent',
    input: { runId },
    run: (api, input) => api.redraftNextSprint(input)
  }),
  defineTool({
    name: 'preview_corrections',
    description:
      "Read only. Previews the corrective work for selected experiments (experimentIds, xp_…) of a sprint report revision's retro (reportId: the latest revision of its sprint), in the same repository. target: new_sprint (default for an unfinished epic: a sprint appended after the draft's last sprint, with its own acceptance node and a human checkpoint), sprint { sprintId } (an existing future sprint, after the report's sprint and any sprint a run in progress has reached), or follow_up_epic { title? } (the only target of a completed epic: a new backlog epic linked to it). Each experiment is ready, created (already created by an identical request: a repeat adds nothing), conflict (already created by a different request or target) or blocked with its problems (unsized or vague work, finished, a Dark Mechanicus-source destination, which is cross-repository); a blocked one with unsized or vague work carries the restatement to resubmit in the sprint's next report revision (by id, from its original { reportId, assessmentId }). Returns the target, the tickets (one per proposed work item, sized, with acceptance criteria, its dependencies and its correction marker; a Fireguard ticket requiring each of them unless fireguard is false; the sprint's acceptance node with a criterion covering each), the dependencies, the draft revision read, the draft's validation, next steps and notes. edits change a work item's title, body (still specific), acceptanceCriteria or dependsOn (other work of the request, or a ticket of the target draft by id or key) before creation. Nothing is written.",
    kind: 'read',
    input: { ...correctionsInput.shape },
    run: (api, input) => api.previewCorrections(input)
  }),
  defineTool({
    name: 'create_corrections',
    description:
      "Creates the corrective work preview_corrections shows as DRAFT work: in the unfinished epic's draft (a future or appended sprint) or in a new follow-up epic of a completed one (backlog, its draft holding the work, provenance naming the source epic). Takes the same input plus expectedDraftRevision (the draftRevision the preview returned; a newer draft is a `conflict`, and null, when the preview found no draft, makes a draft opened since a `conflict` too). Each experiment is created once under its stable key (source report, experiment, target), which its tickets carry, so renaming them or repeating the request adds nothing (changed false); a different payload for an experiment already created fails with `idempotency_mismatch`, a blocked experiment fails the whole request with `conflict`, and work that would make the plan invalid fails with `invalid_graph`. The source epic's passed sprints, saved revisions, runs, reports and scores never change. Nothing is saved, adopted, started, approved, granted or continued: the person reviews the draft and uses Save, adopt, run and checkpoint controls as usual; then record the experiments as scheduled with record_experiment_event.",
    kind: 'idempotent',
    input: { ...createCorrectionsInput.shape },
    run: (api, input) => api.createCorrections(input)
  }),
  defineTool({
    name: 'get_sprint_report',
    description:
      'Returns the latest submitted report for the run\'s active sprint, or for sprintId when given, with the increment that sprint\'s acceptance node named (increment: the commit, its parent, and whether verification passed; absent when none was named; in a folder of repositories increments instead: one per repository, in name order, and increment is absent). The report holds its retro (null when it has none, as for every report saved before retros) and tierFacts, which the server computes from the attempts and the reporter does not write: for each ticket of the sprint its size, planned level and effort, each attempt\'s model and effort, the attempt and rejection counts, and whether it escalated (a later attempt used a higher model tier or a higher effort than an earlier one). Data is null if none was submitted.',
    kind: 'read',
    input: { runId, sprintId: sprintId.optional() },
    run: (api, input) => api.getSprintReport(input)
  }),
  defineTool({
    name: 'get_retro_findings',
    description:
      'Returns the measured gaps of the scorecard frozen with a sprint report revision (reportId from get_sprint_report), ranked largest first, to write the retro from: failed_verification, delivery_gap, coordination_problem, corrective_concentration, budget_overrun and missing_instrumentation. Each finding states the observed fact with its magnitude (value, reference, ratio, observed or estimated), coverage, origins (attempts, criteria, checks, observations, tickets) and cited evidence, and lists hypotheses, each labeled as one and tagged with a concern: code_defect, plan_context, orchestration_tooling or unavailable_evidence. Metrics never prove a cause, and no finding picks a model or tier. A finding with exactly one candidate concern, no contradicting signal and enough data carries a proposal outline (source { reportId, assessmentId }, baseline measure, direction, guardrails, destination) that holds no work: you write specific, sized proposedWork yourself before an experiment can be scheduled; otherwise withheld says why (multiple_candidate_causes, contradictory_signals, sparse_data, no_baseline). status is findings, no_meaningful_issue (propose nothing) or insufficient_data. Derived from the frozen snapshot on every read, never stored. A report from before scorecards fails with `conflict`.',
    kind: 'read',
    input: {
      reportId: stableId.describe('Report revision id (from get_sprint_report).'),
      reportRevision: z.number().int().min(1).max(1_000_000_000).optional().describe('Optional: the revision number the report id must have.')
    },
    run: (api, input) => api.getRetroFindings(input)
  }),
  defineTool({
    name: 'get_experiment',
    description:
      "Returns an improvement experiment of a sprint retro by id (xp_…): its latest definition and the report revision holding it, its status (proposed until a status event), whether a later revision of its sprint's report withdrew it, executionProblems (why its proposed work cannot be scheduled yet: unsized or vague items; empty when it can), its append-only events, crossRepoResults (for an experiment aimed at the Dark Mechanicus source: what each linked cross-repository correction last brought back from the epic it links, its corrective tickets and frozen grades with { reportId, assessmentId } to cite in record_experiment_event; empty until the person brings them back in the desktop app), and its outcome: the corrective tickets created for it (by correction marker) with the run and attempt that accepted each, when the work landed, the frozen baseline, target and guardrails, and every result compared with the baseline (before/after values, per ticket for a run, sprint or epic total, sample sizes, windows, guardrail verdicts, evidence). classification is improved, unchanged, regressed (moved the expected change the other way, or any guardrail breached) or insufficient_evidence (no result; a missing or estimated value; another unit, policy for a score, or ticket size; a window before the work landed or outside the experiment's; or a guardrail that could not be read). It is observational, never proof of cause; nothing is regraded or written.",
    kind: 'read',
    input: { experimentId: stableId.describe('Experiment id (xp_…), from the retro of get_sprint_report.') },
    run: (api, input) => api.getExperiment(input)
  }),
  defineTool({
    name: 'record_experiment_event',
    description:
      "Records a later status (selected, scheduled, in_progress, completed, abandoned) or measured result of a retro experiment as a new append-only event of the run whose report defines it; no report, content hash or frozen scorecard changes. scheduled, in_progress and completed are refused with `conflict` while any proposed work is unsized or vague (restate the experiment by its id, from its original source { reportId, assessmentId }, with sized, specific work in a new report revision first), and scheduled needs a note saying where the corrective work was planned. A result is read from a frozen assessment { reportId, assessmentId } at the baseline's level, of the experiment's epic or of a follow-up epic holding its corrective work in a saved revision, or stated with its value and at least one evidence reference, in the baseline's unit. For an experiment aimed at the Dark Mechanicus source, a result may also cite a grade of the epic its cross-repository correction created there, once the person brought that epic's grades back in the desktop app (Bring back its grades, on the experiment's Improvement tab): get_experiment lists them under crossRepoResults with each grade's { reportId, assessmentId }, and the recorded result carries that evidence; an unknown report there means its grades were not brought back yet. Recording needs the machine that owns the experiment's run, except a result read from a follow-up epic's grade, which the machine owning that follow-up run may record (`run_not_owned` otherwise). A withdrawn experiment, or a status after completed or abandoned, is refused with `conflict`.",
    kind: 'write',
    input: {
      experimentId: stableId.describe('Experiment id (xp_…).'),
      event: experimentEventInput.shape.event,
      idempotencyKey
    },
    run: (api, input) => api.recordExperimentEvent(input)
  }),
  defineTool({
    name: 'get_checkpoint',
    description:
      'Returns the gate for the active sprint: runState (the run\'s state), conditions (report_submitted, no_active_leases, required_accepted, acceptance_accepted, increment_merged, retro, exit_criteria, epic_outcome on the final sprint, plan_current, approval), gatesMet, canAdvance, and the approval state. A run that ended (runState canceled, failed or completed) has nothing to approve: its approval condition is unmet and says so, and canAdvance is false; do not ask anyone to approve it. acceptance_accepted needs an accepted attempt on the acceptance node of the sprint and says what is missing. increment_merged needs that node\'s accepted (or awaiting-review) submission to have named an increment that the server verified as one squashed commit on the epic branch, and says why not; submit_attempt records the verdict. retro needs the sprint report to include a retro with something in it, and is unmet again when a later report revision leaves the retro out. A sprint with no acceptance node (a plan saved before they existed) has none of these three conditions. plan_current is unmet while the epic\'s draft has unsaved changes (save it and adopt the new revision, or discard it) or a saved revision newer than the run\'s is not adopted (adopt_revision). report_submitted is unmet again when an adopted revision changed the sprint\'s exit criteria or required tickets beyond moving the retro\'s leftovers out: submit a new report revision. Poll this to wait for a person\'s approval. You cannot approve.',
    kind: 'read',
    input: { runId },
    run: (api, input) => api.getCheckpoint(input)
  }),
  defineTool({
    name: 'advance_sprint',
    description:
      'Advances to the next sprint, or completes the run and epic after the final sprint, when every gate is met and the policy\'s authorization exists (a person\'s approval in the desktop app for human checkpoints). Fails with `approval_required` or `gate_blocked` and the reasons; do not retry in a loop, poll get_checkpoint instead.',
    kind: 'write',
    input: { runId, idempotencyKey },
    run: (api, input) => api.advanceSprint(input)
  }),
  defineTool({
    name: 'get_run_events',
    command: 'listEvents',
    description:
      'Reads the append-only event log, oldest first. Pass the cursor from the previous page as sinceSeq to get newer events; filter by runId or epicId. Use it to monitor progress and recover after interruptions.',
    kind: 'read',
    input: {
      runId: runId.optional(),
      epicId: epicId.optional(),
      sinceSeq: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional()
    },
    run: (api, input) => api.listEvents(input)
  })
]

export function registerCheckpointTools(server: McpServer, api: CommandApi): void {
  registerTools(server, api, CHECKPOINT_TOOLS)
}
