// DM-273: the ledger's refusals of a contract-valid observation: provenance, time form, repeated evidence and
// attribute names.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MetricObservation } from '../../shared/domain/space'
import { attributeRefusal, ledgerProblem } from './ledger'

const LEDGER = JSON.parse(readFileSync(new URL('./fixtures/observations.json', import.meta.url), 'utf8')) as { observations: MetricObservation[] }
const observation = (metric: string): MetricObservation => structuredClone(LEDGER.observations.find((record) => record.metric === metric)!)

describe('DM-273: ledgerProblem refuses provenance, time form and repeated citations', () => {
  it.each([
    ['a server record naming an actor', { ...observation('wait_ms'), source: { kind: 'server', actor: 'clock' } }, 'source.actor', 'A server-derived observation names no actor'],
    ['an agent record naming no actor', { ...observation('tokens_output'), source: { kind: 'agent', actor: null } }, 'source.actor', 'A agent observation names the actor that measured it'],
    ['a time with an offset', { ...observation('tokens_output'), observedAt: '2026-11-01T12:00:00.000+02:00' }, 'observedAt', 'observedAt is stored in UTC with milliseconds (toISOString)'],
    ['a citation listed twice', { ...observation('wait_ms'), evidence: [...observation('wait_ms').evidence, ...observation('wait_ms').evidence] }, 'evidence.1', 'Each evidence reference is listed once'],
    ['an attribute name of two lines', { ...observation('tokens_output'), attributes: { 'first\nsecond': 1 } }, 'attributes.first\nsecond', 'The attribute name is not one line of at most 200 characters; chat text is never stored']
  ])('%s', (_label, record, path, message) => {
    expect(ledgerProblem(record as MetricObservation)).toEqual({ path, message })
  })

  it('the fixture records it starts from are storable', () => {
    expect(['wait_ms', 'tokens_output'].map((metric) => ledgerProblem(observation(metric)))).toEqual([null, null])
  })
})

describe('DM-273: attributeRefusal reads the last word of a name', () => {
  it('refuses text under a chat-like name, and accepts it under a name of no words', () => {
    expect(attributeRefusal('lastMessage', 'hello')).toBe('An attribute named like chat text is never stored')
    expect(attributeRefusal('--', 'hello')).toBeNull()
  })
})
