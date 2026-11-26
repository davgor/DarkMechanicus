import { z } from 'zod'
import type { ChatRole } from './chat'

export const CALLSIGN_ROLES = ['Magos', 'Lexmechanic', 'Acolyte', 'Inquisitor', 'Servitor'] as const
export const callsignSchema = z.strictObject({
  role: z.enum(CALLSIGN_ROLES),
  ticketKey: z.string().regex(/^[A-Za-z0-9]{1,12}-\d{1,9}$/).nullable(),
  ordinal: z.number().int().min(1).max(9999).nullable(),
  purpose: z.string().max(80).nullable(),
  ticketVerified: z.boolean()
})
export type Callsign = z.infer<typeof callsignSchema>

type CallsignChat = { role: ChatRole; runId?: string }
type ParsedCallsignLabel = {
  role: 'Acolyte' | 'Inquisitor' | 'Servitor'
  ticketKey: string | null
  purpose: string | null
}

/** Keep labels plain text and bounded before interpreting their display-only role. */
export function cleanLabel(label: string): string {
  return label.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function parseCallsignLabel(label: string): ParsedCallsignLabel | null {
  const cleaned = cleanLabel(label)
  // Keep the key pattern aligned with core/schemas.ts without importing core into shared code.
  const keyed = /^(Acolyte|Inquisitor|Servitor):([A-Za-z0-9]{1,12}-\d{1,9})(?:\s+(.+))?$/.exec(cleaned)
  if (keyed) {
    return {
      role: keyed[1] as ParsedCallsignLabel['role'],
      ticketKey: keyed[2],
      purpose: keyed[3]?.slice(0, 80) ?? null
    }
  }
  const servitor = /^Servitor-(\d{1,4})(?:\s+(.+))?$/.exec(cleaned)
  return servitor ? { role: 'Servitor', ticketKey: null, purpose: servitor[2]?.slice(0, 80) ?? null } : null
}

/** The renderer may derive only a root identity; subagent identities are stamped by main. */
export function rootCallsignOf(chat: CallsignChat): Callsign | null {
  const role = chat.role === 'orchestrator' && chat.runId
    ? 'Magos'
    : chat.role === 'planner' ? 'Lexmechanic' : null
  return role === null ? null : { role, ticketKey: null, ordinal: null, purpose: null, ticketVerified: false }
}

/** Main resolves record bindings before model-supplied labels; labels never grant root roles. */
export function resolveCallsign({
  chat, threadId, label, boundTicketKey, servitorOrdinal
}: {
  chat: CallsignChat
  threadId: string | null
  label: string
  boundTicketKey: string | null
  servitorOrdinal: number
}): Callsign | null {
  if (threadId === null) return rootCallsignOf(chat)
  const parsed = parseCallsignLabel(label)
  const purpose = parsed?.purpose ?? null
  if (boundTicketKey !== null) {
    return {
      role: parsed?.ticketKey ? parsed.role : 'Acolyte',
      ticketKey: boundTicketKey,
      ordinal: null,
      purpose,
      ticketVerified: true
    }
  }
  if (parsed?.ticketKey) {
    return { ...parsed, ordinal: null, ticketVerified: false }
  }
  return {
    role: 'Servitor',
    ticketKey: null,
    ordinal: servitorOrdinal,
    purpose,
    ticketVerified: false
  }
}

/** Ordinals come from existing records, never from a model's Servitor-N label. */
export function nextServitorOrdinal(existing: Callsign[]): number {
  let highest = 0
  for (const callsign of existing) {
    if (callsign.role === 'Servitor' && callsign.ordinal !== null) {
      highest = Math.max(highest, callsign.ordinal)
    }
  }
  return highest + 1
}

/** Labels are display-only; main resolves identity and verification separately. */
export function formatCallsign(c: Callsign): string {
  if (c.role === 'Magos' || c.role === 'Lexmechanic') return c.role
  if (c.ticketKey !== null) return `${c.role}:${c.ticketKey}`
  if (c.role === 'Servitor' && c.ordinal !== null) return `Servitor-${c.ordinal}`
  return c.role
}
