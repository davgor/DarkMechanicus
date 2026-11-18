/**
 * P inputs from stored records: a ticket's verification in a run (its attempts, their review decisions and evidence,
 * the criteria and retry limit of the plan revision each ran under, the Definition of Done frozen on an acceptance
 * node's decision, and the lifecycle times of failures, cancellations, lease expiries and retry grants) and the
 * escaped defects of its epic from the observation ledger, both as of a cutoff. Read-only: nothing here writes, so
 * building an input never touches an attempt, a report or the epic's history.
 *
 * Every time read is written once (row columns set once, the append-only event log, ledger `recordedAt`), and nothing
 * current (the Definition of Done in the project file, the execution state, a row's `updated_at`) is read, so the
 * same cutoff gives the same input. A failure recorded on another machine has no local log entry and falls back to
 * its row's last update.
 *
 * Escaped defects are recorded like any observation (`recordObservations`), under the defect vocabulary that
 * `src/core/space/defects.ts` enforces. The pure models are `src/core/space/defects.ts` and
 * `src/core/space/verification.ts`; types are in `src/shared/domain/performance.ts`.
 */
import type { EscapedDefectsView, PerformanceAssessmentInput } from '../../shared/domain/performance'
import type { PlanBundle } from '../../shared/domain/bundle'
import { SIGNED_OUT_PAUSE_REASON } from '../../shared/domain/status'
import type { AttemptDecision, AttemptEvidence } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { parseJson } from '../db/database'
import { fail } from '../errors'
import { resolveDefects } from '../space/defects'
import { ticketPerformance, type VerificationAttempt } from '../space/verification'
import { type EventRow, toEventView } from './events'
import { type AttemptRow, loadBundle, loadRunContext, type RunRow, ticketOf } from './execution'
import { listObservations } from './observations'

/** The cutoff a read uses: the given time in UTC (default now), never later than now. */
export function cutoffOf(ctx: Ctx, cutoff: string | undefined): string {
  const now = ctx.clock.nowIso()
  if (cutoff === undefined) {
    return now
  }
  const ms = Date.parse(cutoff)
  if (!Number.isFinite(ms)) {
    fail('invalid_input', `The cutoff ${cutoff} is not a time.`, { cutoff })
  }
  return ms > Date.parse(now) ? now : new Date(ms).toISOString()
}

/** The escaped defects of an epic's ledger as of `cutoff`, with their reports, fixes and withdrawals. */
export function getEscapedDefects(ctx: Ctx, input: { epicId: string; cutoff?: string }): EscapedDefectsView {
  requireCapability(ctx.session, 'read')
  if (ctx.db.get('SELECT id FROM epics WHERE id = ?', input.epicId) === undefined) {
    fail('not_found', `Epic ${input.epicId} not found.`, { epicId: input.epicId })
  }
  return resolveDefects(listObservations(ctx.db, { epicId: input.epicId, metric: 'escaped_defect' }), cutoffOf(ctx, input.cutoff))
}

interface LoggedEvent {
  at: string
  kind: string
  ticketId: string | null
  payload: Record<string, unknown>
}

const LIFECYCLE_EVENTS = ['attempt.failed', 'attempt.lease_expired', 'run.canceled', 'run.failed', 'run.taken_over', 'ticket.retry_granted']

function lifecycleLog(ctx: Ctx, runId: string): LoggedEvent[] {
  const rows = ctx.db.all<EventRow>(
    `SELECT * FROM events WHERE run_id = ? AND kind IN (${LIFECYCLE_EVENTS.map(() => '?').join(', ')}) ORDER BY seq`,
    runId,
    ...LIFECYCLE_EVENTS
  )
  return rows.map(toEventView).map(({ at, kind, ticketId, payload }) => ({ at, kind, ticketId, payload }))
}

/** Whether the event lists `attemptId` under `key` (`canceledAttempts`, `expiredAttempts`). */
function lists(event: LoggedEvent, key: string, attemptId: string): boolean {
  const value = event.payload[key]
  return Array.isArray(value) && value.includes(attemptId)
}

interface EndSources {
  row: AttemptRow
  run: RunRow
  log: readonly LoggedEvent[]
}

/** A lease's deadline, or the takeover that expired it if earlier (the logged deadline first, else the row's). */
function leaseEnd({ row, log }: EndSources): string {
  const logged = log.find((event) => event.kind === 'attempt.lease_expired' && event.payload.attemptId === row.id)
  const deadline = typeof logged?.payload.leaseExpiresAt === 'string' ? logged.payload.leaseExpiresAt : row.lease_expires_at
  const takeover = log.find((event) => event.kind === 'run.taken_over' && lists(event, 'expiredAttempts', row.id))?.at ?? null
  const times = [deadline, takeover].filter((time): time is string => time !== null).sort()
  return times[0] ?? logged?.at ?? row.heartbeat_at ?? row.created_at
}

/**
 * A held attempt's lease deadline: it expires then whether or not a read has settled the lease yet, so a read before
 * the lazy settle and one after it agree. A run paused for sign-in keeps its leases (`expireLeases` skips it), so
 * there is none while it is.
 */
function heldUntil({ row, run }: EndSources): string | null {
  return run.state === 'paused' && run.pause_reason === SIGNED_OUT_PAUSE_REASON ? null : row.lease_expires_at
}

/**
 * When a failed, canceled or expired attempt ended, from records written once: a failure's logged time; a cancel's
 * logged run end (else the run's `ended_at`); a lease's end. Only a failure or cancel with no log entry and no run end
 * (recorded on another machine) falls back to the row's last update. A held attempt ends at its lease deadline.
 */
const ENDED_AT: Partial<Record<AttemptRow['state'], (sources: EndSources) => string | null>> = {
  failed: ({ row, log }) => log.find((event) => event.kind === 'attempt.failed' && event.payload.attemptId === row.id)?.at ?? row.updated_at,
  canceled: ({ row, run, log }) =>
    log.find((event) => (event.kind === 'run.canceled' || event.kind === 'run.failed') && lists(event, 'canceledAttempts', row.id))?.at ?? run.ended_at ?? row.updated_at,
  lease_expired: leaseEnd,
  claimed: heldUntil,
  running: heldUntil
}

/**
 * The time of each retry grant for the ticket in the run: the logged ones, plus null for any grant the table counts
 * beyond them (the table and the log are written in one transaction, so only a lost log entry leaves a grant untimed;
 * it then counts at every cutoff). Both are this machine's own: no grant arrives from another machine.
 */
function retryGrantTimes(ctx: Ctx, runId: string, ticketId: string, log: readonly LoggedEvent[]): (string | null)[] {
  const logged = log.filter((event) => event.kind === 'ticket.retry_granted' && event.ticketId === ticketId).map((event) => event.at)
  const total = ctx.db.get<{ extra: number }>('SELECT extra FROM retry_grants WHERE run_id = ? AND ticket_id = ?', runId, ticketId)?.extra ?? 0
  return [...Array.from({ length: Math.max(0, total - logged.length) }, () => null), ...logged]
}

/**
 * Whether every retry grant of the ticket is known here at the cutoff: this machine owns the run, or the run had
 * ended by then failed by the plan's `fail_run` on this very ticket (`ticket_failed:<key>`), which the owner does only
 * once its readiness, grants included, finds the ticket out of tries (an ended run takes no grant). A `pause_run`
 * pause keeps that reason after a later grant, so only the terminal failure proves it. Ownership is the closest
 * signal, not a proof: a taken-over run's earlier grants stay on the machine that made them.
 */
function grantsKnownFor(ctx: Ctx, { run, bundle }: { run: RunRow; bundle: PlanBundle }, ticketId: string, cutoff: string): boolean {
  if (run.owner_machine_id === ctx.machineId) return true
  const failedByCutoff = run.state === 'failed' && run.ended_at !== null && run.ended_at <= cutoff
  const key = bundle.tickets.find((ticket) => ticket.id === ticketId)?.key
  return failedByCutoff && key !== undefined && run.pause_reason === `ticket_failed:${key}`
}

/** Which of a ticket's attempts a performance read counts (default: all of them in the run). */
export type AttemptFilter = (row: AttemptRow, bundle: PlanBundle) => boolean

/**
 * A narrower read of a ticket's attempts: only those `holds` keeps (a sprint grade reads the attempts the ticket ran
 * while that sprint held it). For a ticket an adoption has moved out of that sprint, `movedOut` reads those attempts as
 * they ended there: the supersession the move recorded does not undo them, and only the retry grants logged by
 * `grantsUntil` count (later tries were granted for elsewhere), so the failure it had stays with the sprint.
 */
interface AttemptScope {
  holds: AttemptFilter
  movedOut?: { grantsUntil: string }
}

/** The P input of one ticket of the reader's run at its cutoff. */
export type PerformanceReader = (ticketId: string, scope?: AttemptScope) => PerformanceAssessmentInput

/**
 * The P input of tickets of one run at one cutoff, with the run, its plans, its lifecycle log and the epic's escaped
 * defects loaded once for every ticket read through it.
 */
export function ticketPerformanceReader(ctx: Ctx, runId: string, cutoff: string): PerformanceReader {
  const context = loadRunContext(ctx, runId)
  const { run } = context
  const bundles = new Map<string, PlanBundle>([[run.revision_id, context.bundle]])
  const bundleOf = (revisionId: string): PlanBundle => {
    const bundle = bundles.get(revisionId) ?? loadBundle(ctx, revisionId)
    bundles.set(revisionId, bundle)
    return bundle
  }
  const log = lifecycleLog(ctx, run.id)
  const defects = resolveDefects(listObservations(ctx.db, { epicId: run.epic_id, metric: 'escaped_defect' }), cutoff).defects
  const runEnded = run.ended_at === null ? null : { at: run.ended_at, state: run.state }
  return (ticketId, scope) => {
    const rows = context.attempts
      .filter((row) => row.ticket_id === ticketId && (scope === undefined || scope.holds(row, bundleOf(row.revision_id))))
      .sort((a, b) => a.number - b.number)
    if (rows.length === 0) {
      // Without an attempt the ticket must at least be in the run's plan.
      ticketOf(context.bundle, ticketId)
    }
    const attempts = rows.map((row): VerificationAttempt => {
      const bundle = bundleOf(row.revision_id)
      return {
        attemptId: row.id,
        number: row.number,
        kind: row.kind,
        state: row.state,
        createdAt: row.created_at,
        submittedAt: row.submitted_at,
        decidedAt: row.decided_at,
        supersededAt: scope?.movedOut === undefined ? row.superseded_at : null,
        reconciledAt: row.reconciled_at,
        endedAt: (ENDED_AT[row.state] ?? (row.reconciled_at === null ? undefined : leaseEnd))?.({ row, run, log }) ?? null,
        evidence: parseJson<AttemptEvidence | null>(row.evidence_json, null),
        decision: parseJson<AttemptDecision | null>(row.decision_json, null),
        criteria: ticketOf(bundle, row.ticket_id).acceptanceCriteria.map((criterion) => criterion.id),
        retryLimit: bundle.policies.retryLimit
      }
    })
    const grants = retryGrantTimes(ctx, run.id, ticketId, log)
    const until = scope?.movedOut?.grantsUntil
    const retryGrants = until === undefined ? grants : grants.filter((at) => at !== null && at <= until)
    const grantsKnown = grantsKnownFor(ctx, context, ticketId, cutoff)
    return ticketPerformance({ runId: run.id, ticketId, attempts, retryGrants, grantsKnown, runEnded, cutoff }, defects)
  }
}

/**
 * The P input of one ticket in one run as of `cutoff` (default now). The same cutoff always gives the same input;
 * a decision or defect recorded later changes only an input built for a later cutoff.
 */
export function getTicketPerformance(ctx: Ctx, input: { runId: string; ticketId: string; cutoff?: string }): PerformanceAssessmentInput {
  requireCapability(ctx.session, 'read')
  return ticketPerformanceReader(ctx, input.runId, cutoffOf(ctx, input.cutoff))(input.ticketId)
}
