import { expect, it } from 'vitest'
import { callsignSchema, formatCallsign, type Callsign } from './callsign'

it.each([
  ['Magos', null, null, 'Magos'], ['Lexmechanic', null, null, 'Lexmechanic'],
  ['Acolyte', 'DM-770', null, 'Acolyte:DM-770'], ['Inquisitor', 'DM-770', null, 'Inquisitor:DM-770'],
  ['Servitor', 'DM-770', null, 'Servitor:DM-770'], ['Servitor', null, 2, 'Servitor-2']
] as const)('formats %s callsigns', (role, ticketKey, ordinal, expected) => {
  const c: Callsign = { role, ticketKey, ordinal, purpose: null, ticketVerified: false }
  expect(callsignSchema.parse(c)).toEqual(c)
  expect(formatCallsign(c)).toBe(expected)
})

it('rejects untrusted roles, malformed ticket keys and over-limit metadata', () => {
  const c = { role: 'Servitor', ticketKey: null, ordinal: null, purpose: null, ticketVerified: false }
  for (const patch of [{ role: 'Admin' }, { ticketKey: 'DM-770 injected' }, { ordinal: 0 }, { ordinal: 10000 }, { purpose: 'x'.repeat(81) }, { extra: true }]) {
    expect(callsignSchema.safeParse({ ...c, ...patch }).success).toBe(false)
  }
})
