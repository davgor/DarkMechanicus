import type { TicketReference } from '../../shared/domain/bundle'
import type { ContextView } from '../../shared/domain/knowledge'
import { requireCapability } from '../authz'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { filePaths, knowledgeContext } from '../knowledge/push'
import type { CommandTable } from './types'

/** The locations of the `file` references of a ticket, as the newest saved revision that holds it records them. */
function ticketFilePaths(ctx: Ctx, ticketId: string): string[] {
  // Every saved ticket has a `references` array (the bundle schema has always required it), so it is never null.
  const row = ctx.db.get<{ references_json: string }>(
    `SELECT json_extract(t.value, '$.references') AS references_json
     FROM plan_revisions p, json_each(p.bundle_json, '$.tickets') t
     WHERE p.state = 'saved' AND json_extract(t.value, '$.id') = ?
     ORDER BY p.number DESC LIMIT 1`,
    ticketId
  )
  if (!row) return fail('not_found', `Ticket ${ticketId} is not in a saved plan.`, { ticketId })
  return filePaths(JSON.parse(row.references_json) as TicketReference[])
}

const knowledgeCommands = {
  getContext: {
    schema: COMMAND_SCHEMAS.getContext,
    mutates: false,
    run: (core, input): Promise<ContextView> => {
      const ctx = core.ctx()
      requireCapability(ctx.session, 'read')
      const paths = [...(input.paths ?? []), ...(input.ticketId === undefined ? [] : ticketFilePaths(ctx, input.ticketId))]
      return knowledgeContext(core, { event: input.event, topics: input.topics, paths, budgetTokens: input.budgetTokens })
    }
  }
} satisfies Partial<CommandTable>

export { knowledgeCommands }
