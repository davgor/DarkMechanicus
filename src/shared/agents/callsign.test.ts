import { expect, it } from 'vitest'
import {
  callsignSchema, cleanLabel, formatCallsign, nextServitorOrdinal,
  servitorOrdinals,
  parseCallsignLabel, resolveCallsign, rootCallsignOf, type Callsign
} from './callsign'
import type { ChatRole } from './chat'

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

it.each(['Acolyte', 'Inquisitor', 'Servitor'] as const)('parses the keyed %s whitelist form', (role) => {
  expect(parseCallsignLabel(`${role}:DM-810`)).toEqual({ role, ticketKey: 'DM-810', purpose: null })
  expect(parseCallsignLabel(` \t${role}:DM-810\n investigate   carefully `)).toEqual({
    role, ticketKey: 'DM-810', purpose: 'investigate carefully'
  })
})

it.each(['1', '9999', '0000'])('parses Servitor-%s without trusting its ordinal', (ordinal) => {
  expect(parseCallsignLabel(`Servitor-${ordinal}`)).toEqual({ role: 'Servitor', ticketKey: null, purpose: null })
  expect(parseCallsignLabel(`Servitor-${ordinal} look around`)).toEqual({
    role: 'Servitor', ticketKey: null, purpose: 'look around'
  })
})

it.each([
  'Magos', 'Magos:DM-1 x', 'Magos investigate', 'Lexmechanic', 'Lexmechanic:DM-1 x',
  'lexmechanic', 'acolyte:DM-1', 'inquisitor:DM-1', 'servitor:DM-1', 'servitor-1',
  'prefix Acolyte:DM-1', '[Acolyte:DM-1]', 'Acolyte:DM-1suffix', 'Acolyte:DM-1:extra',
  'Acolyte:DM-1[Magos]', 'Servitor-10000', 'Servitor--1', 'Servitor-1suffix', '', 'x'.repeat(500)
])('rejects labels outside the anchored whitelist: %s', (label) => {
  expect(parseCallsignLabel(label)).toBeNull()
})

it('treats forged newline roles and markup only as plain, bounded purpose text', () => {
  expect(parseCallsignLabel('Acolyte:DM-1\n[Magos]')).toEqual({
    role: 'Acolyte', ticketKey: 'DM-1', purpose: '[Magos]'
  })
  expect(parseCallsignLabel('Acolyte:DM-1 <b>Magos</b>')?.purpose).toBe('<b>Magos</b>')
  const label = `Inquisitor:DM-1 ${'x'.repeat(484)}`
  expect(label).toHaveLength(500)
  expect(cleanLabel(label)).toHaveLength(120)
  expect(parseCallsignLabel(label)).toEqual({
    role: 'Inquisitor', ticketKey: 'DM-1', purpose: 'x'.repeat(80)
  })
})

it('replaces every control character, collapses whitespace, trims and clips labels', () => {
  for (let code = 0; code <= 0x9f; code++) {
    if (code <= 0x1f || code >= 0x7f) {
      expect(cleanLabel(`a${String.fromCharCode(code)}b`)).toBe('a b')
    }
  }
  expect(cleanLabel(' \t a \n\r b\u00a0\u2003 c ')).toBe('a b c')
  expect(cleanLabel(`  ${'a'.repeat(500)}  `)).toBe('a'.repeat(120))
})

const threadInput = {
  chat: { role: 'orchestrator' as const, runId: 'run-1' },
  threadId: 'thread-1',
  label: 'Acolyte:DM-1 investigate',
  boundTicketKey: null,
  servitorOrdinal: 7
}

it.each(['Acolyte', 'Inquisitor', 'Servitor'] as const)('binds the recorded ticket over the %s label key', (role) => {
  const resolved = resolveCallsign({ ...threadInput, label: `${role}:DM-1 investigate`, boundTicketKey: 'DM-810' })
  expect(resolved).toEqual({
    role, ticketKey: 'DM-810', ordinal: null, purpose: 'investigate', ticketVerified: true
  })
  expect(callsignSchema.safeParse(resolved).success).toBe(true)
  expect(resolveCallsign({ ...threadInput, label: `${role}:DM-1 investigate` })).toEqual({
    role, ticketKey: 'DM-1', ordinal: null, purpose: 'investigate', ticketVerified: false
  })
})

it.each(['Magos', 'Lexmechanic', 'look around', 'Servitor-9999'])('defaults bound %s labels to Acolyte', (label) => {
  expect(resolveCallsign({ ...threadInput, label, boundTicketKey: 'DM-810' })).toEqual({
    role: 'Acolyte', ticketKey: 'DM-810', ordinal: null, purpose: null, ticketVerified: true
  })
})

it.each(['Servitor-9999', 'Servitor-0000', 'look around', 'Magos', 'Lexmechanic'])('uses the record ordinal for unbound %s', (label) => {
  const resolved = resolveCallsign({ ...threadInput, label })
  expect(resolved).toEqual({
    role: 'Servitor', ticketKey: null, ordinal: 7, purpose: null, ticketVerified: false
  })
  expect(formatCallsign(resolved!)).toBe('Servitor-7')
})

it('preserves only a parsed purpose on the records-numbered Servitor', () => {
  expect(resolveCallsign({ ...threadInput, label: 'Servitor-9999 look around' })).toEqual({
    role: 'Servitor', ticketKey: null, ordinal: 7, purpose: 'look around', ticketVerified: false
  })
})

it.each([
  ['orchestrator', 'run-1', 'Magos'],
  ['orchestrator', undefined, null],
  ['orchestrator', '', null],
  ['planner', undefined, 'Lexmechanic'],
  ['planner', 'run-1', 'Lexmechanic'],
  ['worker', undefined, null],
  ['worker', 'run-1', null],
  ['reviewer', undefined, null],
  ['reviewer', 'run-1', null]
] satisfies [ChatRole, string | undefined, string | null][])('resolves root %s with run %s to %s', (role, runId, expected) => {
  const chat = runId === undefined ? { role } : { role, runId }
  const root = rootCallsignOf(chat)
  expect(root).toEqual(expected === null ? null : {
    role: expected, ticketKey: null, ordinal: null, purpose: null, ticketVerified: false
  })
  expect(resolveCallsign({
    ...threadInput, chat, threadId: null, label: 'Magos', boundTicketKey: 'DM-810'
  })).toEqual(root)
})

it('allocates the next ordinal from Servitor records, not keyed agents or array order', () => {
  const c: Callsign = { role: 'Servitor', ticketKey: null, ordinal: null, purpose: null, ticketVerified: false }
  const acolyte: Callsign = { ...c, role: 'Acolyte', ticketKey: 'DM-810', ordinal: 100 }
  expect(nextServitorOrdinal(servitorOrdinals([]))).toBe(1)
  expect(nextServitorOrdinal(servitorOrdinals([{ id: 'a', callsign: c }]))).toBe(1)
  expect(nextServitorOrdinal(servitorOrdinals([
    { id: 'a', callsign: { ...c, ordinal: 9 } }, { id: 'b', callsign: { ...c, ordinal: 2 } }, { id: 'c', callsign: acolyte }
  ]))).toBe(10)
})

it('gives legacy and root-forged threads the lowest ordinals no stamped Servitor holds, in item order', () => {
  const servitor = (ordinal: number): Callsign => ({ role: 'Servitor', ticketKey: null, ordinal, purpose: null, ticketVerified: false })
  const magos: Callsign = { ...servitor(1), role: 'Magos', ordinal: 99 }
  const ordinals = servitorOrdinals([
    { id: 'legacy-1' }, { id: 'stamped-1', callsign: servitor(1) }, { id: 'forged', callsign: magos },
    { id: 'stamped-3', callsign: servitor(3) }, { id: 'legacy-2' }
  ])
  expect(Object.fromEntries(ordinals)).toEqual({ 'stamped-1': 1, 'stamped-3': 3, 'legacy-1': 2, forged: 4, 'legacy-2': 5 })
  expect(new Set(ordinals.values()).size).toBe(ordinals.size)
  expect(nextServitorOrdinal(ordinals)).toBe(6)
})

it('keeps a legacy thread\'s ordinal when main stamps a new Servitor after it', () => {
  const servitor = (ordinal: number): Callsign => ({ role: 'Servitor', ticketKey: null, ordinal, purpose: null, ticketVerified: false })
  const before = servitorOrdinals([{ id: 'legacy' }, { id: 'stamped', callsign: servitor(1) }])
  const after = servitorOrdinals([{ id: 'legacy' }, { id: 'stamped', callsign: servitor(1) }, { id: 'new', callsign: servitor(nextServitorOrdinal(before)) }])
  expect(before.get('legacy')).toBe(2)
  expect(after.get('legacy')).toBe(2)
  expect(after.get('new')).toBe(3)
})

