/**
 * Planned ticket budgets as frozen baselines. A ticket's `budget` (`TicketBudget`) is edited in the draft like any other
 * field; saving the plan freezes it. Every saved revision that changes a ticket's token or active-time budget is a new
 * budget version, frozen at that revision's server save time and identified by a `bl_` id derived from the revision,
 * ticket and metric, so every machine names it alike. Saved revisions are immutable, so the versions are append-only and
 * travel with the plan snapshots; nothing here is stored separately.
 *
 * A run pins its budgets: a dispatched ticket uses the version in effect in the revision it was first claimed under
 * (frozen before that claim), and an undispatched one the version of the run's current revision. A later save is a
 * prospective version for later dispatches only, so re-budgeting mid-run never inflates an assessment retroactively.
 */
import type { BudgetBasis, PlanBundle, TicketBudget, TicketContent } from '../../shared/domain/bundle'
import type {
  BudgetVersionStatus,
  BudgetVersionView,
  GetPlannedBaselinesInput,
  PlannedBaselinesView,
  PlannedBudgetView,
  TicketPlannedBaselinesView
} from '../../shared/domain/metrics'
import { BASELINE_METRICS, BASELINE_UNITS, type BaselineMetric, type BudgetBaseline } from '../../shared/domain/space'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import type { Db } from '../db/database'
import { fail } from '../errors'
import { derivedStableId } from '../ids'
import { loadBundle, requireRun } from './execution'

/** One budget version before it is placed relative to a run. */
type BudgetVersion = Omit<BudgetVersionView, 'status'>

/** Each ticket's budget versions per metric, oldest first. */
type BudgetHistory = Map<string, Record<BaselineMetric, BudgetVersion[]>>

/** A budget's amount for one metric with the basis stated beside it; both null when the budget sets no such amount. */
function sideOf(budget: TicketBudget | undefined, metric: BaselineMetric): { value: number | null; basis: BudgetBasis | null } {
  const value = (metric === 'tokens' ? budget?.tokens : budget?.activeMs) ?? null
  return { value, basis: value === null ? null : (budget?.basis ?? null) }
}

/** The id of the budget version a saved revision introduced for one ticket and metric. */
function budgetBaselineId(revisionId: string, ticketId: string, metric: BaselineMetric): string {
  return derivedStableId('baseline', JSON.stringify(['ticket-budget', revisionId, ticketId, metric]))
}

interface SavedRevision {
  id: string
  number: number
  frozen_at: string
  bundle_json: string
}

function savedRevisions(db: Db, epicId: string): SavedRevision[] {
  return db.all<SavedRevision>(
    `SELECT id, number, COALESCE(saved_at, created_at) AS frozen_at, bundle_json FROM plan_revisions
     WHERE epic_id = ? AND state = 'saved' ORDER BY number`,
    epicId
  )
}

/**
 * Adds a version for each metric whose budget this revision's ticket changes (value null when it cleared it), or whose
 * stated basis it changes, so every version says where its numbers came from.
 */
function appendVersions(versions: Record<BaselineMetric, BudgetVersion[]>, revision: SavedRevision, ticket: TicketContent): void {
  for (const metric of BASELINE_METRICS) {
    const { value, basis } = sideOf(ticket.budget, metric)
    const before = versions[metric].at(-1) ?? { value: null, basis: null }
    if (before.value === value && before.basis === basis) {
      continue
    }
    versions[metric].push({
      baselineId: value === null ? null : budgetBaselineId(revision.id, ticket.id, metric),
      metric,
      unit: BASELINE_UNITS[metric],
      version: versions[metric].length + 1,
      value,
      basis,
      revisionId: revision.id,
      revisionNumber: revision.number,
      frozenAt: revision.frozen_at
    })
  }
}

/**
 * Walks the epic's saved revisions in order: a revision whose budget for a ticket and metric differs from the one in
 * effect before it adds a version. A ticket missing from a revision keeps its budget; it was moved out of the plan,
 * not re-budgeted.
 */
function budgetHistory(db: Db, epicId: string): BudgetHistory {
  const history: BudgetHistory = new Map()
  for (const revision of savedRevisions(db, epicId)) {
    for (const ticket of (JSON.parse(revision.bundle_json) as PlanBundle).tickets) {
      const versions = history.get(ticket.id) ?? { tokens: [], active_ms: [] }
      history.set(ticket.id, versions)
      appendVersions(versions, revision, ticket)
    }
  }
  return history
}

/** Per database: every budget baseline id with its epic, and the saved revisions it was built from. */
const BASELINE_INDEX = new WeakMap<Db, { signature: string; epics: Map<string, string> }>()

function buildBaselineIndex(db: Db): Map<string, string> {
  const epics = new Map<string, string>()
  for (const { epic_id: epicId } of db.all<{ epic_id: string }>("SELECT DISTINCT epic_id FROM plan_revisions WHERE state = 'saved'")) {
    const ids = [...budgetHistory(db, epicId).values()]
      .flatMap((versions) => [...versions.tokens, ...versions.active_ms])
      .map((version) => version.baselineId)
      .filter((id): id is string => id !== null)
    for (const id of ids) {
      epics.set(id, epicId)
    }
  }
  return epics
}

/**
 * The epic a budget baseline id belongs to, or undefined when no saved revision of this project introduced it. Lets
 * metric evidence cite a budget version. The id index is built once and rebuilt only when the set of saved revisions
 * changes (their count, row range and id range), so a batch citing many baselines parses the plans once.
 */
export function budgetBaselineEpic(db: Db, baselineId: string): string | undefined {
  const shape = db.get<{ n: number; first: number | null; last: number | null; low: string | null; high: string | null }>(
    "SELECT COUNT(*) AS n, MIN(rowid) AS first, MAX(rowid) AS last, MIN(id) AS low, MAX(id) AS high FROM plan_revisions WHERE state = 'saved'"
  )
  const signature = JSON.stringify(shape ?? null)
  let index = BASELINE_INDEX.get(db)
  if (index?.signature !== signature) {
    index = { signature, epics: buildBaselineIndex(db) }
    BASELINE_INDEX.set(db, index)
  }
  return index.epics.get(baselineId)
}

/** A ticket's first claim in the run (carry-forward attempts ran nothing and dispatch nothing). */
interface Dispatch {
  at: string
  revisionId: string
}

function dispatchesOf(ctx: Ctx, runId: string): Map<string, Dispatch> {
  const rows = ctx.db.all<{ ticket_id: string; created_at: string; revision_id: string }>(
    `SELECT ticket_id, created_at, revision_id FROM attempts WHERE run_id = ? AND kind != 'carry_forward'
     ORDER BY created_at, number`,
    runId
  )
  const dispatches = new Map<string, Dispatch>()
  for (const row of rows) {
    if (!dispatches.has(row.ticket_id)) {
      dispatches.set(row.ticket_id, { at: row.created_at, revisionId: row.revision_id })
    }
  }
  return dispatches
}

/** The budget baseline a pinned version provides, when it sets a value frozen strictly before dispatch. */
function appliedBaseline(ticketId: string, pinned: BudgetVersion | undefined, dispatchedAt: string | null): BudgetBaseline | null {
  if (pinned === undefined || pinned.value === null || pinned.baselineId === null) {
    return null
  }
  if (dispatchedAt !== null && !(Date.parse(pinned.frozenAt) < Date.parse(dispatchedAt))) {
    return null
  }
  return {
    baselineId: pinned.baselineId,
    kind: 'budget',
    metric: pinned.metric,
    unit: pinned.unit,
    ticketId,
    revisionId: pinned.revisionId,
    version: pinned.version,
    value: pinned.value,
    frozenAt: pinned.frozenAt
  }
}

interface TicketContext {
  ticketId: string
  dispatch: Dispatch | undefined
  pinnedNumber: number
  /** The ticket's budget in the open draft and in the current saved revision; null without a draft holding it. */
  draft: { draft: TicketBudget | undefined; saved: TicketBudget | undefined } | null
}

/** The draft's change to one metric's budget against the epic's current saved revision; null when it changes nothing. */
function draftChange(draft: TicketContext['draft'], metric: BaselineMetric): PlannedBudgetView['draft'] {
  if (draft === null) {
    return null
  }
  const next = sideOf(draft.draft, metric)
  const saved = sideOf(draft.saved, metric)
  return next.value === saved.value && next.basis === saved.basis ? null : next
}

function budgetView(context: TicketContext, metric: BaselineMetric, versions: BudgetVersion[]): PlannedBudgetView {
  // Versions are in revision order, so the pinned one is the last saved at or before the pinned revision.
  const pinnedIndex = versions.filter((version) => version.revisionNumber <= context.pinnedNumber).length - 1
  const status = (index: number): BudgetVersionStatus => {
    if (index === pinnedIndex) {
      return 'pinned'
    }
    return index < pinnedIndex ? 'superseded' : 'prospective'
  }
  const applied = appliedBaseline(context.ticketId, versions[pinnedIndex], context.dispatch?.at ?? null)
  return {
    metric,
    unit: BASELINE_UNITS[metric],
    state: applied === null ? 'none' : context.dispatch === undefined ? 'planned' : 'frozen',
    applied,
    versions: versions.map((version, index) => ({ ...version, status: status(index) })),
    draft: draftChange(context.draft, metric)
  }
}

/** What every ticket's view is read against. */
interface PlanSides {
  /** The revision undispatched tickets are pinned to: the run's, or without a run the epic's current one. */
  viewRevisionId: string
  numbers: Map<string, number>
  history: BudgetHistory
  dispatches: Map<string, Dispatch>
  current: PlanBundle
  draft: PlanBundle | null
}

function ticketView(sides: PlanSides, ticket: TicketContent): TicketPlannedBaselinesView {
  const dispatch = sides.dispatches.get(ticket.id)
  const pinnedRevisionId = dispatch?.revisionId ?? sides.viewRevisionId
  const drafted = sides.draft?.tickets.find((item) => item.id === ticket.id)
  const saved = sides.current.tickets.find((item) => item.id === ticket.id)
  const context: TicketContext = {
    ticketId: ticket.id,
    dispatch,
    pinnedNumber: sides.numbers.get(pinnedRevisionId) ?? 0,
    draft: drafted === undefined ? null : { draft: drafted.budget, saved: saved?.budget }
  }
  const versions = sides.history.get(ticket.id)
  return {
    ticketId: ticket.id,
    key: ticket.key,
    title: ticket.title,
    dispatchedAt: dispatch?.at ?? null,
    pinnedRevisionId,
    budgets: BASELINE_METRICS.map((metric) => budgetView(context, metric, versions?.[metric] ?? []))
  }
}

function epicRevision(ctx: Ctx, epicId: string): string {
  const epic = ctx.db.get<{ current_revision_id: string | null }>('SELECT current_revision_id FROM epics WHERE id = ?', epicId)
  if (epic === undefined) {
    fail('not_found', `Epic ${epicId} not found.`, { epicId })
  }
  if (epic.current_revision_id === null) {
    fail('not_found', `Epic ${epicId} has no saved plan, so it has no planned budgets yet.`, { epicId })
  }
  return epic.current_revision_id
}

/** The run the budgets are pinned to, when one is named: it must be a run of the epic. */
function epicRun(ctx: Ctx, input: GetPlannedBaselinesInput): { id: string; revision_id: string } | null {
  if (input.runId === undefined) {
    return null
  }
  const run = requireRun(ctx, input.runId)
  if (run.epic_id !== input.epicId) {
    fail('invalid_input', `Run ${run.id} belongs to epic ${run.epic_id}, not ${input.epicId}.`, { runId: run.id })
  }
  return run
}

/**
 * Each ticket's budget versions placed against the run (or, without one, the epic's current saved revision): the
 * pinned version and the baseline it applies, earlier superseded versions, later prospective ones, and an unsaved
 * draft change compared with the epic's current saved revision (never with an older revision the run is pinned to).
 */
export function getPlannedBaselines(ctx: Ctx, input: GetPlannedBaselinesInput): PlannedBaselinesView {
  requireCapability(ctx.session, 'read')
  const currentRevisionId = epicRevision(ctx, input.epicId)
  const run = epicRun(ctx, input)
  const runRevisionId = run === null ? null : run.revision_id
  const viewRevisionId = runRevisionId ?? currentRevisionId
  const draftRow = ctx.db.get<{ bundle_json: string }>('SELECT bundle_json FROM drafts WHERE epic_id = ?', input.epicId)
  const current = loadBundle(ctx, currentRevisionId)
  const sides: PlanSides = {
    viewRevisionId,
    numbers: new Map(savedRevisions(ctx.db, input.epicId).map((revision) => [revision.id, revision.number])),
    history: budgetHistory(ctx.db, input.epicId),
    dispatches: run === null ? new Map() : dispatchesOf(ctx, run.id),
    current,
    draft: draftRow === undefined ? null : (JSON.parse(draftRow.bundle_json) as PlanBundle)
  }
  const bundle = viewRevisionId === currentRevisionId ? current : loadBundle(ctx, viewRevisionId)
  const tickets = bundle.tickets.map((ticket) => ticketView(sides, ticket))
  return { epicId: input.epicId, runId: input.runId ?? null, currentRevisionId, runRevisionId, tickets }
}
