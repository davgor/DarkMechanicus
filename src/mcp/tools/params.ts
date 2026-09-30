/** Input pieces shared by several tools. Descriptions are published to agents in the tool schemas. */
import { z } from 'zod'
import { entityRef, LIMITS, stableId } from '../../core/schemas'

export const epicId = stableId.describe('Epic id (from list_epics or create_epic).')
export const runId = stableId.describe('Run id (from start_run or get_run).')
export const sprintId = stableId.describe('Sprint id (from get_plan or get_run).')
export const attemptId = stableId.describe('Attempt id (from claim_ticket or get_run).')
export const ticketId = stableId.describe('Ticket stable id (from list_tickets or get_ticket).')
export const revisionId = stableId.describe('Saved revision id (from list_revisions).')

export const ticketRef = entityRef.describe(
  'Ticket stable id, display key such as DM-12, or a client ref declared earlier in the same call.'
)
export const sprintRef = entityRef.describe(
  'Sprint stable id, sprint number such as "1", or a client ref declared earlier in the same call.'
)

export const view = z
  .enum(['saved', 'draft'])
  .describe("'saved' = the current saved revision (what execution uses); 'draft' = the unsaved working copy.")

export const draftRevision = z
  .number()
  .int()
  .min(0)
  .max(1_000_000_000)
  .describe(
    'The draftRevision you last read (get_plan view "draft", open_plan_draft, update_plan_draft). A stale value fails with `conflict` and changes nothing.'
  )

export const expectedRevision = z
  .number()
  .int()
  .min(0)
  .max(1_000_000_000)
  .describe('The revision you last read; a stale value fails with `conflict` and changes nothing.')

export const note = z.string().max(LIMITS.shortText)
export const markdown = z.string().max(LIMITS.markdown)

export const claimToken = z
  .string()
  .min(1)
  .max(300)
  .describe('Secret claim token returned by claim_ticket. Only the worker doing the ticket should hold it.')

export const leaseSeconds = z
  .number()
  .int()
  .min(30)
  .max(86_400)
  .describe('Lease length in seconds; omit to use the plan default.')
