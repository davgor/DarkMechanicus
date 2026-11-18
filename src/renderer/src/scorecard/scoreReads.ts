/**
 * The renderer's client for the scorecard reads. It never grades: each identity names one core read model, fetched
 * through the desktop command channel and shown as it arrives. A reader follows one identity at a time; selecting
 * another (a different run, ticket or report revision) starts over, and an answer for an identity no longer selected
 * is dropped, so a slow reply can never put the previous ticket's or revision's grade on screen. A refresh (polled or
 * prompted by an event) replaces the data in place, never stacks requests, and a failed refresh keeps the last good
 * data beside the error instead of blanking it. Every state is typed: idle, loading, ready or error, and an error says
 * what the person can do about it.
 *
 * Edits a person makes beside a refreshing view (a rating, a budget) live in an `EditBuffer`: a refresh moves the saved
 * value under the edit but never overwrites it, and says when the saved value changed while the edit was open.
 */
import type { CommandName } from '../../../shared/domain/api'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { ScopeEfficiencyView } from '../../../shared/domain/efficiency'
import type { DomainErrorCode } from '../../../shared/domain/errors'
import type { ReportIdentity, ReportScorecardView } from '../../../shared/domain/scoreReads'
import type { AttemptUsageView } from '../../../shared/domain/metrics'
import type {
  AggregateGradeView,
  FrozenTiming,
  ScorecardAggregateView,
  ScorecardReassessment,
  ScorecardSnapshot,
  SubjectReassessment,
  TicketGradeView
} from '../../../shared/domain/spaceGrades'
import type { SpaceSignalsView } from '../../../shared/domain/spaceSignals'
import type { RunTiming, TicketTiming } from '../../../shared/domain/timing'
import type { RunView, SprintReportView } from '../../../shared/domain/views'
import type { CommandInput, CommandOutput } from '../../../shared/desktop/api'

// ---------------------------------------------------------------------------------------------------------------
// Identities and their read models

/**
 * One scorecard and what it is pinned to. A report is pinned to one revision: it shows that frozen snapshot only. A
 * `ticketCard` is a ticket's grade in one run with what explains it (see `TicketCardView`); an `epicCard` an epic's
 * live or immutable assessment with its runs and sprints (see `EpicCardView`).
 */
export type ScoreIdentity =
  | { kind: 'ticket'; runId: string; ticketId: string }
  | { kind: 'ticketCard'; runId: string; ticketId: string }
  | { kind: 'sprint'; runId: string; sprintId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'epic'; epicId: string }
  | { kind: 'epicCard'; epicId: string; completed: boolean }
  | { kind: 'report'; reportId: string; reportRevision: number }
  | { kind: 'reportCard'; runId: string; sprintId: string; report: { reportId: string; reportRevision: number } | null }
  /** A dated reassessment at the server's time when asked; each `request` is a new reading. */
  | { kind: 'reassessment'; reportId: string; reportRevision: number; request: number }
  /** The sprint's S, A and C signals in one run as they stand now: what people said about the sprint so far. */
  | { kind: 'sprintSignals'; runId: string; sprintId: string }

/** A part of a composed read: its read model, or its own error beside the parts that loaded. */
export type ReadPart<T> = { ok: true; value: T } | { ok: false; error: ScoreReadError }

/**
 * The sprint report of the ticket's sprint in the run, regraded by the core at the grade's cutoff: `none` before any
 * report (nothing is frozen, the grade is live), else the dated reassessment (`legacy` for a report from before
 * scorecards) and the ticket's own subject in it (null when the report's scorecard holds no grade for it).
 */
export type TicketReportRead =
  | { state: 'none' }
  | { state: 'reassessed'; reportId: string; reportRevision: number; reassessment: ScorecardReassessment; subject: SubjectReassessment | null }

/**
 * A ticket's Scorecard tab: its live grade in one run (`getTicketGrade`), and, read at that grade's cutoff, its timing
 * (`getRunTiming`), its attempts' usage (`getRunMetrics`, the run's usage table as it stands, kept to this ticket) and
 * its frozen-versus-reassessed report grades. Each part after the grade fails on its own. Nothing here is graded.
 */
export interface TicketCardView {
  grade: TicketGradeView
  timing: ReadPart<TicketTiming>
  usage: ReadPart<AttemptUsageView[]>
  report: ReadPart<TicketReportRead>
}

/** The epic's assessment as its Scorecard shows it. */
export type EpicAssessment =
  /** An open epic: its grade as of now, across every run created so far. */
  | { state: 'live'; view: AggregateGradeView }
  /** A completed epic: the grade frozen with its final sprint's report, regraded on read from its stored input. */
  | { state: 'frozen'; report: ReportIdentity; snapshot: ScorecardSnapshot; view: ScorecardAggregateView }
  /** A completed epic whose final report predates scorecards: ungraded, and no grade stands in for one. */
  | { state: 'legacy'; report: ReportIdentity; reason: string }
  /** A completed epic with no frozen epic grade (no run, no final report): nothing is shown in its place. */
  | { state: 'not_frozen'; reason: string }

/** One sprint of a run: the grade frozen with its report, or (open epics only) its live grade. */
export type SprintAssessment =
  | { state: 'frozen'; report: ReportIdentity; snapshot: ScorecardSnapshot; view: ScorecardAggregateView }
  | { state: 'legacy'; report: ReportIdentity; reason: string }
  | { state: 'live'; view: AggregateGradeView }
  /** A completed epic's sprint without a report: it was never assessed. */
  | { state: 'not_reported' }

export interface EpicSprintRead {
  sprintId: string
  ordinal: number
  goal: string
  assessment: ReadPart<SprintAssessment>
}

/** A run's timing: live at the epic grade's cutoff, the one frozen with the run's last report, or none frozen. */
export type EpicRunTiming = { state: 'live'; timing: RunTiming } | { state: 'frozen'; timing: FrozenTiming; reportRevision: number } | { state: 'none' }

export interface EpicRunRead {
  run: RunView
  /** The plan revision the run executed. */
  bundle: PlanBundle
  sprints: EpicSprintRead[]
  timing: ReadPart<EpicRunTiming>
  /**
   * An open epic's run the grade did not measure (it executed no work, though it may have recorded overhead): its own
   * usage (`getRunEfficiency`, the run scope, at the grade's cutoff), so the totals still count it. Null for a measured
   * run (the grade holds its usage) and in a completed epic (only what was frozen is shown).
   */
  usage: ReadPart<ScopeEfficiencyView> | null
}

/** The epic grade frozen with the final sprint's report beside the core's dated reassessment of it. */
interface EpicReassessmentRead {
  report: ReportIdentity
  reassessment: ScorecardReassessment
  /** The epic's own subject in it; null when the reassessment holds none. */
  subject: SubjectReassessment | null
}

/**
 * An epic's Scorecard. An open epic reads its live grade (`getEpicGrade`) and every run it covers at that grade's
 * cutoff: each sprint's frozen report grade when the sprint has a report, else its live grade, the run's timing, and
 * for a run the grade did not measure its own usage. A completed epic reads its immutable assessment, the epic grade
 * frozen with its final sprint's report (`legacy` for a report from before scorecards); nothing live stands in for it:
 * its sprints show their frozen report grades only, and each run's timing is the one frozen with that run's last
 * report. When the final report froze an epic grade, the core's dated reassessment of it is read for the comparison.
 * Each run and the reassessment fail on their own.
 */
export interface EpicCardView {
  epicId: string
  assessment: EpicAssessment
  /** The runs the assessment covers, oldest first. */
  runs: { runId: string; read: ReadPart<EpicRunRead> }[]
  /** Null when no final report froze an epic grade (nothing to compare with). */
  reassessment: ReadPart<EpicReassessmentRead> | null
}

/** The read model each identity reads, unchanged from the core. */
interface ScoreViews {
  ticket: TicketGradeView
  ticketCard: TicketCardView
  sprint: AggregateGradeView
  run: AggregateGradeView
  epic: AggregateGradeView
  epicCard: EpicCardView
  report: ReportScorecardView
  reportCard: ReportCardView
  reassessment: ScorecardReassessment
  sprintSignals: SpaceSignalsView
}

export type ScoreViewOf<I extends ScoreIdentity> = ScoreViews[I['kind']]

/** Runs one desktop command for the folder being shown (`runCommand` bound to a folder). */
export type CommandRunner = <K extends CommandName>(name: K, input: CommandInput<K>) => Promise<CommandOutput<K>>

/** The key that tells two selections apart: the folder and every id of the identity, revision included. */
export function scoreKey(folder: string, identity: ScoreIdentity): string {
  return JSON.stringify([folder, ...Object.entries(identity).sort(([a], [b]) => a.localeCompare(b))])
}

async function part<T>(read: () => Promise<T>): Promise<ReadPart<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (error) {
    return { ok: false, error: scoreReadError(error) }
  }
}

async function ticketTiming(run: CommandRunner, ids: { runId: string; ticketId: string }, cutoff: string): Promise<TicketTiming> {
  const timing = await run('getRunTiming', { ...ids, cutoff })
  const ticket = timing.tickets.find((entry) => entry.ticketId === ids.ticketId)
  if (ticket === undefined) {
    throw new Error(`The run's timing holds no entry for ticket ${ids.ticketId}.`)
  }
  return ticket
}

async function ticketReport(run: CommandRunner, ids: { runId: string; ticketId: string }, grade: TicketGradeView): Promise<TicketReportRead> {
  const scope = grade.sources.efficiency.scope
  const sprintId = scope.level === 'ticket' ? scope.sprintId : null
  const report = sprintId === null ? null : await run('getSprintReport', { runId: ids.runId, sprintId })
  if (report === null) {
    return { state: 'none' }
  }
  const reassessment = await run('reassessReportScorecard', { reportId: report.id, reportRevision: report.reportRevision, cutoff: grade.cutoff })
  const subject = reassessment.subjects.find((entry) => entry.subject.level === 'ticket' && entry.subject.id === ids.ticketId) ?? null
  return { state: 'reassessed', reportId: report.id, reportRevision: report.reportRevision, reassessment, subject }
}

/** Reads a ticket's Scorecard tab: the grade first, then every other part at the grade's cutoff. */
export async function loadTicketCard(run: CommandRunner, ids: { runId: string; ticketId: string }): Promise<TicketCardView> {
  const grade = await run('getTicketGrade', ids)
  const [timing, usage, report] = await Promise.all([
    part(() => ticketTiming(run, ids, grade.cutoff)),
    part(async () => (await run('getRunMetrics', { runId: ids.runId })).attempts.filter((attempt) => attempt.ticketId === ids.ticketId)),
    part(() => ticketReport(run, ids, grade))
  ])
  return { grade, timing, usage, report }
}

const bySprintOrder = <T extends { ordinal: number }>(items: readonly T[]): T[] => [...items].sort((a, b) => a.ordinal - b.ordinal)

async function runAndPlan(run: CommandRunner, runId: string): Promise<{ run: RunView; bundle: PlanBundle }> {
  const view = await run('getRun', { runId })
  if (view === null) {
    throw Object.assign(new Error(`Run ${runId} was not found.`), { code: 'not_found' })
  }
  const plan = await run('getPlan', { epicId: view.epicId, view: 'saved', revisionId: view.revisionId })
  return { run: view, bundle: plan.bundle }
}

/** A sprint report revision's scorecard as a sprint assessment: its frozen sprint grade, or legacy. */
async function reportedSprint(run: CommandRunner, report: SprintReportView): Promise<SprintAssessment> {
  const read = await run('getReportScorecard', { reportId: report.id, reportRevision: report.reportRevision })
  if (read.state === 'legacy') {
    return { state: 'legacy', report: read.report, reason: read.reason }
  }
  return { state: 'frozen', report: read.report, snapshot: read.scorecard.snapshot, view: read.scorecard.sprint }
}

async function sprintAssessment(run: CommandRunner, ids: { runId: string; sprintId: string }, live: { cutoff: string } | null): Promise<SprintAssessment> {
  const report = await run('getSprintReport', ids)
  if (report !== null) {
    return reportedSprint(run, report)
  }
  return live === null ? { state: 'not_reported' } : { state: 'live', view: await run('getSprintGrade', { ...ids, cutoff: live.cutoff }) }
}

/** The run's timing frozen with its last frozen sprint report, if any. */
function frozenRunTiming(sprints: readonly EpicSprintRead[]): EpicRunTiming {
  const frozen = sprints.flatMap((sprint) => (sprint.assessment.ok && sprint.assessment.value.state === 'frozen' ? [sprint.assessment.value] : []))
  const last = frozen.at(-1)
  return last === undefined ? { state: 'none' } : { state: 'frozen', timing: last.snapshot.timing, reportRevision: last.report.reportRevision }
}

interface LiveRead {
  cutoff: string
  /** The runs whose usage the grade already holds. */
  measured: readonly string[]
}

async function epicRun(run: CommandRunner, runId: string, live: LiveRead | null): Promise<EpicRunRead> {
  const { run: view, bundle } = await runAndPlan(run, runId)
  const sprints = await Promise.all(
    bySprintOrder(bundle.sprints).map(async (sprint) => ({
      sprintId: sprint.id,
      ordinal: sprint.ordinal,
      goal: sprint.goal,
      assessment: await part(() => sprintAssessment(run, { runId, sprintId: sprint.id }, live))
    }))
  )
  if (live === null) {
    return { run: view, bundle, sprints, timing: { ok: true, value: frozenRunTiming(sprints) }, usage: null }
  }
  const [timing, usage] = await Promise.all([
    part(async () => ({ state: 'live' as const, timing: await run('getRunTiming', { runId, cutoff: live.cutoff }) })),
    live.measured.includes(runId) ? null : part(async () => (await run('getRunEfficiency', { runId, cutoff: live.cutoff })).run)
  ])
  return { run: view, bundle, sprints, timing, usage }
}

/** A completed epic's immutable assessment: the epic grade its latest run's final sprint report froze. */
async function frozenEpic(run: CommandRunner, epicId: string): Promise<EpicAssessment> {
  const latest = await run('getRun', { epicId })
  if (latest === null) {
    return { state: 'not_frozen', reason: 'No run executed this epic, so no grade was ever frozen for it.' }
  }
  const { bundle } = await runAndPlan(run, latest.id)
  const last = bySprintOrder(bundle.sprints).at(-1)
  const report = last === undefined ? null : await run('getSprintReport', { runId: latest.id, sprintId: last.id })
  if (report === null) {
    return { state: 'not_frozen', reason: `Run #${latest.number} has no report for its final sprint, so no epic grade was frozen.` }
  }
  const read = await run('getReportScorecard', { reportId: report.id, reportRevision: report.reportRevision })
  if (read.state === 'legacy') {
    return { state: 'legacy', report: read.report, reason: read.reason }
  }
  if (read.scorecard.epic === null) {
    return { state: 'not_frozen', reason: `The final sprint's report (revision ${read.report.reportRevision}) froze no epic grade.` }
  }
  return { state: 'frozen', report: read.report, snapshot: read.scorecard.snapshot, view: read.scorecard.epic }
}

/** The runs an assessment covers: the grade's own, or for an ungraded completed epic its latest run. */
async function coveredRuns(run: CommandRunner, epicId: string, assessment: EpicAssessment): Promise<string[]> {
  switch (assessment.state) {
    case 'live':
      return assessment.view.runIds
    case 'frozen':
      return assessment.view.detail.runIds
    case 'legacy':
      return [assessment.report.runId]
    case 'not_frozen': {
      const latest = await run('getRun', { epicId })
      return latest === null ? [] : [latest.id]
    }
  }
}

/** The core's reassessment of the epic grade frozen with the latest run's final sprint report, when one was frozen. */
async function epicReassessment(run: CommandRunner, runs: EpicCardView['runs'], cutoff: string | null): Promise<ReadPart<EpicReassessmentRead> | null> {
  const latest = runs.at(-1)?.read
  const final = latest?.ok === true ? latest.value.sprints.at(-1)?.assessment : undefined
  if (final?.ok !== true || final.value.state !== 'frozen' || final.value.snapshot.epic === null) {
    return null
  }
  const report = final.value.report
  return part(async () => {
    const reassessment = await run('reassessReportScorecard', { reportId: report.reportId, reportRevision: report.reportRevision, ...(cutoff === null ? {} : { cutoff }) })
    return { report, reassessment, subject: reassessment.subjects.find((entry) => entry.subject.level === 'epic') ?? null }
  })
}

/** Reads an epic's Scorecard: its assessment first, then every run it covers and the reassessment. */
export async function loadEpicCard(run: CommandRunner, ids: { epicId: string; completed: boolean }): Promise<EpicCardView> {
  const assessment: EpicAssessment = ids.completed ? await frozenEpic(run, ids.epicId) : { state: 'live', view: await run('getEpicGrade', { epicId: ids.epicId }) }
  const live = assessment.state === 'live' ? { cutoff: assessment.view.cutoff, measured: assessment.view.measuredRunIds } : null
  const runIds = await coveredRuns(run, ids.epicId, assessment)
  const runs = await Promise.all(runIds.map(async (runId) => ({ runId, read: await part(() => epicRun(run, runId, live)) })))
  return { epicId: ids.epicId, assessment, runs, reassessment: await epicReassessment(run, runs, live?.cutoff ?? null) }
}

type GradeIdentity = Exclude<ScoreIdentity, { kind: 'sprintSignals' }>

/** The grade and report reads: each identity's core read model. */
function readGrade(run: CommandRunner, identity: GradeIdentity): Promise<ScoreViews[GradeIdentity['kind']]> {
  switch (identity.kind) {
    case 'ticket':
      return run('getTicketGrade', { runId: identity.runId, ticketId: identity.ticketId })
    case 'ticketCard':
      return loadTicketCard(run, { runId: identity.runId, ticketId: identity.ticketId })
    case 'sprint':
      return run('getSprintGrade', { runId: identity.runId, sprintId: identity.sprintId })
    case 'run':
      return run('getRunGrade', { runId: identity.runId })
    case 'epic':
      return run('getEpicGrade', { epicId: identity.epicId })
    case 'epicCard':
      return loadEpicCard(run, { epicId: identity.epicId, completed: identity.completed })
    case 'report':
      return run('getReportScorecard', { reportId: identity.reportId, reportRevision: identity.reportRevision })
    case 'reportCard':
      return loadReportCard(run, { runId: identity.runId, sprintId: identity.sprintId, report: identity.report })
    case 'reassessment':
      return run('reassessReportScorecard', { reportId: identity.reportId, reportRevision: identity.reportRevision })
  }
}

/** Fetches the read model an identity names through the desktop command channel. */
export function loadScore<I extends ScoreIdentity>(run: CommandRunner, identity: I): Promise<ScoreViewOf<I>> {
  const named: ScoreIdentity = identity
  const read =
    named.kind === 'sprintSignals' ? run('getSpaceSignals', { level: 'sprint', id: named.sprintId, runId: named.runId }) : readGrade(run, named)
  return read as Promise<ScoreViewOf<I>>
}

/**
 * A sprint report's Scorecard tab. A report revision reads the scorecard frozen with it, pinned to that revision
 * (`frozen`, or `legacy` for a report submitted before scorecards: it stays ungraded and no live grade stands in for
 * it). A sprint with no report yet reads its live grade (`getSprintGrade`, as of now) and the run's timing at that
 * grade's cutoff: provisional, nothing frozen. Nothing here is graded.
 */
export type ReportCardView =
  | ReportScorecardView
  | { state: 'live'; runId: string; sprintId: string; sprint: AggregateGradeView; timing: ReadPart<CommandOutput<'getRunTiming'>> }

/** Reads a sprint report's Scorecard tab: the pinned revision's frozen scorecard, or with no report the live grade. */
async function loadReportCard(
  run: CommandRunner,
  ids: { runId: string; sprintId: string; report: { reportId: string; reportRevision: number } | null }
): Promise<ReportCardView> {
  if (ids.report !== null) {
    return run('getReportScorecard', { reportId: ids.report.reportId, reportRevision: ids.report.reportRevision })
  }
  const sprint = await run('getSprintGrade', { runId: ids.runId, sprintId: ids.sprintId })
  const timing = await part(() => run('getRunTiming', { runId: ids.runId, cutoff: sprint.cutoff }))
  return { state: 'live', runId: ids.runId, sprintId: ids.sprintId, sprint, timing }
}

// ---------------------------------------------------------------------------------------------------------------
// Typed states

/**
 * What the person can do about a failed read or edit:
 * - `retry`: a transient failure (the app was busy, a timeout, an unexpected error);
 * - `reload`: what was edited changed underneath (a conflict or a stale draft): reload it, keeping the edit to reapply;
 * - `not_permitted`: this session may not do it (a capability refusal); nothing will change by retrying;
 * - `not_found`: the run, ticket or report revision does not exist (here);
 * - `fix_input`: the input was refused (out of bounds, malformed).
 */
type ScoreErrorAction = 'retry' | 'reload' | 'not_permitted' | 'not_found' | 'fix_input'

export interface ScoreReadError {
  code: DomainErrorCode | 'unexpected'
  message: string
  action: ScoreErrorAction
}

const ACTIONS: Partial<Record<DomainErrorCode, ScoreErrorAction>> = {
  unauthorized: 'not_permitted',
  unauthorized_transition: 'not_permitted',
  unsupported_capability: 'not_permitted',
  not_found: 'not_found',
  invalid_input: 'fix_input',
  invalid_request: 'fix_input',
  conflict: 'reload',
  stale_draft: 'reload',
  branch_changed: 'reload'
}

/** A thrown command failure (`CommandError`, or any error) as a typed, actionable error. */
export function scoreReadError(error: unknown): ScoreReadError {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    const code = error.code as DomainErrorCode
    const message = error instanceof Error ? error.message : String(error.code)
    return { code, message, action: ACTIONS[code] ?? 'retry' }
  }
  return { code: 'unexpected', message: error instanceof Error ? error.message : String(error), action: 'retry' }
}

/**
 * A scorecard read: `idle` with nothing selected, `loading` until the first answer for the selection, `ready` with the
 * read model (and the error of the last refresh, if it failed, beside the data it kept), or `error` when the selection
 * never loaded. No state stands for an empty successful score: a grade with nothing measured arrives as the core's own
 * `ungraded` grade, and a report without a frozen scorecard as `legacy`.
 */
export type ScoreReadState<T> =
  | { status: 'idle' }
  | { status: 'loading'; key: string }
  | { status: 'ready'; key: string; data: T; loadedAt: number; refreshError: ScoreReadError | null }
  | { status: 'error'; key: string; error: ScoreReadError }

/**
 * What a view shows for `key`: the reader's state only while it is about `key`, else `loading` for it (`idle` with
 * nothing selected), so the render that changes the identity never shows the previous identity's data.
 */
export function shownState<T>(state: ScoreReadState<T>, key: string | null): ScoreReadState<T> {
  if (key === null) {
    return { status: 'idle' }
  }
  return state.status !== 'idle' && state.key === key ? state : { status: 'loading', key }
}

export interface ScoreReader<T> {
  /** Follows `key` (null: nothing); the same key again keeps what is shown. Resolves when its first answer settled. */
  select(key: string | null, load: () => Promise<T>): Promise<void>
  /**
   * Reads the selection again in place. While a read of it is in flight, one more read is queued to start when it
   * settles (any number of refreshes meanwhile share it), so a refresh prompted by a write is never lost and refreshes
   * never stack. Resolves when the read it started or joined settled.
   */
  refresh(): Promise<void>
  state(): ScoreReadState<T>
}

interface ReaderOptions<T> {
  onChange(state: ScoreReadState<T>): void
  now(): number
}

interface Selection<T> {
  key: string
  load: () => Promise<T>
  generation: number
}

/** The state a settled read leaves: the data, or its error beside data already shown for the same key. */
function settledState<T>(state: ScoreReadState<T>, key: string, outcome: { data: T; at: number } | { error: unknown }): ScoreReadState<T> {
  if ('data' in outcome) {
    return { status: 'ready', key, data: outcome.data, loadedAt: outcome.at, refreshError: null }
  }
  const failure = scoreReadError(outcome.error)
  return state.status === 'ready' && state.key === key ? { ...state, refreshError: failure } : { status: 'error', key, error: failure }
}

class Reader<T> implements ScoreReader<T> {
  private current: ScoreReadState<T> = { status: 'idle' }
  private selection: Selection<T> | null = null
  private generation = 0
  private inFlight: { generation: number; done: Promise<void> } | null = null
  private queued: Promise<void> | null = null

  constructor(private readonly options: ReaderOptions<T>) {}

  state(): ScoreReadState<T> {
    return this.current
  }

  select(key: string | null, load: () => Promise<T>): Promise<void> {
    if (key === this.selection?.key) {
      this.selection = { ...this.selection, load }
      return Promise.resolve()
    }
    this.generation += 1
    this.queued = null
    if (key === null) {
      this.selection = null
      this.set({ status: 'idle' })
      return Promise.resolve()
    }
    this.selection = { key, load, generation: this.generation }
    this.set({ status: 'loading', key })
    return this.start(this.selection)
  }

  refresh(): Promise<void> {
    const selection = this.selection
    const busy = this.inFlight
    if (selection === null) {
      return Promise.resolve()
    }
    // A read already queued for this selection serves this refresh too: starting another would run two at once.
    if (this.queued !== null) {
      return this.queued
    }
    if (busy === null || busy.generation !== selection.generation) {
      return this.start(selection)
    }
    const queued: Promise<void> = busy.done.then(() => {
      // Only this queue entry is cleared: a later selection may have queued its own meanwhile.
      if (this.queued === queued) this.queued = null
      return this.selection?.generation === selection.generation ? this.start(this.selection) : undefined
    })
    this.queued = queued
    return queued
  }

  private set(next: ScoreReadState<T>): void {
    this.current = next
    this.options.onChange(next)
  }

  private start(selection: Selection<T>): Promise<void> {
    const done = this.read(selection).finally(() => {
      if (this.inFlight?.done === done) this.inFlight = null
    })
    this.inFlight = { generation: selection.generation, done }
    return done
  }

  private async read(selection: Selection<T>): Promise<void> {
    // A loader that throws before returning a promise settles as an error rather than leaving the read loading.
    const outcome = await Promise.resolve()
      .then(() => selection.load())
      .then(
        (data) => ({ data, at: this.options.now() }),
        (error: unknown) => ({ error })
      )
    // An answer for a selection that is no longer current is dropped.
    if (selection.generation === this.generation) {
      this.set(settledState(this.current, selection.key, outcome))
    }
  }
}

/** One reader per view. Answers for a selection that is no longer current are dropped. */
export function createScoreReader<T>(options: ReaderOptions<T>): ScoreReader<T> {
  return new Reader(options)
}

// ---------------------------------------------------------------------------------------------------------------
// Edits beside a refreshing view

/**
 * A value a person edits while the view keeps refreshing. `base` is the saved value as last read; `edit` the person's
 * unsaved edit, wrapped so that any value, `null` included (clearing a budget), is an edit (`edit: null` means none);
 * `baseMoved` whether the saved value changed while the edit was open, which the view shows so the person decides,
 * instead of either value silently winning.
 */
export interface EditBuffer<T> {
  base: T
  edit: { value: T } | null
  baseMoved: boolean
}

export function editBuffer<T>(base: T): EditBuffer<T> {
  return { base, edit: null, baseMoved: false }
}

/** A refresh arrived: the saved value moves, an open edit stays, and a change under it is flagged. */
export function rebaseEdit<T>(buffer: EditBuffer<T>, incoming: T, same: (a: T, b: T) => boolean): EditBuffer<T> {
  if (buffer.edit === null) {
    return { base: incoming, edit: null, baseMoved: false }
  }
  return { base: incoming, edit: buffer.edit, baseMoved: buffer.baseMoved || !same(buffer.base, incoming) }
}

/** The edit was saved (the server's answer is the new saved value) or discarded (the saved value stays). */
export function settleEdit<T>(buffer: EditBuffer<T>, saved: T = buffer.base): EditBuffer<T> {
  return { base: saved, edit: null, baseMoved: false }
}
