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
      'Submits the report for the run\'s active sprint: summary, accepted/failed/blocked work, changes (files, commits), checks, risks, follow-up proposals, and a result for every exit criterion. On the final sprint also give epicOutcome with a result for every epic success criterion. The run then waits at the checkpoint (no new claims). A new report revision invalidates any earlier approval.',
    kind: 'write',
    input: { runId, sprintId, report: sprintReportInput, idempotencyKey },
    run: (api, input) => api.submitSprintReport(input)
  }),
  defineTool({
    name: 'get_sprint_report',
    description:
      'Returns the latest submitted report for the run\'s active sprint, or for sprintId when given. Data is null if none was submitted.',
    kind: 'read',
    input: { runId, sprintId: sprintId.optional() },
    run: (api, input) => api.getSprintReport(input)
  }),
  defineTool({
    name: 'get_checkpoint',
    description:
      'Returns the gate for the active sprint: conditions (report_submitted, no_active_leases, required_accepted, exit_criteria, epic_outcome on the final sprint, approval), gatesMet, canAdvance, and the approval state. Poll this to wait for a person\'s approval. You cannot approve.',
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
