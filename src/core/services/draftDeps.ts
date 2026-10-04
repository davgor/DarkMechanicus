import type { Ctx } from '../context'
import { getMeta, META_KEYS } from '../meta'
import type { DraftDeps } from '../plan/draftOps'
import { type InitialPlanIds, maxKeyNumber } from '../plan/normalize'

const DEFAULT_KEY_PREFIX = 'DM'

/** Every ticket key in every revision and draft of the project; keys never repeat within it. */
function allTicketKeys(ctx: Ctx): string[] {
  return ctx.db
    .all<{ key: string | null }>(
      `SELECT json_extract(t.value, '$.key') AS key FROM plan_revisions p, json_each(p.bundle_json, '$.tickets') t
       UNION ALL
       SELECT json_extract(t.value, '$.key') AS key FROM drafts d, json_each(d.bundle_json, '$.tickets') t`
    )
    .map((row) => row.key ?? '')
}

/** Id and key allocation for the tickets and sprints a draft edit creates. */
export function draftDeps(ctx: Ctx): DraftDeps {
  const prefix = getMeta(ctx.db, META_KEYS.keyPrefix) ?? DEFAULT_KEY_PREFIX
  let next: number | null = null
  return {
    newId: (kind) => ctx.ids.next(kind),
    nextKey: () => {
      const number = next ?? maxKeyNumber(allTicketKeys(ctx)) + 1
      next = number + 1
      return `${prefix}-${number}`
    }
  }
}

/** Identities for a new plan's first sprint and its acceptance node, with the next free ticket key. */
export function initialPlanIds(ctx: Ctx): InitialPlanIds {
  const deps = draftDeps(ctx)
  return { sprintId: deps.newId('sprint'), ticketId: deps.newId('ticket'), ticketKey: deps.nextKey() }
}
