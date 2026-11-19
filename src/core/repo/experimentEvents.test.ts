import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ExperimentEvent } from '../../shared/domain/experiments'
import type { ReconcileResultView } from '../../shared/domain/views'
import { sid } from '../../test/bundles'
import {
  bringBack,
  completedEpic,
  type CompletedEpic,
  dmSourceEpic,
  type FollowUpPlan,
  type Machine,
  machine,
  MACHINE_B,
  measuredEpic,
  planCorrection,
  planFollowUp,
  record,
  requestCorrection,
  runCorrection,
  type CorrectionRun,
  sprintResult,
  submit,
  workCorrection
} from '../../test/outcomeWorld'
import { copyTracked, createStubGit, flush, importerDeps } from '../../test/repoEnv'
import { canonicalJson, contentHash, prettyJson } from '../canonical'
import type { Db } from '../db/database'
import { crossRepoSealOf } from '../plan/corrections'
import { readMeasure, restatementOf, sealedAssessment } from '../plan/experiments'
import { getExperiment } from '../services/experiments'
import { parseScorecardSnapshot } from '../space/snapshot'
import { reconcileRepository } from './importer'
import { ownedPaths } from './paths'
import { buildRunHistoryRecord } from './portable'

const reconcile = (m: Machine): ReconcileResultView => reconcileRepository(importerDeps(m.env, createStubGit(), m.machineId))

/** Every experiment event a machine stores, in order, as stored. */
const eventsOf = (db: Db): { id: string; number: number; event_json: string }[] => db.all('SELECT id, number, event_json FROM experiment_events ORDER BY experiment_id, number')

/** The report rows of an epic as stored: content, hash and frozen scorecard (as values: key order is storage's business). */
const reportRows = (db: Db, epicId: string): unknown[] =>
  db
    .all<{ id: string; report_revision: number; content_hash: string; content_json: string; scorecard_json: string }>(
      'SELECT r.id, r.report_revision, r.content_hash, r.content_json, r.scorecard_json FROM sprint_reports r JOIN runs ON runs.id = r.run_id WHERE runs.epic_id = ? ORDER BY r.id',
      epicId
    )
    .map((row) => ({ ...row, content_json: JSON.parse(row.content_json) as unknown, scorecard_json: JSON.parse(row.scorecard_json) as unknown }))

interface RunFile {
  experimentEvents: ExperimentEvent[]
  reports: { id: string }[]
}

function runFile(m: Machine, runId: string): { path: string; record: RunFile } {
  const path = ownedPaths(m.env.layout).runHistoryFile(runId)
  return { path, record: JSON.parse(m.env.fs.get(path) ?? '{}') as RunFile }
}

function rewriteRunFile(m: Machine, runId: string, edit: (record: RunFile) => RunFile): void {
  const { path, record } = runFile(m, runId)
  m.env.fs.put(path, prettyJson(edit(record)))
}

/** Another machine with its own checkout holding `from`'s tracked records, as a fresh clone. */
function cloneOf(from: Machine): Machine {
  flush(from.env)
  const clone = machine({ machineId: MACHINE_B, idStart: 100_000, at: '2026-11-17T09:00:00.000Z' })
  copyTracked(from.env, clone.env)
  return clone
}

describe('DM-188 c4: result events are append-only, travel with the run history and leave the reports and their grades intact', () => {
  it('appends a result after the earlier events and changes no report row, content hash or frozen scorecard', () => {
    const w = measuredEpic()
    const rows = reportRows(w.m.ctx.db, w.epicId)
    const before = getExperiment(w.m.ctx, { experimentId: w.xp.time.id }).events
    const added = record(w.m, w.xp.time.id, { kind: 'result', result: { value: 5_100_000, unit: 'milliseconds', evidence: [{ kind: 'run', id: w.runId, detail: 'host spans of Sprint 3' }] } })
    const after = getExperiment(w.m.ctx, { experimentId: w.xp.time.id }).events
    expect(added.number).toBe(before.length + 1)
    expect(after.slice(0, -1)).toEqual(before)
    expect(reportRows(w.m.ctx.db, w.epicId)).toEqual(rows)
    const stored = w.m.ctx.db.all<{ content_json: string; content_hash: string; scorecard_json: string }>('SELECT content_json, content_hash, scorecard_json FROM sprint_reports')
    expect(stored.map((row) => parseScorecardSnapshot(JSON.parse(row.scorecard_json)).report.contentHash)).toEqual(stored.map((row) => contentHash(JSON.parse(row.content_json))))
    expect(stored.map((row) => row.content_hash)).toEqual(stored.map((row) => contentHash(JSON.parse(row.content_json))))
  })

  it('exports every event and no derived outcome; another machine imports it, reads the same experiments and re-exports the same file', () => {
    const w = measuredEpic()
    const b = cloneOf(w.m)
    const text = w.m.env.fs.get(ownedPaths(w.m.env.layout).runHistoryFile(w.runId)) ?? ''
    expect((JSON.parse(text) as RunFile).experimentEvents.map((event) => event.id)).toEqual(eventsOf(w.m.ctx.db).map((row) => row.id))
    expect([text.includes('"classification"'), text.includes('experimentOutcomes')]).toEqual([false, false])
    expect(reconcile(b).rejected).toEqual([])
    const views = (m: Machine): string => canonicalJson(Object.values(w.xp).map((experiment) => getExperiment(m.ctx, { experimentId: experiment.id })))
    expect(views(b)).toBe(views(w.m))
    expect(reportRows(b.ctx.db, w.epicId)).toEqual(reportRows(w.m.ctx.db, w.epicId))
    expect(prettyJson(buildRunHistoryRecord(b.ctx.db, w.runId))).toBe(text)
    expect(reconcile(b).rejected).toEqual([])
    expect(eventsOf(b.ctx.db)).toEqual(eventsOf(w.m.ctx.db))
  })
})

describe('DM-270 R7: an import refuses rewritten events, a redefinition under stored events and a broken sequence', () => {
  it('refuses a stored event arriving with other content, and keeps the events and outcomes it has', () => {
    const w = measuredEpic()
    const b = cloneOf(w.m)
    reconcile(b)
    const views = canonicalJson(getExperiment(b.ctx, { experimentId: w.xp.quality.id }))
    const status = eventsOf(w.m.ctx.db).map((row) => JSON.parse(row.event_json) as ExperimentEvent).find((event) => event.kind === 'status' && event.experimentId === w.xp.quality.id)
    rewriteRunFile(b, w.runId, (file) => ({ ...file, experimentEvents: file.experimentEvents.map((event) => (event.id === status?.id ? { ...event, note: 'Rewritten after the fact' } : event)) }))
    const result = reconcile(b)
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/history/${w.runId}/run.json`, message: `Experiment event ${status?.id ?? ''} differs from the one stored here; experiment events are never rewritten.` }])
    expect(canonicalJson(getExperiment(b.ctx, { experimentId: w.xp.quality.id }))).toBe(views)
  })

  it("refuses a run history whose events of an experiment skip a number", () => {
    const w = measuredEpic()
    const b = cloneOf(w.m)
    const second = eventsOf(w.m.ctx.db).map((row) => JSON.parse(row.event_json) as ExperimentEvent).find((event) => event.experimentId === w.xp.quality.id && event.number === 2)
    rewriteRunFile(b, w.runId, (file) => ({ ...file, experimentEvents: file.experimentEvents.filter((event) => event.id !== second?.id) }))
    const result = reconcile(b)
    expect(result.rejected.map((item) => item.message).join(' ')).toContain(`Experiment ${w.xp.quality.id}'s events are not numbered 1 to 4`)
    expect(eventsOf(b.ctx.db)).toEqual([])
  })

  it('refuses a run history that drops the definition its stored events cite', () => {
    const w = measuredEpic()
    const b = cloneOf(w.m)
    reconcile(b)
    const stored = eventsOf(b.ctx.db)
    rewriteRunFile(b, w.runId, (file) => ({ ...file, reports: file.reports.filter((report) => report.id !== w.reports[0].id), experimentEvents: [] }))
    const messages = reconcile(b).rejected.map((item) => item.message).join(' ')
    expect(messages).toContain('an experiment that has events is never redefined')
    expect(eventsOf(b.ctx.db)).toEqual(stored)
  })
})

interface FollowedUp {
  m: Machine
  source: CompletedEpic
  plan: FollowUpPlan
  run: CorrectionRun
  event: Extract<ExperimentEvent, { kind: 'result' }>
}

/** A completed epic's experiment measured in its follow-up epic on one machine, the result recorded and exported. */
function followedUp(): FollowedUp {
  const m = machine()
  const source = completedEpic(m)
  const plan = planFollowUp(m, source)
  const run = runCorrection(m, plan, 16)
  const event = record(m, source.experiment.id, sprintResult(run.cards[1], 'milliseconds', 'follow-up Sprint 2'))
  if (event.kind !== 'result') throw new Error('not a result')
  flush(m.env)
  return { m, source, plan, run, event }
}

describe('DM-270 R6: an imported result never stands on the grade of an epic that holds no corrective work', () => {
  it("refuses a result re-pointed at an unrelated epic's grade, honestly or relabeled as the experiment's own epic", () => {
    const w = followedUp()
    const unrelated = completedEpic(w.m, 21)
    const card = getExperiment(w.m.ctx, { experimentId: unrelated.experiment.id }).outcome.baseline
    const reportId = card.assessment?.reportId ?? ''
    const stored = JSON.parse(w.m.ctx.db.get<{ scorecard_json: string }>('SELECT scorecard_json FROM sprint_reports WHERE id = ?', reportId)?.scorecard_json ?? '{}')
    const found = sealedAssessment(stored, stored.sprint.assessmentId)
    if (found === null) throw new Error('no grade')
    const reading = readMeasure(stored, found.grade, 'T.actual_ms')
    const value = 'value' in reading ? reading.value : null
    const repoint = (assessment: typeof found.ref) => (b: Machine): void =>
      rewriteRunFile(b, w.source.runId, (file) => ({ ...file, experimentEvents: file.experimentEvents.map((event) => (event.id === w.event.id ? { ...w.event, result: { ...w.event.result, assessment, value } } : event)) }))
    const honest = cloneOf(w.m)
    repoint(found.ref)(honest)
    expect(reconcile(honest).rejected.map((item) => item.message)).toContain(
      `Experiment event ${w.event.id} cites a grade of epic ${unrelated.epicId}, which holds no corrective work of experiment ${w.source.experiment.id} (epic ${unrelated.epicId} is neither a follow-up of epic ${w.source.epicId} nor this project's own correction epic for experiment ${w.source.experiment.id}).`
    )
    const relabeled = cloneOf(w.m)
    repoint({ ...found.ref, epicId: w.source.epicId })(relabeled)
    expect(reconcile(relabeled).rejected.map((item) => item.message)).toContain(`Experiment event ${w.event.id} does not match the frozen assessment ${found.ref.assessmentId} it cites.`)
  })
})

/** A clone without the follow-up epic's records (deleted, or never shared): its folder and its run's folder. */
function withoutFollowUp(w: FollowedUp): Machine {
  const clone = cloneOf(w.m)
  const paths = ownedPaths(clone.env.layout)
  clone.env.fs.removeTree(paths.epicDir(w.plan.epicId))
  clone.env.fs.removeTree(dirname(paths.runHistoryFile(w.run.runId)))
  return clone
}

describe('DM-270 R2: a result citing a follow-up epic that is not here does not hold the source run history back', () => {
  it('imports the source run history; its result reads as not here until the follow-up arrives, then as measured', () => {
    const w = followedUp()
    const clone = withoutFollowUp(w)
    const first = reconcile(clone)
    expect(first.rejected).toEqual([])
    expect(first.imported).toContain(w.source.runId)
    const missing = getExperiment(clone.ctx, { experimentId: w.source.experiment.id }).outcome
    expect(missing.comparisons.map((comparison) => comparison.reasons)).toEqual([[`the scorecard of report ${w.run.reports[1].id} it cites is not here`]])
    expect(missing.classification).toBe('insufficient_evidence')
    copyTracked(w.m.env, clone.env)
    expect(reconcile(clone).rejected).toEqual([])
    const arrived = getExperiment(clone.ctx, { experimentId: w.source.experiment.id }).outcome
    expect(canonicalJson(arrived)).toBe(canonicalJson(getExperiment(w.m.ctx, { experimentId: w.source.experiment.id }).outcome))
    expect([arrived.classification, arrived.decidedBy]).toEqual(['improved', w.event.id])
  })

  it('checks the result against the grade once the follow-up arrives: a value edited while it was away is not read', () => {
    const w = followedUp()
    const clone = withoutFollowUp(w)
    rewriteRunFile(clone, w.source.runId, (file) => ({ ...file, experimentEvents: file.experimentEvents.map((event) => (event.id === w.event.id ? { ...w.event, result: { ...w.event.result, value: 600_000 } } : event)) }))
    expect(reconcile(clone).rejected).toEqual([])
    copyTracked(w.m.env, clone.env)
    rewriteRunFile(clone, w.source.runId, (file) => ({ ...file, experimentEvents: file.experimentEvents.map((event) => (event.id === w.event.id ? { ...w.event, result: { ...w.event.result, value: 600_000 } } : event)) }))
    expect(reconcile(clone).rejected).toEqual([])
    const outcome = getExperiment(clone.ctx, { experimentId: w.source.experiment.id }).outcome
    expect(outcome.comparisons[0]?.reasons).toEqual([`the result states a value the assessment ${w.run.cards[1].sprint.assessmentId} does not hold, so it is not read`])
    expect(outcome.classification).toBe('insufficient_evidence')
  })
})

interface TwoMachines {
  a: Machine
  b: Machine
  source: CompletedEpic
  run: CorrectionRun
}

/**
 * Machine A completes an epic with one experiment and plans its follow-up; machine B imports them and runs the
 * follow-up (B owns the follow-up run, A the source run). With `shared`, both work in one checkout; otherwise each in
 * its own, exchanging records as Git does (`copyTracked`).
 */
function twoMachines(shared: boolean): TwoMachines {
  const a = machine()
  const source = completedEpic(a)
  const plan = planFollowUp(a, source)
  flush(a.env)
  const b = machine({ ...(shared ? { fs: a.env.fs } : {}), machineId: MACHINE_B, idStart: 100_000, at: '2026-11-16T09:00:00.000Z' })
  if (!shared) copyTracked(a.env, b.env)
  expect(reconcile(b).rejected).toEqual([])
  const run = runCorrection(b, plan, 16)
  flush(b.env)
  if (!shared) copyTracked(b.env, a.env)
  expect(reconcile(a).rejected).toEqual([])
  return { a, b, source, run }
}

/** Both machines hold the same events, the tracked file holds them too, and both read the same outcome. */
function expectConverged(t: TwoMachines, ids: string[]): void {
  expect(eventsOf(t.a.ctx.db).map((row) => [row.id, row.number])).toEqual(ids.map((id, index) => [id, index + 1]))
  expect(eventsOf(t.b.ctx.db)).toEqual(eventsOf(t.a.ctx.db))
  expect(runFile(t.a, t.source.runId).record.experimentEvents.map((event) => [event.id, event.number])).toEqual(ids.map((id, index) => [id, index + 1]))
  const outcome = getExperiment(t.a.ctx, { experimentId: t.source.experiment.id }).outcome
  expect(canonicalJson(getExperiment(t.b.ctx, { experimentId: t.source.experiment.id }).outcome)).toBe(canonicalJson(outcome))
  expect(outcome.classification).toBe('improved')
}

describe("DM-270 R1: two machines appending to one run's history never drop each other's events", () => {
  it("refuses to write the follow-up machine's stale copy over the owner's newer history; the reconcile numbers its result after", () => {
    const t = twoMachines(true)
    const status = record(t.a, t.source.experiment.id, { kind: 'status', status: 'completed' })
    flush(t.a.env)
    const result = record(t.b, t.source.experiment.id, sprintResult(t.run.cards[1], 'milliseconds', 'follow-up Sprint 2'))
    const refused = flush(t.b.env)
    expect(refused.failed).toBe(1)
    expect(refused.errors.join(' ')).toContain(`holds records of run ${t.source.runId} this machine has not imported, and machine ${t.a.machineId} owns the run`)
    expect(runFile(t.a, t.source.runId).record.experimentEvents.map((event) => event.id)).toEqual([status.id])
    expect(reconcile(t.b).rejected).toEqual([])
    expect(flush(t.b.env).failed).toBe(0)
    expect(reconcile(t.a).rejected).toEqual([])
    expectConverged(t, [status.id, result.id])
  })

  it("refuses to write the owner's history over the follow-up machine's result; the reconcile merges it and the owner's event follows", () => {
    const t = twoMachines(true)
    const result = record(t.b, t.source.experiment.id, sprintResult(t.run.cards[1], 'milliseconds', 'follow-up Sprint 2'))
    expect(flush(t.b.env).failed).toBe(0)
    const status = record(t.a, t.source.experiment.id, { kind: 'status', status: 'completed' })
    const refused = flush(t.a.env)
    expect(refused.errors.join(' ')).toContain(`holds experiment events this machine has not imported (${result.id})`)
    expect(runFile(t.a, t.source.runId).record.experimentEvents.map((event) => event.id)).toEqual([result.id])
    const merged = reconcile(t.a)
    expect([merged.rejected, merged.conflicts]).toEqual([[], []])
    expect(flush(t.a.env).failed).toBe(0)
    expect(reconcile(t.b).rejected).toEqual([])
    expectConverged(t, [result.id, status.id])
  })
})

describe('DM-270 R1: a fork of one run history recovers, and a rewritten event is still refused', () => {
  it('recovers a fork Git resolved by keeping one side: the machine whose event was left out numbers it after and exports it again', () => {
    const t = twoMachines(false)
    const status = record(t.a, t.source.experiment.id, { kind: 'status', status: 'completed' })
    flush(t.a.env)
    const result = record(t.b, t.source.experiment.id, sprintResult(t.run.cards[1], 'milliseconds', 'follow-up Sprint 2'))
    flush(t.b.env)
    copyTracked(t.a.env, t.b.env)
    expect(reconcile(t.b).rejected).toEqual([])
    expect(flush(t.b.env).failed).toBe(0)
    copyTracked(t.b.env, t.a.env)
    expect(reconcile(t.a).rejected).toEqual([])
    expectConverged(t, [status.id, result.id])
  })

  it('still refuses an event of the merged history arriving with other content', () => {
    const t = twoMachines(true)
    const result = record(t.b, t.source.experiment.id, sprintResult(t.run.cards[1], 'milliseconds', 'follow-up Sprint 2'))
    flush(t.b.env)
    expect(reconcile(t.a).rejected).toEqual([])
    rewriteRunFile(t.a, t.source.runId, (file) => ({ ...file, experimentEvents: file.experimentEvents.map((event) => (event.id === result.id ? { ...event, note: 'Edited' } : event)) }))
    expect(reconcile(t.a).rejected.map((item) => item.message)).toEqual([`Experiment event ${result.id} differs from the one stored here; experiment events are never rewritten.`])
  })
})

const MACHINE_C = 'mc_000000000000000000000000cc'

/** A third machine with its own checkout. */
const thirdMachine = (): Machine => machine({ machineId: MACHINE_C, idStart: 200_000, at: '2026-11-18T09:00:00.000Z' })

describe('DM-270 R1: a third machine follows a fork another machine resolved', () => {
  it('takes the new number of an event it imported under the old one, and imports the resolved history', () => {
    const t = twoMachines(false)
    const status = record(t.a, t.source.experiment.id, { kind: 'status', status: 'completed' })
    flush(t.a.env)
    const result = record(t.b, t.source.experiment.id, sprintResult(t.run.cards[1], 'milliseconds', 'follow-up Sprint 2'))
    flush(t.b.env)
    const c = thirdMachine()
    copyTracked(t.b.env, c.env)
    expect(reconcile(c).rejected).toEqual([])
    expect(eventsOf(c.ctx.db).map((row) => [row.id, row.number])).toEqual([[result.id, 1]])
    copyTracked(t.a.env, t.b.env)
    reconcile(t.b)
    flush(t.b.env)
    copyTracked(t.b.env, c.env)
    expect(reconcile(c).rejected).toEqual([])
    expect(eventsOf(c.ctx.db).map((row) => [row.id, row.number])).toEqual([[status.id, 1], [result.id, 2]])
    expect(eventsOf(c.ctx.db)).toEqual(eventsOf(t.b.ctx.db))
  })

  it('imports the resolved history as new events when it saw the kept side first', () => {
    const t = twoMachines(false)
    const status = record(t.a, t.source.experiment.id, { kind: 'status', status: 'completed' })
    flush(t.a.env)
    const result = record(t.b, t.source.experiment.id, sprintResult(t.run.cards[1], 'milliseconds', 'follow-up Sprint 2'))
    flush(t.b.env)
    const c = thirdMachine()
    copyTracked(t.a.env, c.env)
    expect(reconcile(c).rejected).toEqual([])
    copyTracked(t.a.env, t.b.env)
    reconcile(t.b)
    flush(t.b.env)
    copyTracked(t.b.env, c.env)
    expect(reconcile(c).rejected).toEqual([])
    expect(eventsOf(c.ctx.db).map((row) => [row.id, row.number])).toEqual([[status.id, 1], [result.id, 2]])
  })
})

/** An id of the same kind as `id` that no machine minted. */
const forgedId = (id: string): string => `${id.slice(0, -2)}zz`

describe("DM-270 R1: another machine's events merge into a run this machine owns only when they pass every check", () => {
  it('refuses statuses of one experiment recorded on two machines', () => {
    const w = followedUp()
    const own = record(w.m, w.source.experiment.id, { kind: 'status', status: 'completed' })
    const other = { ...own, id: forgedId(own.id), note: 'Recorded on another machine' }
    rewriteRunFile(w.m, w.source.runId, (file) => ({ ...file, experimentEvents: [...file.experimentEvents, other] }))
    expect(reconcile(w.m).rejected.map((item) => item.message)).toEqual([
      `Experiment ${w.source.experiment.id}'s statuses were recorded on two machines (event ${own.id} here, event ${other.id} in the tracked history), so they cannot be put in order; record statuses only on the machine that owns run ${w.source.runId}.`
    ])
    expect(eventsOf(w.m.ctx.db).map((row) => row.id)).toEqual([w.event.id, own.id])
  })

  it('refuses an arriving event citing a report revision the reports stored here do not hold', () => {
    const w = followedUp()
    const own = record(w.m, w.source.experiment.id, { kind: 'status', status: 'completed' })
    const copyId = forgedId(w.source.report.id)
    const arriving = { ...w.event, id: forgedId(w.event.id), number: 2, source: { ...w.event.source, reportId: copyId } }
    rewriteRunFile(w.m, w.source.runId, (file) => {
      const report: Record<string, unknown> = { ...(file.reports[0] as unknown as Record<string, unknown>), id: copyId, reportRevision: 2 }
      const copy = Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'scorecard')) as unknown as RunFile['reports'][number]
      return { ...file, reports: [...file.reports, copy], experimentEvents: [...file.experimentEvents, arriving] }
    })
    expect(reconcile(w.m).rejected.map((item) => item.message)).toEqual([
      `Experiment event ${arriving.id} names experiment ${w.source.experiment.id}, which report ${copyId} of this run does not hold here, so it is not merged into run ${w.source.runId}.`
    ])
    expect(eventsOf(w.m.ctx.db).map((row) => row.id)).toEqual([w.event.id, own.id])
  })

  it("refuses arriving events whose run history changed a report's content", () => {
    const w = followedUp()
    const own = record(w.m, w.source.experiment.id, { kind: 'status', status: 'completed' })
    const arriving = { ...w.event, id: forgedId(w.event.id), number: 2 }
    rewriteRunFile(w.m, w.source.runId, (file) => {
      const report = file.reports[0] as unknown as { content: { summary: string }; contentHash: string; scorecard?: unknown }
      const content = { ...report.content, summary: 'Rewritten elsewhere' }
      const { scorecard: _scorecard, ...edited } = { ...report, content, contentHash: contentHash(content) }
      return { ...file, reports: [edited as unknown as RunFile['reports'][number]], experimentEvents: [...file.experimentEvents, arriving] }
    })
    const messages = reconcile(w.m).rejected.map((item) => item.message)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(`Report ${w.source.report.id} differs from the revision stored here`)
    expect(eventsOf(w.m.ctx.db).map((row) => row.id)).toEqual([w.event.id, own.id])
  })
})

describe('DM-270 R7: an event may arrive renumbered, never renumbered and rewritten', () => {
  it('refuses an event taking the number of a stored event that arrives with other content', () => {
    const w = measuredEpic()
    const b = cloneOf(w.m)
    reconcile(b)
    const [second, third] = eventsOf(w.m.ctx.db).map((row) => JSON.parse(row.event_json) as ExperimentEvent).filter((event) => event.experimentId === w.xp.quality.id && [2, 3].includes(event.number))
    if (second === undefined || third === undefined) throw new Error('missing events')
    rewriteRunFile(b, w.runId, (file) => ({
      ...file,
      experimentEvents: file.experimentEvents
        .map((event) => (event.id === second.id ? { ...event, number: 3, note: 'Moved and rewritten' } : event.id === third.id ? { ...event, number: 2 } : event))
        .sort((x, y) => (x.experimentId === y.experimentId ? x.number - y.number : x.experimentId.localeCompare(y.experimentId)))
    }))
    expect(reconcile(b).rejected.map((item) => item.message)).toEqual([
      `Experiment event ${third.id} takes number 2 of experiment ${w.xp.quality.id}, which event ${second.id} already holds here.`
    ])
  })

  it("refuses a history that only renumbers an experiment's stored events into another order, and keeps them as stored", () => {
    const w = measuredEpic()
    const b = cloneOf(w.m)
    reconcile(b)
    const stored = eventsOf(b.ctx.db)
    const before = getExperiment(b.ctx, { experimentId: w.xp.quality.id }).status
    rewriteRunFile(b, w.runId, (file) => ({
      ...file,
      experimentEvents: file.experimentEvents
        .map((event) => (event.experimentId === w.xp.quality.id ? { ...event, number: 6 - event.number } : event))
        .sort((x, y) => (x.experimentId === y.experimentId ? x.number - y.number : x.experimentId.localeCompare(y.experimentId)))
    }))
    expect(reconcile(b).rejected.map((item) => item.message)).toEqual([
      `Experiment ${w.xp.quality.id}'s statuses arrive in another order than stored here; a stored status never moves past another stored status, since that changes what the experiment's status is.`
    ])
    expect(eventsOf(b.ctx.db)).toEqual(stored)
    expect([before, getExperiment(b.ctx, { experimentId: w.xp.quality.id }).status]).toEqual(['completed', 'completed'])
  })
})

describe('DM-270 R1: a resolved fork moves several stored events at once', () => {
  it('numbers two results after the kept status on the machine that recorded them and on one that imported them', () => {
    const t = twoMachines(false)
    const status = record(t.a, t.source.experiment.id, { kind: 'status', status: 'completed' })
    flush(t.a.env)
    const first = record(t.b, t.source.experiment.id, sprintResult(t.run.cards[1], 'milliseconds', 'follow-up Sprint 2'))
    const second = record(t.b, t.source.experiment.id, sprintResult(t.run.cards[1], 'milliseconds', 'follow-up Sprint 2, read again'))
    flush(t.b.env)
    const c = thirdMachine()
    copyTracked(t.b.env, c.env)
    expect(reconcile(c).rejected).toEqual([])
    copyTracked(t.a.env, t.b.env)
    expect(reconcile(t.b).rejected).toEqual([])
    flush(t.b.env)
    copyTracked(t.b.env, c.env)
    expect(reconcile(c).rejected).toEqual([])
    const expected = [[status.id, 1], [first.id, 2], [second.id, 3]]
    expect(eventsOf(t.b.ctx.db).map((row) => [row.id, row.number])).toEqual(expected)
    expect(eventsOf(c.ctx.db)).toEqual(eventsOf(t.b.ctx.db))
  })
})

describe('DM-270 R1: a third machine follows forks resolved in turn on two other machines', () => {
  it('lets a third machine follow two forks resolved in turn, where its result moves back past a status it had numbered it after', () => {
    const t = twoMachines(false)
    const s1 = record(t.a, t.source.experiment.id, { kind: 'status', status: 'in_progress' })
    flush(t.a.env)
    const r1 = record(t.b, t.source.experiment.id, sprintResult(t.run.cards[1], 'milliseconds', 'follow-up Sprint 2'))
    flush(t.b.env)
    const c = thirdMachine()
    copyTracked(t.b.env, c.env)
    expect(reconcile(c).rejected).toEqual([])
    expect(eventsOf(c.ctx.db).map((row) => [row.id, row.number])).toEqual([[r1.id, 1]])
    copyTracked(t.a.env, t.b.env)
    expect(reconcile(t.b).rejected).toEqual([])
    flush(t.b.env)
    expect(eventsOf(t.b.ctx.db).map((row) => [row.id, row.number])).toEqual([[s1.id, 1], [r1.id, 2]])
    const s2 = record(t.a, t.source.experiment.id, { kind: 'status', status: 'completed' })
    flush(t.a.env)
    copyTracked(t.a.env, c.env)
    expect(reconcile(c).rejected).toEqual([])
    flush(c.env)
    expect(eventsOf(c.ctx.db).map((row) => [row.id, row.number])).toEqual([[s1.id, 1], [s2.id, 2], [r1.id, 3]])
    copyTracked(t.b.env, t.a.env)
    expect(reconcile(t.a).rejected).toEqual([])
    flush(t.a.env)
    copyTracked(t.a.env, c.env)
    expect(reconcile(c).rejected).toEqual([])
    copyTracked(t.a.env, t.b.env)
    expect(reconcile(t.b).rejected).toEqual([])
    const expected = [[s1.id, 1], [r1.id, 2], [s2.id, 3]]
    expect(eventsOf(t.a.ctx.db).map((row) => [row.id, row.number])).toEqual(expected)
    expect(eventsOf(t.b.ctx.db)).toEqual(eventsOf(t.a.ctx.db))
    expect(eventsOf(c.ctx.db)).toEqual(eventsOf(t.a.ctx.db))
  })
})

describe("DM-270 R1: an owner's restatement waiting to be exported never blocks another machine's result", () => {
  it("merges the result recorded on another machine into a run whose new report revision is not exported yet, and both machines converge", () => {
    const a = machine()
    const source = dmSourceEpic(a)
    const plan = planCorrection(a, requestCorrection(a, a, source).epicId)
    flush(a.env)
    const b = machine({ fs: a.env.fs, machineId: MACHINE_B, idStart: 100_000, at: '2026-11-16T09:00:00.000Z' })
    expect(reconcile(b).rejected).toEqual([])
    const run = runCorrection(b, plan, 14)
    flush(b.env)
    expect(reconcile(a).rejected).toEqual([])
    const result = record(b, source.experiment.id, sprintResult(run.cards[1], 'milliseconds', 'correction Sprint 2'))
    expect(flush(b.env).failed).toBe(0)
    const restated = submit(a, source.runId, sid(1), { summary: 'Sprint 1, the experiment restated.', retro: { wentWell: ['Tickets 1-3 landed'], experiments: [restatementOf(source.experiment)] } })
    const status = record(a, source.experiment.id, { kind: 'status', status: 'selected', note: 'Chosen at the Sprint 1 checkpoint' })
    expect(status.source.reportId).toBe(restated.id)
    expect(flush(a.env).errors.join(' ')).toContain(`holds experiment events this machine has not imported (${result.id})`)
    expect(reconcile(a).rejected).toEqual([])
    expect(flush(a.env).failed).toBe(0)
    const file = runFile(a, source.runId).record
    expect(file.reports.map((report) => report.id)).toContain(restated.id)
    expect(file.experimentEvents.map((event) => [event.id, event.number])).toEqual([[result.id, 1], [status.id, 2]])
    expect(reconcile(b).rejected).toEqual([])
    expect(eventsOf(b.ctx.db)).toEqual(eventsOf(a.ctx.db))
  })
})

describe('DM-191 c1/c2 (DM-270 R8): cross-repository results import elsewhere as recorded, and only as recorded', () => {
  it("imports a result citing the active repository's own correction epic from the records alone, with the same outcome", () => {
    const m = machine()
    const source = dmSourceEpic(m)
    const run = workCorrection(m, requestCorrection(m, m, source).epicId, 14)
    record(m, source.experiment.id, sprintResult(run.cards[1], 'milliseconds', 'correction Sprint 2'))
    const clone = cloneOf(m)
    expect(reconcile(clone).rejected).toEqual([])
    expect(canonicalJson(getExperiment(clone.ctx, { experimentId: source.experiment.id }).outcome)).toBe(canonicalJson(getExperiment(m.ctx, { experimentId: source.experiment.id }).outcome))
  })

  it("imports carried evidence of another project's correction epic, and refuses it with its scorecard's scope starts moved and resealed", () => {
    const m = machine()
    const source = dmSourceEpic(m)
    const target = machine({ machineId: MACHINE_B, idStart: 100_000, projectId: 'pj_000000000000000000000000qq' })
    const requested = requestCorrection(m, target, source)
    const run = workCorrection(target, requested.epicId, 14)
    bringBack(m, target, requested, source.experiment.id)
    const event = record(m, source.experiment.id, sprintResult(run.cards[1], 'milliseconds', 'correction Sprint 2 in the source'))
    if (event.kind !== 'result' || event.result.crossRepo === undefined) throw new Error('no carried evidence')
    const honest = cloneOf(m)
    expect(reconcile(honest).rejected).toEqual([])
    expect(getExperiment(honest.ctx, { experimentId: source.experiment.id }).outcome.classification).toBe('improved')
    const carried = event.result.crossRepo
    const card = carried.scorecard
    const moved = { ...carried, starts: carried.starts.map((item) => (item.runId === card.runId && item.sprintId === card.sprintId ? { ...item, sprint: '2026-01-01T00:00:00.000Z' } : item)) }
    const forged = { ...event, result: { ...event.result, crossRepo: { ...moved, seal: crossRepoSealOf(moved) } } }
    const tampered = cloneOf(m)
    rewriteRunFile(tampered, source.runId, (file) => ({ ...file, experimentEvents: file.experimentEvents.map((item) => (item.id === event.id ? forged : item)) }))
    expect(reconcile(tampered).rejected.map((item) => item.message)).toContain(
      `Experiment event ${event.id} carries scope starts for sprint ${card.sprintId} of run ${card.runId} that are not those its scorecard ${card.report.reportId} holds.`
    )
  })
})
