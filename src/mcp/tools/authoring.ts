import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DomainError } from '../../core/errors'
import { criterionInput, epicBranch, LIMITS, ticketInput, workStatus } from '../../core/schemas'
import type { CommandApi } from '../../shared/domain/api'
import { toTicketInput, toTicketPatch } from './bridge'
import { defineArglessTool, defineTool, registerTools } from './define'
import {
  draftRevision,
  epicId,
  expectedRevision,
  idempotencyKey,
  markdown,
  note,
  sprintRef,
  ticketId,
  ticketRef,
  view
} from './params'

/** Client ref given to the ticket that create_ticket adds, so prerequisite edges can point at it. */
const NEW_TICKET_REF = 'new'

const CREATE_TICKET_INPUT = {
  epicId,
  sprint: sprintRef.default('1'),
  ticket: ticketInput,
  requires: z
    .array(ticketRef)
    .max(100)
    .optional()
    .describe('Prerequisite tickets: the new ticket requires each one to be accepted first.'),
  expectedDraftRevision: draftRevision.optional(),
  idempotencyKey
}

async function createTicket(
  api: CommandApi,
  input: z.output<z.ZodObject<typeof CREATE_TICKET_INPUT>>
): Promise<{ ticketId: string; draftRevision: number; validation: unknown }> {
  const prerequisites = (input.requires ?? []).map((from) => ({
    op: 'add_dependency' as const,
    from,
    to: NEW_TICKET_REF
  }))
  const result = await api.updatePlanDraft({
    epicId: input.epicId,
    ops: [
      { op: 'add_ticket', ref: NEW_TICKET_REF, sprint: input.sprint, ticket: toTicketInput(input.ticket) },
      ...prerequisites
    ],
    expectedDraftRevision: input.expectedDraftRevision,
    idempotencyKey: input.idempotencyKey
  })
  const created = result.refMap[NEW_TICKET_REF]
  if (created === undefined) {
    throw new DomainError('internal', 'The draft update did not report the id of the new ticket.')
  }
  return { ticketId: created, draftRevision: result.draftRevision, validation: result.validation }
}

const UPDATE_TICKET_INPUT = {
  epicId,
  ticket: ticketRef,
  patch: ticketInput
    .partial()
    .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one field to change.')
    .describe('Fields to change; omitted fields keep their value. acceptanceCriteria replaces the whole list.'),
  expectedDraftRevision: draftRevision.optional(),
  idempotencyKey
}

const AUTHORING_TOOLS = [
  defineArglessTool({
    name: 'list_epics',
    description:
      'Lists epics with status (backlog, in_progress, completed), saved revision, draft presence, ticket and sprint counts, and the active run summary.',
    kind: 'read',
    run: (api) => api.listEpics()
  }),
  defineTool({
    name: 'create_epic',
    description:
      'Creates an epic in Backlog with an empty draft plan (one sprint). It has no saved revision until the first save_plan. Write success criteria as checkable statements. To redo or extend completed work, create a NEW epic and set provenance to the source epic; never copy completion state. branch records the epic feature branch.',
    kind: 'write',
    input: {
      title: z.string().min(1).max(LIMITS.title),
      intent: markdown.optional().describe('Markdown: the outcome wanted and why.'),
      successCriteria: z.array(criterionInput).max(LIMITS.criteria).optional(),
      ownerRole: z.string().max(LIMITS.label).nullable().optional(),
      branch: epicBranch.nullable().optional(),
      provenance: z
        .strictObject({ sourceEpicId: epicId, note: note.optional() })
        .nullable()
        .optional()
        .describe('Link to the epic this one redoes or extends.'),
      idempotencyKey
    },
    run: (api, input) => api.createEpic(input)
  }),
  defineTool({
    name: 'get_epic',
    description:
      'Returns one epic: intent, success criteria, owner role, branch, provenance, status, and its recorded outcome once completed.',
    kind: 'read',
    input: { epicId },
    run: (api, input) => api.getEpic(input)
  }),
  defineTool({
    name: 'set_epic_status',
    description:
      'Sets an epic to backlog or in_progress. completed is accepted only when the final-sprint checkpoint rules are already satisfied (normally reached by advance_sprint) and is terminal: completed epics are read-only. in_progress returns to backlog only while no run is active.',
    kind: 'idempotent',
    input: { epicId, status: workStatus, expectedRevision: expectedRevision.optional() },
    run: (api, input) => api.setEpicStatus(input)
  }),
  defineTool({
    name: 'set_epic_branch',
    description:
      'Records the epic feature branch (repository, branch name, start commit). Workers integrate into this branch, never directly into the default branch. Rejected for completed epics.',
    kind: 'idempotent',
    input: { epicId, branch: epicBranch, expectedRevision: expectedRevision.optional() },
    run: (api, input) => api.setEpicBranch(input)
  }),
  defineTool({
    name: 'list_tickets',
    description:
      'Lists an epic\'s tickets with key, title, status, sprint, priority, and tags. view "saved" (default) is what execution uses; "draft" includes unsaved edits.',
    kind: 'read',
    input: { epicId, view: view.default('saved') },
    run: (api, input) => api.listTickets(input)
  }),
  defineTool({
    name: 'get_ticket',
    description:
      'Returns one ticket: Markdown body, acceptance criteria, capability profile, prerequisites, dependents, and (saved view) execution state and attempts. ticketId accepts a stable id or a display key such as DM-12.',
    kind: 'read',
    input: { epicId, ticketId: ticketRef, view: view.default('saved') },
    run: (api, input) => api.getTicket(input)
  }),
  defineTool({
    name: 'create_ticket',
    description:
      'Convenience: adds one ticket to the epic DRAFT in a single atomic update. sprint is a sprint number ("1"), id, or client ref. requires lists prerequisites (ids or keys): the new ticket needs their accepted results, and prerequisites must sit in the same or an earlier sprint. Returns the new ticketId, the draftRevision, and validation. Nothing executes until save_plan.',
    kind: 'write',
    input: CREATE_TICKET_INPUT,
    run: createTicket
  }),
  defineTool({
    name: 'update_ticket',
    description:
      'Edits a ticket in the DRAFT; only the fields in patch change (capability groups merge one level deep). Keep criterion ids in acceptanceCriteria to preserve evidence mappings. The saved plan is unchanged until save_plan.',
    kind: 'write',
    input: UPDATE_TICKET_INPUT,
    run: (api, input) =>
      api.updatePlanDraft({
        epicId: input.epicId,
        ops: [{ op: 'update_ticket', ticket: input.ticket, patch: toTicketPatch(input.patch) }],
        expectedDraftRevision: input.expectedDraftRevision,
        idempotencyKey: input.idempotencyKey
      })
  }),
  defineTool({
    name: 'set_ticket_status',
    description:
      'Sets a ticket status on the saved plan: backlog or in_progress. completed is accepted only when an accepted attempt or carry-forward exists in the epic\'s active or latest run, so it cannot bypass review.',
    kind: 'idempotent',
    input: { ticketId, status: workStatus, expectedRevision: expectedRevision.optional() },
    run: (api, input) => api.setTicketStatus(input)
  })
]

export function registerAuthoringTools(server: McpServer, api: CommandApi): void {
  registerTools(server, api, AUTHORING_TOOLS)
}
