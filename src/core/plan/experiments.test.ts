import { describe, expect, it } from 'vitest'
import { contentHash } from '../canonical'
import { parseInput, sprintReportInput } from '../schemas'
import { experimentContext } from '../services/experiments'
import { draftScorecard } from '../services/scorecards'
import { EXPERIMENT_MEASURE_NAMES, EXPERIMENT_MEASURES, EXPERIMENT_UNITS, type RetroExperiment, type RetroExperimentInput } from '../../shared/domain/experiments'
import type { SprintReportView } from '../../shared/domain/views'
import { tid } from '../../test/bundles'
import { fixture, frozenSnapshot, measuredSprint, MIN, outcome, reported, type Reported, submit, tokens, validExperiment } from '../../test/experimentWorld'
import { executionProblems, normalizeExperiments, readMeasure, restatementOf, resultProblem, retroExperimentsSchema, sealedAssessment, sourceProblem, vagueness } from './experiments'
import { retroIsEmpty } from './retro'

/** The scorecard drafted for report revision 2 of a reported sprint, and the normalizing context the service builds. */
function normalizing() {
  const w = reported()
  const valid = validExperiment(w) as unknown as RetroExperimentInput
  const reportId = w.ctx.ids.next('report')
  const draft = draftScorecard(w.ctx, { runId: w.runId, sprintId: w.sprintId, report: { reportId, reportRevision: 2 }, cutoff: w.ctx.clock.nowIso() })
  const context = experimentContext(w.ctx, { id: w.runId, epic_id: w.epicId }, w.sprintId, draft)
  const normalize = (input: RetroExperimentInput): RetroExperiment => normalizeExperiments([input], context)[0] as RetroExperiment
  return { w, valid, reportId, draft, context, normalize }
}

describe('DM-184 c1: experiment normalization of a source by subject', () => {
  it('freezes a source by subject to the grade identity of this submission without the circular seals', () => {
    const { w, valid, reportId, draft, normalize } = normalizing()
    const stored = normalize(valid)
    expect(stored.id).toMatch(/^xp_[0-9a-z]{26}$/)
    expect(stored.source).toEqual({
      revision: 'own',
      epicId: w.epicId,
      runId: w.runId,
      sprintId: w.sprintId,
      reportId,
      reportRevision: 2,
      snapshotId: draft.snapshotId,
      policyHash: draft.policy.hash,
      assessmentId: draft.sprint.assessmentId,
      subject: { level: 'sprint', id: w.sprintId },
      inputHash: draft.sprint.result.inputHash
    })
  })

  it('reads the baseline value and state from the cited grade, never from the reporter', () => {
    const { draft, valid, normalize } = normalizing()
    const stored = normalize(valid)
    expect(stored.baseline).toEqual({ measure: 'T.actual_ms', unit: 'milliseconds', value: 70 * MIN, state: 'observed' })
    expect(readMeasure(draft, draft.sprint, 'T.actual_ms')).toEqual({ value: 70 * MIN, state: 'observed' })
  })

  it('stores every planning field, an unwritten evidence detail as null and a single-repository destination as repository null', () => {
    const { valid, normalize } = normalizing()
    const stored = normalize(valid)
    expect(stored.issue.evidence.map((item) => item.detail)).toEqual([null, 'longest attempt'])
    expect(stored.destination).toEqual({ kind: 'source_repository', repository: null })
    expect(stored.proposedWork).toEqual([{ title: 'Add an importer context note to the planner skill', body: "Add one paragraph to the planner skill naming the importer's record files.", size: 'small' }])
    expect(stored.expectedChange).toEqual({ direction: 'decrease', amount: 20, unit: 'percent' })
    expect(stored.guardrails).toHaveLength(2)
    expect(stored.window).toEqual({ basis: 'sprints', count: 1 })
    expect(stored.concern).toBe('plan_context')
  })
})

describe('DM-184 c1: experiment normalization of source references', () => {
  it("freezes a grade of an earlier revision with that scorecard's report content hash and seal", () => {
    const { w, valid, normalize } = normalizing()
    const stored = normalize({ ...valid, source: { reportId: w.first.id, assessmentId: w.snapshot.run.assessmentId } })
    expect(stored.source).toEqual({
      revision: 'earlier',
      epicId: w.epicId,
      runId: w.runId,
      sprintId: w.sprintId,
      reportId: w.first.id,
      reportRevision: 1,
      snapshotId: w.snapshot.snapshotId,
      policyHash: w.snapshot.policy.hash,
      assessmentId: w.snapshot.run.assessmentId,
      subject: { level: 'run', id: w.runId },
      inputHash: w.snapshot.run.result.inputHash,
      reportContentHash: w.first.contentHash,
      snapshotHash: w.snapshot.snapshotHash
    })
  })

  it('refuses a missing source reference, naming the field', () => {
    const { w, valid, context, normalize } = normalizing()
    const cases: [RetroExperimentInput['source'], string][] = [
      [{ subject: { level: 'ticket', id: 'tk_zzzzzzzzzzzzzzzzzzzzzzzzzz' } }, "Unknown subject at retro.experiments[0].source.subject: this report's scorecard grades no ticket tk_zzzzzzzzzzzzzzzzzzzzzzzzzz."],
      [{ reportId: 'rp_zzzzzzzzzzzzzzzzzzzzzzzzzz', assessmentId: w.snapshot.sprint.assessmentId }, 'Unknown report rp_zzzzzzzzzzzzzzzzzzzzzzzzzz at retro.experiments[0].source.reportId'],
      [{ reportId: w.first.id, assessmentId: 'as_zzzzzzzzzzzzzzzzzzzzzzzzzz' }, 'Unknown assessment as_zzzzzzzzzzzzzzzzzzzzzzzzzz at retro.experiments[0].source.assessmentId']
    ]
    for (const [source, message] of cases) {
      expect(outcome(() => normalize({ ...valid, source }))).toEqual({ code: 'invalid_input', message: expect.stringContaining(message) })
    }
    expect(outcome(() => normalizeExperiments([valid], { ...context, own: null })).message).toContain('only a report being submitted cites its own scorecard by subject')
  })
})

describe('DM-184 c1: experiment normalization of metric references', () => {
  it("refuses every unit that is not the measure's own, for baselines and guardrails", () => {
    const { valid, normalize } = normalizing()
    const refusals = EXPERIMENT_MEASURE_NAMES.flatMap((measure) =>
      EXPERIMENT_UNITS.filter((unit) => unit !== EXPERIMENT_MEASURES[measure].unit).map((unit) => outcome(() => normalize({ ...valid, baseline: { measure, unit } })).message)
    )
    expect(refusals).toHaveLength(EXPERIMENT_MEASURE_NAMES.length * 3)
    expect(refusals.every((message) => /^Invalid unit at retro\.experiments\[0\]\.baseline\.unit: \S+ is measured in \w+, not \w+\.$/.test(message))).toBe(true)
    const guardrail = outcome(() => normalize({ ...valid, guardrails: [{ measure: 'P.score', unit: 'count', comparator: 'at_least', threshold: 80 }] }))
    expect(guardrail.message).toBe('Invalid unit at retro.experiments[0].guardrails[0].unit: P.score is measured in points, not count.')
  })

  it('refuses a points guardrail past 100, a fractional count change and a measure the grade did not measure', () => {
    const { valid, normalize } = normalizing()
    expect(outcome(() => normalize({ ...valid, guardrails: [{ measure: 'P.score', unit: 'points', comparator: 'at_least', threshold: 101 }] })).message).toBe(
      'Invalid guardrail at retro.experiments[0].guardrails[0].threshold: points run from 0 to 100.'
    )
    expect(outcome(() => normalize({ ...valid, guardrails: [{ measure: 'P.score', unit: 'points', comparator: 'at_least', threshold: 100 }] })).code).toBe('ok')
    const count = outcome(() => normalize({ ...valid, baseline: { measure: 'A.delivered', unit: 'count' }, expectedChange: { direction: 'increase', amount: 0.5, unit: 'count' } }))
    expect(count.message).toContain('a count changes by whole items')
    const unmeasured = outcome(() => normalize({ ...valid, baseline: { measure: 'S.score', unit: 'points' }, expectedChange: { direction: 'increase', amount: 5, unit: 'points' } }))
    expect(unmeasured.message).toMatch(/S\.score has no value in assessment as_\w+ \(no_rating\)/)
  })
})

describe('DM-184 c1: stable experiment identity', () => {
  it('mints one id per new experiment and keeps a restated id with its original source', () => {
    const { w, valid, context } = normalizing()
    let minted = 0
    const ids = normalizeExperiments([valid, valid], { ...context, mint: () => `xp_${String(++minted).padStart(26, '0')}` }).map((item) => item.id)
    expect(ids).toEqual(['xp_00000000000000000000000001', 'xp_00000000000000000000000002'])
    const written = submit(w, { summary: 'With an experiment.', retro: { experiments: [valid] } }).report.retro?.experiments?.[0] as RetroExperiment
    const again = experimentContext(w.ctx, { id: w.runId, epic_id: w.epicId }, w.sprintId, null)
    const restated = normalizeExperiments([{ ...valid, id: written.id, source: { reportId: written.source.reportId, assessmentId: written.source.assessmentId } }], {
      ...again,
      mint: () => {
        throw new Error('a restatement mints no id')
      }
    })[0]
    expect(restated?.id).toBe(written.id)
    expect(restated?.source).toMatchObject({ revision: 'earlier', reportId: written.source.reportId, assessmentId: written.source.assessmentId })
  })

  it('refuses a restatement from another sprint, with another source, by subject, with an unminted id, or listed twice', () => {
    const { w, valid, draft } = normalizing()
    const written = submit(w, { summary: 'With an experiment.', retro: { experiments: [valid] } }).report.retro?.experiments?.[0] as RetroExperiment
    const id = written.id
    const original = { reportId: written.source.reportId, assessmentId: written.source.assessmentId }
    const again = experimentContext(w.ctx, { id: w.runId, epic_id: w.epicId }, w.sprintId, null)
    const otherSprint = experimentContext(w.ctx, { id: w.runId, epic_id: w.epicId }, 'sp_00000000000000000000000002', null)
    expect(outcome(() => normalizeExperiments([{ ...valid, id, source: original }], otherSprint)).message).toContain("belongs to another sprint's report")
    expect(outcome(() => normalizeExperiments([{ ...valid, id, source: { reportId: w.first.id, assessmentId: w.snapshot.run.assessmentId } }], again)).message).toContain(
      'a restated experiment keeps its source'
    )
    expect(outcome(() => normalizeExperiments([{ ...valid, id }], { ...again, own: draft })).message).toContain('a restated experiment keeps its source')
    expect(outcome(() => normalizeExperiments([{ ...valid, id: 'xp_zzzzzzzzzzzzzzzzzzzzzzzzzz', source: original }], again)).message).toContain(
      'Unknown experiment xp_zzzzzzzzzzzzzzzzzzzzzzzzzz at retro.experiments[0].id'
    )
    expect(outcome(() => normalizeExperiments([{ ...valid, id, source: original }, { ...valid, id, source: original }], again)).message).toBe(
      `Experiment ${id} is listed twice in retro.experiments: restate each experiment once.`
    )
  })
})

describe('DM-184 c1: target descriptor and required planning fields', () => {
  it('names one repository of a folder of repositories as the destination, and none in a single repository', () => {
    const { valid, context, normalize } = normalizing()
    expect(outcome(() => normalize({ ...valid, destination: { kind: 'source_repository', repository: 'api' } })).message).toContain('this project is a single repository')
    expect(normalize({ ...valid, destination: { kind: 'darkmechanicus_source' } }).destination).toEqual({ kind: 'darkmechanicus_source' })
    const folder = { ...context, repositories: ['api', 'web'] }
    const inFolder = (destination: RetroExperimentInput['destination']) => outcome(() => normalizeExperiments([{ ...valid, destination }], folder))
    expect(inFolder({ kind: 'source_repository' }).message).toContain('name one repository of this folder (api, web)')
    expect(inFolder({ kind: 'source_repository', repository: 'mobile' }).message).toContain('name one repository of this folder (api, web)')
    expect(normalizeExperiments([{ ...valid, destination: { kind: 'source_repository', repository: 'api' } }], folder)[0]?.destination).toEqual({ kind: 'source_repository', repository: 'api' })
  })

  it('refuses an experiment without any one planning field, naming it', () => {
    const { valid, normalize } = normalizing()
    for (const field of ['source', 'concern', 'issue', 'hypothesis', 'destination', 'proposedWork', 'baseline', 'expectedChange', 'guardrails', 'window'] as const) {
      const { [field]: _left, ...partial } = valid
      const refused = outcome(() => normalize(partial as RetroExperimentInput))
      expect(refused.code).toBe('invalid_input')
      expect(refused.message).toContain(`retro.experiments[0] at ${field}`)
    }
    expect(outcome(() => normalize({ ...valid, owner: 'someone' } as RetroExperimentInput)).message).toContain('Unrecognized key')
  })
})

interface Case {
  name: string
  expect: 'accepted' | 'rejected' | 'normalized'
  error?: string
  retro: Record<string, unknown>
}

/** A reported sprint with a report from before scorecards and an experiment written in an earlier revision. */
function fixtureWorld(): { w: Reported; valid: Record<string, unknown>; cases: Case[]; earlier: RetroExperiment } {
  const w = reported()
  const legacy = submit(w, { summary: 'Sprint 1, written before scorecards existed.', retro: { wentWell: ['ok'] } })
  w.ctx.db.run('UPDATE sprint_reports SET scorecard_json = NULL WHERE id = ?', legacy.id)
  const earlier = submit(w, { summary: 'Sprint 1 with one experiment.', retro: { experiments: [validExperiment(w)] } }).report.retro?.experiments?.[0] as RetroExperiment
  const filled = fixture<{ valid: Record<string, unknown>; cases: Case[] }>(
    'experiment-cases.json',
    tokens(w, { legacyReport: legacy.id, earlierExperiment: earlier.id, earlierReport: earlier.source.reportId, earlierAssessment: earlier.source.assessmentId })
  )
  return { w, earlier, ...filled }
}

/** "$valid" is the valid experiment; { "$valid": patch } is the valid experiment with `patch` merged in (null removes a field). */
function expand(value: unknown, valid: Record<string, unknown>): unknown {
  if (value === '$valid') return valid
  if (Array.isArray(value)) return value.map((item) => expand(item, valid))
  if (value === null || typeof value !== 'object') return value
  if ('$valid' in value) {
    const merged: Record<string, unknown> = { ...valid }
    for (const [key, patch] of Object.entries(value.$valid as Record<string, unknown>)) {
      if (patch === null) delete merged[key]
      else merged[key] = patch
    }
    return merged
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, valid)]))
}

const CASES = fixture<{ cases: Case[] }>('experiment-cases.json', {}).cases

describe('DM-184 c4: the checked-in experiment cases', () => {
  it('holds accepted, rejected and normalized cases for missing references, repeated ids, units, destinations and mixed reports', () => {
    const names = CASES.map((item) => item.name)
    expect(CASES.filter((item) => item.expect === 'rejected')).toHaveLength(32)
    expect(CASES.filter((item) => item.expect === 'normalized')).toHaveLength(3)
    for (const topic of ['missing reference', 'repeated ids', 'invalid metric unit', 'absent destination', 'structured/prose mixed']) {
      expect(names.some((name) => name.startsWith(topic))).toBe(true)
    }
  })

  it.each(CASES.filter((item) => item.expect === 'rejected').map((item) => [item.name, item] as const))('rejects %s', (_name, item) => {
    const { w, valid, cases } = fixtureWorld()
    const before = w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sprint_reports')?.n
    const refused = outcome(() => submit(w, { summary: 'Sprint 1 with experiments.', retro: expand(cases.find((c) => c.name === item.name)?.retro, valid) }))
    expect(refused.code).toBe('invalid_input')
    expect(refused.message).toContain(item.error)
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sprint_reports')?.n).toBe(before)
  })

  it.each(CASES.filter((item) => item.expect === 'accepted').map((item) => [item.name, item] as const))('accepts %s, minting or keeping the id', (_name, item) => {
    const { w, valid, cases, earlier } = fixtureWorld()
    const retro = expand(cases.find((c) => c.name === item.name)?.retro, valid)
    const stored = submit(w, { summary: 'Sprint 1 with experiments.', retro }).report.retro?.experiments ?? []
    expect(stored).toHaveLength(1)
    const restated = item.name === 'stable identity: a restated experiment keeps its id and original source'
    expect(stored[0]?.id === earlier.id).toBe(restated)
    expect(stored[0]?.id).toMatch(/^xp_[0-9a-z]{26}$/)
  })

  it('stores prose actions as written, in order, beside a structured experiment', () => {
    const { w, valid, cases } = fixtureWorld()
    const item = cases.find((c) => c.name === 'structured/prose mixed: prose actions beside structured experiments') as Case
    const retro = submit(w, { summary: 'Sprint 1 with experiments.', retro: expand(item.retro, valid) }).report.retro
    expect(retro?.actions).toEqual(['Keep reviews short', 'Pair on the importer'])
    expect(retro?.wentWell).toEqual(['Reviews were quick'])
    expect(retro?.experiments?.map((experiment) => experiment.baseline.measure)).toEqual(['T.actual_ms'])
  })

  it('drops an empty experiments list, so the report stores and hashes like the same prose without it', () => {
    const { w, valid, cases } = fixtureWorld()
    const prose = submit(w, { summary: 'Prose only.', retro: { actions: ['Keep reviews short', 'Pair on the importer'] } })
    const empty = submit(w, { summary: 'Prose only.', retro: {} })
    const mixed = cases.find((c) => c.name === 'structured/prose mixed: prose actions with an empty experiments list') as Case
    const alone = cases.find((c) => c.name === 'an empty experiments list alone') as Case
    const withProse: SprintReportView = submit(w, { summary: 'Prose only.', retro: expand(mixed.retro, valid) })
    const withNothing: SprintReportView = submit(w, { summary: 'Prose only.', retro: expand(alone.retro, valid) })
    expect(withProse.contentHash).toBe(prose.contentHash)
    expect(withProse.report.retro !== null && 'experiments' in withProse.report.retro).toBe(false)
    expect(withNothing.contentHash).toBe(empty.contentHash)
    expect(withNothing.report.retro === null ? null : retroIsEmpty(withNothing.report.retro)).toBe(true)
    expect(contentHash(withNothing.report.retro)).toBe(contentHash(empty.report.retro))
  })
})

describe('DM-184 c4: a structured/prose mix says where each part goes', () => {
  const parse = (retro: unknown) => outcome(() => parseInput(sprintReportInput, { summary: 'Mixed.', retro }, 'report'))

  it('refuses an experiment written as prose, pointing prose to retro.actions', () => {
    expect(parse({ actions: ['Size importer tickets larger'], experiments: ['Cut active time by 20% by documenting the importer'] }).message).toBe(
      'Invalid report at retro.experiments.0: An experiment is a structured object (source, concern, issue, hypothesis, …); write a prose proposal in retro.actions instead'
    )
  })

  it('refuses a structured experiment among the prose actions, pointing it to retro.experiments', () => {
    expect(parse({ actions: ['Keep reviews short', { hypothesis: 'x' }] }).message).toBe(
      'Invalid report at retro.actions.1: An action is one line of prose; write a structured experiment in retro.experiments instead'
    )
  })

  it('refuses an experiment without a source, saying the two forms a source takes', () => {
    const refused = parse({ experiments: [{ concern: 'plan_context' }] })
    expect(refused.message).toBe(
      "Invalid report at retro.experiments.0.source: An experiment's source is { subject: { level, id } } (a grade of this report's own scorecard) or { reportId, assessmentId } (a grade of an earlier revision's scorecard)"
    )
  })
})

const VAGUE = [
  'Improve the quality of the code and the tests in the whole project soon.',
  'Improve the quality of the code and the tests in the whole project.',
  'To be decided after the next sprint review with the whole team present.',
  'aaa bbb ccc ddd eee fff ggg hhh iii jjj',
  'x'.repeat(40),
  'TODO: write down which importer files change and how they change.',
  'Fix the issues and problems so that things work better than before now.',
  'To be determined.',
  'To be determined once the reviewers have read the importer changes.',
  '?'.repeat(40)
]

const SPECIFIC = [
  'TODO comments in src/core/board/imports.ts are deleted or turned into tickets.',
  'Placeholder text of the search input in Search.tsx becomes "Search tickets".',
  'Raise the reviewer timeout from 10 to 20 minutes in the review settings.',
  "Add one paragraph to the planner skill naming the importer's record files.",
  // Words a deferral rule must not catch mid-body: "as soon as", "eventually", "TBD", "sometime".
  'The lint step in scripts/check.ts exits as soon as oxlint reports its first error.',
  'The reviewer retry loop in src/core/services/review.ts eventually times out after 30 s; cap it at 3 attempts.',
  'Replace the TBD markers in docs/architecture.md with the measured limits.',
  'Rename the "sometime" enum value in src/shared/domain/schedule.ts to "unscheduled".',
  // Only a leading "to be decided" / "to be determined" defers: another "to be …" or one mid-body says what changes.
  'To be defined in src/core/limits.ts: a MAX_RETRIES constant of 3 that the reviewer retry loop reads.',
  'The retry cap in src/core/services/review.ts, previously to be decided, is set to 3 attempts.'
]

describe('DM-185 c3: vague proposed work is told from specific work', () => {
  it.each(VAGUE)('reads %j as vague', (body) => {
    expect(vagueness({ title: 'Corrective work', body })).toMatch(/^its body /)
  })

  it.each(SPECIFIC)('reads %j as specific', (body) => {
    expect(vagueness({ title: 'Corrective work', body })).toBeNull()
  })

  it('says why: a leading deferral, generic scope words, a placeholder, or a body that restates its title', () => {
    expect(vagueness({ title: 'Work', body: VAGUE[0] as string })).toBe('its body names 2 distinct term(s) beyond filler words, fewer than 3')
    expect(vagueness({ title: 'Work', body: VAGUE[1] as string })).toBe('its body names 1 distinct term(s) beyond filler words, fewer than 3')
    expect(vagueness({ title: 'Work', body: VAGUE[2] as string })).toBe('its body opens by putting the decision off ("To be decided …")')
    expect(vagueness({ title: 'Work', body: VAGUE[8] as string })).toBe('its body opens by putting the decision off ("To be decided …")')
    expect(vagueness({ title: 'Work', body: VAGUE[5] as string })).toBe('its body starts with a placeholder (TBD, TODO, FIXME, …)')
    expect(vagueness({ title: 'Raise the reviewer timeout from 10 to 20 minutes', body: 'Raise the reviewer timeout from 10 to 20 minutes.' })).toBe('its body only restates its title')
  })

  it('lists an unsized and a vague item of an experiment as reasons it cannot be scheduled', () => {
    const experiment = {
      proposedWork: [
        { title: 'Fix the budgets', body: '' },
        { title: 'Name the search input', body: SPECIFIC[1] as string, size: 'small' as const },
        { title: 'Tidy up', body: VAGUE[1] as string, size: 'micro' as const }
      ]
    } as RetroExperiment
    expect(executionProblems(experiment)).toEqual([
      'proposedWork[0] "Fix the budgets" has no size',
      'proposedWork[0] "Fix the budgets" is vague: it does not say what changes (its body is under 40 characters)',
      'proposedWork[2] "Tidy up" is vague: it does not say what changes (its body names 1 distinct term(s) beyond filler words, fewer than 3)'
    ])
  })
})

describe('DM-185 c2: valid exploration is not waste', () => {
  it('refuses an experiment that sets out to cut productive effort, and accepts cutting corrective effort', () => {
    const { valid, normalize } = normalizing()
    const cut = (measure: 'E.productive_ms' | 'E.corrective_ms') =>
      outcome(() => normalize({ ...valid, baseline: { measure, unit: 'milliseconds' }, expectedChange: { direction: 'decrease', amount: 20, unit: 'percent' } }))
    expect(cut('E.productive_ms').message).toBe(
      'Invalid expected change at retro.experiments[0].expectedChange: E.productive_ms counts planned tests and useful investigation, which is not waste; aim a decrease at E.corrective_ms instead.'
    )
    expect(cut('E.corrective_ms').message).not.toContain('not waste')
    expect(outcome(() => normalize({ ...valid, baseline: { measure: 'E.productive_ms', unit: 'milliseconds' }, expectedChange: { direction: 'increase', amount: 20, unit: 'percent' } })).message).not.toContain(
      'not waste'
    )
  })

  it('keeps a ticket grade as a source by subject', () => {
    const { valid, normalize } = normalizing()
    expect(normalize({ ...valid, source: { subject: { level: 'ticket', id: tid(1) } }, baseline: { measure: 'A.delivered', unit: 'count' }, expectedChange: { direction: 'increase', amount: 1, unit: 'count' } }).source.subject).toEqual({
      level: 'ticket',
      id: tid(1)
    })
  })
})

describe('DM-273: reading quantity measures out of a measured sprint scorecard', () => {
  it('reads counts, rejections and a partial resource total from the sprint grade', () => {
    const { w, report } = measuredSprint()
    const card = frozenSnapshot(w, report.id)
    const read = (measure: Parameters<typeof readMeasure>[2]) => readMeasure(card, card.sprint, measure)
    expect(read('A.committed')).toEqual({ value: 6, state: 'observed' })
    expect(read('A.added')).toEqual({ value: 0, state: 'observed' })
    expect(read('P.regressions')).toEqual({ value: 0, state: 'observed' })
    expect(read('C.rejected_submissions')).toEqual({ value: 3, state: 'observed' })
    expect(read('T.actual_ms')).toEqual({ missing: 'partial_coverage' })
    expect(read('E.unclassified_ms')).toEqual({ missing: 'partial_coverage' })
  })

  it('reads a final ticket grade as observed, and an unclaimed ticket as having no frozen scope or report', () => {
    const { w, report } = measuredSprint()
    const card = frozenSnapshot(w, report.id)
    const ticket = (n: number) => card.tickets.find((grade) => grade.subject.id === tid(n)) ?? card.sprint
    expect(readMeasure(card, ticket(1), 'grade.score')).toEqual({ value: 97.5, state: 'observed' })
    expect(readMeasure(card, ticket(2), 'C.rejected_submissions')).toEqual({ value: 1, state: 'observed' })
    expect(readMeasure(card, ticket(5), 'A.committed')).toEqual({ missing: 'scope_not_frozen' })
    expect(readMeasure(card, ticket(5), 'grade.score')).toEqual({ missing: 'the grade is ungraded' })
    expect(readMeasure(card, ticket(5), 'E.unclassified_ms')).toEqual({ missing: 'not_reported' })
  })
})

/** A report revision holding one experiment drawn from its own scorecard, and one drawn from the first revision's. */
function heldExperiments() {
  const { w, valid, normalize } = normalizing()
  const view = submit(w, { summary: 'With an experiment.', retro: { experiments: [valid] } })
  const own = view.report.retro?.experiments?.[0] as RetroExperiment
  const earlier = normalize({ ...valid, source: { reportId: w.first.id, assessmentId: w.snapshot.run.assessmentId } })
  const cards = new Map([
    [view.id, frozenSnapshot(w, view.id)],
    [w.first.id, w.snapshot]
  ])
  return { w, view, own, earlier, lookup: (reportId: string) => cards.get(reportId) }
}

describe('DM-273: checking a stored source against the scorecard it cites', () => {
  it('accepts an own source held by its revision, and refuses it held by another revision or without its scorecard', () => {
    const { view, own, lookup } = heldExperiments()
    expect(sourceProblem(own, { id: view.id, reportRevision: view.reportRevision }, lookup)).toBeNull()
    expect(sourceProblem(own, { id: view.id, reportRevision: view.reportRevision + 1 }, lookup)).toBe('cites its own scorecard but names another report revision')
    expect(sourceProblem(own, { id: view.id, reportRevision: view.reportRevision }, () => undefined)).toBe(`cites the scorecard of report ${view.id}, which is not here`)
  })

  it('refuses an earlier source held by the revision it cites, or naming an assessment its scorecard lacks', () => {
    const { w, view, earlier, lookup } = heldExperiments()
    expect(sourceProblem(earlier, { id: view.id, reportRevision: view.reportRevision }, lookup)).toBeNull()
    expect(sourceProblem(earlier, { id: w.first.id, reportRevision: 1 }, lookup)).toBe('cites its own report revision as an earlier one')
    const unknown = { ...earlier, source: { ...earlier.source, assessmentId: 'as_zzzzzzzzzzzzzzzzzzzzzzzzzz' } }
    expect(sourceProblem(unknown, { id: view.id, reportRevision: view.reportRevision }, lookup)).toBe(
      `cites assessment as_zzzzzzzzzzzzzzzzzzzzzzzzzz, which the scorecard of report ${w.first.id} does not hold`
    )
  })

  it('checks a result against its assessment only once that scorecard is here', () => {
    const { w, lookup } = heldExperiments()
    const cited = sealedAssessment(w.snapshot, w.snapshot.run.assessmentId)
    const result = { value: 70 * MIN, unit: 'milliseconds' as const, state: 'observed' as const, assessment: cited?.ref ?? null, evidence: [] }
    expect(resultProblem(result, 'T.actual_ms', lookup)).toBeNull()
    expect(resultProblem({ ...result, value: 1 }, 'T.actual_ms', lookup)).toBe(`states a value the assessment ${w.snapshot.run.assessmentId} does not hold`)
    expect(resultProblem(result, 'T.actual_ms', () => undefined)).toBe(`reads the scorecard of report ${w.first.id}, which is not here yet; the run history is imported once it is`)
  })
})

describe('DM-273: stored experiment lists and restatements', () => {
  it('refuses a stored experiment list that holds one id twice', () => {
    const { own } = heldExperiments()
    const parsed = retroExperimentsSchema.safeParse([own, own])
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([`Experiment ${own.id} is listed twice`])
    expect(retroExperimentsSchema.safeParse([own]).success).toBe(true)
  })

  it('stores unwritten work as an empty unsized body, and restates an experiment without a concern without one', () => {
    const { valid, normalize } = normalizing()
    const stored = normalize({ ...valid, proposedWork: [{ title: 'Name the importer record files' }] })
    expect(stored.proposedWork).toEqual([{ title: 'Name the importer record files', body: '' }])
    const { concern: _concern, ...withoutConcern } = stored
    const restated = restatementOf(withoutConcern)
    expect('concern' in restated).toBe(false)
    expect(restated.proposedWork).toEqual([{ title: 'Name the importer record files', body: '' }])
    expect(restatementOf(stored).concern).toBe('plan_context')
  })
})
