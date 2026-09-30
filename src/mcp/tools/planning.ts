import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { draftOps, idempotencyKey } from '../../core/schemas'
import type { CommandApi } from '../../shared/domain/api'
import { toDraftOps } from './bridge'
import { defineTool, registerTools } from './define'
import { draftRevision, epicId, revisionId, view } from './params'

const PLANNING_TOOLS = [
  defineTool({
    name: 'get_plan',
    description:
      'Returns the plan bundle: epic, tickets, sprints, dependency edges, policies, rationale. view is required. "saved" is the immutable revision execution uses (optionally a specific revisionId). "draft" is the editable working copy, with its changes since the base and the draftRevision to pass on edits. For large plans prefer list_tickets and get_ticket.',
    kind: 'read',
    input: { epicId, view, revisionId: revisionId.optional() },
    run: (api, input) => api.getPlan(input)
  }),
  defineTool({
    name: 'open_plan_draft',
    description:
      'Ensures the epic has a draft, creating it from the current saved plan if none exists, and returns it with its draftRevision. update_plan_draft also creates the draft implicitly. Not allowed for completed epics.',
    kind: 'idempotent',
    input: { epicId },
    run: (api, input) => api.openDraft(input)
  }),
  defineTool({
    name: 'update_plan_draft',
    description:
      'Applies edit operations to the epic DRAFT atomically: every op succeeds or none does, and a rejected op returns a concrete reason. Ops: set_epic, add_sprint, update_sprint, remove_sprint, add_ticket, update_ticket, remove_ticket, move_ticket, add_dependency, remove_dependency, add_relation, remove_relation, set_policies, set_rationale. Give add_ticket or add_sprint a client ref to refer to it later in the same call; refMap in the result maps refs to stable ids. A dependency {from, to} means `to` requires the accepted result of `from`; a prerequisite must be in the same or an earlier sprint. Pass expectedDraftRevision to detect concurrent edits. The saved plan changes only on save_plan.',
    kind: 'write',
    input: { epicId, ops: draftOps, expectedDraftRevision: draftRevision.optional(), idempotencyKey },
    run: (api, input) => api.updatePlanDraft({ ...input, ops: toDraftOps(input.ops) })
  }),
  defineTool({
    name: 'validate_plan',
    description:
      'Validates the whole plan graph and content. Errors block save_plan (duplicate ids, cycles, a prerequisite in a later sprint, unknown references, invalid policies). Warnings do not (isolated tickets, empty sprints, missing acceptance or success criteria). view is required: validate "draft" before saving.',
    kind: 'read',
    input: { epicId, view },
    run: (api, input) => api.validatePlan(input)
  }),
  defineTool({
    name: 'save_plan',
    description:
      'Validates the whole draft and replaces the saved plan. Requires the session to be launched with --allow-save; otherwise ask the user to press Save in the desktop app. Pass the draftRevision you last read. Result status: saved (durable), pending (still being written; the draft is kept, check get_storage_status), or unchanged. Fails with `invalid_plan`, `stale_draft`, `conflict`, or `branch_changed`.',
    kind: 'write',
    input: { epicId, expectedDraftRevision: draftRevision, idempotencyKey },
    run: (api, input) => api.savePlan(input)
  }),
  defineTool({
    name: 'discard_plan_draft',
    description:
      'Discards the epic\'s unsaved draft and restores the last saved plan (a never-saved epic resets to its initial empty plan). Saved revisions are never affected.',
    kind: 'idempotent',
    input: { epicId, expectedDraftRevision: draftRevision.optional() },
    run: (api, input) => api.discardPlanDraft(input)
  }),
  defineTool({
    name: 'list_revisions',
    description:
      'Lists the epic\'s saved revisions: number, state (pending, saved, failed), content hash, ticket count, and which one is current.',
    kind: 'read',
    input: { epicId },
    run: (api, input) => api.listRevisions(input)
  })
]

export function registerPlanningTools(server: McpServer, api: CommandApi): void {
  registerTools(server, api, PLANNING_TOOLS)
}
