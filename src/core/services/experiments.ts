/**
 * Improvement experiments (`src/shared/domain/experiments.ts`) as the reports service and later readers see them:
 * the context a retro's experiments are resolved against when a report is submitted, the append-only later events of an
 * experiment (statuses and measured results), and the read model joining an experiment's latest definition with them.
 *
 * An experiment's definition lives in the retro of a report revision and is never edited. Its events are rows of their
 * own (`experiment_events`), exported with the run history beside the reports and never inside one, so recording one
 * leaves every report, its content hash and its frozen scorecard exactly as approved.
 */
import type {
  ExperimentEvent,
  ExperimentEventInput,
  ExperimentOutcome,
  ExperimentResult,
  ExperimentStatus,
  ExperimentView
} from '../../shared/domain/experiments'
import { FINAL_EXPERIMENT_STATUSES } from '../../shared/domain/experiments'
import type { SprintRetro } from '../../shared/domain/retro'
import type { ScorecardDraft } from '../../shared/domain/spaceGrades'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { parseJson, toJson } from '../db/database'
import { fail } from '../errors'
import { crossRepoEvidenceProblem } from '../plan/corrections'
import {
  evidenceOf,
  type ExperimentContext,
  experimentEventSchema,
  executionProblems,
  experimentHash,
  type KnownExperiment,
  readMeasure,
  resolveSealed
} from '../plan/experiments'
import { experimentEventInput, parseInput } from '../schemas'
import { appendEvent } from './events'
import { requireRun, type RunRow } from './execution'
import { broughtBackResults, carriedEvidence, outcomeReads, readExperimentOutcome, resultEpics, scorecardReader } from './experimentOutcomes'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { enqueueOutbox } from './outbox'

interface ReportRetroRow {
  id: string
  run_id: string
  sprint_id: string
  report_revision: number
  content_json: string
}

/** Every report revision of the epic whose retro holds an experiment, oldest first (later revisions restate). */
function experimentReports(ctx: Ctx, epicId: string): ReportRetroRow[] {
  return ctx.db.all<ReportRetroRow>(
    `SELECT r.id, r.run_id, r.sprint_id, r.report_revision, r.content_json
     FROM sprint_reports r JOIN runs ON runs.id = r.run_id
     WHERE runs.epic_id = ? AND json_extract(r.content_json, '$.retro.experiments') IS NOT NULL
     ORDER BY r.created_at, r.report_revision, r.id`,
    epicId
  )
}

/** The latest definition of each experiment of the epic, with the report revision that holds it. */
function knownExperiments(ctx: Ctx, epicId: string): Map<string, KnownExperiment> {
  const known = new Map<string, KnownExperiment>()
  for (const row of experimentReports(ctx, epicId)) {
    const retro = parseJson<{ retro?: SprintRetro | null }>(row.content_json, {}).retro
    for (const experiment of retro?.experiments ?? []) {
      known.set(experiment.id, { runId: row.run_id, sprintId: row.sprint_id, reportId: row.id, experiment })
    }
  }
  return known
}

/**
 * What a report's retro experiments are resolved against: the report's run and sprint, the scorecard drafted for this
 * very submission (`own`, whose grades a source may name by subject), the epic's frozen scorecards, the experiments
 * already written in its reports, and the project's repositories (a folder of repositories names one).
 */
export function experimentContext(ctx: Ctx, run: { id: string; epic_id: string }, sprintId: string, own: ScorecardDraft | null): ExperimentContext {
  let known: Map<string, KnownExperiment> | null = null
  return {
    epicId: run.epic_id,
    runId: run.id,
    sprintId,
    mint: () => ctx.ids.next('experiment'),
    scorecard: scorecardReader(ctx, [run.epic_id]),
    own,
    known: (experimentId) => {
      known ??= knownExperiments(ctx, run.epic_id)
      return known.get(experimentId) ?? null
    },
    repositories: ctx.repositoryEntries()?.map((entry) => entry.name) ?? null
  }
}

/**
 * An experiment's latest definition, with its epic and the revision number of the report that holds it. It is
 * `withdrawn` when a later revision of the same sprint's report (in the same run) leaves it out.
 */
interface DefinedExperiment extends KnownExperiment {
  epicId: string
  reportRevision: number
  withdrawn: boolean
}

/** An experiment's latest definition anywhere in this database, or `not_found`. */
function requireExperiment(ctx: Ctx, experimentId: string): DefinedExperiment {
  const row =
    ctx.db.get<ReportRetroRow & { epic_id: string }>(
      `SELECT r.id, r.run_id, r.sprint_id, r.report_revision, r.content_json, runs.epic_id
       FROM sprint_reports r JOIN runs ON runs.id = r.run_id
       WHERE EXISTS (SELECT 1 FROM json_each(r.content_json, '$.retro.experiments') AS item WHERE json_extract(item.value, '$.id') = ?)
       ORDER BY r.report_revision DESC, r.created_at DESC, r.id DESC LIMIT 1`,
      experimentId
    ) ?? fail('not_found', `Experiment ${experimentId} is not in any sprint report's retro.`, { experimentId })
  const retro = parseJson<{ retro?: SprintRetro | null }>(row.content_json, {}).retro
  const experiment =
    retro?.experiments?.find((item) => item.id === experimentId) ?? fail('internal', `Report ${row.id} lost experiment ${experimentId}.`)
  const latest = ctx.db.get<{ latest: number }>('SELECT MAX(report_revision) AS latest FROM sprint_reports WHERE run_id = ? AND sprint_id = ?', row.run_id, row.sprint_id)
  return {
    runId: row.run_id,
    sprintId: row.sprint_id,
    reportId: row.id,
    reportRevision: row.report_revision,
    epicId: row.epic_id,
    experiment,
    withdrawn: (latest?.latest ?? row.report_revision) > row.report_revision
  }
}

function storedEvents(ctx: Ctx, experimentId: string): ExperimentEvent[] {
  return ctx.db
    .all<{ event_json: string }>('SELECT event_json FROM experiment_events WHERE experiment_id = ? ORDER BY number', experimentId)
    .map((row) => JSON.parse(row.event_json) as ExperimentEvent)
}

/** The latest status event's status; `proposed` before any. */
function statusOf(events: ExperimentEvent[]): ExperimentStatus {
  return events.reduce<ExperimentStatus>((status, event) => (event.kind === 'status' ? event.status : status), 'proposed')
}

type ResultInput = Extract<ExperimentEventInput, { kind: 'result' }>['result']

/**
 * A stated result: never negative (the schema), at most 100 points, and backed by at least one evidence reference,
 * since nothing else says where the number came from.
 */
function statedResult(found: DefinedExperiment, input: ResultInput, value: number | null): ExperimentResult {
  const { baseline } = found.experiment
  const evidence = evidenceOf(input.evidence ?? [], 'event.result.evidence')
  if (value === null) {
    fail('invalid_input', 'Invalid result at event.result: cite the frozen assessment it was read from, or state its value with evidence.', { path: 'event.result' })
  }
  if (baseline.unit === 'points' && value > 100) {
    fail('invalid_input', 'Invalid result at event.result.value: points run from 0 to 100.', { path: 'event.result.value' })
  }
  if (evidence.length === 0) {
    fail('invalid_input', 'Invalid result at event.result.evidence: a stated value cites at least one piece of evidence (or read it from a frozen assessment).', {
      path: 'event.result.evidence'
    })
  }
  return { value, unit: baseline.unit, state: 'observed', assessment: null, evidence }
}

/**
 * A result in the experiment's baseline unit: read from a cited frozen assessment at the baseline's level, of the
 * experiment's epic or of a follow-up epic holding its corrective work in a saved revision (`resultEpics`; the
 * scorecard is checked against its seal and regraded), where a stated value must agree with it; or stated with
 * evidence. A cited assessment without a value for the measure gives a missing result. For an experiment aimed at the
 * Dark Mechanicus source, the cited report may also be a scorecard of the epic its cross-repository correction
 * created there, as the linked receipt brought it back (`carriedEvidence`, regraded here): the result then carries that
 * evidence (`crossRepo`), and the same checks apply.
 */
function resultOf(ctx: Ctx, found: DefinedExperiment, input: ResultInput): ExperimentResult {
  const { baseline, source } = found.experiment
  if (input.unit !== baseline.unit) {
    fail('invalid_input', `Invalid unit at event.result.unit: experiment ${found.experiment.id} measures ${baseline.measure} in ${baseline.unit}, not ${input.unit}.`, {
      path: 'event.result.unit',
      unit: input.unit,
      expected: baseline.unit
    })
  }
  const stated = input.value ?? null
  if (input.assessment == null) return statedResult(found, input, stated)
  const { reader, crossRepo } = citedScorecards(ctx, found, input.assessment.reportId)
  const { ref, grade, card } = resolveSealed(input.assessment, reader, 'event.result.assessment')
  requireStorable(ctx, found, crossRepo.crossRepo, ref)
  if (ref.subject.level !== source.subject.level) {
    fail('invalid_input', `Invalid result at event.result.assessment: the baseline is a ${source.subject.level} grade, so the result is read from a ${source.subject.level} grade, not a ${ref.subject.level} one.`, {
      path: 'event.result.assessment'
    })
  }
  const evidence = evidenceOf(input.evidence ?? [], 'event.result.evidence')
  const reading = readMeasure(card, grade, baseline.measure)
  if ('missing' in reading) {
    if (stated !== null) {
      fail('invalid_input', `Invalid result at event.result.value: assessment ${ref.assessmentId} has no ${baseline.measure} (${reading.missing}).`, { path: 'event.result.value' })
    }
    return { value: null, unit: baseline.unit, state: 'missing', assessment: ref, evidence, ...crossRepo }
  }
  if (stated !== null && stated !== reading.value) {
    fail('invalid_input', `Invalid result at event.result.value: assessment ${ref.assessmentId} reads ${baseline.measure} ${reading.value}, not ${stated}.`, {
      path: 'event.result.value'
    })
  }
  return { value: reading.value, unit: baseline.unit, state: reading.state, assessment: ref, evidence, ...crossRepo }
}

/**
 * What a result stores must pass the very check every read and import applies (`crossRepoEvidenceProblem`), so a write
 * never stores what they would refuse.
 */
function requireStorable(ctx: Ctx, found: DefinedExperiment, carried: ExperimentResult['crossRepo'], cited: NonNullable<ExperimentResult['assessment']>): void {
  if (carried === undefined) return
  const problem = crossRepoEvidenceProblem(carried, found.experiment, { projectId: ctx.projectId, own: resultEpics(ctx, found.experiment), regrade: false }, cited)
  if (problem !== null) fail('invalid_input', `Invalid result at event.result.assessment: the grade brought back ${problem}, so it cannot be recorded.`, { path: 'event.result.assessment' })
}

/**
 * Where a cited report's scorecard is read: this project's (the experiment's epic and its follow-ups), else a
 * scorecard a linked cross-repository receipt of the experiment brought back, which the result then carries. For an
 * experiment aimed at the Dark Mechanicus source, a report that is neither says to bring the target's grades back first.
 * A grade brought back from this very project (its correction epic in another checkout) is never carried: it is cited
 * directly once that checkout's records arrive through Git (`broughtBackResults` does not list it either).
 */
function citedScorecards(ctx: Ctx, found: DefinedExperiment, reportId: string): { reader: ExperimentContext['scorecard']; crossRepo: Pick<ExperimentResult, 'crossRepo'> } {
  const local = scorecardReader(ctx, resultEpics(ctx, found.experiment))
  if (local(reportId) !== undefined || found.experiment.destination.kind !== 'darkmechanicus_source') return { reader: local, crossRepo: {} }
  const carried = carriedEvidence(ctx, found.experiment, reportId)
  if (carried === null) {
    fail(
      'invalid_input',
      `Unknown report ${reportId} at event.result.assessment.reportId: it is not a report of this project's epics, nor one the experiment's cross-repository correction brought back. If it is a report of the correction epic in the Dark Mechanicus source, bring that epic's grades back in the desktop app first (get_experiment lists them under crossRepoResults).`,
      { path: 'event.result.assessment.reportId', reportId }
    )
  }
  if (carried.projectId === ctx.projectId) {
    fail(
      'invalid_input',
      `Report ${reportId} at event.result.assessment.reportId is a grade of epic ${carried.epicId} of this very project, brought back from another checkout of it: a grade of this project is never carried. Bring that checkout's records here through Git (commit and push them there, pull and reconcile here), then cite the report directly.`,
      { path: 'event.result.assessment.reportId', reportId, epicId: carried.epicId }
    )
  }
  return { reader: (id) => (id === carried.scorecard.report.reportId ? carried.scorecard : undefined), crossRepo: { crossRepo: carried } }
}

interface RecordExperimentEventInput {
  experimentId: string
  event: ExperimentEventInput
  idempotencyKey?: string
}

/** Stores a new event row, announces it and queues its run history for export (the report rows are not touched). */
function storeEvent(ctx: Ctx, run: { id: string; epic_id: string }, event: ExperimentEvent): void {
  ctx.db.run(
    'INSERT INTO experiment_events (id, run_id, number, experiment_id, recorded_at, event_json) VALUES (?, ?, ?, ?, ?, ?)',
    event.id,
    run.id,
    event.number,
    event.experimentId,
    event.recordedAt,
    toJson(event)
  )
  appendEvent(ctx, {
    kind: 'experiment.event_recorded',
    epicId: run.epic_id,
    runId: run.id,
    payload: { experimentId: event.experimentId, eventId: event.id, kind: event.kind, number: event.number }
  })
  enqueueOutbox(ctx, { kind: 'run_history', epicId: run.epic_id, runId: run.id })
}

/** Statuses that say the corrective work went ahead, by the verb a refusal names: each needs sized, specific proposed work. */
const EXECUTION_VERBS: Partial<Record<ExperimentStatus, string>> = { scheduled: 'scheduled', in_progress: 'started', completed: 'completed' }

/** Work goes ahead (or is called done) only on sized, specific proposed work, and scheduling says where it was planned. */
function requireSchedulable(found: DefinedExperiment, event: Extract<ExperimentEventInput, { kind: 'status' }>): void {
  const verb = EXECUTION_VERBS[event.status]
  if (verb === undefined) return
  const problems = executionProblems(found.experiment)
  if (problems.length > 0) {
    fail(
      'conflict',
      `Experiment ${found.experiment.id} cannot be ${verb}: ${problems.join('; ')}. Restate it in a new revision of its sprint's report (by its id, from its original { reportId, assessmentId }) with sized, specific work first.`,
      { experimentId: found.experiment.id, problems }
    )
  }
  if (event.status === 'scheduled' && (event.note ?? '').trim() === '') {
    fail('invalid_input', 'Invalid event at event.note: say where the corrective work was planned (the tickets, sprint or Kanban card) when scheduling.', {
      path: 'event.note'
    })
  }
}

/**
 * The run whose history takes an event: always the run whose report defines the experiment, so its events stay one
 * numbered, append-only sequence beside the definition they cite (import checks them there). This machine may append
 * when it owns that run; or, for a result read from a follow-up epic's grade, when it owns the run that froze that
 * grade: a completed source run cannot be taken over, and whoever runs the follow-up is the one who measures it. A
 * result read from a correction epic in another project is recorded on the machine owning the source run (its receipt
 * brought the grade back there). Two machines appending to one experiment at once fork its numbering: the export
 * refuses to write over the other's events, and the reconcile numbers this machine's after them (`importer.ts`).
 */
function recordingRun(ctx: Ctx, found: DefinedExperiment, result: ExperimentResult | null): RunRow {
  const run = requireRun(ctx, found.runId)
  if (run.owner_machine_id === ctx.machineId) return run
  const cited = result?.assessment ?? null
  if (cited !== null && result?.crossRepo === undefined && cited.epicId !== found.epicId && requireRun(ctx, cited.runId).owner_machine_id === ctx.machineId) return run
  return fail(
    'run_not_owned',
    `Run ${run.id}, whose report defines experiment ${found.experiment.id}, belongs to another machine: record its events there, or record a result read from a follow-up epic's grade on the machine that owns that follow-up run.`,
    { runId: run.id, ownerMachineId: run.owner_machine_id }
  )
}

/**
 * Orchestrator: records a later status or measured result of an experiment, as a new append-only event of the run
 * whose report defines it (`recordingRun` says which machine may), numbered 1, 2, 3, … per experiment. The event cites
 * the exact definition it is about (the latest report revision holding the experiment, and the experiment's content
 * hash). Refused with `conflict`: an experiment a later revision of its sprint's report left out (withdrawn), a
 * status after `completed` or `abandoned`, and `scheduled`, `in_progress` or `completed` while any proposed work is
 * unsized or vague (`executionProblems`: restate the experiment with sized, specific work first). Scheduling is never silent: a
 * `scheduled` status needs a note saying where the work was planned. A result is in the baseline's unit; notes and
 * evidence details follow the metric ledger's text rule. No report, content hash or frozen scorecard changes: the event
 * is exported with the run history beside the reports.
 */
export function recordExperimentEvent(ctx: Ctx, raw: RecordExperimentEventInput): ExperimentEvent {
  requireCapability(ctx.session, 'report.submit')
  const input = parseInput(experimentEventInput, raw, 'experiment event') as RecordExperimentEventInput
  return withIdempotency(ctx, { command: 'recordExperimentEvent', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    const found = requireExperiment(ctx, input.experimentId)
    const result = input.event.kind === 'result' ? resultOf(ctx, found, input.event.result) : null
    const run = recordingRun(ctx, found, result)
    if (found.withdrawn) {
      fail('conflict', `Experiment ${input.experimentId} was left out of a later revision of its sprint's report, so it is withdrawn and takes no events.`, {
        experimentId: input.experimentId,
        reportId: found.reportId
      })
    }
    const events = storedEvents(ctx, input.experimentId)
    const current = statusOf(events)
    if (input.event.kind === 'status' && FINAL_EXPERIMENT_STATUSES.includes(current)) {
      fail('conflict', `Experiment ${input.experimentId} is ${current}; its status no longer changes.`, { experimentId: input.experimentId, status: current })
    }
    if (input.event.kind === 'status') requireSchedulable(found, input.event)
    const base = {
      id: ctx.ids.next('experimentEvent'),
      experimentId: input.experimentId,
      runId: run.id,
      number: events.length + 1,
      source: { reportId: found.reportId, experimentHash: experimentHash(found.experiment) },
      note: input.event.note ?? '',
      recordedBy: { role: ctx.session.role, label: ctx.session.label },
      recordedAt: ctx.clock.nowIso()
    }
    const event = parseInput<ExperimentEvent>(
      experimentEventSchema,
      input.event.kind === 'status' ? { ...base, kind: 'status', status: input.event.status } : { ...base, kind: 'result', result },
      'experiment event'
    )
    storeEvent(ctx, run, event)
    return event
  })
}

/**
 * An experiment as read: its latest definition and where it is written, its status, whether it is withdrawn, why its
 * work cannot be scheduled yet (empty: it can), its events, and its outcome (`readExperimentOutcome`): its corrective
 * tickets and where they landed, and every result compared with the frozen baseline, target and guardrails.
 */
export function getExperiment(ctx: Ctx, input: { experimentId: string }): ExperimentView {
  requireCapability(ctx.session, 'read')
  const found = requireExperiment(ctx, input.experimentId)
  const events = storedEvents(ctx, input.experimentId)
  const status = statusOf(events)
  return {
    experiment: found.experiment,
    definedIn: {
      runId: found.runId,
      sprintId: found.sprintId,
      reportId: found.reportId,
      reportRevision: found.reportRevision,
      experimentHash: experimentHash(found.experiment)
    },
    status,
    withdrawn: found.withdrawn,
    executionProblems: executionProblems(found.experiment),
    events,
    outcome: readExperimentOutcome(ctx, { experiment: found.experiment, status, events }),
    crossRepoResults: broughtBackResults(ctx, found.experiment.id)
  }
}

/**
 * Where an experiment stands without its outcome: whether it is withdrawn and its status (what corrective-work checks
 * need; reading the outcome would read every scorecard its results cite).
 */
export function experimentStanding(ctx: Ctx, experimentId: string): { withdrawn: boolean; status: ExperimentStatus } {
  return { withdrawn: requireExperiment(ctx, experimentId).withdrawn, status: statusOf(storedEvents(ctx, experimentId)) }
}

/** The outcome of each of a report's experiments (read with `getSprintReport`; never part of its content or hash). */
export function experimentOutcomes(ctx: Ctx, experimentIds: string[]): ExperimentOutcome[] {
  const reads = outcomeReads(ctx)
  return experimentIds.map((experimentId) => {
    const found = requireExperiment(ctx, experimentId)
    const events = storedEvents(ctx, experimentId)
    return readExperimentOutcome(ctx, { experiment: found.experiment, status: statusOf(events), events }, reads)
  })
}
