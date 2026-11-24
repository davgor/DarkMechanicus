import { z } from 'zod'

export const CALLSIGN_ROLES = ['Magos', 'Lexmechanic', 'Acolyte', 'Inquisitor', 'Servitor'] as const
export const callsignSchema = z.strictObject({
  role: z.enum(CALLSIGN_ROLES),
  ticketKey: z.string().regex(/^[A-Za-z0-9]{1,12}-\d{1,9}$/).nullable(),
  ordinal: z.number().int().min(1).max(9999).nullable(),
  purpose: z.string().max(80).nullable(),
  ticketVerified: z.boolean()
})
export type Callsign = z.infer<typeof callsignSchema>

/** Labels are display-only; main resolves identity and verification separately. */
export function formatCallsign(c: Callsign): string {
  if (c.role === 'Magos' || c.role === 'Lexmechanic') return c.role
  if (c.ticketKey !== null) return `${c.role}:${c.ticketKey}`
  if (c.role === 'Servitor' && c.ordinal !== null) return `Servitor-${c.ordinal}`
  return c.role
}
