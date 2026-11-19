/**
 * E, T and K inputs from stored records as of a cutoff (default now, never later): one run's timing input and metric
 * ledger, each ticket's saved budget versions (`getPlannedBaselines`) and the records of the project's other runs with
 * an accepted ticket, for cohorts. The rules are the pure `runEfficiency` (`src/core/space/efficiency.ts`); see
 * docs/space-grading.md. Reads only, apart from the lazy lease expiry every run read model does on its own run; other
 * runs are read as they are stored, never settled.
 */
import type { PlanBundle } from '../../shared/domain/bundle'
import type { RunEfficiencyView, TicketEfficiencyView } from '../../shared/domain/efficiency'
import type { BudgetVersionView } from '../../shared/domain/metrics'
import type { BaselineMetric, BudgetBaseline } from '../../shared/domain/space'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { type BudgetCandidates, type CohortSource, cohortSource, type PlannedTicket, runEfficiency, type TokenCell } from '../space/efficiency'
import { CURRENT_SPACE_POLICY } from '../space/rubric'
import { type AttemptRow, loadBundle, requireRun } from './execution'
import { usageCell } from './metricReports'
import { listObservations } from './observations'
import { cutoffOf } from './performance'
import { getPlannedBaselines } from './plannedBaselines'
import { runTimingInput } from './timing'

const tokenCell: TokenCell = (observations) => usageCell(observations, 'tokens_total')

type BundleOf = (revisionId: string) => PlanBundle

/**
 * Each ticket of the run as planned in the revision it was first dispatched under (carry-forward attempts dispatched
 * nothing), else in the run's current revision: its cohort key (work type, size, planned reasoning level; null
 * without a size) and whether it is an acceptance node.
 */
function plannedTickets(ctx: Ctx, run: { id: string; revision_id: string }, bundleOf: BundleOf): Record<string, PlannedTicket> {
  const rows = ctx.db.all<Pick<AttemptRow, 'ticket_id' | 'revision_id'>>(
    `SELECT ticket_id, revision_id FROM attempts WHERE run_id = ? AND kind != 'carry_forward' ORDER BY created_at, number`,
    run.id
  )
  const revisionOf = new Map<string, string>()
  for (const row of rows) if (!revisionOf.has(row.ticket_id)) revisionOf.set(row.ticket_id, row.revision_id)
  const planned: Record<string, PlannedTicket> = {}
  const ticketIds = new Set([...bundleOf(run.revision_id).tickets.map((t) => t.id), ...revisionOf.keys()])
  for (const ticketId of ticketIds) {
    const ticket = bundleOf(revisionOf.get(ticketId) ?? run.revision_id).tickets.find((t) => t.id === ticketId)
    if (ticket === undefined) continue
    planned[ticketId] = {
      cohortKey: ticket.size === undefined ? null : { workType: ticket.capability.workType, size: ticket.size, risk: ticket.capability.reasoning.level },
      acceptance: ticket.kind === 'acceptance'
    }
  }
  return planned
}

function budgetBaseline(ticketId: string, version: BudgetVersionView): BudgetBaseline | null {
  if (version.value === null || version.baselineId === null) return null
  const { baselineId, metric, unit, revisionId, version: number, value, frozenAt } = version
  return { baselineId, kind: 'budget', metric, unit, ticketId, revisionId, version: number, value, frozenAt }
}

/** One metric's saved versions that exist by the cutoff: the pinned one and every other one. */
function candidatesOf(ticketId: string, versions: readonly BudgetVersionView[], cutoff: string): BudgetCandidates {
  const candidates: { pinned: BudgetBaseline | null; others: BudgetBaseline[] } = { pinned: null, others: [] }
  for (const version of versions) {
    const baseline = Date.parse(version.frozenAt) > Date.parse(cutoff) ? null : budgetBaseline(ticketId, version)
    if (baseline === null) continue
    if (version.status === 'pinned') candidates.pinned = baseline
    else candidates.others.push(baseline)
  }
  return candidates
}

/** Each ticket's saved budget versions per metric that exist by the cutoff. */
function budgetCandidates(ctx: Ctx, epicId: string, runId: string, cutoff: string): Record<string, Record<BaselineMetric, BudgetCandidates>> {
  const result: Record<string, Record<BaselineMetric, BudgetCandidates>> = {}
  for (const ticket of getPlannedBaselines(ctx, { epicId, runId }).tickets) {
    const entry: Record<BaselineMetric, BudgetCandidates> = { active_ms: { pinned: null, others: [] }, tokens: { pinned: null, others: [] } }
    for (const budget of ticket.budgets) entry[budget.metric] = candidatesOf(ticket.ticketId, budget.versions, cutoff)
    result[ticket.ticketId] = entry
  }
  return result
}

/**
 * Other runs' cohort sources, keyed by run and cutoff. A source depends only on its run's records at the cutoff, so a
 * read that grades several runs at one cutoff (the project metrics summary) passes one memo: each run's records are
 * loaded and projected once, rather than once per graded run, and every graded run asks the same sources.
 */
export type OtherRunSources = Map<string, CohortSource>

/** Every other run of the project with an accepted work ticket, as stored (its leases are not settled by this read). */
function otherSources(ctx: Ctx, at: { runId: string; cutoff: string }, bundleOf: BundleOf, memo: OtherRunSources | undefined): CohortSource[] {
  const { runId, cutoff } = at
  const runs = ctx.db.all<{ id: string; revision_id: string }>(
    `SELECT id, revision_id FROM runs WHERE id != ? AND EXISTS (
       SELECT 1 FROM attempts WHERE attempts.run_id = runs.id AND state = 'accepted' AND kind != 'carry_forward') ORDER BY rowid`,
    runId
  )
  return runs.map((run) => {
    const key = `${run.id}@${cutoff}`
    const held = memo?.get(key)
    if (held !== undefined) return held
    const input = {
      timing: runTimingInput(ctx, { runId: run.id, asOf: cutoff, settleLeases: false }),
      observations: listObservations(ctx.db, { runId: run.id }),
      plan: plannedTickets(ctx, run, bundleOf)
    }
    const source = cohortSource(input, tokenCell)
    memo?.set(key, source)
    return source
  })
}

/**
 * A run's E, T and K inputs as of `cutoff` (default now): per ticket with its baselines, per sprint and for the run.
 * `ticketId` limits the ticket list to that ticket.
 */
export function getRunEfficiency(ctx: Ctx, input: { runId: string; cutoff?: string; ticketId?: string }, memo?: OtherRunSources): RunEfficiencyView {
  requireCapability(ctx.session, 'read')
  return ctx.db.tx(() => {
    const run = requireRun(ctx, input.runId)
    const cutoff = cutoffOf(ctx, input.cutoff)
    const bundles = new Map<string, PlanBundle>()
    const bundleOf: BundleOf = (revisionId) => {
      const bundle = bundles.get(revisionId) ?? loadBundle(ctx, revisionId)
      bundles.set(revisionId, bundle)
      return bundle
    }
    const timing = runTimingInput(ctx, { runId: run.id, asOf: cutoff })
    const view = runEfficiency(
      {
        timing,
        observations: listObservations(ctx.db, { runId: run.id }),
        budgets: budgetCandidates(ctx, run.epic_id, run.id, cutoff),
        plan: plannedTickets(ctx, run, bundleOf),
        // The other runs reach `runEfficiency` as cohort sources built (or reused from `memo`) here.
        otherRuns: [],
        ...(input.ticketId === undefined ? {} : { ticketIds: [input.ticketId] })
      },
      tokenCell,
      CURRENT_SPACE_POLICY,
      otherSources(ctx, { runId: run.id, cutoff }, bundleOf, memo)
    )
    if (input.ticketId !== undefined) {
      onlyTicket(view, run.id, input.ticketId)
    }
    return view
  })
}

/** The one ticket a run read limited to `ticketId` lists; `not_found` when the run holds no such ticket. */
function onlyTicket(view: RunEfficiencyView, runId: string, ticketId: string): TicketEfficiencyView {
  return view.tickets[0] ?? fail('not_found', `Ticket ${ticketId} is not a ticket of run ${runId}.`, { ticketId })
}

/** One ticket's E, T and K inputs in a run as of `cutoff` (default now): what `gradeSpace` consumes as E, T and K. */
export function getTicketEfficiency(ctx: Ctx, input: { runId: string; ticketId: string; cutoff?: string }): TicketEfficiencyView {
  return onlyTicket(getRunEfficiency(ctx, input), input.runId, input.ticketId)
}
