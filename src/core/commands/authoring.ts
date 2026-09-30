import type { TicketExecutionState } from '../../shared/domain/status'
import type { TicketDetailView } from '../../shared/domain/views'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import type { Ctx } from '../context'
import { createEpic, getEpic, listEpics, setEpicBranch, setEpicStatus } from '../services/epics'
import { discardPlanDraft, openDraft, updatePlanDraft } from '../services/drafts'
import { listAttempts, runExecution } from '../services/execution'
import { getPlan, listRevisions, requestSave, saveResult, validatePlanView } from '../services/plans'
import { getTicket, listTickets, setTicketStatus } from '../services/tickets'
import type { CommandTable, WorkspaceCore } from './types'

function latestRunId(ctx: Ctx, epicId: string): string | null {
  const row = ctx.db.get<{ id: string }>(
    'SELECT id FROM runs WHERE epic_id = ? ORDER BY number DESC LIMIT 1',
    epicId
  )
  return row?.id ?? null
}

/** Adds attempts and per-run execution state to a ticket read (authoring services leave them empty). */
function enrichTicket(ctx: Ctx, detail: TicketDetailView): TicketDetailView {
  const runId = latestRunId(ctx, detail.epicId)
  const snapshot = runId ? runExecution(ctx, runId) : null
  const byTicket = new Map(snapshot?.tickets.map((ticket) => [ticket.ticketId, ticket]) ?? [])
  const stateOf = (ticketId: string): TicketExecutionState | null => byTicket.get(ticketId)?.state ?? null
  return {
    ...detail,
    execution: byTicket.get(detail.ticket.id) ?? null,
    attempts: listAttempts(ctx, { ticketId: detail.ticket.id, epicId: detail.epicId }),
    prerequisites: detail.prerequisites.map((link) => ({ ...link, executionState: stateOf(link.ticketId) })),
    dependents: detail.dependents.map((link) => ({ ...link, executionState: stateOf(link.ticketId) })),
    relations: detail.relations.map((relation) => ({
      ...relation,
      ticket: { ...relation.ticket, executionState: stateOf(relation.ticket.ticketId) }
    }))
  }
}

async function savePlanCommand(
  core: WorkspaceCore,
  input: { epicId: string; expectedDraftRevision: number; idempotencyKey?: string }
): Promise<ReturnType<typeof saveResult>> {
  const ctx = core.ctx()
  const request = requestSave(ctx, input)
  if (request.status === 'unchanged') {
    return {
      status: 'unchanged',
      epicId: input.epicId,
      revisionId: request.revisionId,
      revisionNumber: request.revisionNumber,
      contentHash: request.contentHash,
      error: null
    }
  }
  core.safeFlush()
  return saveResult(ctx, request.revisionId)
}

const authoringCommands = {
  listEpics: { mutates: false, run: (core) => listEpics(core.ctx()) },
  createEpic: {
    schema: COMMAND_SCHEMAS.createEpic,
    mutates: true,
    run: (core, input) => createEpic(core.ctx(), input)
  },
  getEpic: { schema: COMMAND_SCHEMAS.getEpic, mutates: false, run: (core, input) => getEpic(core.ctx(), input) },
  setEpicStatus: {
    schema: COMMAND_SCHEMAS.setEpicStatus,
    mutates: true,
    run: (core, input) => setEpicStatus(core.ctx(), input)
  },
  setEpicBranch: {
    schema: COMMAND_SCHEMAS.setEpicBranch,
    mutates: true,
    run: (core, input) => setEpicBranch(core.ctx(), input)
  },
  getPlan: { schema: COMMAND_SCHEMAS.getPlan, mutates: false, run: (core, input) => getPlan(core.ctx(), input) },
  openDraft: { schema: COMMAND_SCHEMAS.openDraft, mutates: true, run: (core, input) => openDraft(core.ctx(), input) },
  updatePlanDraft: {
    schema: COMMAND_SCHEMAS.updatePlanDraft,
    mutates: true,
    run: (core, input) => updatePlanDraft(core.ctx(), input)
  },
  validatePlan: {
    schema: COMMAND_SCHEMAS.validatePlan,
    mutates: false,
    run: (core, input) => validatePlanView(core.ctx(), input)
  },
  savePlan: { schema: COMMAND_SCHEMAS.savePlan, mutates: false, run: savePlanCommand },
  discardPlanDraft: {
    schema: COMMAND_SCHEMAS.discardPlanDraft,
    mutates: true,
    run: (core, input) => discardPlanDraft(core.ctx(), input)
  },
  listRevisions: {
    schema: COMMAND_SCHEMAS.listRevisions,
    mutates: false,
    run: (core, input) => listRevisions(core.ctx(), input)
  },
  listTickets: {
    schema: COMMAND_SCHEMAS.listTickets,
    mutates: false,
    run: (core, input) => listTickets(core.ctx(), input)
  },
  getTicket: {
    schema: COMMAND_SCHEMAS.getTicket,
    mutates: false,
    run: (core, input) => enrichTicket(core.ctx(), getTicket(core.ctx(), input))
  },
  setTicketStatus: {
    schema: COMMAND_SCHEMAS.setTicketStatus,
    mutates: true,
    run: (core, input) => setTicketStatus(core.ctx(), input)
  }
} satisfies Partial<CommandTable>

export { authoringCommands }
