import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { ExperimentEvent } from '../../shared/domain/experiments'
import type { ScorecardSnapshot } from '../../shared/domain/spaceGrades'
import { makeBundle, sid } from '../../test/bundles'
import { reported, submit as submitReport } from '../../test/experimentWorld'
import {
  bringBack,
  completedEpic,
  dmSourceEpic,
  frozenSnapshot,
  machine,
  MACHINE_B,
  measuredEpic,
  outcomeOf,
  planFollowUp,
  record,
  requestCorrection,
  runCorrection,
  sprintResult,
  unfinishedEpic,
  workCorrection
} from '../../test/outcomeWorld'
import { copyTracked, createStubGit, flush, importerDeps } from '../../test/repoEnv'
import { idOf, insertEpic, insertRevision, T0 } from '../../test/repoFixtures'
import { createTestCtx } from '../../test/testContext'
import { canonicalJson } from '../canonical'
import type { Db } from '../db/database'
import { readMeasure } from '../plan/experiments'
import { reconcileRepository } from '../repo/importer'
import { parseScorecardSnapshot, snapshotHashOf } from '../space/snapshot'
import { createCorrections } from './corrections'
import { correctionEpicResults, markedBundles, outcomeReads } from './experimentOutcomes'
import { getExperiment } from './experiments'
import { getSprintReport } from './reports'

const OTHER_PROJECT = 'pj_000000000000000000000000qq'

const count = (db: Db): number => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM experiment_events')?.n ?? -1

describe('DM-188 c1: an experiment resolves to its corrective tickets, their run and the assessments of its results', () => {
  it('resolves each experiment to exactly the tickets create_corrections made for it, accepted in this run, landed when the last was accepted', () => {
    const w = measuredEpic()
    for (const experiment of Object.values(w.xp)) {
      const { outcome } = getExperiment(w.m.ctx, { experimentId: experiment.id })
      const tickets = outcome.corrections.tickets
      expect(tickets.map((ticket) => ticket.ticketId)).toEqual(w.corrective.get(experiment.id))
      expect(tickets.map((ticket) => [ticket.role, ticket.epicId, ticket.accepted?.runId])).toEqual([['work', w.epicId, w.runId]])
      expect(outcome.corrections.runIds).toEqual([w.runId])
      expect([outcome.landing.by, outcome.landing.at]).toEqual(['corrective_tickets', tickets[0]?.accepted?.at])
    }
  })

  it("exposes the frozen baseline, target and guardrails, and the after-result read from Sprint 3's frozen sprint grade", () => {
    const w = measuredEpic()
    const { outcome } = getExperiment(w.m.ctx, { experimentId: w.xp.tokens.id })
    const result = w.results.get(w.xp.tokens.id)
    expect(outcome.baseline).toMatchObject({ value: 90_000, unit: 'tokens', state: 'observed', assessment: w.xp.tokens.source, sampleSize: 3, perTicket: 30_000, sizeMix: { medium: 3 } })
    expect(outcome.target).toEqual({ direction: 'decrease', amount: 20, unit: 'percent', value: 72_000 })
    expect(outcome.guardrails).toEqual(w.xp.tokens.guardrails)
    const [comparison] = outcome.comparisons
    expect(comparison?.after).toMatchObject({ value: 84_000, state: 'observed', sampleSize: 4, perTicket: 21_000, sizeMix: { medium: 4 } })
    expect(comparison?.after.assessment?.assessmentId).toBe(w.cards[2].sprint.assessmentId)
    expect([comparison?.before, comparison?.measured, comparison?.target, comparison?.difference, comparison?.percentChange]).toEqual([30_000, 21_000, 24_000, -9_000, -30])
    expect([outcome.classification, outcome.decidedBy]).toEqual(['improved', result?.id])
    const classes = Object.values(w.xp).map((experiment) => getExperiment(w.m.ctx, { experimentId: experiment.id }).outcome.classification)
    expect(classes).toEqual(['regressed', 'improved', 'unchanged', 'insufficient_evidence'])
  })

  it("resolves an experiment of a completed epic to its follow-up epic's tickets, the follow-up run and its sprint grade", () => {
    const m = machine()
    const source = completedEpic(m)
    const plan = planFollowUp(m, source)
    const run = runCorrection(m, plan, 16)
    const event = record(m, source.experiment.id, sprintResult(run.cards[1], 'milliseconds', 'follow-up Sprint 2'))
    const { outcome } = getExperiment(m.ctx, { experimentId: source.experiment.id })
    expect(outcome.corrections.tickets.map((ticket) => [ticket.ticketId, ticket.epicId, ticket.accepted?.runId])).toEqual(plan.correctiveIds.map((id) => [id, plan.epicId, run.runId]))
    expect(outcome.corrections.runIds).toEqual([run.runId])
    expect(event.runId).toBe(source.runId)
    const [comparison] = outcome.comparisons
    expect(comparison?.after.assessment?.epicId).toBe(plan.epicId)
    expect([comparison?.before, comparison?.measured, comparison?.target]).toEqual([1_400_000, 960_000, 1_120_000])
    expect([outcome.classification, outcome.decidedBy]).toEqual(['improved', event.id])
  })
})

describe('DM-270 R3 / DM-187: a draft in another epic is listed, but never changes an outcome', () => {
  it("lists a follow-up's draft that copies the corrective work's markers, and keeps the landing, comparisons and classification", () => {
    const m = machine()
    const source = completedEpic(m)
    const plan = planFollowUp(m, source)
    record(m, source.experiment.id, sprintResult(runCorrection(m, plan, 16).cards[1], 'milliseconds', 'follow-up Sprint 2'))
    const before = getExperiment(m.ctx, { experimentId: source.experiment.id }).outcome
    const forged = 'ep_0000000000000000000000ffff'
    insertEpic(m.ctx.db, { id: forged, provenance: { sourceEpicId: source.epicId, note: 'forged' } })
    const bundle = m.ctx.db.get<{ bundle_json: string }>('SELECT bundle_json FROM plan_revisions WHERE id = ?', plan.revisionId)?.bundle_json ?? ''
    m.ctx.db.run('INSERT INTO drafts (epic_id, base_revision_id, draft_revision, bundle_json, created_at, updated_at) VALUES (?, NULL, 1, ?, ?, ?)', forged, bundle, m.ctx.clock.nowIso(), m.ctx.clock.nowIso())
    const after = getExperiment(m.ctx, { experimentId: source.experiment.id }).outcome
    const drafted = after.corrections.tickets.filter((ticket) => ticket.epicId === forged)
    expect(drafted.map((ticket) => [ticket.ticketId, ticket.revisionNumber, ticket.accepted])).toEqual(plan.correctiveIds.map((id) => [id, null, null]))
    expect(canonicalJson([after.landing, after.comparisons, after.classification, after.decidedBy])).toBe(canonicalJson([before.landing, before.comparisons, before.classification, before.decidedBy]))
    expect(after.classification).toBe('improved')
  })

  it('lists the tickets of a follow-up epic created as draft work before it is saved, without landing them', () => {
    const m = machine()
    const source = completedEpic(m)
    const created = createCorrections(m.orchestrator, { reportId: source.report.id, experimentIds: [source.experiment.id], fireguard: false })
    const { outcome } = getExperiment(m.ctx, { experimentId: source.experiment.id })
    const work = created.tickets.filter((ticket) => ticket.role === 'work').map((ticket) => [ticket.ticketId, created.target.epicId, null])
    expect(outcome.corrections.tickets.map((ticket) => [ticket.ticketId, ticket.epicId, ticket.revisionNumber])).toEqual(work)
    const keys = created.tickets.filter((ticket) => ticket.role === 'work').map((ticket) => ticket.key).join(', ')
    expect(outcome.landing).toEqual({ at: null, by: null, detail: `corrective work ${keys} is only in an unsaved draft of another epic` })
  })
})

describe("DM-270 R3: only the experiment's own epic counts with a draft; another epic needs a saved revision", () => {
  it("counts the experiment's own epic's drafted corrective work toward the landing: it is not accepted yet", () => {
    const m = machine()
    const source = unfinishedEpic(m)
    const created = createCorrections(m.orchestrator, { reportId: source.report.id, experimentIds: [source.experiment.id], target: { kind: 'sprint', sprintId: sid(2) }, fireguard: false })
    const work = created.tickets.filter((ticket) => ticket.role === 'work')
    const { outcome } = getExperiment(m.ctx, { experimentId: source.experiment.id })
    expect(outcome.corrections.tickets.map((ticket) => [ticket.ticketId, ticket.epicId, ticket.revisionNumber])).toEqual(work.map((ticket) => [ticket.ticketId, source.epicId, null]))
    expect(outcome.landing).toEqual({ at: null, by: null, detail: `corrective work ${work.map((ticket) => ticket.key).join(', ')} is not accepted yet` })
  })

  it('never reads a result from the grade of an epic that holds the work only in a draft', () => {
    const m = machine()
    const source = completedEpic(m)
    const plan = planFollowUp(m, source)
    const other = completedEpic(m, 21)
    const bundle = m.ctx.db.get<{ bundle_json: string }>('SELECT bundle_json FROM plan_revisions WHERE id = ?', plan.revisionId)?.bundle_json ?? ''
    m.ctx.db.run('UPDATE epics SET provenance_json = ? WHERE id = ?', JSON.stringify({ sourceEpicId: source.epicId, note: 'drafted' }), other.epicId)
    m.ctx.db.run(
      `INSERT INTO drafts (epic_id, base_revision_id, draft_revision, bundle_json, created_at, updated_at) VALUES (?, NULL, 1, ?, ?, ?)
       ON CONFLICT(epic_id) DO UPDATE SET bundle_json = excluded.bundle_json`,
      other.epicId,
      bundle,
      m.ctx.clock.nowIso(),
      m.ctx.clock.nowIso()
    )
    expect(getExperiment(m.ctx, { experimentId: source.experiment.id }).outcome.corrections.tickets.some((ticket) => ticket.epicId === other.epicId)).toBe(true)
    const events = count(m.ctx.db)
    const refused = outcomeOf(() => record(m, source.experiment.id, sprintResult(frozenSnapshot(m.ctx, other.report.id), 'milliseconds', 'a drafted epic')))
    expect(refused.code).toBe('invalid_input')
    expect(refused.message).toContain(other.report.id)
    expect(count(m.ctx.db)).toBe(events)
  })
})

/** Rewrites the stored scorecard of `reportId` with `edit`, resealing it when `reseal`. */
function rewriteCard(db: Db, reportId: string, edit: (card: ScorecardSnapshot) => ScorecardSnapshot, reseal: boolean): ScorecardSnapshot {
  const stored = JSON.parse(db.get<{ scorecard_json: string }>('SELECT scorecard_json FROM sprint_reports WHERE id = ?', reportId)?.scorecard_json ?? '{}') as ScorecardSnapshot
  const edited = edit(stored)
  const card = reseal ? { ...edited, snapshotHash: snapshotHashOf(edited) } : edited
  db.run('UPDATE sprint_reports SET scorecard_json = ? WHERE id = ?', JSON.stringify(card), reportId)
  return card
}

describe('DM-270 R4: an outcome read checks a stored scorecard against its seal only, and never regrades it', () => {
  it("reads the baseline's resealed scorecard, whose frozen results would fail regrading, exactly as before", () => {
    const w = measuredEpic()
    const before = canonicalJson(getExperiment(w.m.ctx, { experimentId: w.xp.tokens.id }).outcome)
    const card = rewriteCard(w.m.ctx.db, w.reports[0].id, (stored) => ({ ...stored, sprint: { ...stored.sprint, result: { ...stored.sprint.result, score: 1 } } }), true)
    expect(() => parseScorecardSnapshot(card)).toThrow()
    expect(canonicalJson(getExperiment(w.m.ctx, { experimentId: w.xp.tokens.id }).outcome)).toBe(before)
  })

  it('does not read a result whose cited scorecard was resealed since: the result cites the original seal', () => {
    const w = measuredEpic()
    rewriteCard(w.m.ctx.db, w.reports[2].id, (stored) => ({ ...stored, sprint: { ...stored.sprint, result: { ...stored.sprint.result, score: 1 } } }), true)
    const { outcome } = getExperiment(w.m.ctx, { experimentId: w.xp.tokens.id })
    expect(outcome.comparisons[0]?.reasons).toEqual([`the result does not match the frozen assessment ${w.cards[2].sprint.assessmentId} it cites, so it is not read`])
    expect(outcome.classification).toBe('insufficient_evidence')
  })

  it('treats a scorecard that fails its seal as not here: the report still reads, and the result is insufficient evidence', () => {
    const w = measuredEpic()
    rewriteCard(w.m.ctx.db, w.reports[2].id, (stored) => ({ ...stored, cutoff: `1${stored.cutoff}` }), false)
    const report = getSprintReport(w.m.ctx, { runId: w.runId, sprintId: sid(1) })
    const tokens = report?.experimentOutcomes?.find((item) => item.experimentId === w.xp.tokens.id)
    expect(tokens?.comparisons.map((comparison) => comparison.reasons)).toEqual([[`the scorecard of report ${w.reports[2].id} it cites is not here`]])
    expect(tokens?.classification).toBe('insufficient_evidence')
  })
})

describe('DM-191 c4 (DM-270 R8): measuring corrective work created in the Dark Mechanicus source', () => {
  it('measures the active repository chosen as its own target locally: the result carries nothing and is improved', () => {
    const m = machine()
    const source = dmSourceEpic(m)
    const requested = requestCorrection(m, m, source)
    const run = workCorrection(m, requested.epicId, 14)
    const event = record(m, source.experiment.id, sprintResult(run.cards[1], 'milliseconds', 'correction Sprint 2'))
    const { outcome } = getExperiment(m.ctx, { experimentId: source.experiment.id })
    expect(event.kind === 'result' ? event.result.crossRepo : 'not a result').toBeUndefined()
    expect(outcome.corrections.tickets.map((ticket) => [ticket.epicId, ticket.projectId, ticket.accepted?.runId])).toEqual([[requested.epicId, undefined, run.runId]])
    expect(outcome.landing.by).toBe('corrective_tickets')
    expect([outcome.comparisons[0]?.measured, outcome.classification, outcome.decidedBy]).toEqual([840_000, 'improved', event.id])
  })

  it('refuses a grade of the epic another project asked of this one, and does not count its tickets', () => {
    const self = machine()
    const source = dmSourceEpic(self)
    const own = workCorrection(self, requestCorrection(self, self, source).epicId, 14)
    const shop = machine({ machineId: MACHINE_B, projectId: OTHER_PROJECT })
    const asked = workCorrection(self, requestCorrection(shop, self, dmSourceEpic(shop)).epicId, 10)
    const events = count(self.ctx.db)
    const refused = outcomeOf(() => record(self, source.experiment.id, sprintResult(asked.cards[1], 'milliseconds', 'the epic shop asked for')))
    expect(refused.code).toBe('invalid_input')
    expect(refused.message).toContain(`Unknown report ${asked.reports[1].id} at event.result.assessment.reportId`)
    expect(count(self.ctx.db)).toBe(events)
    const { outcome } = getExperiment(self.ctx, { experimentId: source.experiment.id })
    expect(outcome.corrections.tickets.map((ticket) => ticket.epicId)).toEqual(own.correctiveIds.map(() => own.epicId))
  })
})

describe('DM-191 c4 (DM-270 R8): grades of a correction epic held in another checkout or project', () => {
  it('carries the sealed evidence of a correction epic in another project, and reads the outcome from it', () => {
    const m = machine()
    const source = dmSourceEpic(m)
    const target = machine({ machineId: MACHINE_B, idStart: 100_000, projectId: OTHER_PROJECT })
    const requested = requestCorrection(m, target, source)
    const run = workCorrection(target, requested.epicId, 14)
    bringBack(m, target, requested, source.experiment.id)
    const listed = getExperiment(m.ctx, { experimentId: source.experiment.id }).crossRepoResults
    expect(listed.map((item) => [item.key, item.targetProjectId, item.results.grades.map((grade) => grade.reportId)])).toEqual([[requested.key, OTHER_PROJECT, run.reports.map((report) => report.id)]])
    const event = record(m, source.experiment.id, sprintResult(run.cards[1], 'milliseconds', 'correction Sprint 2 in the source'))
    const carried = event.kind === 'result' ? event.result.crossRepo : undefined
    expect([carried?.projectId, carried?.key, carried?.epicId, carried?.scorecard.report.reportId]).toEqual([OTHER_PROJECT, requested.key, requested.epicId, run.reports[1].id])
    const { outcome } = getExperiment(m.ctx, { experimentId: source.experiment.id })
    expect(outcome.corrections.tickets.map((ticket) => [ticket.epicId, ticket.projectId])).toEqual([[requested.epicId, OTHER_PROJECT]])
    expect([outcome.comparisons[0]?.crossRepo?.projectId, outcome.classification]).toEqual([OTHER_PROJECT, 'improved'])
  })

  it("neither lists nor records a grade of this project's epic held in another checkout, and cites it directly once its records arrive through Git", () => {
    const m = machine()
    const source = dmSourceEpic(m)
    const checkout = machine({ machineId: MACHINE_B, idStart: 100_000, projectId: m.ctx.projectId })
    const requested = requestCorrection(m, checkout, source)
    const run = workCorrection(checkout, requested.epicId, 14)
    bringBack(m, checkout, requested, source.experiment.id)
    expect(getExperiment(m.ctx, { experimentId: source.experiment.id }).crossRepoResults).toEqual([])
    const events = count(m.ctx.db)
    const refused = outcomeOf(() => record(m, source.experiment.id, sprintResult(run.cards[1], 'milliseconds', 'correction Sprint 2')))
    expect(refused.code).toBe('invalid_input')
    expect(refused.message).toContain(`is a grade of epic ${requested.epicId} of this very project, brought back from another checkout of it`)
    expect(refused.message).toContain("Bring that checkout's records here through Git")
    expect(count(m.ctx.db)).toBe(events)
    flush(checkout.env)
    copyTracked(checkout.env, m.env)
    expect(reconcileRepository(importerDeps(m.env, createStubGit(), m.machineId)).rejected).toEqual([])
    const event: ExperimentEvent = record(m, source.experiment.id, sprintResult(run.cards[1], 'milliseconds', 'correction Sprint 2, cited directly'))
    expect(event.kind === 'result' ? [event.result.crossRepo, event.result.assessment?.epicId] : []).toEqual([undefined, requested.epicId])
    const reading = readMeasure(run.cards[1], run.cards[1].sprint, 'T.actual_ms')
    expect(getExperiment(m.ctx, { experimentId: source.experiment.id }).outcome).toMatchObject({ classification: 'improved', decidedBy: event.id })
    expect('value' in reading ? reading.value : null).toBe(2_520_000)
  })
})

describe('DM-273: a stored scorecard that is not sealed is not here', () => {
  it('reads an unknown report as no epic and no card, and a stored card that is not JSON or not a snapshot as not here', () => {
    const w = reported()
    const card = (reportId: string) => outcomeReads(w.ctx).card(reportId)
    expect(card(w.first.id)).toEqual({ epicId: w.epicId, card: w.snapshot })
    expect(card('rp_zzzzzzzzzzzzzzzzzzzzzzzzzz')).toEqual({ epicId: '', card: undefined })
    w.ctx.db.run('UPDATE sprint_reports SET scorecard_json = ? WHERE id = ?', '{"snapshotHash":', w.first.id)
    expect(card(w.first.id)).toEqual({ epicId: w.epicId, card: undefined })
    w.ctx.db.run('UPDATE sprint_reports SET scorecard_json = ? WHERE id = ?', 'null', w.first.id)
    expect(card(w.first.id)).toEqual({ epicId: w.epicId, card: undefined })
  })

  it('brings back only the sealed scorecards of a correction epic, and no corrective ticket of an experiment it does not hold', () => {
    const w = reported()
    const second = submitReport(w, { summary: 'Sprint 1, revised.', retro: { wentWell: ['Tickets 1-3 landed'] } })
    w.ctx.db.run('UPDATE sprint_reports SET scorecard_json = ? WHERE id = ?', '{"snapshotHash":"sha256:0"}', w.first.id)
    const results = correctionEpicResults(w.ctx, { id: w.epicId, title: 'The epic' }, { id: 'xp_zzzzzzzzzzzzzzzzzzzzzzzzzz' }, 'cr-key')
    expect(results.scorecards.map((item) => item.report.reportId)).toEqual([second.id])
    expect(results.corrections).toEqual([])
    expect(results.starts.map((item) => [item.sprint === null, item.tickets.length])).toEqual([
      [true, 0],
      [false, 4]
    ])
  })
})

describe('DM-270 R3: the bundles that may hold an experiment’s markers', () => {
  it('lists the draft first, then the saved revisions newest first, and skips a bundle without the marker', () => {
    const ctx = createTestCtx()
    const epicId = idOf('epic', 1)
    insertEpic(ctx.db, { id: epicId })
    const marker = { kind: 'doc' as const, label: 'correction', location: 'darkmechanicus:correction/cr-key/xp_1/work#a', hash: null, remoteOnly: false }
    const marked = (title: string, withMarker: boolean): PlanBundle => {
      const bundle = makeBundle([[1]])
      return { ...bundle, epic: { ...bundle.epic, title }, tickets: bundle.tickets.map((ticket) => ({ ...ticket, references: withMarker ? [marker] : [] })) }
    }
    insertRevision(ctx.db, { id: idOf('revision', 1), epicId, number: 1, bundle: marked('saved one', true), state: 'saved' })
    insertRevision(ctx.db, { id: idOf('revision', 2), epicId, number: 2, bundle: marked('saved two', true), state: 'saved' })
    insertRevision(ctx.db, { id: idOf('revision', 3), epicId, number: 3, bundle: marked('saved three', false), state: 'saved' })
    ctx.db.run(
      'INSERT INTO drafts (epic_id, base_revision_id, draft_revision, bundle_json, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)',
      epicId,
      idOf('revision', 3),
      JSON.stringify(marked('drafted', true)),
      T0,
      T0
    )
    const listed = markedBundles(ctx, 'xp_1').map((row) => [row.holder, row.number, (JSON.parse(row.bundle_json) as PlanBundle).epic.title])
    expect(listed).toEqual([
      ['draft', null, 'drafted'],
      ['revision', 2, 'saved two'],
      ['revision', 1, 'saved one']
    ])
    expect(markedBundles(ctx, 'xp_2')).toEqual([])
  })
})
