// DM-177 (pinned by DM-269): ticket grades read from real records by getTicketGrade.
import { describe, expect, it } from 'vitest'
import type { SpaceComponent, SpaceComponentResult, SpaceGrade } from '../../shared/domain/space'
import { tid } from '../../test/bundles'
import { accept, gradeWorld, met, rate, reject, ticketGrade, unmet, work } from '../../test/ticketGradeWorld'
import { listObservations } from './observations'

function component(grade: SpaceGrade, name: SpaceComponent): SpaceComponentResult {
  const found = grade.components.find((item) => item.component === name)
  if (found === undefined) throw new Error(`no component ${name}`)
  return found
}

const scores = (grade: SpaceGrade): string => grade.components.map((c) => `${c.component}=${c.score}`).join(' ')
const TWENTY_MINUTES = { minutes: 20, tokens: 20_000, productive: 20 }

describe('DM-177 c1: getTicketGrade reproduces at a cutoff', () => {
  it('reads the same grade byte for byte at one cutoff, ignoring records stored after it', () => {
    const w = gradeWorld()
    const attemptId = work(w, 1, { minutes: 36, tokens: 60_000, productive: 30, corrective: { minutes: 6, cause: 'implementation' } })
    accept(w, attemptId, [met('c1'), met('c2')])
    rate(w, 1, 4)
    const cutoff = w.ctx.clock.nowIso()
    const first = ticketGrade(w, 1, cutoff).grade
    accept(w, work(w, 2, TWENTY_MINUTES), [met('c1'), met('c2')])
    rate(w, 1, 1)
    expect(JSON.stringify(ticketGrade(w, 1, cutoff).grade)).toBe(JSON.stringify(first))
    const now = ticketGrade(w, 1).grade
    expect(component(first, 'S').score).toBe(75)
    expect(component(now, 'S').score).toBe(0)
    expect(now.inputHash).not.toBe(first.inputHash)
  })
})

describe('DM-177 c2: failures cap at F, missing verification stays ungraded, from records', () => {
  it('a cheap, fast attempt accepted with c2 found unmet grades 59 F although T and K score 100', () => {
    const w = gradeWorld()
    accept(w, work(w, 1, { minutes: 5, tokens: 2_000, productive: 5 }), [met('c1'), unmet('c2', 'the docs are missing')])
    const grade = ticketGrade(w, 1).grade
    expect(scores(grade)).toBe('S=null P=0 A=50 C=100 E=100 T=100 K=100')
    expect(grade.outcome).toBe('failed')
    expect(grade.score).toBe(59)
    expect(grade.letter).toBe('F')
  })

  it('a ticket rejected until the retry limit is a confirmed failure graded F', () => {
    const w = gradeWorld()
    reject(w, work(w, 2, { minutes: 5, tokens: 2_000, productive: 5 }), 'c1 does not hold')
    reject(w, work(w, 2, { minutes: 5, tokens: 2_000, productive: 5 }), 'c1 still does not hold')
    const grade = ticketGrade(w, 2).grade
    expect(grade.outcome).toBe('failed')
    expect(grade.letter).toBe('F')
    expect(grade.caps.map((cap) => cap.kind)).toEqual(['mandatory_failure'])
  })

  it('accepted on worker claims only is ungraded (verification_missing) although T and K score 100', () => {
    const w = gradeWorld()
    accept(w, work(w, 3, { minutes: 3, tokens: 1_000, productive: 3 }))
    const grade = ticketGrade(w, 3).grade
    expect(component(grade, 'T').score).toBe(100)
    expect(component(grade, 'K').score).toBe(100)
    expect(grade.status).toBe('ungraded')
    expect(grade.letter).toBeNull()
    expect(grade.statusReasons).toContain('verification_missing')
  })

  it('submitted but not reviewed is ungraded (verification_pending)', () => {
    const w = gradeWorld()
    work(w, 4, { minutes: 3, tokens: 1_000, productive: 3 })
    const grade = ticketGrade(w, 4).grade
    expect(grade.status).toBe('ungraded')
    expect(grade.score).toBeNull()
    expect(grade.statusReasons).toContain('verification_pending')
  })
})

describe('DM-177 c3: missing telemetry is shown missing, never 0 or 100, from records', () => {
  it('verified without telemetry or rating is ungraded; a rating makes it provisional with E, T, K missing at weight 0', () => {
    const w = gradeWorld()
    accept(w, work(w, 1, { minutes: null, tokens: null }), [met('c1'), met('c2')])
    const unrated = ticketGrade(w, 1).grade
    expect(scores(unrated)).toBe('S=null P=100 A=100 C=100 E=null T=null K=null')
    expect(unrated.status).toBe('ungraded')
    expect(unrated.statusReasons).toContain('insufficient_coverage')
    rate(w, 1, 4)
    const rated = ticketGrade(w, 1).grade
    expect(rated.status).toBe('provisional')
    expect(rated.coverage).toBe(4 / 7)
    expect(rated.explanation.missing.map((m) => m.component)).toEqual(['E', 'T', 'K'])
    expect(rated.components.map((c) => c.effectiveWeight)).toEqual([0.25, 0.25, 0.25, 0.25, 0, 0, 0])
    expect(rated.score).toBe(93.75)
  })

  it('tokens of one reporting attempt are not read as the total when another attempt reported none', () => {
    const w = gradeWorld()
    const silent = work(w, 2, { minutes: null, tokens: null })
    reject(w, silent, 'c1 does not hold')
    accept(w, work(w, 2, TWENTY_MINUTES), [met('c1'), met('c2')])
    rate(w, 2, 5)
    const view = ticketGrade(w, 2)
    const k = component(view.grade, 'K')
    expect(k.missingReason).toBe('partial_telemetry')
    expect(k.inputs.unreportedAttempts).toBe(1)
    expect(view.sources.efficiency.tokens.unreportedAttemptIds).toEqual([silent])
    expect(view.grade.status).toBe('provisional')
  })
})

describe('DM-177 c4: record-based explanations', () => {
  it('cites stored observation ids, the accepted attempt, each reviewed criterion, the budget and the cutoff', () => {
    const w = gradeWorld()
    const attemptId = work(w, 1, { minutes: 24, tokens: 40_000, productive: 20, corrective: { minutes: 4, cause: 'implementation' } })
    accept(w, attemptId, [met('c1'), met('c2')])
    const ratingId = rate(w, 1, 4)
    const cutoff = w.ctx.clock.nowIso()
    const view = ticketGrade(w, 1, cutoff)
    const stored = new Set(listObservations(w.ctx.db, { runId: w.runId }).map((o) => o.observationId))
    const observations = view.grade.explanation.evidence.filter((ref) => ref.kind === 'observation').map((ref) => ref.id)
    expect(observations).toContain(ratingId)
    for (const id of observations) expect(stored).toContain(id)
    const p = component(view.grade, 'P').evidence
    expect(p).toContainEqual(expect.objectContaining({ kind: 'attempt', id: attemptId }))
    expect(p).toContainEqual({ kind: 'criterion', id: tid(1), detail: 'c1' })
    expect(p).toContainEqual({ kind: 'criterion', id: tid(1), detail: 'c2' })
    const budget = component(view.grade, 'T').explanation.baseline
    expect(budget).toMatchObject({ kind: 'budget', value: 1_800_000, refusedReason: null })
    expect(Date.parse(budget?.frozenAt ?? '')).toBeLessThan(Date.parse(view.grade.dispatchedAt ?? ''))
    expect(view.grade.components.map((c) => c.explanation.cutoff)).toEqual(Array(7).fill(cutoff))
  })
})

describe('DM-177 c4: activity volume alone never raises a grade, from records', () => {
  it('the same work listing 40 commits instead of 1 grades the same', () => {
    const w = gradeWorld()
    const effort = { minutes: 24, tokens: 40_000, productive: 20, corrective: { minutes: 4, cause: 'implementation' as const } }
    accept(w, work(w, 1, effort), [met('c1'), met('c2')])
    rate(w, 1, 4)
    const commits = Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(40, 'b'))
    accept(w, work(w, 2, { ...effort, commits }), [met('c1'), met('c2')])
    rate(w, 2, 4)
    const one = ticketGrade(w, 1).grade
    const many = ticketGrade(w, 2).grade
    expect(component(one, 'A').diagnostics.commits).toBe(1)
    expect(component(many, 'A').diagnostics.commits).toBe(40)
    expect(many.score).toBe(one.score)
    expect(many.letter).toBe(one.letter)
  })

  it('each rejected submission counts as a failed handoff: more rejected attempts lower C and the grade, never raise them', () => {
    const w = gradeWorld(3)
    accept(w, work(w, 1, TWENTY_MINUTES), [met('c1'), met('c2')])
    rate(w, 1, 4)
    reject(w, work(w, 2, TWENTY_MINUTES), 'c1 does not hold')
    accept(w, work(w, 2, TWENTY_MINUTES), [met('c1'), met('c2')])
    rate(w, 2, 4)
    reject(w, work(w, 3, TWENTY_MINUTES), 'c1 does not hold')
    reject(w, work(w, 3, TWENTY_MINUTES), 'c1 still does not hold')
    accept(w, work(w, 3, TWENTY_MINUTES), [met('c1'), met('c2')])
    rate(w, 3, 4)
    const grades = [1, 2, 3].map((n) => ticketGrade(w, n).grade)
    expect(grades.map((g) => component(g, 'C').score)).toEqual([100, 50, 33.333333])
    expect(grades.map((g) => `${g.score} ${g.letter}`)).toEqual(['96.428571 A', '86.904762 B', '78.333333 C'])
    expect(component(grades[1] as SpaceGrade, 'C').inputs.rejectedSubmissions).toBe(1)
  })
})
