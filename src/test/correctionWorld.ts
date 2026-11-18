/**
 * Worlds for tests of same-repository corrective work (`core/services/corrections.ts`, DM-186/DM-187). Not shipped.
 *
 * A started run whose sprint 1 tickets 1-3 are claimed, measured, submitted and accepted through the real services, in a
 * repository environment (so the person's Save exports and adopts like the app), then reported with experiments drawn
 * from the scorecard the report freezes (`src/core/plan/fixtures/experiments/experiment-cases.json`, read in place).
 *
 * - `unfinished`: the epic is in progress (sprint 1's acceptance node is not accepted); its report carries four
 *   experiments: `ready` (two sized, specific items), `vague` (one unsized item), `dm` (aimed at the Dark Mechanicus
 *   source) and `later` (one sized, specific item).
 * - `completed`: a one-sprint epic without an acceptance node, reported with `count` ready experiments, approved by the
 *   person and advanced, so it is completed.
 *
 * The clock and ids are fixed, so every world is the same and nothing is shared between worlds.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../core/db/database'
import { DomainError } from '../core/errors'
import { acceptAttempt, heartbeatAttempt } from '../core/services/attempts'
import { advanceSprint, approveCheckpoint } from '../core/services/checkpoints'
import { recordAttemptMetrics } from '../core/services/metricReports'
import { enqueueOutbox } from '../core/services/outbox'
import { submitSprintReport } from '../core/services/reports'
import { parseInput, sprintReportInput } from '../core/schemas'
import type { SprintReportInput } from '../shared/domain/api'
import type { PlanBundle, TicketContent } from '../shared/domain/bundle'
import type { RetroExperiment } from '../shared/domain/experiments'
import type { MetricReport } from '../shared/domain/metrics'
import type { SprintReportView } from '../shared/domain/views'
import { makeBundle, makeTicket, sid, tid } from './bundles'
import { claim, startedRun, submitClaim } from './execution'
import { createRepoEnv, initProject, type RepoEnv } from './repoEnv'
import { createTestCtx, type TestCtx, withRole } from './testContext'

const MIN = 60_000
const T0 = '2026-11-15T09:00:00.000Z'
const FIXTURES = join(__dirname, '..', 'core', 'plan', 'fixtures', 'experiments')

export interface CorrectionWorld {
  env: RepoEnv
  ctx: TestCtx
  orchestrator: TestCtx
  reviewer: TestCtx
  worker: TestCtx
  desktop: TestCtx
  epicId: string
  runId: string
  sprintId: string
}

/** Sprint 1: work tickets 1-3 and, unless `acceptanceNode` is false, its acceptance node 4; the run is started. */
function world(acceptanceNode: boolean): CorrectionWorld {
  const env = createRepoEnv()
  const ctx = createTestCtx({ db: env.db, clock: env.clock })
  ctx.clock.set(T0)
  const base = makeBundle([acceptanceNode ? [1, 2, 3, 4] : [1, 2, 3]])
  const ticket = (n: number): TicketContent =>
    n === 4
      ? makeTicket(4, { kind: 'acceptance', title: 'Sprint 1 acceptance', size: 'medium', acceptanceCriteria: [{ id: 'c1', text: 'The sprint works end to end' }] })
      : makeTicket(n, { size: 'medium', acceptanceCriteria: [{ id: 'c1', text: 'It works' }], budget: { activeMs: 30 * MIN, tokens: 50_000 } })
  const run = startedRun(ctx, { bundle: { ...base, tickets: base.tickets.map((_, index) => ticket(index + 1)) } })
  ctx.clock.advanceSeconds(60)
  return {
    env,
    ctx,
    orchestrator: withRole(ctx, 'orchestrator'),
    reviewer: withRole(ctx, 'reviewer'),
    worker: withRole(ctx, 'worker'),
    desktop: withRole(ctx, 'desktop'),
    epicId: run.epicId,
    runId: run.runId,
    sprintId: sid(1)
  }
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** Claims ticket `n`, reports `minutes` of host-measured active time and `tokens`, submits and accepts it. */
function deliver(w: CorrectionWorld, n: number, minutes: number, tokens: number): string {
  const claimed = claim(w.ctx, w.runId, n)
  const attemptId = claimed.attempt.id
  const start = w.ctx.clock.nowMs()
  for (let left = minutes; left > 0; left -= 10) {
    w.ctx.clock.advanceSeconds(Math.min(10, left) * 60)
    heartbeatAttempt(w.worker, { attemptId, claimToken: claimed.packet.claimToken })
  }
  const actor = `omp:worker-${attemptId.slice(-6)}`
  const end = w.ctx.clock.nowMs()
  const reports: MetricReport[] = [
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
  recordAttemptMetrics(w.orchestrator, { attemptId, reports })
  w.ctx.clock.advanceSeconds(60)
  submitClaim(w.worker, claimed, {
    outputs: { summary: 'done', artifacts: [], commits: ['a'.repeat(40)], changedFiles: [], branch: `ticket-${n}` },
    evidence: { checks: [{ name: 'typecheck', status: 'passed', detail: 'ok' }], criteria: [{ criterionId: 'c1', met: true, note: 'checked' }], notes: '' }
  })
  w.ctx.clock.advanceSeconds(60)
  acceptAttempt(w.reviewer, { attemptId, notes: 'reviewed', criteria: [{ criterionId: 'c1', met: true, note: 'checked' }] })
  w.ctx.clock.advanceSeconds(60)
  return attemptId
}

/** Submits a report revision for sprint 1 as the command layer does (the `submit_sprint_report` schema first). */
function submit(w: CorrectionWorld, report: unknown): SprintReportView {
  const parsed = parseInput(sprintReportInput, report, 'report') as SprintReportInput
  const view = submitSprintReport(w.orchestrator, { runId: w.runId, sprintId: w.sprintId, report: parsed })
  w.ctx.clock.advanceSeconds(60)
  return view
}

/** Sprint 1 delivered (tickets 1-3 accepted) and the repository exportable, so the person's Save works. */
function delivered(acceptanceNode: boolean): CorrectionWorld & { attempt1: string } {
  const w = world(acceptanceNode)
  const attempt1 = deliver(w, 1, 20, 30_000)
  deliver(w, 2, 30, 40_000)
  deliver(w, 3, 20, 20_000)
  initProject(w.env)
  const revisionId = w.ctx.db.get<{ revision_id: string }>('SELECT revision_id FROM runs WHERE id = ?', w.runId)?.revision_id ?? ''
  enqueueOutbox(w.ctx, { kind: 'snapshot', epicId: w.epicId, revisionId })
  enqueueOutbox(w.ctx, { kind: 'epic_state', epicId: w.epicId })
  return { ...w, attempt1 }
}

type ExperimentInput = Record<string, unknown>

/** The fixture's complete experiment (drawn from the report's own sprint grade), with `patch` over it. */
function experimentInput(w: CorrectionWorld & { attempt1: string }, patch: ExperimentInput = {}): ExperimentInput {
  const values: Record<string, string> = { sprintId: w.sprintId, runId: w.runId, ticket1: tid(1), attempt1: w.attempt1 }
  const text = readFileSync(join(FIXTURES, 'experiment-cases.json'), 'utf8').replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
  const { valid } = JSON.parse(text) as { valid: ExperimentInput }
  return { ...valid, ...patch }
}

/** Sized, specific work items. */
export const SPECIFIC_WORK = [
  { title: 'Add an importer context note to the planner skill', body: "Add one paragraph to skills/planner.md naming the importer's record files and where their schemas live.", size: 'small' },
  { title: 'Re-budget importer tickets from measured time', body: 'Set the planned active time of importer tickets to the measured median of Sprint 1 and record that source in the plan rationale.', size: 'small' },
  { title: 'Write the importer review checklist', body: 'Add docs/review-importer.md listing the five checks a reviewer runs on importer changes, with the commands for each.', size: 'micro' }
] as const

export interface Unfinished extends CorrectionWorld {
  report: SprintReportView
  xp: { ready: RetroExperiment; vague: RetroExperiment; dm: RetroExperiment; later: RetroExperiment }
}

/** An epic in progress: sprint 1 delivered except its acceptance node; its report carries four experiments. */
export function unfinished(): Unfinished {
  const w = delivered(true)
  const inputs = [
    experimentInput(w, { proposedWork: [SPECIFIC_WORK[0], SPECIFIC_WORK[1]] }),
    experimentInput(w, { hypothesis: 'Hypothesis: the budgets were guessed.', proposedWork: [{ title: 'Fix the budgets', body: 'x'.repeat(40) }] }),
    experimentInput(w, { hypothesis: 'Hypothesis: the claim packet lacks the importer context.', destination: { kind: 'darkmechanicus_source' }, proposedWork: [SPECIFIC_WORK[0]] }),
    experimentInput(w, { hypothesis: 'Hypothesis: reviews wait on a missing checklist.', proposedWork: [SPECIFIC_WORK[2]] })
  ]
  const report = submit(w, { summary: 'Sprint 1 with four experiments.', retro: { wentWell: ['Tickets 1-3 landed'], experiments: inputs } })
  const [ready, vague, dm, later] = report.report.retro?.experiments ?? []
  if (ready === undefined || vague === undefined || dm === undefined || later === undefined) throw new Error('the report stored fewer than four experiments')
  return { ...w, report, xp: { ready, vague, dm, later } }
}

interface Completed extends CorrectionWorld {
  report: SprintReportView
  /** The ids of its two ready experiments: x1 asks for two work items, x2 for one. */
  x1: string
  x2: string
}

/** A completed one-sprint epic whose report carries two ready experiments, approved by the person and advanced. */
export function completed(): Completed {
  const w = delivered(false)
  const inputs = [
    experimentInput(w, { hypothesis: 'Hypothesis 1: the planner lacks the importer context.', proposedWork: [SPECIFIC_WORK[0], SPECIFIC_WORK[1]] }),
    experimentInput(w, { hypothesis: 'Hypothesis 2: reviews wait on a missing checklist.', proposedWork: [SPECIFIC_WORK[2]] })
  ]
  const report = submit(w, {
    summary: 'Sprint 1 with two experiments.',
    retro: { wentWell: ['Tickets 1-3 landed'], experiments: inputs },
    epicOutcome: { summary: 'Done', successCriteria: [{ criterionId: 's1', met: true, note: 'ok' }] }
  })
  approveCheckpoint(w.desktop, { runId: w.runId, reportId: report.id })
  advanceSprint(w.orchestrator, { runId: w.runId })
  const [x1, x2] = report.report.retro?.experiments ?? []
  if (x1 === undefined || x2 === undefined) throw new Error('the report stored fewer than two experiments')
  return { ...w, report, x1: x1.id, x2: x2.id }
}

/** The source epic's row, saved revisions, runs, reports with their scorecards, attempts and checkpoint events, as stored. */
export function sourceRecords(w: CorrectionWorld): string {
  const db = w.ctx.db
  return JSON.stringify({
    epic: db.get('SELECT status, revision, current_revision_id, title, provenance_json, outcome_json, completed_at FROM epics WHERE id = ?', w.epicId),
    revisions: db.all('SELECT id, number, state, content_hash, bundle_json FROM plan_revisions WHERE epic_id = ? ORDER BY number', w.epicId),
    runs: db.all('SELECT id, state, revision_id, active_sprint_id, auto_continue, revision FROM runs WHERE epic_id = ? ORDER BY number', w.epicId),
    reports: db.all('SELECT r.id, r.content_hash, r.content_json, r.scorecard_json FROM sprint_reports r JOIN runs ON runs.id = r.run_id WHERE runs.epic_id = ? ORDER BY r.report_revision', w.epicId),
    attempts: db.all('SELECT a.id, a.state, a.superseded_at FROM attempts a JOIN runs ON runs.id = a.run_id WHERE runs.epic_id = ? ORDER BY a.id', w.epicId),
    checkpoints: db.all("SELECT * FROM events WHERE epic_id = ? AND kind LIKE 'checkpoint.%' ORDER BY seq", w.epicId)
  })
}

/** An epic's open draft as stored, or null. */
export function draftOf(db: Db, epicId: string): { revision: number; bundle: PlanBundle } | null {
  const row = db.get<{ draft_revision: number; bundle_json: string }>('SELECT draft_revision, bundle_json FROM drafts WHERE epic_id = ?', epicId)
  return row === undefined ? null : { revision: row.draft_revision, bundle: JSON.parse(row.bundle_json) as PlanBundle }
}

/** The domain error code and message an action throws, or `ok`. */
export function outcome(action: () => unknown): { code: string; message: string } {
  try {
    action()
    return { code: 'ok', message: '' }
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, message: error.message }
    throw error
  }
}
