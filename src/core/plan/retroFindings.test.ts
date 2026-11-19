import { describe, expect, it } from 'vitest'
import { acceptAttempt } from '../services/attempts'
import { getRetroFindings } from '../services/retroFindings'
import { FINDING_KINDS, type RetroFinding, type RetroFindingsView } from '../../shared/domain/retroFindings'
import { tid } from '../../test/bundles'
import { deliver, frozenSnapshot, measuredSprint, MIN, reject, sprintReport, work, world, type World } from '../../test/experimentWorld'
import { deriveRetroFindings } from './retroFindings'

const findingsOf = (w: World): RetroFindingsView => getRetroFindings(w.ctx, { reportId: sprintReport(w).id })
const find = (view: RetroFindingsView, kind: RetroFinding['kind'], ticket?: number): RetroFinding | undefined =>
  view.findings.find((item) => item.kind === kind && (ticket === undefined || item.subject.id === tid(ticket)))
const concernsOf = (finding: RetroFinding | undefined): string[] => [...new Set(finding?.hypotheses.map((item) => item.concern))].sort()
const texts = (view: RetroFindingsView): string[] => [
  ...view.findings.flatMap((item) => [item.statement, ...item.hypotheses.map((hypothesis) => hypothesis.hypothesis), ...item.contradictedBy]),
  ...view.contradictions.map((item) => item.detail)
]

describe('DM-185 c1: findings rank concrete observed gaps', () => {
  it('ranks by severity, then the fixed kind order, then the id', () => {
    const { w, report } = measuredSprint()
    const view = getRetroFindings(w.ctx, { reportId: report.id })
    expect(view.status).toBe('findings')
    expect(view.findings.map((item) => item.rank)).toEqual(view.findings.map((_, index) => index + 1))
    for (const [index, item] of view.findings.entries()) {
      const previous = view.findings[index - 1]
      if (previous === undefined) continue
      expect(previous.severity).toBeGreaterThanOrEqual(item.severity)
      if (previous.severity === item.severity) {
        const order = FINDING_KINDS.indexOf(previous.kind) - FINDING_KINDS.indexOf(item.kind)
        expect(order < 0 || (order === 0 && previous.id < item.id)).toBe(true)
      }
    }
    expect(view.findings.slice(0, 4).map((item) => item.id)).toEqual([
      `failed_verification:ticket:${tid(6)}`,
      `coordination_problem:ticket:${tid(6)}`,
      `budget_overrun:ticket:${tid(2)}:T`,
      `budget_overrun:ticket:${tid(3)}:T`
    ])
  })

  it('shows a delivery gap with its committed and delivered counts, the undelivered tickets and the attempts behind them', () => {
    const { w, report, attempts } = measuredSprint()
    const gap = find(getRetroFindings(w.ctx, { reportId: report.id }), 'delivery_gap')
    expect(gap?.statement).toBe(
      `Sprint ${w.sprintId}: delivered 4 of 6 committed items (2 short, 33.3%). Not delivered: DM-5 "Ticket 5" (missing, no_attempt), DM-6 "Ticket 6" (failed, confirmed_failure).`
    )
    expect(gap?.magnitude).toMatchObject({ measure: 'A.delivered', value: 4, unit: 'count', reference: 6, ratio: 0.666667 })
    expect(gap?.severity).toBe(0.333333)
    expect(gap?.origins.ticketIds).toEqual([tid(5), tid(6)].sort())
    expect(gap?.origins.attemptIds).toContain(attempts.second6)
  })

  it('counts the committed items whose delivery state rests on reviewed evidence as the delivery gap coverage', () => {
    const { w, report } = measuredSprint()
    expect(find(getRetroFindings(w.ctx, { reportId: report.id }), 'delivery_gap')?.coverage.items).toEqual({ measured: 6, total: 6 })
    const claimsOnly = world({ size: 3, acceptanceNode: false })
    deliver(claimsOnly, 1, { minutes: 20, tokens: 20_000 })
    work(claimsOnly, 2, { minutes: 20, tokens: 20_000 })
    // Accepted with no criterion checked by the reviewer: the worker's claims are all there is.
    acceptAttempt(claimsOnly.reviewer, { attemptId: work(claimsOnly, 3, { minutes: 20, tokens: 20_000 }), notes: 'looks fine' })
    const gap = find(findingsOf(claimsOnly), 'delivery_gap')
    expect(gap?.statement).toBe(
      `Sprint ${claimsOnly.sprintId}: delivered 2 of 3 committed items (1 short, 33.3%). Not delivered: DM-2 "Ticket 2" (pending, awaiting_review), DM-3 "Ticket 3" (missing, worker_claims_only).`
    )
    expect(gap?.coverage.items).toEqual({ measured: 2, total: 3 })
  })
})

describe('DM-185 c1: findings show magnitude, coverage, origins and ticket names', () => {
  it('cites the failed criteria, checks and attempts of a failed verification', () => {
    const { w, report, attempts } = measuredSprint()
    const failed = find(getRetroFindings(w.ctx, { reportId: report.id }), 'failed_verification', 6)
    expect(failed?.magnitude).toMatchObject({ measure: 'P.score', value: 0, reference: 100, text: 'verification failed (P 0 of 100)' })
    expect(failed?.origins.attemptIds).toEqual([attempts.second6])
    expect(failed?.origins.criteria).toEqual([
      { ticketId: tid(6), criterionId: 'c1' },
      { ticketId: tid(6), criterionId: 'c2' }
    ])
    expect(failed?.origins.checks).toEqual([{ attemptId: attempts.second6, name: 'typecheck' }])
  })

  it('shows an overrun as actual against baseline, a rejection as a count, and gives handoff findings no item coverage', () => {
    const { w, report } = measuredSprint()
    const view = getRetroFindings(w.ctx, { reportId: report.id })
    expect(find(view, 'budget_overrun', 3)?.magnitude).toMatchObject({ measure: 'T.actual_ms', value: 50 * MIN, reference: 30 * MIN, ratio: 1.666667, text: '66.7% over its budget baseline' })
    const rejected = find(view, 'coordination_problem', 2)
    expect(rejected?.magnitude).toMatchObject({ measure: 'C.rejected_submissions', value: 1 })
    expect(rejected?.coverage.items).toBeNull()
  })

  it('names tickets by key and title in statements, hypotheses and contradictions', () => {
    const { w, report } = measuredSprint()
    const view = getRetroFindings(w.ctx, { reportId: report.id })
    expect(find(view, 'failed_verification', 6)?.statement).toBe('Ticket DM-6 "Ticket 6": required verification failed (4 cited records): verification failed (P 0 of 100).')
    expect(find(view, 'coordination_problem', 2)?.statement).toBe('Ticket DM-2 "Ticket 2": 1 submission rejected (C 50 of 100).')
    expect(view.contradictions.map((item) => item.detail)).toContain('Active time and tokens of DM-6 "Ticket 6" sit on opposite sides of their baselines (T 133.3%, K 80% of baseline).')
    expect(texts(view).filter((text) => /tk_[0-9a-z]{26}/.test(text))).toEqual([])
  })
})

describe('DM-185 c1: findings stay deterministic and show unmeasured tickets', () => {
  it('names tickets by id when no names are given, and gives the same findings for the same snapshot', () => {
    const { w, report } = measuredSprint()
    const snapshot = frozenSnapshot(w, report.id)
    const bare = deriveRetroFindings(snapshot)
    expect(find(bare, 'failed_verification', 6)?.statement).toBe(`Ticket ${tid(6)}: required verification failed (4 cited records): verification failed (P 0 of 100).`)
    expect(JSON.stringify(deriveRetroFindings(snapshot))).toBe(JSON.stringify(bare))
    expect(JSON.stringify(getRetroFindings(w.ctx, { reportId: report.id }))).toBe(JSON.stringify(getRetroFindings(w.ctx, { reportId: report.id })))
  })

  it('shows missing instrumentation with the tickets that reported nothing', () => {
    const { w, report } = measuredSprint()
    const missing = getRetroFindings(w.ctx, { reportId: report.id }).findings.filter((item) => item.kind === 'missing_instrumentation')
    expect(missing.map((item) => item.component).sort()).toEqual(['E', 'K', 'T'])
    for (const item of missing) {
      expect(item.origins.ticketIds).toEqual([tid(4)])
      expect(item.coverage.items).toEqual({ measured: item.coverage.items === null ? -1 : item.coverage.items.total - 1, total: 5 })
    }
  })
})

describe('DM-185 c1: corrective concentration needs a strict majority', () => {
  const split = (corrective: [number, number]): RetroFindingsView => {
    const w = world({ size: 2, acceptanceNode: false })
    deliver(w, 1, { minutes: 20, tokens: 20_000, productive: 20 - corrective[0], corrective: corrective[0] })
    deliver(w, 2, { minutes: 20, tokens: 20_000, productive: 20 - corrective[1], corrective: corrective[1] })
    return findingsOf(w)
  }

  it('finds no concentration in an even split of corrective effort', () => {
    expect(split([10, 10]).findings.filter((item) => item.kind === 'corrective_concentration')).toEqual([])
  })

  it('finds the ticket holding the majority, with its share of the sprint', () => {
    const concentrated = split([11, 9]).findings.filter((item) => item.kind === 'corrective_concentration')
    expect(concentrated.map((item) => item.subject.id)).toEqual([tid(1)])
    expect(concentrated[0]?.magnitude).toMatchObject({ measure: 'E.corrective_ms', value: 11 * MIN, reference: 20 * MIN, ratio: 0.55 })
    expect(concentrated[0]?.coverage.items).toEqual({ measured: 2, total: 2 })
  })
})

describe('DM-185 c2: proposals tell code, plan, tooling and evidence gaps apart', () => {
  it('reads a recorded coordination defect as orchestration or tooling, routed to the Dark Mechanicus source', () => {
    const { w, report } = measuredSprint({ defect: true })
    const coordination = find(getRetroFindings(w.ctx, { reportId: report.id }), 'coordination_problem', 1)
    expect(concernsOf(coordination)).toEqual(['orchestration_tooling'])
    expect(coordination?.proposal).toMatchObject({ concern: 'orchestration_tooling', destination: 'darkmechanicus_source' })
  })

  it('lists a code defect and a plan or context issue for a failed verification and picks neither', () => {
    const { w, report } = measuredSprint()
    const failed = find(getRetroFindings(w.ctx, { reportId: report.id }), 'failed_verification', 6)
    expect(concernsOf(failed)).toEqual(['code_defect', 'plan_context'])
    expect(failed).toMatchObject({ concern: null, proposal: null, withheld: 'multiple_candidate_causes' })
  })

  it('reads a delivery gap from a confirmed failure as the failed ticket reads, so neither picks a cause', () => {
    const w = world({ size: 2, acceptanceNode: false, retryLimit: 2 })
    deliver(w, 1, { minutes: 20, tokens: 20_000 })
    reject(w, work(w, 2, { minutes: 20, tokens: 20_000 }), 'c1 fails')
    reject(w, work(w, 2, { minutes: 20, tokens: 20_000 }), 'c1 still fails')
    const view = findingsOf(w)
    const gap = find(view, 'delivery_gap')
    expect(concernsOf(gap)).toEqual(concernsOf(find(view, 'failed_verification', 2)))
    expect(concernsOf(gap)).toEqual(['code_defect', 'plan_context'])
    expect(gap).toMatchObject({ concern: null, proposal: null, withheld: 'multiple_candidate_causes' })
    expect(gap?.hypotheses.map((item) => item.hypothesis)).toEqual([
      'Hypothesis: the delivered change did not do what the failed check or criterion asked (DM-2 "Ticket 2" confirmed_failure).',
      'Hypothesis: the criterion as written did not say what the review expected, so the work aimed elsewhere (DM-2 "Ticket 2" confirmed_failure).'
    ])
  })
})

describe('DM-185 c2: unavailable evidence and valid exploration', () => {
  it('reads missing instrumentation as unavailable evidence, outlined as a discovery for the Dark Mechanicus source', () => {
    const { w, report } = measuredSprint()
    const missing = getRetroFindings(w.ctx, { reportId: report.id }).findings.filter((item) => item.kind === 'missing_instrumentation')
    expect(missing.map((item) => [item.concern, item.proposal?.destination, item.proposal?.baseline])).toEqual(missing.map(() => ['unavailable_evidence', 'darkmechanicus_source', null]))
  })

  it('reads an overrun spent on productive work as a plan fit, calls its exploration not waste and outlines it for the source repository', () => {
    const { w, report } = measuredSprint()
    const view = getRetroFindings(w.ctx, { reportId: report.id })
    const overrun = find(view, 'budget_overrun', 3)
    expect(overrun?.hypotheses).toEqual([
      {
        concern: 'plan_context',
        hypothesis:
          'Hypothesis: the budget or size did not fit the work. No corrective effort was recorded, so the overrun went into productive work, exploration included, which is not waste.'
      }
    ])
    expect(overrun?.proposal).toMatchObject({ concern: 'plan_context', destination: 'source_repository', direction: 'increase', baseline: { measure: 'T.score', unit: 'points', state: 'observed' } })
    expect(find(view, 'corrective_concentration', 3)).toBeUndefined()
    const waste = texts(view).filter((text) => /waste/i.test(text))
    expect(waste.length).toBeGreaterThan(0)
    expect(waste.every((text) => /(not|neither is) (counted as )?waste/i.test(text))).toBe(true)
    expect(view.notes).toContain('Productive effort (planned tests, useful investigation) and unclassified effort are never counted as waste; only corrective effort is.')
  })
})

describe('DM-185 c3: a proposal outline is measurable, routed, and holds no work', () => {
  it('gives an outline a measured baseline, a direction, guardrails at their current values and what the planner still writes', () => {
    const { w, report } = measuredSprint()
    const outline = find(getRetroFindings(w.ctx, { reportId: report.id }), 'budget_overrun', 3)?.proposal
    expect(outline?.source).toEqual({ reportId: report.id, assessmentId: find(getRetroFindings(w.ctx, { reportId: report.id }), 'budget_overrun', 3)?.assessmentId })
    expect(outline?.guardrails).toEqual([
      { measure: 'P.score', unit: 'points', comparator: 'at_least', threshold: 100 },
      { measure: 'A.delivered', unit: 'count', comparator: 'at_least', threshold: 2 }
    ])
    expect(outline?.needs[0]).toBe('proposedWork: specific, sized corrective work the planner authors (each item says what changes and has a size)')
    expect(outline !== undefined && outline !== null && 'proposedWork' in outline).toBe(false)
  })

  it('guards nothing with a measure at zero: no "at least 0" guardrail, and the planner is told to write one', () => {
    const w = world({ size: 3, acceptanceNode: false, retryLimit: 3 })
    deliver(w, 1, { minutes: 20, tokens: 20_000, productive: 20, corrective: 0 })
    deliver(w, 2, { minutes: 20, tokens: 20_000, productive: 20, corrective: 0 })
    reject(w, work(w, 3, { minutes: 50, tokens: 50_000, productive: 50, corrective: 0 }), 'c1 is not met yet')
    const view = findingsOf(w)
    for (const finding of [find(view, 'budget_overrun', 3), find(view, 'delivery_gap')]) {
      expect(finding?.proposal?.concern).toBe('plan_context')
      expect(finding?.proposal?.guardrails).toEqual([])
      expect(finding?.proposal?.needs).toContain('guardrails: no guardrail measure has a value above zero in this grade to hold')
    }
  })
})

describe('DM-185 c4: edge cases stay deterministic and invent no work', () => {
  it('says there is no meaningful issue when every ticket is on budget, verified and without rework', () => {
    const w = world({ size: 3, acceptanceNode: false })
    for (const n of [1, 2, 3]) deliver(w, n, { minutes: 20, tokens: 30_000, productive: 20, corrective: 0 })
    const view = findingsOf(w)
    expect(view.status).toBe('no_meaningful_issue')
    expect(view.findings).toEqual([])
    expect(view.notes).toContain('No measured gap passed the thresholds: there is nothing to correct, and no improvement work is proposed.')
  })

  it('outlines only instrumentation on sparse data', () => {
    const w = world({ size: 3, acceptanceNode: false })
    for (const n of [1, 2, 3]) deliver(w, n, { minutes: null, tokens: null })
    const view = findingsOf(w)
    expect(view.status).toBe('insufficient_data')
    expect(view.findings.length).toBeGreaterThan(0)
    for (const item of view.findings) {
      if (item.kind === 'missing_instrumentation') expect(item.proposal?.baseline).toBeNull()
      else expect(item).toMatchObject({ proposal: null, withheld: 'sparse_data' })
    }
  })

  it('lists contradictory signals and withholds the outline of the finding they touch', () => {
    const w = world({ size: 2, acceptanceNode: false, retryLimit: 2 })
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20, corrective: 0 })
    reject(w, work(w, 2, { minutes: 20, tokens: 30_000, productive: 20, corrective: 0 }), 'c1 unmet')
    deliver(w, 2, { minutes: 5, tokens: 5_000, productive: 5, corrective: 0 })
    const view = findingsOf(w)
    const torn = find(view, 'coordination_problem', 2)
    expect(view.contradictions).toEqual([
      { subject: { level: 'ticket', id: tid(2) }, findingIds: [`coordination_problem:ticket:${tid(2)}`], detail: 'C shows 1 rejected submission, but E records no corrective effort for DM-2 "Ticket 2".' }
    ])
    expect(torn).toMatchObject({ withheld: 'contradictory_signals', proposal: null, contradictedBy: [view.contradictions[0]?.detail] })
  })

  it('outlines nothing for a finding with several candidate causes, and reading findings writes no experiment', () => {
    const { w, report } = measuredSprint()
    const view = getRetroFindings(w.ctx, { reportId: report.id })
    const multi = view.findings.filter((item) => concernsOf(item).length > 1)
    expect(multi.length).toBeGreaterThan(0)
    expect(multi.every((item) => item.concern === null && item.proposal === null)).toBe(true)
    expect(view.notes).toContain('Where several concerns could explain a gap, each is listed as a hypothesis and none is chosen.')
    const stored = w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sprint_reports WHERE json_extract(content_json, '$.retro.experiments') IS NOT NULL")
    expect(stored?.n).toBe(0)
  })
})
