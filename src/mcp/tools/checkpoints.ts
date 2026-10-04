import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { sprintReportInput } from '../../core/schemas'
import type { CommandApi } from '../../shared/domain/api'
import { defineTool, registerTools } from './define'
import { epicId, idempotencyKey, runId, sprintId } from './params'

const CHECKPOINT_TOOLS = [
  defineTool({
    name: 'submit_sprint_report',
    description:
      'Submits the report for the run\'s active sprint: summary, accepted/failed/blocked work, changes (files, commits), checks, risks, follow-up proposals, a result for every exit criterion, and a retro (the sprint review and retrospective). On the final sprint also give epicOutcome with a result for every epic success criterion. The retro holds delivered { ticket, demo, evidence } (what to look at and where), wentWell, wentPoorly, actions (process changes for the next sprint), discoveries { title, body, ticket? } (new work found), leftovers { ticket, reason } (required work not accepted), and tierFit { ticket, verdict: right_sized | oversized | undersized, note } (were the developers sized right). A ticket is a ticket id or display key such as DM-12; one the run\'s plan does not have is refused with `invalid_input`. A sprint with an acceptance node cannot advance until its latest report includes a retro with something in it. The run then waits at the checkpoint (no new claims). A new report revision invalidates any earlier approval and must carry the retro again.',
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
    name: 'get_sprint_report',
    description:
      'Returns the latest submitted report for the run\'s active sprint, or for sprintId when given, with the increment that sprint\'s acceptance node named (increment: the commit, its parent, and whether verification passed; absent when none was named). The report holds its retro (null when it has none, as for every report saved before retros) and tierFacts, which the server computes from the attempts and the reporter does not write: for each ticket of the sprint its size, planned level and effort, each attempt\'s model and effort, the attempt and rejection counts, and whether it escalated (a later attempt used a higher model tier or a higher effort than an earlier one). Data is null if none was submitted.',
    kind: 'read',
    input: { runId, sprintId: sprintId.optional() },
    run: (api, input) => api.getSprintReport(input)
  }),
  defineTool({
    name: 'get_checkpoint',
    description:
      'Returns the gate for the active sprint: conditions (report_submitted, no_active_leases, required_accepted, acceptance_accepted, increment_merged, retro, exit_criteria, epic_outcome on the final sprint, plan_current, approval), gatesMet, canAdvance, and the approval state. acceptance_accepted needs an accepted attempt on the acceptance node of the sprint and says what is missing. increment_merged needs that node\'s accepted (or awaiting-review) submission to have named an increment that the server verified as one squashed commit on the epic branch, and says why not; submit_attempt records the verdict. retro needs the sprint report to include a retro with something in it, and is unmet again when a later report revision leaves the retro out. A sprint with no acceptance node (a plan saved before they existed) has none of these three conditions. plan_current is unmet while the epic\'s draft has unsaved changes (save it and adopt the new revision, or discard it) or a saved revision newer than the run\'s is not adopted (adopt_revision). report_submitted is unmet again when an adopted revision changed the sprint\'s exit criteria or required tickets beyond moving the retro\'s leftovers out: submit a new report revision. Poll this to wait for a person\'s approval. You cannot approve.',
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
