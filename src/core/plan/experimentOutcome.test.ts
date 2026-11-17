import { describe, expect, it } from 'vitest'
import type { TicketSize } from '../../shared/domain/bundle'
import type { ExperimentEvent, ExperimentGuardrail, ExperimentOutcome, RetroExperiment } from '../../shared/domain/experiments'
import type { ScorecardSnapshot } from '../../shared/domain/spaceGrades'
import { tid } from '../../test/bundles'
import { cleanSprint4, measuredEpic, type MeasuredEpic } from '../../test/outcomeWorld'
import { canonicalJson } from '../canonical'
import { getExperiment } from '../services/experiments'
import { outcomeReads } from '../services/experimentOutcomes'
import { experimentOutcome, type OutcomeInput } from './experimentOutcome'
import { ownAssessment, readMeasure, sealedAssessment } from './experiments'

type ResultEvent = Extract<ExperimentEvent, { kind: 'result' }>

/** What the outcome read hands the classifier for `w`'s epic: its stored scorecards, scope starts and planned sizes. */
function inputFor(w: MeasuredEpic, experiment: RetroExperiment, patch: Partial<OutcomeInput> = {}): OutcomeInput {
  const reads = outcomeReads(w.m.ctx)
  return {
    experiment,
    status: 'completed',
    events: [resultOf(w, w.xp.tokens.id)],
    scorecard: (reportId) => reads.card(reportId).card,
    starts: reads.starts(w.epicId),
    corrections: getExperiment(w.m.ctx, { experimentId: experiment.id }).outcome.corrections.tickets,
    sizeOf: (planRevisionId, ticketId) => reads.size(planRevisionId, ticketId),
    ...patch
  }
}

/** The experiment's result read from Sprint 3's sprint grade. */
function resultOf(w: MeasuredEpic, experimentId: string): ResultEvent {
  const event = w.results.get(experimentId)
  if (event?.kind !== 'result') throw new Error(`experiment ${experimentId} has no Sprint 3 result`)
  return event
}

/** A result event citing `grade` of `card`, holding exactly what that grade holds for `experiment`'s measure. */
function citing(template: ResultEvent, card: ScorecardSnapshot, assessmentId: string, measure: RetroExperiment['baseline']['measure']): ResultEvent {
  const found = sealedAssessment(card, assessmentId)
  if (found === null) throw new Error(`no assessment ${assessmentId}`)
  const reading = readMeasure(card, found.grade, measure)
  const value = 'missing' in reading ? { value: null, state: 'missing' as const } : { value: reading.value, state: reading.state }
  return { ...template, id: `${template.id.slice(0, -2)}zz`, result: { ...template.result, assessment: found.ref, ...value } }
}

const changed = (experiment: RetroExperiment, change: Partial<RetroExperiment['expectedChange']>): RetroExperiment => ({ ...experiment, expectedChange: { ...experiment.expectedChange, ...change } })

const last = (outcome: ExperimentOutcome) => outcome.comparisons.at(-1)

describe('DM-188 c2: compatible numeric results classify deterministically at the boundaries of the expected change', () => {
  it('reads 30,000 -> 21,000 tokens per ticket as improved when -30% is expected and unchanged at -31%', () => {
    const w = measuredEpic()
    const exactly = experimentOutcome(inputFor(w, changed(w.xp.tokens, { amount: 30 })))
    const short = experimentOutcome(inputFor(w, changed(w.xp.tokens, { amount: 31 })))
    expect([last(exactly)?.before, last(exactly)?.measured, last(exactly)?.target]).toEqual([30_000, 21_000, 21_000])
    expect(exactly.classification).toBe('improved')
    expect(exactly.reasons).toEqual([`result #5: it moved 9000 toward the target (9000 expected), and every guardrail held`])
    expect(short.classification).toBe('unchanged')
    expect(short.reasons).toEqual([`result #5: it moved 9000 toward the target (9300 expected): less than the expected change either way`])
  })

  it('reads the same move against an expected increase as regressed at +30% and unchanged at +31%', () => {
    const w = measuredEpic()
    const reversed = experimentOutcome(inputFor(w, changed(w.xp.tokens, { direction: 'increase', amount: 30 })))
    const short = experimentOutcome(inputFor(w, changed(w.xp.tokens, { direction: 'increase', amount: 31 })))
    expect(reversed.classification).toBe('regressed')
    expect(reversed.reasons).toEqual(['result #5: it moved 9000 away from the target (9000 expected): at least the expected change the other way'])
    expect(short.classification).toBe('unchanged')
  })

  it('divides an absolute expected change of a sprint total by its tickets: -27,000 tokens is improved, -27,001 unchanged', () => {
    const w = measuredEpic()
    const reached = experimentOutcome(inputFor(w, changed(w.xp.tokens, { amount: 27_000, unit: 'tokens' })))
    const missed = experimentOutcome(inputFor(w, changed(w.xp.tokens, { amount: 27_001, unit: 'tokens' })))
    expect([reached.classification, last(reached)?.target]).toEqual(['improved', 21_000])
    expect(missed.classification).toBe('unchanged')
    expect(missed.reasons[0]).toContain('(9000.333333 expected)')
  })

  it('gives byte-identical outcomes for the same records, whatever order the scope starts are listed in', () => {
    const w = measuredEpic()
    const window = { ...w.xp.tokens, window: { basis: 'tickets' as const, count: 7 } }
    const once = canonicalJson(experimentOutcome(inputFor(w, window)))
    expect(canonicalJson(experimentOutcome(inputFor(w, window)))).toBe(once)
    expect(canonicalJson(experimentOutcome(inputFor(w, window, { starts: [...inputFor(w, window).starts].reverse() })))).toBe(once)
  })
})

describe('DM-188 c2: missing or incomparable data gives insufficient evidence', () => {
  it('without any result, says no measured result is recorded', () => {
    const w = measuredEpic()
    const outcome = experimentOutcome(inputFor(w, w.xp.tokens, { events: [] }))
    expect([outcome.classification, outcome.decidedBy, outcome.reasons]).toEqual(['insufficient_evidence', null, ['no measured result is recorded']])
  })

  it('places no result before the corrective work landed: unaccepted work, or no ticket and no completed status; a completed status lands it', () => {
    const w = measuredEpic()
    const tickets = inputFor(w, w.xp.tokens).corrections
    const open = experimentOutcome(inputFor(w, w.xp.tokens, { corrections: tickets.map((ticket) => ({ ...ticket, accepted: null })) }))
    const none = experimentOutcome(inputFor(w, w.xp.tokens, { corrections: [] }))
    const completed = getExperiment(w.m.ctx, { experimentId: w.xp.tokens.id }).events.filter((event) => event.kind === 'status' && event.status === 'completed')
    const byStatus = experimentOutcome(inputFor(w, w.xp.tokens, { corrections: [], events: [...completed, resultOf(w, w.xp.tokens.id)] }))
    expect(open.classification).toBe('insufficient_evidence')
    expect(open.reasons[0]).toContain(`the corrective work has not landed (corrective work ${tickets[0]?.key ?? ''} is not accepted yet)`)
    expect(none.reasons[0]).toContain('no corrective ticket is found here and it is not marked completed')
    expect([byStatus.classification, byStatus.landing.by]).toEqual(['improved', 'completed_status'])
  })

  it('does not compare a stated value, a missing or estimated reading, or a value in another unit', () => {
    const w = measuredEpic()
    const template = resultOf(w, w.xp.tokens.id)
    const stated = experimentOutcome(inputFor(w, w.xp.tokens, { events: [{ ...template, result: { ...template.result, assessment: null, value: 60_000 } }] }))
    // S.score is never rated, so Sprint 3's grade holds no value for it; grade.score is estimated until every component is measured.
    const rating = { ...w.xp.tokens, baseline: { measure: 'S.score' as const, unit: 'points' as const, value: 80, state: 'observed' as const }, expectedChange: { direction: 'increase' as const, amount: 5, unit: 'points' as const } }
    const missing = experimentOutcome(inputFor(w, rating, { events: [citing(template, w.cards[2], w.cards[2].sprint.assessmentId, 'S.score')] }))
    const grade = { ...rating, baseline: { ...rating.baseline, measure: 'grade.score' as const, value: 100, state: 'estimated' as const } }
    const estimated = experimentOutcome(inputFor(w, grade, { events: [citing(template, w.cards[2], w.cards[2].sprint.assessmentId, 'grade.score')] }))
    const unit = experimentOutcome(inputFor(w, w.xp.tokens, { events: [{ ...template, result: { ...template.result, unit: 'milliseconds' } }] }))
    expect(stated.reasons).toEqual(['result #5: it is a stated value that names no frozen assessment, so its window, scope and guardrails cannot be checked'])
    expect(missing.reasons[0]).toContain('the result has no value (missing)')
    expect(estimated.reasons[0]).toContain('the result is estimated, not measured; the baseline is estimated, not measured')
    expect(unit.reasons[0]).toContain('the result is in milliseconds, the baseline in tokens')
    expect([stated, missing, estimated, unit].map((outcome) => outcome.classification)).toEqual(Array(4).fill('insufficient_evidence'))
  })

  it("does not compare the baseline's own assessment, or a result whose scorecard is not here", () => {
    const w = measuredEpic()
    const own = experimentOutcome(inputFor(w, { ...w.xp.tokens, source: { ...w.xp.tokens.source, assessmentId: w.cards[2].sprint.assessmentId } }))
    const reads = inputFor(w, w.xp.tokens).scorecard
    const gone = experimentOutcome(inputFor(w, w.xp.tokens, { scorecard: (reportId) => (reportId === w.reports[2].id ? undefined : reads(reportId)) }))
    expect(own.reasons[0]).toContain("the result is the baseline's own assessment")
    expect(gone.reasons).toEqual([`result #5: the scorecard of report ${w.reports[2].id} it cites is not here`])
    expect([own.classification, gone.classification]).toEqual(['insufficient_evidence', 'insufficient_evidence'])
  })
})

describe('DM-188 c2: a result outside the window or graded under another policy gives insufficient evidence', () => {
  it('places a result only within the window counted after the work landed', () => {
    const w = measuredEpic()
    const windowed = (basis: RetroExperiment['window']['basis'], count: number): ExperimentOutcome => experimentOutcome(inputFor(w, { ...w.xp.tokens, window: { basis, count } }))
    expect(windowed('runs', 1).reasons[0]).toContain('its scope is not among the runs that started after the corrective work landed')
    expect(windowed('tickets', 6).reasons[0]).toContain('it is ticket 7 after the corrective work landed; the experiment measures the next 6')
    expect([windowed('runs', 1), windowed('tickets', 6), windowed('tickets', 7), windowed('sprints', 2)].map((outcome) => outcome.classification)).toEqual([
      'insufficient_evidence',
      'insufficient_evidence',
      'improved',
      'improved'
    ])
  })

  it('compares a score only under the policy of the baseline, and a token total under any policy', () => {
    const w = measuredEpic()
    const reads = inputFor(w, w.xp.tokens).scorecard
    const policy = `sha256:${'2'.repeat(64)}`
    const regraded = (reportId: string): ScorecardSnapshot | null | undefined => {
      const card = reads(reportId)
      return reportId === w.reports[2].id && card != null ? { ...card, policy: { ...card.policy, hash: policy } } : card
    }
    const template = resultOf(w, w.xp.tokens.id)
    const assessment = template.result.assessment
    if (assessment === null) throw new Error('the Sprint 3 result cites no grade')
    const moved = { ...template, result: { ...template.result, assessment: { ...assessment, policyHash: policy } } }
    const score = { ...w.xp.tokens, baseline: { measure: 'A.score' as const, unit: 'points' as const, value: 100, state: 'observed' as const }, expectedChange: { direction: 'increase' as const, amount: 1, unit: 'points' as const } }
    const scoreEvent = { ...moved, result: { ...moved.result, unit: 'points' as const, value: 100, state: 'observed' as const } }
    const scoreOutcome = experimentOutcome(inputFor(w, score, { scorecard: regraded, events: [scoreEvent] }))
    expect(scoreOutcome.classification).toBe('insufficient_evidence')
    expect(scoreOutcome.reasons[0]).toContain(`the result was graded under policy ${policy}, the baseline under ${w.cards[0].policy.hash}`)
    expect(experimentOutcome(inputFor(w, w.xp.tokens, { scorecard: regraded, events: [moved] })).classification).toBe('improved')
  })
})

describe('DM-188 c2: a result of another task scope gives insufficient evidence', () => {
  it("compares a ticket's total only with a ticket of the same planned size", () => {
    const w = measuredEpic()
    const before = ownAssessment(w.cards[0], { level: 'ticket', id: tid(2) })
    const after = w.cards[2].tickets.find((grade) => grade.subject.id === tid(5))
    if (before === null || after === undefined) throw new Error('missing ticket grades')
    const ticket: RetroExperiment = {
      ...w.xp.tokens,
      source: before.ref,
      baseline: { ...w.xp.tokens.baseline, value: 40_000 },
      guardrails: [{ measure: 'C.failed_checks', unit: 'count', comparator: 'at_most', threshold: 0 }],
      window: { basis: 'tickets', count: 7 }
    }
    const events = [citing(resultOf(w, w.xp.tokens.id), w.cards[2], after.assessmentId, 'K.actual_tokens')]
    const reads = inputFor(w, ticket).sizeOf
    const medium = experimentOutcome(inputFor(w, ticket, { events }))
    const large = experimentOutcome(inputFor(w, ticket, { events, sizeOf: (revision, ticketId): TicketSize | null => (ticketId === tid(5) ? 'large' : reads(revision, ticketId)) }))
    expect([last(medium)?.before, last(medium)?.measured, medium.classification]).toEqual([40_000, 21_000, 'improved'])
    expect(large.classification).toBe('insufficient_evidence')
    expect(large.reasons[0]).toContain("a ticket's K.actual_tokens compares only with a ticket of the same planned size (baseline medium, result large)")
  })

  it("compares a sprint's per-ticket figure only with a scope of the same size mix; unsized scopes compare with unsized ones", () => {
    const w = measuredEpic()
    const reads = inputFor(w, w.xp.tokens).sizeOf
    const mixed = experimentOutcome(inputFor(w, w.xp.tokens, { sizeOf: (revision, ticketId) => ([tid(5), tid(6)].includes(ticketId) ? 'large' : reads(revision, ticketId)) }))
    const unsized = experimentOutcome(inputFor(w, w.xp.tokens, { sizeOf: () => null }))
    const half = experimentOutcome(inputFor(w, w.xp.tokens, { sizeOf: (revision, ticketId) => (ticketId === tid(5) ? null : reads(revision, ticketId)) }))
    expect(mixed.reasons[0]).toContain("the scopes' planned size mixes differ (baseline 3 medium; result 2 large, 2 medium)")
    expect([unsized.baseline.sizeMix, last(unsized)?.after.sizeMix, unsized.classification]).toEqual([{ unsized: 3 }, { unsized: 4 }, 'improved'])
    expect(half.reasons[0]).toContain('(baseline 3 medium; result 3 medium, 1 unsized)')
    expect([mixed.classification, half.classification, experimentOutcome(inputFor(w, w.xp.tokens)).classification]).toEqual(['insufficient_evidence', 'insufficient_evidence', 'improved'])
  })

  it('does not read a result that is not what the grade it cites holds', () => {
    const w = measuredEpic()
    const template = resultOf(w, w.xp.tokens.id)
    const forged = experimentOutcome(inputFor(w, w.xp.tokens, { events: [{ ...template, result: { ...template.result, value: 60_000 } }] }))
    expect(forged.classification).toBe('insufficient_evidence')
    expect(forged.reasons[0]).toContain(`states a value the assessment ${w.cards[2].sprint.assessmentId} does not hold, so it is not read`)
  })
})

const without = (experiment: RetroExperiment, measure: ExperimentGuardrail['measure']): RetroExperiment => ({ ...experiment, guardrails: experiment.guardrails.filter((item) => item.measure !== measure) })

describe('DM-188 c3: a lower token or time total with a failed quality guardrail never counts as an improvement', () => {
  it('reads 30,000 -> 21,000 tokens per ticket with C.failed_checks 1 past at most 0 as regressed, whatever drop was expected', () => {
    const w = measuredEpic()
    const events = [resultOf(w, w.xp.quality.id)]
    const outcome = experimentOutcome(inputFor(w, w.xp.quality, { events }))
    expect(outcome.classification).toBe('regressed')
    expect(outcome.reasons).toEqual(['result #5: guardrail breached: C.failed_checks 1 count, past at most 0 count; a breached guardrail is never an improvement, whatever the measure did'])
    expect(experimentOutcome(inputFor(w, without(w.xp.quality, 'C.failed_checks'), { events })).classification).toBe('improved')
    const sweep = [1, 5, 10, 20, 25, 30].map((amount) => experimentOutcome(inputFor(w, changed(w.xp.quality, { amount }), { events })).classification)
    expect(sweep).toEqual(Array(6).fill('regressed'))
  })

  it("reads a ticket's time drop as regressed when that ticket's handoff check failed, and improved without the guardrail", () => {
    const w = measuredEpic()
    const before = ownAssessment(w.cards[0], { level: 'ticket', id: tid(2) })
    const after = w.cards[2].tickets.find((grade) => grade.subject.id === tid(6))
    if (before === null || after === undefined) throw new Error('missing ticket grades')
    const timed: RetroExperiment = {
      ...w.xp.time,
      source: before.ref,
      baseline: { measure: 'T.actual_ms', unit: 'milliseconds', value: 30 * 60_000, state: 'observed' },
      expectedChange: { direction: 'decrease', amount: 10, unit: 'percent' },
      guardrails: [{ measure: 'C.failed_checks', unit: 'count', comparator: 'at_most', threshold: 0 }],
      window: { basis: 'tickets', count: 10 }
    }
    const events = [citing(resultOf(w, w.xp.time.id), w.cards[2], after.assessmentId, 'T.actual_ms')]
    const guarded = experimentOutcome(inputFor(w, timed, { events }))
    expect([last(guarded)?.before, last(guarded)?.measured, guarded.classification]).toEqual([1_800_000, 1_440_000, 'regressed'])
    expect(experimentOutcome(inputFor(w, without(timed, 'C.failed_checks'), { events })).classification).toBe('improved')
  })

  it('keeps a token drop with a guardrail that cannot be read from counting as an improvement', () => {
    const w = measuredEpic()
    const outcome = experimentOutcome(inputFor(w, w.xp.rated, { events: [resultOf(w, w.xp.rated.id)] }))
    expect(outcome.classification).toBe('insufficient_evidence')
    expect(outcome.reasons).toEqual([
      'result #5: it moved 9000 toward the target (6000 expected), but a guardrail could not be read, so it cannot count as an improvement; S.score was not measured (no_rating)'
    ])
  })
})

describe('DM-188 c3: a breach on a placed result decides, whatever its value, other results or unreadable grades', () => {
  it('counts a breach on a placed result whose own value is missing or estimated', () => {
    const w = measuredEpic()
    const template = resultOf(w, w.xp.quality.id)
    const guard = [{ measure: 'C.failed_checks' as const, unit: 'count' as const, comparator: 'at_most' as const, threshold: 0 }]
    const rating = { ...w.xp.quality, guardrails: guard, baseline: { measure: 'S.score' as const, unit: 'points' as const, value: 80, state: 'observed' as const }, expectedChange: { direction: 'increase' as const, amount: 5, unit: 'points' as const } }
    const grade = { ...rating, baseline: { ...rating.baseline, measure: 'grade.score' as const, value: 100 } }
    const missing = experimentOutcome(inputFor(w, rating, { events: [citing(template, w.cards[2], w.cards[2].sprint.assessmentId, 'S.score')] }))
    const estimated = experimentOutcome(inputFor(w, grade, { events: [citing(template, w.cards[2], w.cards[2].sprint.assessmentId, 'grade.score')] }))
    expect([missing.classification, estimated.classification]).toEqual(['regressed', 'regressed'])
    expect(missing.reasons[0]).toContain('also: the result has no value (missing)')
    expect(estimated.reasons[0]).toContain('also: the result is estimated, not measured')
  })

  it('does not count a breach on a result outside the window (Sprint 2, before the work landed)', () => {
    const w = measuredEpic()
    const early = citing(resultOf(w, w.xp.tokens.id), w.cards[1], w.cards[1].sprint.assessmentId, 'K.actual_tokens')
    const outcome = experimentOutcome(inputFor(w, w.xp.tokens, { events: [{ ...early, number: 4 }, resultOf(w, w.xp.tokens.id)] }))
    const first = outcome.comparisons[0]
    expect(first?.guardrails.map((check) => check.verdict)).toEqual(['breached'])
    expect(first?.classification).toBe('insufficient_evidence')
    expect([outcome.classification, outcome.decidedBy]).toEqual(['improved', resultOf(w, w.xp.tokens.id).id])
  })

  it('lets an in-window breach decide over a later clean result', () => {
    const w = measuredEpic()
    const sprint4 = cleanSprint4(w)
    const twoSprints = { ...w.xp.quality, window: { basis: 'sprints' as const, count: 2 } }
    const breach = resultOf(w, w.xp.quality.id)
    const clean = { ...citing(breach, sprint4.card, sprint4.card.sprint.assessmentId, 'K.actual_tokens'), number: 6 }
    const outcome = experimentOutcome(inputFor(w, twoSprints, { events: [breach, clean], starts: outcomeReads(w.m.ctx).starts(w.epicId) }))
    expect(outcome.comparisons.map((comparison) => comparison.classification)).toEqual(['regressed', 'improved'])
    expect([outcome.classification, outcome.decidedBy]).toEqual(['regressed', breach.id])
  })
})

describe('DM-188 c3 (DM-270 R5): a result whose cited grade cannot be read never lets an outcome count as improved', () => {
  it('never counts as improved while the scorecard holding the breach cannot be read (DM-270 R5)', () => {
    const w = measuredEpic()
    const sprint4 = cleanSprint4(w)
    const twoSprints = { ...w.xp.quality, window: { basis: 'sprints' as const, count: 2 } }
    const breach = resultOf(w, w.xp.quality.id)
    const clean = { ...citing(breach, sprint4.card, sprint4.card.sprint.assessmentId, 'K.actual_tokens'), number: 6 }
    const reads = outcomeReads(w.m.ctx)
    const damaged = experimentOutcome(
      inputFor(w, twoSprints, { events: [breach, clean], starts: reads.starts(w.epicId), scorecard: (reportId) => (reportId === w.reports[2].id ? undefined : reads.card(reportId).card) })
    )
    expect(damaged.comparisons.map((comparison) => comparison.classification)).toEqual(['insufficient_evidence', 'improved'])
    expect([damaged.classification, damaged.decidedBy]).toEqual(['insufficient_evidence', null])
    expect(damaged.reasons[0]).toBe('result #6 would count as improved, but the frozen grade cited by result #5 cannot be read here, so a guardrail breach there cannot be ruled out')
  })

  it('does not hold a stated value against an improvement: it cites no grade that could hide a breach', () => {
    const w = measuredEpic()
    const measured = resultOf(w, w.xp.tokens.id)
    const stated = { ...measured, id: `${measured.id.slice(0, -2)}zz`, number: 4, result: { ...measured.result, assessment: null, value: 60_000 } }
    const outcome = experimentOutcome(inputFor(w, w.xp.tokens, { events: [stated, measured] }))
    expect(outcome.comparisons.map((comparison) => comparison.classification)).toEqual(['insufficient_evidence', 'improved'])
    expect([outcome.classification, outcome.decidedBy]).toEqual(['improved', measured.id])
  })
})

describe('DM-273: a baseline or result this machine cannot place', () => {
  it('reads no scope for a baseline whose scorecard or assessment is not here, so no per-ticket figure compares', () => {
    const w = measuredEpic()
    const reads = inputFor(w, w.xp.tokens).scorecard
    const gone = experimentOutcome(inputFor(w, w.xp.tokens, { scorecard: (reportId) => (reportId === w.reports[0].id ? undefined : reads(reportId)) }))
    const unknown = experimentOutcome(inputFor(w, { ...w.xp.tokens, source: { ...w.xp.tokens.source, subject: { level: 'sprint', id: 'sp_zzzzzzzzzzzzzzzzzzzzzzzzzz' } } }))
    for (const outcome of [gone, unknown]) {
      expect([outcome.baseline.sampleSize, outcome.baseline.sizeMix, outcome.baseline.window, last(outcome)?.target]).toEqual([null, null, null, null])
      expect(outcome.reasons).toEqual(['result #5: a per-ticket comparison needs counted tickets in both scopes'])
    }
  })

  it('does not compare a ticket grade with a sprint baseline, whose size mix it does not have', () => {
    const w = measuredEpic()
    const ticket = w.cards[2].tickets.find((grade) => grade.subject.id === tid(5))?.assessmentId ?? ''
    const outcome = experimentOutcome(inputFor(w, w.xp.tokens, { events: [citing(resultOf(w, w.xp.tokens.id), w.cards[2], ticket, 'K.actual_tokens')] }))
    expect(outcome.classification).toBe('insufficient_evidence')
    expect(outcome.reasons[0]).toContain('the result is a ticket grade, the baseline a sprint grade')
    expect(outcome.reasons[0]).toContain("the scopes' planned size mixes differ (baseline 3 medium; result unknown)")
  })

  it("names an unsized ticket's planned size as unsized on either side", () => {
    const w = measuredEpic()
    const before = ownAssessment(w.cards[0], { level: 'ticket', id: tid(2) })
    const after = w.cards[2].tickets.find((grade) => grade.subject.id === tid(5))?.assessmentId ?? ''
    const ticket: RetroExperiment = { ...w.xp.tokens, source: before?.ref ?? w.xp.tokens.source, baseline: { ...w.xp.tokens.baseline, value: 40_000 }, window: { basis: 'tickets', count: 7 } }
    const outcome = experimentOutcome(inputFor(w, ticket, { events: [citing(resultOf(w, w.xp.tokens.id), w.cards[2], after, 'K.actual_tokens')], sizeOf: () => null }))
    expect(outcome.reasons[0]).toContain("a ticket's K.actual_tokens compares only with a ticket of the same planned size (baseline unsized, result unsized)")
  })

  it('does not compare per-ticket figures of scopes that share no planned size', () => {
    const w = measuredEpic()
    const reads = inputFor(w, w.xp.tokens).sizeOf
    const after = [tid(5), tid(6), tid(7), tid(8)]
    const outcome = experimentOutcome(inputFor(w, w.xp.tokens, { sizeOf: (revision, ticketId) => (after.includes(ticketId) ? 'small' : reads(revision, ticketId)) }))
    expect(outcome.classification).toBe('insufficient_evidence')
    expect(outcome.reasons[0]).toContain("the scopes' planned size mixes differ (baseline 3 medium; result 4 small)")
  })

  it('gives a result whose grade has no dispatch no window', () => {
    const w = measuredEpic()
    const reads = inputFor(w, w.xp.tokens).scorecard
    const undispatched = (reportId: string): ScorecardSnapshot | null | undefined => {
      const card = reads(reportId)
      return reportId === w.reports[2].id && card != null ? { ...card, sprint: { ...card.sprint, dispatchedAt: null } } : card
    }
    const outcome = experimentOutcome(inputFor(w, w.xp.tokens, { scorecard: undispatched }))
    expect(outcome.reasons).toEqual(['result #5: the after-assessment has no dispatch, so its window has no start'])
  })
})

describe('DM-273: landing and the window counted after it', () => {
  it('lands the work when its latest accepted corrective ticket was accepted, whatever order they are listed in', () => {
    const w = measuredEpic()
    const [ticket] = inputFor(w, w.xp.tokens).corrections
    if (ticket?.accepted == null) throw new Error('the corrective ticket was not accepted')
    const later = { ...ticket, key: 'DM-90', accepted: { ...ticket.accepted, at: '2026-11-15T09:00:00.000Z' } }
    const earlier = { ...ticket, key: 'DM-91', accepted: { ...ticket.accepted, at: '2026-11-15T08:00:00.000Z' } }
    const outcome = experimentOutcome(inputFor(w, w.xp.tokens, { corrections: [later, earlier] }))
    expect(outcome.landing).toEqual({ at: '2026-11-15T09:00:00.000Z', by: 'corrective_tickets', detail: 'its last corrective ticket DM-90 was accepted at 2026-11-15T09:00:00.000Z' })
  })

  it('orders scopes that started at the same time by their key', () => {
    const w = measuredEpic()
    const starts = inputFor(w, w.xp.tokens).starts
    const third = starts.find((item) => item.sprintId === w.cards[2].sprintId)
    if (third === undefined) throw new Error('Sprint 3 has no scope start')
    const twin = { ...third, runId: 'rn_00000000000000000000000000' }
    const outcome = experimentOutcome(inputFor(w, w.xp.tokens, { starts: [...starts, twin] }))
    expect(outcome.reasons[0]).toContain('it is sprint 2 after the corrective work landed; the experiment measures the next 1')
  })

  it('places no result counted in tickets when no ticket started after the work landed', () => {
    const w = measuredEpic()
    const starts = inputFor(w, w.xp.tokens).starts.map((item) => ({ ...item, tickets: [] }))
    const outcome = experimentOutcome(inputFor(w, { ...w.xp.tokens, window: { basis: 'tickets', count: 7 } }, { starts }))
    expect(outcome.reasons[0]).toContain('its scope is not among the tickets that started after the corrective work landed')
  })
})

describe('DM-273: guardrails that cannot be read, a zero expected change and an abandoned experiment', () => {
  it('reads no score guardrail graded under another policy, and no estimated guardrail', () => {
    const w = measuredEpic()
    const reads = inputFor(w, w.xp.tokens).scorecard
    const policy = `sha256:${'3'.repeat(64)}`
    const regraded = (reportId: string): ScorecardSnapshot | null | undefined => {
      const card = reads(reportId)
      return reportId === w.reports[2].id && card != null ? { ...card, policy: { ...card.policy, hash: policy } } : card
    }
    const template = resultOf(w, w.xp.tokens.id)
    const moved = { ...template, result: { ...template.result, assessment: template.result.assessment === null ? null : { ...template.result.assessment, policyHash: policy } } }
    const guarded = { ...w.xp.tokens, guardrails: [{ measure: 'P.score' as const, unit: 'points' as const, comparator: 'at_least' as const, threshold: 0 }] }
    const otherPolicy = experimentOutcome(inputFor(w, guarded, { scorecard: regraded, events: [moved] }))
    expect(last(otherPolicy)?.guardrails.map((check) => check.detail)).toEqual(['P.score was graded under another policy than the baseline'])
    const estimated = experimentOutcome(inputFor(w, { ...w.xp.tokens, guardrails: [{ measure: 'grade.score', unit: 'points', comparator: 'at_least', threshold: 0 }] }))
    expect(last(estimated)?.guardrails.map((check) => [check.verdict, check.detail])).toEqual([['unknown', 'grade.score is estimated, not measured']])
    expect([otherPolicy.classification, estimated.classification]).toEqual(['insufficient_evidence', 'insufficient_evidence'])
  })

  it('reads an expected change that rounds to nothing as no evidence', () => {
    const w = measuredEpic()
    const outcome = experimentOutcome(inputFor(w, changed(w.xp.tokens, { amount: 1e-9 })))
    expect(outcome.classification).toBe('insufficient_evidence')
    expect(last(outcome)?.reasons).toEqual(['the expected change from a baseline of 30000 is zero'])
  })

  it('assesses no result as the outcome of an abandoned experiment', () => {
    const w = measuredEpic()
    const outcome = experimentOutcome(inputFor(w, w.xp.tokens, { status: 'abandoned' }))
    expect([outcome.classification, outcome.decidedBy, outcome.reasons]).toEqual(['insufficient_evidence', null, ['the experiment was abandoned, so no result is assessed as its outcome']])
    expect(last(outcome)?.classification).toBe('improved')
  })
})
