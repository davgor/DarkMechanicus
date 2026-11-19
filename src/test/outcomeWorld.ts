/**
 * Real workspaces for the experiment outcome tests (DM-188, DM-191 measurement): every record is made by the real
 * services on an in-memory repository environment (`repoEnv.ts`), so run histories export and import between
 * machines. Each machine has its own database, clock, machine id and id range (records two machines create never share
 * an id); machines built on one memory file system share one checkout, as two clones that pull each other's commits.
 *   measuredEpic(): four sprints. Sprint 1 (tickets 1-3, medium) reports four experiments; their corrective work is
 *                   created in Sprint 2, saved and adopted; Sprint 2 delivers it; Sprint 3 (tickets 5-8, one handed
 *                   off without evidence) is measured and its sprint grade recorded as each experiment's result.
 *   completedEpic() / planFollowUp() / runFollowUp(): a one-sprint epic completed with one experiment, whose corrective
 *                   work goes into a follow-up epic that a run delivers and measures (on the same machine or another).
 *   dmSourceEpic() / requestCorrection() / workCorrection() / bringBack(): an experiment aimed at the Dark Mechanicus
 *                   source, its correction epic created in a target project (this very project, or another one) the
 *                   way the desktop broker does, worked there, and its grades brought back to the source.
 * Not shipped.
 */
import { DomainError } from '../core/errors'
import { encodeBase32, ID_PREFIXES, type IdGenerator } from '../core/ids'
import { META_KEYS, setMeta } from '../core/meta'
import { parseInput, sprintReportInput } from '../core/schemas'
import { adoptRevision } from '../core/services/adoption'
import { acceptAttempt, claimTicket, heartbeatAttempt } from '../core/services/attempts'
import { advanceSprint, approveCheckpoint } from '../core/services/checkpoints'
import { createCorrections } from '../core/services/corrections'
import { beginCrossRepoCorrection, crossRepoResults, materializeCrossRepoCorrection, recordCrossRepoDelivery, recordCrossRepoResults } from '../core/services/crossRepoCorrections'
import { updatePlanDraft } from '../core/services/drafts'
import { recordExperimentEvent } from '../core/services/experiments'
import { recordAttemptMetrics } from '../core/services/metricReports'
import { enqueueOutbox } from '../core/services/outbox'
import { requestSave } from '../core/services/plans'
import { submitSprintReport } from '../core/services/reports'
import { startRun } from '../core/services/runs'
import { getReportScorecard } from '../core/services/scorecards'
import type { SprintReportInput } from '../shared/domain/api'
import type { PlanBundle, TicketContent } from '../shared/domain/bundle'
import type { ExperimentEvent, ExperimentEventInput, RetroExperiment } from '../shared/domain/experiments'
import type { MetricReport } from '../shared/domain/metrics'
import type { ScorecardSnapshot } from '../shared/domain/spaceGrades'
import type { SprintReportView } from '../shared/domain/views'
import { makeBundle, makeTicket, sid, tid } from './bundles'
import { issued, startedRun, submitClaim } from './execution'
import type { MemoryFs } from './memoryFs'
import { createRepoEnv, flush, initProject, type RepoEnv } from './repoEnv'
import { createTestCtx, type TestCtx, withRole } from './testContext'

const MIN = 60_000
const T0 = '2026-11-15T09:00:00.000Z'
const MACHINE_A = 'mc_000000000000000000000000aa'
export const MACHINE_B = 'mc_000000000000000000000000bb'
const EPIC_OUTCOME = { summary: 'Done', successCriteria: [{ criterionId: 's1', met: true, note: 'ok' }] }

/** The error code and message an action throws (a domain error), or `ok`. */
export function outcomeOf(action: () => unknown): { code: string; message: string } {
  try {
    action()
    return { code: 'ok', message: '' }
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, message: error.message }
    throw error
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Machines

export interface Machine {
  env: RepoEnv
  ctx: TestCtx
  orchestrator: TestCtx
  reviewer: TestCtx
  worker: TestCtx
  desktop: TestCtx
  machineId: string
}

/** Sequential ids from `start` on: two machines given distant starts never mint the same id. */
function idsFrom(start: number): IdGenerator {
  let counter = start
  return {
    next(kind) {
      counter += 1
      return `${ID_PREFIXES[kind]}_${encodeBase32(BigInt(counter), 26)}`
    },
    secret() {
      counter += 1
      return `secret-${counter}`
    }
  }
}

interface MachineOptions {
  /** Another machine's file system: this machine works in the same checkout. */
  fs?: MemoryFs
  machineId?: string
  idStart?: number
  projectId?: string
  at?: string
}

/**
 * A machine with its own database, clock and id range, in an initialized checkout (its own, or `fs`'s); it knows its
 * machine id as a workspace records it.
 */
export function machine(options: MachineOptions = {}): Machine {
  const env = createRepoEnv(options.fs === undefined ? {} : { fs: options.fs })
  initProject(env)
  const machineId = options.machineId ?? MACHINE_A
  const ctx = createTestCtx({ db: env.db, clock: env.clock, machineId, ids: idsFrom(options.idStart ?? 0), ...(options.projectId === undefined ? {} : { projectId: options.projectId }) })
  ctx.clock.set(options.at ?? T0)
  setMeta(env.db, META_KEYS.machineId, machineId)
  return { env, ctx, machineId, orchestrator: withRole(ctx, 'orchestrator'), reviewer: withRole(ctx, 'reviewer'), worker: withRole(ctx, 'worker'), desktop: withRole(ctx, 'desktop') }
}

/** Queues the epic's seeded plan and state for export (a seeded revision is not exported by itself). */
function portable(m: Machine, epicId: string): void {
  const revisionId = m.ctx.db.get<{ current_revision_id: string }>('SELECT current_revision_id FROM epics WHERE id = ?', epicId)?.current_revision_id ?? ''
  enqueueOutbox(m.ctx, { kind: 'snapshot', epicId, revisionId })
  enqueueOutbox(m.ctx, { kind: 'epic_state', epicId })
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** Host-measured active time and tokens of an attempt, as `record_attempt_metrics` takes them. */
function metrics(attemptId: string, start: number, end: number, tokens: number): MetricReport[] {
  const actor = `omp:worker-${attemptId.slice(-6)}`
  return [
    {
      metric: 'active_ms',
      unit: 'milliseconds',
      source: { kind: 'host', actor },
      measurement: { state: 'observed', value: end - start },
      accumulation: 'delta',
      eventId: `span-${attemptId}`,
      observedAt: iso(end),
      attributes: { spanStart: iso(start), activeBasis: 'requests_and_tools' },
      usage: { coverage: 'self', parentActor: null }
    },
    {
      metric: 'tokens_total',
      unit: 'tokens',
      source: { kind: 'host', actor },
      measurement: { state: 'observed', value: tokens },
      accumulation: 'cumulative',
      sequence: 1,
      observedAt: iso(end),
      usage: { coverage: 'self', parentActor: null }
    }
  ]
}

/**
 * Claims a ticket, reports `minutes` of host-measured active time and `tokens`, hands it off and accepts it. With
 * `failedCheck` the handoff reports its criterion without evidence, so its handoff check fails (C.failed_checks).
 */
function deliver(m: Machine, runId: string, ticketId: string, work: { minutes: number; tokens: number; failedCheck?: boolean }): string {
  const claimed = issued(claimTicket(m.ctx, { runId, ticketId, worker: { label: 'worker-1' } }))
  const attemptId = claimed.attempt.id
  const start = m.ctx.clock.nowMs()
  for (let left = work.minutes; left > 0; left -= 10) {
    m.ctx.clock.advanceSeconds(Math.min(10, left) * 60)
    heartbeatAttempt(m.worker, { attemptId, claimToken: claimed.packet.claimToken })
  }
  recordAttemptMetrics(m.orchestrator, { attemptId, reports: metrics(attemptId, start, m.ctx.clock.nowMs(), work.tokens) })
  m.ctx.clock.advanceSeconds(60)
  submitClaim(m.worker, claimed, {
    outputs: { summary: 'done', artifacts: [], commits: ['a'.repeat(40)], changedFiles: [], branch: `ticket-${ticketId.slice(-4)}` },
    evidence: { checks: [{ name: 'typecheck', status: 'passed', detail: 'ok' }], criteria: [{ criterionId: 'c1', met: true, note: work.failedCheck === true ? '' : 'checked' }], notes: '' }
  })
  m.ctx.clock.advanceSeconds(60)
  acceptAttempt(m.reviewer, { attemptId, notes: 'reviewed', criteria: [{ criterionId: 'c1', met: true, note: 'checked' }] })
  m.ctx.clock.advanceSeconds(60)
  return attemptId
}

/** Submits a sprint report the way the command layer does (parsed with the submit_sprint_report schema). */
export function submit(m: Machine, runId: string, sprintId: string, report: unknown): SprintReportView {
  const parsed = parseInput(sprintReportInput, report, 'report') as SprintReportInput
  const view = submitSprintReport(m.orchestrator, { runId, sprintId, report: parsed })
  m.ctx.clock.advanceSeconds(60)
  return view
}

/** The person approves the sprint's report and the run advances. */
function approveAndAdvance(m: Machine, runId: string, reportId: string): void {
  approveCheckpoint(m.desktop, { runId, reportId })
  advanceSprint(m.orchestrator, { runId })
  m.ctx.clock.advanceSeconds(60)
}

/** The sealed scorecard a report froze. */
export function frozenSnapshot(ctx: TestCtx, reportId: string): ScorecardSnapshot {
  const read = getReportScorecard(ctx, { reportId })
  if (read.state !== 'frozen') throw new Error(`report ${reportId} froze no scorecard`)
  return read.scorecard.snapshot
}

/** Records an experiment event as the orchestrator of `m`. */
export function record(m: Machine, experimentId: string, event: ExperimentEventInput): ExperimentEvent {
  const stored = recordExperimentEvent(m.orchestrator, { experimentId, event })
  m.ctx.clock.advanceSeconds(60)
  return stored
}

/** A result read from a report's sprint grade. */
export function sprintResult(card: ScorecardSnapshot, unit: RetroExperiment['baseline']['unit'], detail: string): ExperimentEventInput {
  return { kind: 'result', result: { assessment: { reportId: card.report.reportId, assessmentId: card.sprint.assessmentId }, unit, evidence: [{ kind: 'run', id: card.runId, detail }] }, note: detail }
}

function experimentStem(runId: string, attemptId: string): Record<string, unknown> {
  return {
    source: { subject: { level: 'sprint', id: sid(1) } },
    concern: 'plan_context',
    issue: { summary: 'Sprint 1 spent 90,000 tokens and 70 minutes on three medium tickets.', evidence: [{ kind: 'run', id: runId }, { kind: 'attempt', id: attemptId, detail: 'largest attempt' }] },
    hypothesis: 'Hypothesis: workers re-read the importer sources on every ticket because the packet lacks their context.',
    destination: { kind: 'source_repository' },
    expectedChange: { direction: 'decrease', amount: 20, unit: 'percent' },
    window: { basis: 'sprints', count: 1 }
  }
}

const work = (title: string, body: string): { title: string; body: string; size: 'small' } => ({ title, body, size: 'small' })

/** A medium ticket budgeted at 30 minutes and 50,000 tokens (`size` overrides). */
const budgeted = (n: number, size: TicketContent['size'] = 'medium'): TicketContent =>
  makeTicket(n, { size, acceptanceCriteria: [{ id: 'c1', text: 'It works' }], budget: { activeMs: 30 * MIN, tokens: 50_000 } })

/** A started run of an epic whose sprints hold `sprints` (ticket numbers), each ticket medium unless `sizes` says. */
function startedEpic(m: Machine, sprints: number[][], sizes: Record<number, TicketContent['size']> = {}): { epicId: string; runId: string } {
  const bundle = makeBundle(sprints)
  const run = startedRun(m.ctx, { bundle: { ...bundle, tickets: sprints.flat().map((n) => budgeted(n, sizes[n])) } })
  m.ctx.clock.advanceSeconds(60)
  portable(m, run.epicId)
  return { epicId: run.epicId, runId: run.runId }
}

// ---------------------------------------------------------------------------------------------------------------
// One epic measuring its own corrective work

interface Experiments {
  /** K.actual_tokens -20%, guardrails C.failed_checks at most 0 and A.delivered at least 3. */
  quality: RetroExperiment
  /** K.actual_tokens -20%, guardrail A.delivered at least 3. */
  tokens: RetroExperiment
  /** T.actual_ms -20%, guardrail A.delivered at least 3. */
  time: RetroExperiment
  /** K.actual_tokens -20%, guardrail S.score at least 60 (never rated, so it cannot be read). */
  rated: RetroExperiment
}

export interface MeasuredEpic {
  m: Machine
  epicId: string
  runId: string
  xp: Experiments
  /** Sprint 1 to 3 reports and their frozen scorecards. */
  reports: [SprintReportView, SprintReportView, SprintReportView]
  cards: [ScorecardSnapshot, ScorecardSnapshot, ScorecardSnapshot]
  /** The corrective work tickets create_corrections made in Sprint 2, by experiment id. */
  corrective: Map<string, string[]>
  /** Each experiment's result read from Sprint 3's sprint grade, by experiment id. */
  results: Map<string, ExperimentEvent>
}

const DELIVERY = { measure: 'A.delivered', unit: 'count', comparator: 'at_least', threshold: 3 }

/**
 * Sprint 1: tickets 1-3 (20, 30, 20 minutes; 30,000, 40,000, 20,000 tokens), a report with four experiments drawn from
 * its sprint grade; create_corrections puts their work into Sprint 2, the person saves and adopts it, approves Sprint 1
 * and the run advances; statuses selected, scheduled, in_progress. Sprint 2: the corrective tickets (10 minutes, 8,000
 * tokens each) and ticket 4 (small), reported; every experiment completed. Sprint 3: tickets 5-8 (21,000 tokens per
 * ticket on average, ticket 6 handed off without evidence), reported; its sprint grade is each experiment's result.
 */
export function measuredEpic(m: Machine = machine()): MeasuredEpic {
  const { epicId, runId } = startedEpic(m, [[1, 2, 3], [4], [5, 6, 7, 8], [9, 10, 11]], { 4: 'small' })
  const { report: sprint1, xp } = sprintWithExperiments(m, runId)
  const all = Object.values(xp)
  const created = createCorrections(m.orchestrator, { reportId: sprint1.id, experimentIds: all.map((item) => item.id), target: { kind: 'sprint', sprintId: sid(2) }, fireguard: false })
  const save = requestSave(m.desktop, { epicId, expectedDraftRevision: created.draftRevision ?? 0 })
  flush(m.env)
  adoptRevision(m.desktop, { runId, revisionId: save.revisionId })
  approveAndAdvance(m, runId, sprint1.id)
  for (const experiment of all) {
    record(m, experiment.id, { kind: 'status', status: 'selected', note: 'Chosen at the Sprint 1 checkpoint' })
    record(m, experiment.id, { kind: 'status', status: 'scheduled', note: 'Planned in Sprint 2 by create_corrections' })
    record(m, experiment.id, { kind: 'status', status: 'in_progress' })
  }
  const corrective = new Map(all.map((experiment) => [experiment.id, created.tickets.filter((ticket) => ticket.role === 'work' && ticket.experimentId === experiment.id).map((ticket) => ticket.ticketId ?? '')]))
  for (const ticketId of [...corrective.values()].flat()) deliver(m, runId, ticketId, { minutes: 10, tokens: 8_000 })
  deliver(m, runId, tid(4), { minutes: 10, tokens: 9_000 })
  const sprint2 = submit(m, runId, sid(2), { summary: 'Sprint 2: the corrective work.', retro: { wentWell: ['Corrective work landed'] } })
  for (const experiment of all) record(m, experiment.id, { kind: 'status', status: 'completed' })
  approveAndAdvance(m, runId, sprint2.id)
  deliver(m, runId, tid(5), { minutes: 23, tokens: 21_000 })
  deliver(m, runId, tid(6), { minutes: 24, tokens: 20_000, failedCheck: true })
  deliver(m, runId, tid(7), { minutes: 22, tokens: 22_000 })
  deliver(m, runId, tid(8), { minutes: 25, tokens: 21_000 })
  const sprint3 = submit(m, runId, sid(3), { summary: 'Sprint 3: measured after the corrective work.', retro: { wentWell: ['Tickets 5-8 landed'] } })
  const cards: MeasuredEpic['cards'] = [frozenSnapshot(m.ctx, sprint1.id), frozenSnapshot(m.ctx, sprint2.id), frozenSnapshot(m.ctx, sprint3.id)]
  const results = new Map(all.map((experiment) => [experiment.id, record(m, experiment.id, sprintResult(cards[2], experiment.baseline.unit, 'Sprint 3 sprint grade'))]))
  enqueueOutbox(m.ctx, { kind: 'epic_state', epicId })
  return { m, epicId, runId, xp, reports: [sprint1, sprint2, sprint3], cards, corrective, results }
}

/** Sprint 1 delivered (20, 30, 20 minutes; 30,000, 40,000, 20,000 tokens) and reported with the four experiments. */
function sprintWithExperiments(m: Machine, runId: string): { report: SprintReportView; xp: Experiments } {
  const attempts = [deliver(m, runId, tid(1), { minutes: 20, tokens: 30_000 }), deliver(m, runId, tid(2), { minutes: 30, tokens: 40_000 }), deliver(m, runId, tid(3), { minutes: 20, tokens: 20_000 })]
  const stem = experimentStem(runId, attempts[1] ?? '')
  const inputs = [
    { ...stem, baseline: { measure: 'K.actual_tokens', unit: 'tokens' }, guardrails: [{ measure: 'C.failed_checks', unit: 'count', comparator: 'at_most', threshold: 0 }, DELIVERY], proposedWork: [work('Add importer context to the claim packet', 'List the importer record files and their schema modules in the claim packet context section for importer tickets.')] },
    { ...stem, baseline: { measure: 'K.actual_tokens', unit: 'tokens' }, guardrails: [DELIVERY], proposedWork: [work('Cache importer schema summaries for workers', 'Write docs/importer-schemas.md summarizing each portable record schema so workers read one page instead of the sources.')] },
    { ...stem, baseline: { measure: 'T.actual_ms', unit: 'milliseconds' }, guardrails: [DELIVERY], proposedWork: [work('Pre-build the importer fixtures', 'Check in the importer fixture repositories under src/test/fixtures so tickets stop rebuilding them for every test run.')] },
    { ...stem, baseline: { measure: 'K.actual_tokens', unit: 'tokens' }, guardrails: [{ measure: 'S.score', unit: 'points', comparator: 'at_least', threshold: 60 }], proposedWork: [work('Trim the reviewer packet for importer tickets', 'Drop the full plan bundle from reviewer packets of importer tickets and link the ticket references instead.')] }
  ]
  const report = submit(m, runId, sid(1), { summary: 'Sprint 1 with four experiments.', retro: { wentWell: ['Tickets 1-3 landed'], experiments: inputs } })
  const [quality, tokens, time, rated] = report.report.retro?.experiments ?? []
  if (quality === undefined || tokens === undefined || time === undefined || rated === undefined) throw new Error('the report stored fewer than four experiments')
  return { report, xp: { quality, tokens, time, rated } }
}

/** Sprint 4 after `measuredEpic`: tickets 9-11, about 20,000 tokens each, every handoff clean; the epic's last report. */
export function cleanSprint4(w: MeasuredEpic): { report: SprintReportView; card: ScorecardSnapshot } {
  approveAndAdvance(w.m, w.runId, w.reports[2].id)
  deliver(w.m, w.runId, tid(9), { minutes: 22, tokens: 20_000 })
  deliver(w.m, w.runId, tid(10), { minutes: 23, tokens: 21_000 })
  deliver(w.m, w.runId, tid(11), { minutes: 22, tokens: 19_000 })
  const report = submit(w.m, w.runId, sid(4), { summary: 'Sprint 4: a clean sprint.', retro: { wentWell: ['Tickets 9-11 landed'] }, epicOutcome: EPIC_OUTCOME })
  return { report, card: frozenSnapshot(w.m.ctx, report.id) }
}

// ---------------------------------------------------------------------------------------------------------------
// A completed epic whose corrective work goes into a follow-up epic

export interface CompletedEpic {
  epicId: string
  runId: string
  report: SprintReportView
  experiment: RetroExperiment
}

const SPECIFIC_WORK = [
  { title: 'Add an importer context note to the planner skill', body: "Add one paragraph to skills/planner.md naming the importer's record files and where their schemas live.", size: 'small' },
  { title: 'Re-budget importer tickets from measured time', body: 'Set the planned active time of importer tickets to the measured median of Sprint 1 and record that source in the plan rationale.', size: 'small' }
]

/** One experiment of a one-sprint report: T.actual_ms -20% with delivery and regression guardrails, over the next sprint. */
function timeExperiment(runId: string, attemptId: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...experimentStem(runId, attemptId),
    issue: { summary: 'Sprint 1 took 70 minutes of active time across three medium tickets.', evidence: [{ kind: 'run', id: runId }, { kind: 'attempt', id: attemptId, detail: 'longest attempt' }] },
    hypothesis: 'Hypothesis: the tickets were sized without the importer context, so workers re-read it each time.',
    proposedWork: SPECIFIC_WORK,
    baseline: { measure: 'T.actual_ms', unit: 'milliseconds' },
    guardrails: [DELIVERY, { measure: 'P.regressions', unit: 'count', comparator: 'at_most', threshold: 0 }],
    ...patch
  }
}

/** Sprint 1 (tickets 1-3: 20, 30, 20 minutes) delivered and reported with one experiment, approved and advanced: the epic is completed. */
export function completedEpic(m: Machine, first = 1): CompletedEpic {
  const [one, two, three] = [first, first + 1, first + 2]
  const { epicId, runId } = startedEpic(m, [[one, two, three]])
  const attempts = [deliver(m, runId, tid(one), { minutes: 20, tokens: 30_000 }), deliver(m, runId, tid(two), { minutes: 30, tokens: 40_000 }), deliver(m, runId, tid(three), { minutes: 20, tokens: 20_000 })]
  const report = submit(m, runId, sid(1), { summary: 'Sprint 1 with one experiment.', retro: { wentWell: ['Tickets 1-3 landed'], experiments: [timeExperiment(runId, attempts[1] ?? '')] }, epicOutcome: EPIC_OUTCOME })
  approveAndAdvance(m, runId, report.id)
  const experiment = report.report.retro?.experiments?.[0]
  if (experiment === undefined) throw new Error('the report stored no experiment')
  return { epicId, runId, report, experiment }
}

export interface FollowUpPlan {
  epicId: string
  correctiveIds: string[]
  measuredIds: string[]
  /** Sprint 1 (the corrective work) and Sprint 2 (three medium tickets measured after it). */
  sprintIds: [string, string]
  revisionId: string
}

function draftOf(ctx: TestCtx, epicId: string): { revision: number; bundle: PlanBundle } {
  const row = ctx.db.get<{ draft_revision: number; bundle_json: string }>('SELECT draft_revision, bundle_json FROM drafts WHERE epic_id = ?', epicId)
  if (row === undefined) throw new Error(`epic ${epicId} has no draft`)
  return { revision: row.draft_revision, bundle: JSON.parse(row.bundle_json) as PlanBundle }
}

/** Measured tickets of a correction epic's Sprint 2, sized and budgeted like the source's so the scopes compare. */
function measuredOps(): { op: 'add_sprint' | 'add_ticket'; [key: string]: unknown }[] {
  const ticket = (n: number): { op: 'add_ticket'; [key: string]: unknown } => ({
    op: 'add_ticket',
    ref: `m${n}`,
    sprint: 's2',
    ticket: { title: `Importer change ${n}`, body: `Ship importer change ${n} with its tests.`, size: 'medium', acceptanceCriteria: ['It works'], budget: { activeMs: 30 * MIN, tokens: 50_000 } }
  })
  return [{ op: 'add_sprint', ref: 's2', sprint: { goal: 'Importer changes, measured after the corrective work' } }, ticket(1), ticket(2), ticket(3)]
}

/**
 * Adds Sprint 2 (three measured tickets) to a correction epic's draft, drops its acceptance nodes (the in-memory
 * checkout verifies no Git increment), saves it and exports it.
 */
function planMeasured(m: Machine, epicId: string): Omit<FollowUpPlan, 'epicId' | 'correctiveIds'> {
  const { ctx } = m
  const added = updatePlanDraft(m.orchestrator, { epicId, expectedDraftRevision: draftOf(ctx, epicId).revision, ops: measuredOps() as never })
  const nodes = draftOf(ctx, epicId).bundle.tickets.filter((ticket) => ticket.kind === 'acceptance').map((ticket) => ({ op: 'remove_ticket' as const, ticket: ticket.id }))
  const trimmed = updatePlanDraft(m.orchestrator, { epicId, expectedDraftRevision: added.draftRevision, ops: nodes })
  const save = requestSave(m.desktop, { epicId, expectedDraftRevision: trimmed.draftRevision })
  flush(m.env)
  const bundle = JSON.parse(ctx.db.get<{ bundle_json: string }>('SELECT bundle_json FROM plan_revisions WHERE id = ?', save.revisionId)?.bundle_json ?? '{}') as PlanBundle
  const [sprint1, sprint2] = [...bundle.sprints].sort((a, b) => a.ordinal - b.ordinal)
  return { measuredIds: ['m1', 'm2', 'm3'].map((ref) => added.refMap[ref] ?? ''), sprintIds: [sprint1?.id ?? '', sprint2?.id ?? ''], revisionId: save.revisionId }
}

/** create_corrections makes the follow-up epic of a completed epic; Sprint 2 is added and the plan saved and exported. */
export function planFollowUp(m: Machine, source: CompletedEpic): FollowUpPlan {
  const created = createCorrections(m.orchestrator, { reportId: source.report.id, experimentIds: [source.experiment.id], fireguard: false })
  const epicId = created.target.epicId ?? ''
  const correctiveIds = created.tickets.filter((ticket) => ticket.role === 'work').map((ticket) => ticket.ticketId ?? '')
  const measured = planMeasured(m, epicId)
  return { epicId, correctiveIds, ...measured }
}

export interface CorrectionRun {
  runId: string
  /** Sprint 1 (the corrective work) and Sprint 2 (measured after it) reports and their frozen scorecards. */
  reports: [SprintReportView, SprintReportView]
  cards: [ScorecardSnapshot, ScorecardSnapshot]
}

/** A run of a saved correction epic: the corrective tickets accepted (10 minutes each), Sprint 2's tickets at `minutes` each. */
export function runCorrection(m: Machine, plan: Pick<FollowUpPlan, 'epicId' | 'correctiveIds' | 'measuredIds' | 'sprintIds'>, minutes: number): CorrectionRun {
  const run = startRun(m.orchestrator, { epicId: plan.epicId })
  for (const ticketId of plan.correctiveIds) deliver(m, run.id, ticketId, { minutes: 10, tokens: 8_000 })
  const report1 = submit(m, run.id, plan.sprintIds[0], { summary: 'The corrective work.', retro: { wentWell: ['Corrective work landed'] } })
  approveAndAdvance(m, run.id, report1.id)
  for (const ticketId of plan.measuredIds) deliver(m, run.id, ticketId, { minutes, tokens: 20_000 })
  const report2 = submit(m, run.id, plan.sprintIds[1], { summary: 'Measured after the corrective work.', retro: { wentWell: ['Importer changes landed'] }, epicOutcome: EPIC_OUTCOME })
  return { runId: run.id, reports: [report1, report2], cards: [frozenSnapshot(m.ctx, report1.id), frozenSnapshot(m.ctx, report2.id)] }
}

// ---------------------------------------------------------------------------------------------------------------
// Corrections in the Dark Mechanicus source (cross-repository)

/** An unfinished epic (Sprint 2 still to run) whose Sprint 1 report holds one experiment (`patch` over the time experiment). */
function reportedEpic(m: Machine, patch: Record<string, unknown>): CompletedEpic {
  const { epicId, runId } = startedEpic(m, [[1, 2, 3], [4]])
  const attempts = [deliver(m, runId, tid(1), { minutes: 20, tokens: 30_000 }), deliver(m, runId, tid(2), { minutes: 30, tokens: 40_000 }), deliver(m, runId, tid(3), { minutes: 20, tokens: 20_000 })]
  const report = submit(m, runId, sid(1), { summary: 'Sprint 1 with an experiment.', retro: { wentWell: ['Tickets 1-3 landed'], experiments: [timeExperiment(runId, attempts[1] ?? '', patch)] } })
  const experiment = report.report.retro?.experiments?.[0]
  if (experiment === undefined) throw new Error('the report stored no experiment')
  return { epicId, runId, report, experiment }
}

/** An unfinished epic whose Sprint 1 report holds one experiment aimed at this repository. */
export function unfinishedEpic(m: Machine): CompletedEpic {
  return reportedEpic(m, {})
}

/** An unfinished epic whose Sprint 1 report holds one experiment aimed at the Dark Mechanicus source. */
export function dmSourceEpic(m: Machine): CompletedEpic {
  return reportedEpic(m, {
    concern: 'orchestration_tooling',
    destination: { kind: 'darkmechanicus_source' },
    proposedWork: [{ title: 'Put the importer context into the claim packet', body: 'Add the importer record files and their schema locations to the context section of every claim packet that names src/core/repo/importer.ts.', size: 'small' }]
  })
}

interface Requested {
  key: string
  epicId: string
}

/** The desktop broker's delivery: the receipt in the source, the correction epic created in the target, the link recorded. */
export function requestCorrection(source: Machine, target: Machine, of: CompletedEpic): Requested {
  const begun = beginCrossRepoCorrection(source.desktop, { reportId: of.report.id, experimentId: of.experiment.id, expectedTargetProjectId: target.ctx.projectId, fireguard: false }, { projectId: target.ctx.projectId })
  const view = materializeCrossRepoCorrection(target.desktop, begun.packet, { expected: null, closed: begun.closed })
  recordCrossRepoDelivery(source.desktop, begun.link.key, view, begun.unsaved)
  source.ctx.clock.advanceSeconds(60)
  return { key: begun.link.key, epicId: view.epicId }
}

/** A correction epic's draft planned in the target: Sprint 2 added, saved and exported (nothing run yet). */
export function planCorrection(target: Machine, epicId: string): FollowUpPlan {
  const correctiveIds = draftOf(target.ctx, epicId).bundle.tickets.filter((ticket) => ticket.kind !== 'acceptance').map((ticket) => ticket.id)
  return { epicId, correctiveIds, ...planMeasured(target, epicId) }
}

/** The correction epic worked in the target: Sprint 2 added, saved, run; the corrective tickets accepted; both sprints reported. */
export function workCorrection(target: Machine, epicId: string, minutes: number): CorrectionRun & FollowUpPlan {
  const plan = planCorrection(target, epicId)
  return { ...plan, ...runCorrection(target, plan, minutes) }
}

/** The desktop broker's collect: what the target epic holds, read there and kept on the source's receipt. */
export function bringBack(source: Machine, target: Machine, requested: Requested, experimentId: string): void {
  const read = crossRepoResults(target.ctx, { key: requested.key, epicId: requested.epicId, experimentId })
  recordCrossRepoResults(source.desktop, requested.key, { ...read, readAt: source.ctx.clock.nowIso() })
  source.ctx.clock.advanceSeconds(60)
}
