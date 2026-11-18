// DM-175 c2: escaped defects have stable provenance, severity, observation window and an attributable origin or an
// explicit unassigned status; duplicate reports do not count twice. Records go through the real ledger.
import { describe, expect, it } from 'vitest'
import type { EscapedDefect } from '../../shared/domain/performance'
import type { ObservationInput } from '../services/observations'
import { listObservations, recordObservations } from '../services/observations'
import { getEscapedDefects, getTicketPerformance } from '../services/performance'
import { tid } from '../../test/bundles'
import { errorCode } from '../../test/execution'
import { accept, COMMIT, defectFollowUp, defectReport, met, type PerformanceWorld, performanceWorld, reject, type ReportFields, submit } from '../../test/performanceWorld'
import { observationPayloadHash } from './ledger'

const UNKNOWN = 'mo_01m7gg00000000000000000001'

/** A world where ticket 2 has an accepted attempt, an hour before any defect record. */
function acceptedWorld() {
  const w = performanceWorld()
  const t2 = submit(w, 2, { criteria: [met('c1'), met('c2')] })
  accept(w, t2, [met('c1'), met('c2')])
  w.ctx.clock.advanceSeconds(3600)
  return { w, t2 }
}

/** Records one call, then moves the clock a minute so each call has its own server time. */
function record(w: PerformanceWorld, ...items: ObservationInput[]): string[] {
  const { created } = recordObservations(w.ctx, items)
  w.ctx.clock.advanceSeconds(60)
  return created
}

const defects = (w: PerformanceWorld, cutoff?: string) => getEscapedDefects(w.ctx, { epicId: w.epicId, ...(cutoff === undefined ? {} : { cutoff }) })
const summary = (defect: EscapedDefect) => `${defect.severity}/${defect.attribution}/${defect.status}/reports=${defect.reportIds.length}`
const ticket2 = (w: PerformanceWorld) => getTicketPerformance(w.ctx, { runId: w.runId, ticketId: tid(2) })
const charges = (w: PerformanceWorld) => ticket2(w).regressions.map((item) => `${item.severity}:${item.charge}`)

describe('DM-175 c2: defect reports carry provenance and an origin that fits their attribution', () => {
  it.each<[string, (w: PerformanceWorld, attempts: { t2: string; t3: string; t5: string }) => ObservationInput]>([
    ['a report without a source build', (w) => defectReport(w, { severity: 'high', attribution: 'unassigned', sourceBuild: null })],
    ['an unknown severity', (w) => defectReport(w, { severity: 'blocker', attribution: 'unassigned' })],
    ['an unknown discovery phase', (w) => defectReport(w, { severity: 'low', attribution: 'unassigned', phase: 'after_acceptance' })],
    ['an attributed report without its origin attempt', (w) => defectReport(w, { severity: 'high', attribution: 'attributed', origin: { ticket: 2 } })],
    ['a candidate without an origin ticket', (w) => defectReport(w, { severity: 'high', attribution: 'candidate' })],
    ['an unassigned report naming an origin', (w) => defectReport(w, { severity: 'high', attribution: 'unassigned', origin: { ticket: 2 } })],
    ['an attributed report blaming a rejected attempt', (w, a) => defectReport(w, { severity: 'high', attribution: 'attributed', origin: { ticket: 5, attemptId: a.t5 } })],
    ['an attributed report blaming another ticket’s attempt', (w, a) => defectReport(w, { severity: 'high', attribution: 'attributed', origin: { ticket: 2, attemptId: a.t3 } })],
    ['a report counting 2', (w) => ({ ...defectReport(w, { severity: 'low', attribution: 'unassigned' }), measurement: { state: 'observed', value: 2 } })],
    ['a fix citing no report', (w) => ({ ...defectFollowUp(w, 'fix', UNKNOWN), evidence: [{ kind: 'commit', id: COMMIT.fix, detail: 'fixed by' }] })],
    ['a reassessment changing nothing', (w) => defectFollowUp(w, 'reassessment', UNKNOWN)]
  ])('refuses %s as invalid input', (_label, build) => {
    const w = performanceWorld()
    const t2 = submit(w, 2, { criteria: [met('c1'), met('c2')] })
    accept(w, t2, [met('c1'), met('c2')])
    const t3 = submit(w, 3, { criteria: [met('c1'), met('c2')] })
    accept(w, t3, [met('c1'), met('c2')])
    const t5 = submit(w, 5, { criteria: [met('c1'), met('c2')] })
    reject(w, t5, 'no')
    expect(errorCode(() => recordObservations(w.ctx, [build(w, { t2, t3, t5 })]))).toBe('invalid_input')
    expect(listObservations(w.ctx.db, { metric: 'escaped_defect' })).toEqual([])
  })
})

describe('DM-175 c2: defect reports keep provenance and fold duplicates', () => {
  it('refuses a withdrawal citing an observation that does not exist', () => {
    const w = performanceWorld()
    expect(errorCode(() => recordObservations(w.ctx, [defectFollowUp(w, 'withdrawal', UNKNOWN)]))).toBe('not_found')
  })

  it('folds a shared defect key and an explicit duplicate into the first report, keeping its provenance', () => {
    const { w } = acceptedWorld()
    const candidate: ReportFields = { severity: 'medium', attribution: 'candidate', origin: { ticket: 2 } }
    const [first = ''] = record(w, defectReport(w, { ...candidate, defectKey: 'GH-41' }))
    const [second = ''] = record(w, defectReport(w, { ...candidate, defectKey: ' GH-41 ', phase: 'integration', source: { kind: 'agent', actor: 'worker-7' } }))
    const [third = ''] = record(w, defectReport(w, candidate))
    const [unrelated = ''] = record(w, defectReport(w, { severity: 'high', attribution: 'unassigned', phase: 'later_sprint', sourceBuild: COMMIT.other }))
    record(w, defectFollowUp(w, 'duplicate', first, { evidence: [{ kind: 'observation', id: third, detail: 'duplicate' }] }))
    const view = defects(w)
    expect(view.anomalies).toEqual([])
    expect(view.defects).toHaveLength(2)
    const [shared, other] = view.defects
    expect(shared).toMatchObject({
      defectId: first,
      reportIds: [first, second, third],
      defectKey: 'GH-41',
      severity: 'medium',
      attribution: 'candidate',
      origin: { ticketId: tid(2), attemptId: null },
      discoveryPhase: 'sprint_review',
      sourceBuild: COMMIT.build,
      reportedBy: { kind: 'human', actor: 'desktop' },
      discoveredAt: '2026-11-15T10:07:00.000Z',
      recordedAt: '2026-11-15T10:07:00.000Z',
      status: 'open',
      counted: true
    })
    expect(other).toMatchObject({ defectId: unrelated, attribution: 'unassigned', origin: null, sourceBuild: COMMIT.other, discoveryPhase: 'later_sprint' })
    expect(ticket2(w).regressions).toEqual([{ defectId: first, severity: 'medium', attribution: 'candidate', status: 'open', charge: 'candidate' }])
    expect(ticket2(w).performance.regressions).toEqual([{ observationId: first, severity: 'medium', attribution: 'unassigned' }])
  })
})

describe('DM-175 c2: the defect observation window, reassessment and withdrawal', () => {
  it('reads only records stored by the cutoff', () => {
    const { w } = acceptedWorld()
    const [first = ''] = record(w, defectReport(w, { severity: 'low', attribution: 'unassigned', defectKey: 'K' }))
    const firstAt = defects(w).defects[0]?.recordedAt ?? ''
    record(w, defectReport(w, { severity: 'low', attribution: 'unassigned', defectKey: 'K' }))
    record(w, defectFollowUp(w, 'withdrawal', first))
    expect(defects(w, '2026-11-15T09:00:00.000Z').defects).toEqual([])
    expect(defects(w, firstAt).defects.map((d) => [d.reportIds.length, d.withdrawals.length])).toEqual([[1, 0]])
    expect(defects(w).defects.map((d) => [d.reportIds.length, d.withdrawals.length, d.counted])).toEqual([[2, 1, true]])
  })

  it('confirms a candidate through a reassessment citing any of its reports without changing a stored record', () => {
    const { w, t2 } = acceptedWorld()
    const [first = ''] = record(w, defectReport(w, { severity: 'medium', attribution: 'candidate', origin: { ticket: 2 }, defectKey: 'K' }))
    const [second = ''] = record(w, defectReport(w, { severity: 'medium', attribution: 'candidate', origin: { ticket: 2 }, defectKey: 'K' }))
    const stored = listObservations(w.ctx.db, { metric: 'escaped_defect' }).map(observationPayloadHash)
    record(
      w,
      defectFollowUp(w, 'reassessment', second, {
        attributes: { attribution: 'attributed', severity: 'high' },
        evidence: [{ kind: 'ticket', id: tid(2), detail: 'origin' }, { kind: 'attempt', id: t2, detail: 'origin' }]
      })
    )
    expect(defects(w).defects.map((d) => [d.defectId, d.severity, d.attribution, d.origin])).toEqual([[first, 'high', 'attributed', { ticketId: tid(2), attemptId: t2 }]])
    expect(listObservations(w.ctx.db, { metric: 'escaped_defect' }).slice(0, 2).map(observationPayloadHash)).toEqual(stored)
    expect(charges(w)).toEqual(['high:charged'])
  })

  it('keeps a withdrawn report in the ledger, uncounted, and refuses rewriting it', () => {
    const { w } = acceptedWorld()
    const [reportId = ''] = record(w, defectReport(w, { severity: 'high', attribution: 'unassigned' }))
    record(w, defectFollowUp(w, 'withdrawal', reportId))
    const [second = ''] = record(w, defectFollowUp(w, 'withdrawal', reportId))
    const view = defects(w)
    expect(view.defects.map((d) => [d.status, d.counted])).toEqual([['withdrawn', false]])
    expect(view.anomalies).toEqual([{ observationId: second, reason: 'withdrawn_twice', relatedId: reportId }])
    expect(listObservations(w.ctx.db, { metric: 'escaped_defect' }).map((o) => o.observationId)).toContain(reportId)
    expect(errorCode(() => recordObservations(w.ctx, [{ ...defectReport(w, { severity: 'low', attribution: 'unassigned' }), observationId: reportId }]))).toBe('conflict')
  })
})

describe('DM-175 c2: records in one call link by reference and reassessments read in call order', () => {
  const REPORT = 'mo_01m7gz00000000000000000009'

  it.each([
    ['report first', false],
    ['withdrawal first', true]
  ])('withdraws a report sent with its withdrawal in one call (%s)', (_label, reversed) => {
    const { w } = acceptedWorld()
    const batch = [defectReport(w, { severity: 'low', attribution: 'unassigned', observationId: REPORT }), defectFollowUp(w, 'withdrawal', REPORT)]
    record(w, ...(reversed ? batch.reverse() : batch))
    expect(defects(w).defects.map((d) => [d.defectId, d.status, d.counted])).toEqual([[REPORT, 'withdrawn', false]])
  })

  it.each([
    ['report first', false],
    ['fix first', true]
  ])('fixes a report sent with its fix in one call (%s)', (_label, reversed) => {
    const { w, t2 } = acceptedWorld()
    const batch = [
      defectReport(w, { severity: 'high', attribution: 'attributed', origin: { ticket: 2, attemptId: t2 }, observationId: REPORT }),
      defectFollowUp(w, 'fix', REPORT, { evidence: [{ kind: 'commit', id: COMMIT.fix, detail: 'fixed by' }] })
    ]
    record(w, ...(reversed ? batch.reverse() : batch))
    expect(defects(w).defects.map((d) => [d.status, d.counted, d.fixes.length])).toEqual([['fixed', true, 1]])
    expect(charges(w)).toEqual(['high:charged'])
  })

  it.each([
    ['high then critical', ['high', 'critical'], 'critical'],
    ['critical then high', ['critical', 'high'], 'high']
  ])('applies two reassessments of one call in call order (%s)', (_label, order, final) => {
    const { w } = acceptedWorld()
    const [reportId = ''] = record(w, defectReport(w, { severity: 'low', attribution: 'unassigned' }))
    record(w, ...order.map((severity) => defectFollowUp(w, 'reassessment', reportId, { attributes: { severity } })))
    expect(defects(w).defects.map((d) => d.severity)).toEqual([final])
  })

  it('retries an attributed and an unassigned report with descending caller ids as a no-op', () => {
    const { w, t2 } = acceptedWorld()
    const low = 'mo_01m7gz00000000000000000001'
    const batch = [
      defectReport(w, { severity: 'high', attribution: 'attributed', origin: { ticket: 2, attemptId: t2 }, observationId: REPORT }),
      defectReport(w, { severity: 'low', attribution: 'unassigned', observationId: low })
    ]
    expect(recordObservations(w.ctx, batch).created).toEqual([REPORT, low])
    expect(recordObservations(w.ctx, batch).unchanged).toEqual([REPORT, low])
  })
})

const lowUnassigned: ReportFields = { severity: 'low', attribution: 'unassigned', defectKey: 'K' }
const highOn = (t2: string): ReportFields => ({ severity: 'high', attribution: 'attributed', origin: { ticket: 2, attemptId: t2 }, defectKey: 'K' })

describe('DM-175 c2: reports grouped by judgement count once', () => {
  it('three reports under one key: an unassigned one then two agreeing attributed ones charge ticket 2 once', () => {
    const { w, t2 } = acceptedWorld()
    const [a = ''] = record(w, defectReport(w, lowUnassigned))
    const [b = ''] = record(w, defectReport(w, highOn(t2)))
    const [c = ''] = record(w, defectReport(w, highOn(t2)))
    const view = defects(w)
    expect(view.defects.map((d) => [d.defectId, d.reportIds, summary(d)])).toEqual([
      [a, [a], 'low/unassigned/open/reports=1'],
      [b, [b, c], 'high/attributed/open/reports=2']
    ])
    expect(view.anomalies).toEqual([{ observationId: b, reason: 'conflicting_reports', relatedId: a }])
    expect(charges(w)).toEqual(['high:charged'])
    expect(ticket2(w).performance.regressions).toEqual([{ observationId: b, severity: 'high', attribution: 'attributed' }])
  })

  it.each([
    ['one call each', false],
    ['all in one call', true]
  ])('alternating judgements A B A B B under one key read as two defects (%s)', (_label, oneCall) => {
    const { w, t2 } = acceptedWorld()
    const reports = [lowUnassigned, highOn(t2), lowUnassigned, highOn(t2), highOn(t2)].map((fields) => defectReport(w, fields))
    if (oneCall) {
      record(w, ...reports)
    } else {
      reports.forEach((item) => record(w, item))
    }
    const view = defects(w)
    expect(view.defects.map(summary)).toEqual(['low/unassigned/open/reports=2', 'high/attributed/open/reports=3'])
    expect(view.anomalies.map((item) => item.reason)).toEqual(['conflicting_reports'])
    expect(charges(w)).toEqual(['high:charged'])
  })
})

describe('DM-175 c2: duplicate records and withdrawals in judgement groups', () => {
  it('a duplicate citing a later attributed report as the defect makes the earlier unassigned one read as it', () => {
    const { w, t2 } = acceptedWorld()
    const [a = ''] = record(w, defectReport(w, { severity: 'low', attribution: 'unassigned' }))
    const [b = ''] = record(w, defectReport(w, { severity: 'critical', attribution: 'attributed', origin: { ticket: 2, attemptId: t2 } }))
    record(w, defectFollowUp(w, 'duplicate', b, { evidence: [{ kind: 'observation', id: a, detail: 'duplicate' }] }))
    const view = defects(w)
    expect(view.defects.map((d) => [d.defectId, d.reportIds, summary(d)])).toEqual([[a, [a, b], 'critical/attributed/open/reports=2']])
    expect(view.anomalies).toEqual([])
    expect(charges(w)).toEqual(['critical:charged'])
  })

  it('withdrawing the base report of a duplicate-joined group falls back to a live report sharing its judgement', () => {
    const { w, t2 } = acceptedWorld()
    const [a = ''] = record(w, defectReport(w, lowUnassigned))
    const [b = ''] = record(w, defectReport(w, highOn(t2)))
    const [d = ''] = record(w, defectReport(w, highOn(t2)))
    record(w, defectFollowUp(w, 'duplicate', d, { evidence: [{ kind: 'observation', id: a, detail: 'duplicate' }] }))
    expect(defects(w).defects.map((x) => [x.defectId, summary(x)])).toEqual([[a, 'high/attributed/open/reports=3']])
    record(w, defectFollowUp(w, 'withdrawal', b))
    const [defect] = defects(w).defects
    expect([defect?.severity, defect?.attribution, defect?.origin, defect?.counted, defect?.recordedAt]).toEqual(['high', 'attributed', { ticketId: tid(2), attemptId: t2 }, true, '2026-11-15T10:09:00.000Z'])
    expect(charges(w)).toEqual(['high:charged'])
  })

  it('withdrawing every report of a reassessed defect stops counting it', () => {
    const { w, t2 } = acceptedWorld()
    const [a = ''] = record(w, defectReport(w, highOn(t2)))
    const [b = ''] = record(w, defectReport(w, highOn(t2)))
    record(w, defectFollowUp(w, 'reassessment', b, { attributes: { severity: 'critical' } }))
    expect(charges(w)).toEqual(['critical:charged'])
    record(w, defectFollowUp(w, 'withdrawal', a))
    expect(charges(w)).toEqual(['critical:charged'])
    record(w, defectFollowUp(w, 'withdrawal', b))
    expect(charges(w)).toEqual([])
    expect(defects(w).defects.map((x) => [x.status, x.counted])).toEqual([['withdrawn', false]])
  })
})
