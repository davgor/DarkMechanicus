import type { z } from 'zod'
import type { draftOps, ticketInput } from '../../core/schemas'
import type { DraftOp, TicketInput } from '../../shared/domain/api'

/**
 * The tool schemas (from `core/schemas`) accept partial capability groups, for example only
 * `reasoning.level`, and the core merges them one level deep. The shared `TicketInput` type
 * declares whole groups instead. These two assertions are the only place that difference is
 * bridged; everything else in the parsed values already matches the command types.
 */
export function toTicketInput(ticket: z.output<typeof ticketInput>): TicketInput {
  return ticket as TicketInput
}

export function toDraftOps(ops: z.output<typeof draftOps>): DraftOp[] {
  return ops as DraftOp[]
}

export function toTicketPatch(patch: Partial<z.output<typeof ticketInput>>): Partial<TicketInput> {
  return patch as Partial<TicketInput>
}
