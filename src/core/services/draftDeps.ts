import type { Ctx } from '../context'
import { getMeta, META_KEYS } from '../meta'
import type { DraftDeps } from '../plan/draftOps'
import { type InitialPlanIds, maxKeyNumber } from '../plan/normalize'
import { ticketAttachmentRefs } from './ticketAttachments'

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

/** Every key the project has handed out: every plan ticket key, and every Kanban card key, which share one sequence. */
function allProjectKeys(ctx: Ctx): string[] {
  const cardKeys = ctx.db.all<{ key: string }>('SELECT key FROM kanban_cards').map((row) => row.key)
  return [...allTicketKeys(ctx), ...cardKeys]
}

/** The next free key of the project's ticket sequence, for a new Kanban card. */
export function nextProjectKey(ctx: Ctx): string {
  const prefix = getMeta(ctx.db, META_KEYS.keyPrefix) ?? DEFAULT_KEY_PREFIX
  return `${prefix}-${maxKeyNumber(allProjectKeys(ctx)) + 1}`
}

/**
 * Id and key allocation for the tickets and sprints a draft edit creates, the project's repositories, and the refs of
 * the images a ticket names. `epicId` is the epic whose draft is edited: the draft ops check that draft themselves.
 */
export function draftDeps(ctx: Ctx, epicId?: string): DraftDeps {
  const prefix = getMeta(ctx.db, META_KEYS.keyPrefix) ?? DEFAULT_KEY_PREFIX
  let next: number | null = null
  return {
    newId: (kind) => ctx.ids.next(kind),
    nextKey: () => {
      const number = next ?? maxKeyNumber(allProjectKeys(ctx)) + 1
      next = number + 1
      return `${prefix}-${number}`
    },
    repositories: () => ctx.repositories(),
    attachmentRefs: (ids, ticketId) => ticketAttachmentRefs(ctx.db, { ids, ticketId, epicId })
  }
}

/** Identities for a new plan's first sprint and its acceptance node, with the next free ticket key. */
export function initialPlanIds(ctx: Ctx): InitialPlanIds {
  const deps = draftDeps(ctx)
  return { sprintId: deps.newId('sprint'), ticketId: deps.newId('ticket'), ticketKey: deps.nextKey() }
}
