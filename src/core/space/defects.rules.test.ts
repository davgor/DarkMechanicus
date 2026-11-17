// DM-273: the escaped-defect record rules and read model, driven with plain observations (no ledger round trip).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { EvidenceRef, MetricAttributes, MetricObservation } from '../../shared/domain/space'
import { defectProblem, resolveDefects } from './defects'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
/** The checked-in observation fixtures (contract.test.ts proves each parses). */
const LEDGER: { observations: MetricObservation[] } = JSON.parse(readFileSync(`${FIXTURES}observations.json`, 'utf8'))
const REPORT: MetricObservation = LEDGER.observations.find((record) => record.metric === 'escaped_defect')!
const CUTOFF = '2026-12-01T00:00:00.000Z'
const UNKNOWN = 'mo_01m7gg0000000000000000zzzz'

const id = (n: number): string => `mo_01m7gg${String(n).padStart(20, '0')}`

/** A report (the fixture's attributed low-severity report) stored at minute `n` under id `n`. */
function report(n: number, attributes: MetricAttributes = {}, evidence: EvidenceRef[] = REPORT.evidence): MetricObservation {
  const at = `2026-11-03T09:${String(n).padStart(2, '0')}:00.000Z`
  return { ...structuredClone(REPORT), observationId: id(n), observedAt: at, recordedAt: at, attributes: { ...REPORT.attributes, ...attributes }, evidence }
}

/** A person's follow-up record (count 0) at minute `n`, citing `defect` and any further links. */
function followUp(n: number, defectEvent: string, defect: string, extra: { attributes?: MetricAttributes; more?: EvidenceRef[] } = {}): MetricObservation {
  const at = `2026-11-03T09:${String(n).padStart(2, '0')}:00.000Z`
  return {
    ...structuredClone(REPORT),
    observationId: id(n),
    measurement: { state: 'observed', value: 0 },
    observedAt: at,
    recordedAt: at,
    attributes: { defectEvent, ...extra.attributes },
    evidence: [{ kind: 'observation', id: defect, detail: 'defect' }, ...(extra.more ?? [])]
  }
}

const FIXED_BY: EvidenceRef = { kind: 'commit', id: '1a1b2c3d4e5f60718293a4b5c6d7e8f901234567', detail: 'fixed by' }

describe('DM-273: defectProblem refuses a malformed escaped-defect record with the rule it breaks', () => {
  it.each([
    ['no defectEvent', { ...REPORT, attributes: { severity: 'low' } }, 'attributes.defectEvent', 'An escaped defect record names its defectEvent: one of report, duplicate, reassessment, fix, withdrawal'],
    ['no epic', { ...REPORT, scope: { ...REPORT.scope, epicId: null } }, 'scope.epicId', 'An escaped defect record belongs to an epic (the epic of its origin)'],
    ['a report without its severity', { ...report(1), attributes: { defectEvent: 'report', attribution: 'attributed', discoveryPhase: 'later_sprint' } }, 'attributes.severity', 'A defect report names its severity'],
    ['a reassessment naming a discovery phase', followUp(2, 'reassessment', id(1), { attributes: { severity: 'high', discoveryPhase: 'integration' } }), 'attributes.discoveryPhase', 'A defect reassessment has no discoveryPhase'],
    ['a blank defect key', report(3, { defectKey: '   ' }), 'attributes.defectKey', 'Expected a non-empty text'],
    ['a source build that is a ticket', report(4, {}, [{ kind: 'ticket', id: 'tk_01m453gpad0000000000000001', detail: 'source build' }]), 'evidence', 'A "source build" link cites a commit, not a ticket'],
    ['a duplicate citing one report twice', followUp(5, 'duplicate', id(1), { more: [{ kind: 'observation', id: id(1), detail: 'duplicate' }] }), 'evidence', 'A duplicate record cites two different reports'],
    ['a person stamping review authority', report(6, { authority: 'review' }), 'attributes.authority', 'Only an agent or host record carries the review stamp'],
    ['the server stamping review authority', { ...report(7, { authority: 'review' }), source: { kind: 'server', actor: null } }, 'attributes.authority', 'Only an agent or host record carries the review stamp'],
    ['an unstamped worker attributing a defect', { ...report(8), source: { kind: 'agent', actor: 'worker' } }, 'source', 'A defect report that changes charging comes from a person, the server, or a session holding attempt.review']
  ])('%s', (_label, record, path, message) => {
    expect(defectProblem(record as MetricObservation)).toEqual({ path, message })
  })

  it('a report citing plain evidence beside its links, and a stamped agent report, are well formed', () => {
    const plain: EvidenceRef = { kind: 'ticket', id: 'tk_01m453gpad0000000000000002', detail: null }
    expect(defectProblem(report(1, {}, [...REPORT.evidence, plain]))).toBeNull()
    expect(defectProblem({ ...report(2, { authority: 'review' }), source: { kind: 'agent', actor: 'reviewer' } })).toBeNull()
    expect(defectProblem({ ...report(3, { attribution: 'unassigned' }, REPORT.evidence.slice(0, 1)), source: { kind: 'agent', actor: 'worker' } })).toBeNull()
  })
})

describe('DM-273: resolveDefects lists follow-ups citing no known report as anomalies', () => {
  it.each([
    ['a duplicate', followUp(2, 'duplicate', UNKNOWN, { more: [{ kind: 'observation', id: id(1), detail: 'duplicate' }] })],
    ['a withdrawal', followUp(2, 'withdrawal', UNKNOWN)],
    ['a reassessment', followUp(2, 'reassessment', UNKNOWN, { attributes: { severity: 'critical' } })],
    ['a fix', followUp(2, 'fix', UNKNOWN, { more: [FIXED_BY] })]
  ])('%s of an unknown report', (_label, record) => {
    const view = resolveDefects([report(1), record], CUTOFF)
    expect(view.anomalies).toEqual([{ observationId: id(2), reason: 'unknown_defect', relatedId: null }])
    expect(view.defects.map((defect) => `${defect.defectId}:${defect.severity}:${defect.status}:${defect.reportIds.length}`)).toEqual([`${id(1)}:low:open:1`])
  })
})

describe('DM-273: resolveDefects applies follow-ups to the defect they cite', () => {
  it('a reassessment that changes only the attribution keeps the severity', () => {
    const candidate = followUp(2, 'reassessment', id(1), { attributes: { attribution: 'candidate' }, more: [{ kind: 'ticket', id: 'tk_01m453gpad0000000000000002', detail: 'origin' }] })
    const [defect] = resolveDefects([report(1), candidate], CUTOFF).defects
    expect(defect).toMatchObject({ severity: 'low', attribution: 'candidate', origin: { ticketId: 'tk_01m453gpad0000000000000002', attemptId: null }, reassessmentIds: [id(2)] })
  })

  it('a fix of a withdrawn defect is listed but the defect stays withdrawn', () => {
    const [defect] = resolveDefects([report(1), followUp(2, 'withdrawal', id(1)), followUp(3, 'fix', id(1), { more: [FIXED_BY] })], CUTOFF).defects
    expect(defect).toMatchObject({ status: 'withdrawn', counted: false, updatedAt: '2026-11-03T09:03:00.000Z' })
    expect(defect?.fixes.map((fix) => fix.observationId)).toEqual([id(3)])
  })

  it('a duplicate record joining two reports already grouped by key counts them once, without anomaly', () => {
    const keyed = [report(1, { defectKey: 'K' }), report(2, { defectKey: ' K ' })]
    const joined = followUp(3, 'duplicate', id(1), { more: [{ kind: 'observation', id: id(2), detail: 'duplicate' }] })
    const view = resolveDefects([...keyed, joined], CUTOFF)
    expect(view.anomalies).toEqual([])
    expect(view.defects.map((defect) => [defect.defectId, defect.defectKey, defect.reportIds])).toEqual([[id(1), 'K', [id(1), id(2)]]])
  })
})
