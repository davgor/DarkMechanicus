// DM-175 c1, c3, c4: verification records, dated regression reassessments and the checked-in performance fixtures.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RegressionView, VerificationItem, VerificationReason } from '../../shared/domain/performance'
import type { MetricObservation, PerformanceInput, SpaceGradeInput, VerificationState } from '../../shared/domain/space'
import { contentHash } from '../canonical'
import { buildRunHistoryRecord } from '../repo/portable'
import { reconcileAttempt, settleLeases } from '../services/attempts'
import { recordObservations } from '../services/observations'
import { getTicketPerformance } from '../services/performance'
import { submitSprintReport } from '../services/reports'
import { tid } from '../../test/bundles'
import { claim, errorCode } from '../../test/execution'
import {
  accept,
  COMMIT,
  defectFollowUp,
  defectReport,
  failClaimed,
  failedCheck,
  met,
  passed,
  type PerformanceWorld,
  performanceWorld,
  reject,
  skipped,
  submit,
  unmet
} from '../../test/performanceWorld'
import { parseObservation } from './contract'
import { resolveDefects } from './defects'
import { ledgerProblem } from './ledger'
import { gradeSpace } from './rubric'
import { ticketPerformance, type VerificationFacts } from './verification'

const read = (w: PerformanceWorld, n: number, cutoff?: string) =>
  getTicketPerformance(w.ctx, { runId: w.runId, ticketId: tid(n), ...(cutoff === undefined ? {} : { cutoff }) })

const bases = (items: readonly VerificationItem[]) => items.map((item) => `${item.kind} ${item.id} ${item.required ? 'required' : 'optional'} ${item.basis} ${item.result ?? '-'}`)

const fixturesDir = join(__dirname, 'fixtures')

/** The complete rubric example (S 75, A 100, C 75, E 70, T 90, K 92.5) with its P swapped for `performance`. */
function gradeWith(performance: PerformanceInput) {
  const { input } = JSON.parse(readFileSync(join(fixturesDir, 'rubric', 'complete.json'), 'utf8')) as { input: SpaceGradeInput }
  return gradeSpace({ ...input, components: { ...input.components, P: performance } })
}

describe('DM-175 c1: verification records', () => {
  it('reads an acceptance whose reviewer stated every criterion as verified and reviewer-checked', () => {
    const w = performanceWorld()
    const attempt = submit(w, 2, { checks: [passed('typecheck'), passed('vitest')], criteria: [met('c1'), met('c2')] })
    accept(w, attempt, [met('c1', 'reran the script'), met('c2', 'read the docs')])
    const input = read(w, 2)
    expect([input.verification.state, input.verification.reason, input.verification.attemptState]).toEqual(['verified', 'reviewed', 'accepted'])
    expect(bases(input.verification.items)).toEqual([
      'criterion c1 required reviewer_checked passed',
      'criterion c2 required reviewer_checked passed',
      'check typecheck optional reviewer_checked passed',
      'check vitest optional reviewer_checked passed'
    ])
    expect(input.verification.items[0]?.note).toBe('reran the script')
    expect(input.performance.verification.evidence).toEqual([
      { kind: 'attempt', id: attempt, detail: 'accepted' },
      { kind: 'criterion', id: tid(2), detail: 'c1' },
      { kind: 'criterion', id: tid(2), detail: 'c2' },
      { kind: 'check', id: attempt, detail: 'typecheck' },
      { kind: 'check', id: attempt, detail: 'vitest' }
    ])
  })

  it('keeps criteria only the worker claimed as worker claims on an accepted attempt, leaving it ungraded', () => {
    const w = performanceWorld()
    accept(w, submit(w, 3, { checks: [passed('typecheck')], criteria: [met('c1'), met('c2')] }))
    const input = read(w, 3)
    expect([input.verification.state, input.verification.reason]).toEqual(['missing', 'worker_claims_only'])
    expect(bases(input.verification.items)).toEqual([
      'criterion c1 required worker_claim passed',
      'criterion c2 required worker_claim passed',
      'check typecheck optional reviewer_checked passed'
    ])
    const grade = gradeWith(input.performance)
    expect(grade.status).toBe('ungraded')
    expect(grade.statusReasons).toContain('verification_missing')
  })
})

describe('DM-175 c1: verification records — failures and open outcomes', () => {
  it('reads a criterion the reviewer found unmet as a confirmed failure and a failed optional check as a diagnostic', () => {
    const w = performanceWorld()
    accept(w, submit(w, 4, { checks: [passed('typecheck'), failedCheck('vitest')], criteria: [met('c1'), met('c2')] }), [met('c1'), unmet('c2', 'docs missing')])
    const input = read(w, 4)
    expect([input.verification.state, input.verification.reason]).toEqual(['failed', 'confirmed_failure'])
    expect(bases(input.verification.items)).toEqual([
      'criterion c1 required reviewer_checked passed',
      'criterion c2 required reviewer_checked failed',
      'check typecheck optional reviewer_checked passed',
      'check vitest optional reviewer_checked failed'
    ])
    const grade = gradeWith(input.performance)
    expect([grade.letter, grade.score]).toEqual(['F', 59])
  })

  it('reads a failed optional check alone on a reviewed acceptance as verified', () => {
    const w = performanceWorld()
    accept(w, submit(w, 4, { checks: [failedCheck('vitest')], criteria: [met('c1'), met('c2')] }), [met('c1'), met('c2')])
    expect([read(w, 4).verification.state, read(w, 4).verification.reason]).toEqual(['verified', 'reviewed'])
  })

  it('reads a submission awaiting review as pending with worker claims', () => {
    const w = performanceWorld()
    submit(w, 1, { checks: [passed('typecheck')], criteria: [met('c1'), met('c2')] })
    const input = read(w, 1)
    expect([input.verification.state, input.verification.reason, input.verification.attemptState]).toEqual(['pending', 'awaiting_review', 'submitted'])
    expect(bases(input.verification.items)).toEqual(['criterion c1 required worker_claim passed', 'criterion c2 required worker_claim passed', 'check typecheck optional worker_claim passed'])
  })

  it('reads a rejection with tries left as awaiting retry and the last failed try as a confirmed failure', () => {
    const w = performanceWorld()
    reject(w, submit(w, 5, { criteria: [met('c1'), met('c2')] }), 'c1 does not hold')
    const afterReject = w.ctx.clock.nowIso()
    expect([read(w, 5).verification.state, read(w, 5).verification.reason]).toEqual(['pending', 'awaiting_retry'])
    w.ctx.clock.advanceSeconds(1)
    failClaimed(w, 5, 'cannot make it work')
    expect([read(w, 5).verification.state, read(w, 5).verification.reason]).toEqual(['failed', 'confirmed_failure'])
    expect([read(w, 5, afterReject).verification.state, read(w, 5, afterReject).verification.reason]).toEqual(['pending', 'awaiting_retry'])
  })
})

describe('DM-175 c1: verification records — required evidence and the cutoff', () => {
  it('reads a skipped or unreported required Definition of Done check on an acceptance node as missing evidence', () => {
    const w = performanceWorld()
    for (const n of [2, 3, 4]) {
      accept(w, submit(w, n, { criteria: [met('c1'), met('c2')] }), [met('c1'), met('c2')])
    }
    accept(w, submit(w, 6, { checks: [passed('typecheck'), skipped('test')], criteria: [met('c1')] }), [met('c1', 'ticket 2 verified')])
    const input = read(w, 6)
    expect([input.verification.state, input.verification.reason]).toEqual(['missing', 'required_evidence_missing'])
    expect(bases(input.verification.items)).toEqual([
      'criterion c1 required reviewer_checked passed',
      'check typecheck required reviewer_checked passed',
      'check test required skipped -',
      'check build required missing -'
    ])
  })

  it('reads a required check skipped while the others passed as missing evidence', () => {
    const w = performanceWorld()
    for (const n of [2, 3, 4]) {
      accept(w, submit(w, n, { criteria: [met('c1'), met('c2')] }), [met('c1'), met('c2')])
    }
    accept(w, submit(w, 6, { checks: [passed('typecheck'), skipped('test'), passed('build')], criteria: [met('c1')] }), [met('c1')])
    expect([read(w, 6).verification.state, read(w, 6).verification.reason]).toEqual(['missing', 'required_evidence_missing'])
  })

  it('reads a ticket with no attempt as missing, and a cutoff before the acceptance as pending worker claims', () => {
    const w = performanceWorld()
    expect([read(w, 7).verification.state, read(w, 7).verification.reason, read(w, 7).verification.attemptId]).toEqual(['missing', 'no_attempt', null])
    const attempt = submit(w, 2, { criteria: [met('c1'), met('c2')] })
    const beforeAccept = w.ctx.clock.nowIso()
    w.ctx.clock.advanceSeconds(1)
    accept(w, attempt, [met('c1'), met('c2')])
    const early = read(w, 2, beforeAccept)
    expect([early.verification.state, early.verification.reason, early.verification.decidedAt]).toEqual(['pending', 'awaiting_review', null])
    expect(early.verification.items.map((item) => item.basis)).toEqual(['worker_claim', 'worker_claim'])
  })
})

describe('DM-175 c1: verification records — late reconciliation (required fix)', () => {
  it('refuses a cutoff that is not a time and a ticket outside the run', () => {
    const w = performanceWorld()
    expect(errorCode(() => read(w, 2, 'yesterday'))).toBe('invalid_input')
    expect(errorCode(() => read(w, 99))).toBe('not_found')
  })

  it('keeps the state read at an older cutoff when an expired attempt is resubmitted later (reconcileAttempt)', () => {
    const w = performanceWorld()
    const claimed = claim(w.ctx, w.runId, 3)
    w.ctx.clock.advanceSeconds(24 * 3600)
    settleLeases(w.ctx, claimed.attempt.id)
    const cutoff = w.ctx.clock.nowIso()
    const before = read(w, 3, cutoff)
    expect([before.verification.state, before.verification.reason, before.verification.attemptState]).toEqual(['pending', 'in_progress', 'lease_expired'])
    w.ctx.clock.advanceSeconds(600)
    reconcileAttempt(w.ctx, { attemptId: claimed.attempt.id, resolution: 'resubmit', outputs: { summary: 'late' }, evidence: { checks: [], criteria: [met('c1'), met('c2')], notes: '' } })
    expect(read(w, 3, cutoff)).toEqual(before)
    const now = read(w, 3)
    expect([now.verification.state, now.verification.reason, now.verification.attemptState]).toEqual(['pending', 'awaiting_review', 'submitted'])
  })

  it('reads a resubmitted attempt as running before its lease ended', () => {
    const w = performanceWorld()
    const claimed = claim(w.ctx, w.runId, 3)
    const whileHeld = w.ctx.clock.nowIso()
    w.ctx.clock.advanceSeconds(24 * 3600)
    reconcileAttempt(w.ctx, { attemptId: claimed.attempt.id, resolution: 'resubmit', outputs: { summary: 'late' }, evidence: { checks: [], criteria: [met('c1')], notes: '' } })
    expect(read(w, 3, whileHeld).verification.attemptState).toBe('running')
  })
})

describe('DM-175 c3: a later confirmed regression is a new dated input; accepted history stays', () => {
  it('lists a candidate, then charges the confirmed regression and keeps it charged after the fix, rebuilding every earlier input exactly', () => {
    const w = performanceWorld()
    const attempt = submit(w, 2, { checks: [passed('typecheck')], criteria: [met('c1'), met('c2')] })
    accept(w, attempt, [met('c1'), met('c2')])
    accept(w, submit(w, 3, { criteria: [met('c1'), met('c2')] }), [met('c1'), met('c2')])
    const report = submitSprintReport(w.ctx, {
      runId: w.runId,
      sprintId: w.sprintId,
      report: { summary: 'Tickets 2 and 3.', accepted: [tid(2), tid(3)], failed: [], blocked: [], changes: { files: [], commits: [] }, checks: [], risks: [], followUps: [], exitCriteria: [], epicOutcome: null, retro: null }
    })
    const history = () => {
      const all = (sql: string) => contentHash(w.ctx.db.all(sql).map((row) => ({ ...(row as object) })))
      return [all('SELECT * FROM attempts ORDER BY id'), all('SELECT * FROM sprint_reports ORDER BY id'), contentHash(buildRunHistoryRecord(w.ctx.db, w.runId)), all('SELECT * FROM epics ORDER BY id'), all('SELECT * FROM plan_revisions ORDER BY id')]
    }
    w.ctx.clock.advanceSeconds(3600)
    const before = history()
    const first = read(w, 2)
    expect(first.regressions).toEqual([])
    expect(gradeWith(first.performance).components.find((c) => c.component === 'P')?.score).toBe(100)

    w.ctx.clock.advanceSeconds(86_400)
    const [defectId = ''] = recordObservations(w.ctx, [defectReport(w, { severity: 'medium', attribution: 'candidate', origin: { ticket: 2 }, phase: 'later_sprint' })]).created
    const second = read(w, 2)
    expect(second.basisAt).toBe(w.ctx.clock.nowIso())
    expect(second.regressions).toEqual([{ defectId, severity: 'medium', attribution: 'candidate', status: 'open', charge: 'candidate' }])
    expect(second.performance.regressions).toEqual([{ observationId: defectId, severity: 'medium', attribution: 'unassigned' }])

    w.ctx.clock.advanceSeconds(3600)
    recordObservations(w.ctx, [
      defectFollowUp(w, 'reassessment', defectId, {
        attributes: { attribution: 'attributed', severity: 'high' },
        evidence: [{ kind: 'ticket', id: tid(2), detail: 'origin' }, { kind: 'attempt', id: attempt, detail: 'origin' }]
      })
    ])
    const third = read(w, 2)
    expect(third.basisAt).toBe(w.ctx.clock.nowIso())
    expect(third.regressions).toEqual([{ defectId, severity: 'high', attribution: 'attributed', status: 'open', charge: 'charged' }])
    expect(gradeWith(third.performance).components.find((c) => c.component === 'P')?.score).toBe(70)

    w.ctx.clock.advanceSeconds(3600)
    recordObservations(w.ctx, [defectFollowUp(w, 'fix', defectId, { evidence: [{ kind: 'commit', id: COMMIT.fix, detail: 'fixed by' }] })])
    expect(read(w, 2).regressions).toEqual([{ defectId, severity: 'high', attribution: 'attributed', status: 'fixed', charge: 'charged' }])

    expect(read(w, 2, first.cutoff)).toEqual(first)
    expect(read(w, 2, second.cutoff)).toEqual(second)
    expect(read(w, 2, third.cutoff)).toEqual(third)
    expect(history()).toEqual(before)
    expect(w.ctx.db.get<{ content_hash: string }>('SELECT content_hash FROM sprint_reports WHERE id = ?', report.id)?.content_hash).toBe(report.contentHash)
  })
})

interface PerformanceFixture {
  facts: VerificationFacts
  defects: MetricObservation[]
  expected: {
    verification: { state: VerificationState; reason: VerificationReason; items: Pick<VerificationItem, 'kind' | 'id' | 'required' | 'basis' | 'result'>[] }
    performance: PerformanceInput
    regressions: RegressionView[]
  }
}

function runFixture(name: string) {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, 'performance', `${name}.json`), 'utf8')) as PerformanceFixture
  const input = ticketPerformance(fixture.facts, resolveDefects(fixture.defects, fixture.facts.cutoff).defects)
  return { fixture, input, grade: gradeWith(input.performance) }
}

describe('DM-175 c4: checked-in performance fixtures', () => {
  it.each(['fast-cheap-failing', 'passing-missing-evidence', 'unrelated-defect', 'fixed-linked-regression'])('%s: every defect record is storable and the P input is the expected one', (name) => {
    const { fixture, input } = runFixture(name)
    expect(fixture.defects.map((defect) => ledgerProblem(parseObservation(defect)))).toEqual(fixture.defects.map(() => null))
    expect([input.verification.state, input.verification.reason]).toEqual([fixture.expected.verification.state, fixture.expected.verification.reason])
    expect(input.verification.items.map(({ kind, id, required, basis, result }) => ({ kind, id, required, basis, result }))).toEqual(fixture.expected.verification.items)
    expect(input.performance).toEqual(fixture.expected.performance)
    expect(input.regressions).toEqual(fixture.expected.regressions)
  })

  it('fast-cheap-failing: a confirmed failure scores P 0 and caps the grade at F 59', () => {
    const { input, grade } = runFixture('fast-cheap-failing')
    expect(input.performance.verification.state).toBe('failed')
    expect(grade.components.find((c) => c.component === 'P')?.score).toBe(0)
    expect([grade.letter, grade.score]).toEqual(['F', 59])
  })

  it('passing-missing-evidence: a passing change without required evidence stays ungraded', () => {
    const { input, grade } = runFixture('passing-missing-evidence')
    expect(input.performance.verification.state).toBe('missing')
    expect(grade.status).toBe('ungraded')
    expect(grade.statusReasons).toContain('verification_missing')
  })

  it('unrelated-defect: a defect without this ticket as origin charges nothing (P 100)', () => {
    const { input, grade } = runFixture('unrelated-defect')
    expect(input.performance.regressions).toEqual([])
    expect(grade.components.find((c) => c.component === 'P')?.score).toBe(100)
  })

  it('fixed-linked-regression: one high regression reported twice counts once and stays charged after its fix (P 70)', () => {
    const { input, grade } = runFixture('fixed-linked-regression')
    expect(input.regressions.map((item) => [item.severity, item.status, item.charge])).toEqual([['high', 'fixed', 'charged']])
    expect(grade.components.find((c) => c.component === 'P')?.score).toBe(70)
  })
})
