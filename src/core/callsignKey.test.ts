import { expect, it } from 'vitest'
import { callsignSchema, parseCallsignLabel } from '../shared/agents/callsign'
import { ticketKey } from './schemas'

it.each([
  ['DM-1', true],
  ['a1-0', true],
  ['ABCDEFGHIJKL-123456789', true],
  ['dm-000000001', true],
  ['ABCDEFGHIJKLM-1', false],
  ['DM-1234567890', false],
  ['-1', false],
  ['DM-', false],
  ['D_M-1', false],
  ['DM-1suffix', false]
] as const)('agrees with the core ticket key schema for %s', (key, accepted) => {
  expect(ticketKey.safeParse(key).success).toBe(accepted)
  expect(callsignSchema.shape.ticketKey.safeParse(key).success).toBe(accepted)
  expect(parseCallsignLabel(`Acolyte:${key}`)?.ticketKey === key).toBe(accepted)
})
