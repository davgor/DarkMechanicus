import type { PlanBundle } from '../../shared/domain/bundle'
import { requireCapability } from '../authz'
import { contentHash } from '../canonical'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { deliverySatisfied } from '../plan/delivery'
import { indexBundle, sortedSprints, ticketLabel } from '../plan/graph'
import { ADOPTION_REASON_MIN, LIMITS } from '../schemas'
import { maskSecretText } from '../storedSecrets'
import { bindRepositoryBranches } from './epicBranches'
import { appendEvent } from './events'
import { loadDeliveryChecks } from './execution'
import { enqueueOutbox } from './outbox'
import { loadBundle, loadRun, requireOwnedRun, type RunRow } from './reports'

interface AdoptionResult {
  runId: string
  /** Tickets whose acceptance in this run carries over to the adopted revision. */
  kept: string[]
  /** Tickets whose accepted attempt was superseded: they need new work in this run. */
  superseded: string[]
  /** Tickets that moved to a later sprint and started it with a fresh retry budget (their spent attempts were superseded). */
  freshBudget: string[]
  activeSprintId: string
}

interface Reconciliation {
  run: RunRow
  current: PlanBundle
  target: PlanBundle
  carryForward: ReadonlySet<string>
}

/**
 * A running run adopts too, so an orchestrator can fix the plan of the sprint it is in without a pause. Open
 * attempts still refuse it in every state: adoption invalidates grants bound to the old revision, so in-flight
 * workers finish (or are reconciled) first. A queued run has started nothing and has nothing to adopt into.
 */
const ADOPTABLE_STATES: ReadonlySet<string> = new Set(['running', 'awaiting_checkpoint', 'paused'])

function requireAdoptableRun(ctx: Ctx, run: RunRow): void {
  if (!ADOPTABLE_STATES.has(run.state)) {
    fail('run_not_active', 'Adopt a new revision while the run is running, paused or at a checkpoint.', { runId: run.id, state: run.state })
  }
  const open = ctx.db.all<{ id: string }>(
    `SELECT id FROM attempts WHERE run_id = ? AND state IN ('claimed', 'running', 'submitted') ORDER BY id`,
    run.id
  )
  if (open.length > 0) {
    fail('conflict', 'Finish or reconcile the open attempts before adopting a new revision.', {
      openAttempts: open.map((attempt) => attempt.id)
    })
  }
}

/**
 * Why the run adopts, trimmed and with claim and grant tokens masked; null when none was given. An agent must say
 * why (it acts without the person, who reads the reason in the run's activity); the desktop's person may leave it
 * out, and so may approve with redraft, which the person presses. The reason is information only: nothing waits on it.
 */
function adoptionReason(ctx: Ctx, reason: string | undefined): string | null {
  const trimmed = reason?.trim() ?? ''
  if (trimmed === '') {
    if (ctx.session.role !== 'desktop') {
      fail('invalid_input', 'Say why you adopt this revision: what failed and what the revision changes (reason).', { field: 'reason' })
    }
    return null
  }
  if (trimmed.length < ADOPTION_REASON_MIN || trimmed.length > LIMITS.shortText) {
    fail('invalid_input', `The adoption reason must be ${ADOPTION_REASON_MIN} to ${LIMITS.shortText} characters.`, {
      field: 'reason',
      length: trimmed.length
    })
  }
  return maskSecretText(trimmed)
}

/** Only the epic's current saved revision can replace the run's pinned one. */
function loadTargetBundle(ctx: Ctx, run: RunRow, revisionId: string): { bundle: PlanBundle; number: number } {
  if (revisionId === run.revision_id) {
    fail('conflict', 'The run already executes this revision.', { revisionId })
  }
  const epic = ctx.db.get<{ current_revision_id: string | null }>(
    'SELECT current_revision_id FROM epics WHERE id = ?',
    run.epic_id
  )
  if (epic?.current_revision_id !== revisionId) {
    fail('conflict', "Only the epic's current saved revision can be adopted.", {
      revisionId,
      currentRevisionId: epic?.current_revision_id ?? null
    })
  }
  const revision = ctx.db.get<{ state: string; number: number }>('SELECT state, number FROM plan_revisions WHERE id = ?', revisionId)
  if (revision?.state !== 'saved') {
    fail('conflict', `Revision ${revisionId} is not saved yet.`, { revisionId })
  }
  return { bundle: loadBundle(ctx, revisionId), number: revision.number }
}

/**
 * Each ticket's work content hash. The planned budget is left out: re-budgeting is planning metadata that applies only
 * to later dispatches (see `plannedBaselines.ts`), so it never supersedes accepted work or blocks a passed sprint.
 */
function ticketHashes(bundle: PlanBundle): Map<string, string> {
  return new Map(bundle.tickets.map(({ budget: _budget, ...work }) => [work.id, contentHash(work)]))
}

function supersede(ctx: Ctx, attempt: { id: string; ticket_id: string }, stillPlanned: boolean): void {
  const now = ctx.clock.nowIso()
  ctx.db.run('UPDATE attempts SET superseded_at = ?, updated_at = ? WHERE id = ?', now, now, attempt.id)
  if (stillPlanned) {
    ctx.db.run(
      `UPDATE ticket_status SET status = 'in_progress', revision = revision + 1, updated_at = ?
       WHERE ticket_id = ? AND status = 'completed'`,
      now,
      attempt.ticket_id
    )
  }
}

/**
 * Unchanged tickets keep their acceptance; changed ones keep it only with explicit carry-forward;
 * everything else (changed, or removed from the plan) is superseded and needs new work.
 */
function reconcileAcceptances(ctx: Ctx, input: Reconciliation): { kept: string[]; superseded: string[] } {
  const before = ticketHashes(input.current)
  const after = ticketHashes(input.target)
  const accepted = ctx.db.all<{ id: string; ticket_id: string }>(
    `SELECT id, ticket_id FROM attempts WHERE run_id = ? AND state = 'accepted' AND superseded_at IS NULL
     ORDER BY created_at, id`,
    input.run.id
  )
  const kept = new Set<string>()
  const superseded = new Set<string>()
  for (const attempt of accepted) {
    const next = after.get(attempt.ticket_id)
    const unchanged = next !== undefined && before.get(attempt.ticket_id) === next
    if (unchanged || (next !== undefined && input.carryForward.has(attempt.ticket_id))) {
      kept.add(attempt.ticket_id)
    } else {
      supersede(ctx, attempt, next !== undefined)
      superseded.add(attempt.ticket_id)
    }
  }
  return { kept: [...kept], superseded: [...superseded] }
}

/**
 * Attempts that used up a try without delivering: failed, rejected, or abandoned after an expired lease. An accepted
 * attempt delivered, and a canceled one never counted, so neither is spent.
 */
const SPENT_ATTEMPT_SQL = "(state IN ('failed', 'rejected') OR (state = 'lease_expired' AND reconciled_at IS NOT NULL))"

/**
 * The tickets that sit in a later sprint of `target` than the sprint `current` had them in. A sprint is the same
 * sprint under the same id, whatever its ordinal becomes, so renumbering moves nothing; a ticket whose old sprint
 * is gone, or that is new, did not move.
 */
function ticketsMovedLater(current: PlanBundle, target: PlanBundle): string[] {
  const before = indexBundle(current)
  const after = indexBundle(target)
  return target.tickets
    .map((ticket) => ticket.id)
    .filter((id) => {
      const origin = after.sprints.get(before.sprintOf.get(id)?.id ?? '')
      const now = after.sprintOf.get(id)
      return origin !== undefined && now !== undefined && now.id !== origin.id && now.ordinal > origin.ordinal
    })
}

/** The tickets with spent attempts in the run that no later adoption has superseded, sorted by id. */
function spentTicketIds(ctx: Ctx, runId: string): string[] {
  return ctx.db
    .all<{ ticket_id: string }>(
      `SELECT DISTINCT ticket_id FROM attempts WHERE run_id = ? AND superseded_at IS NULL AND ${SPENT_ATTEMPT_SQL} ORDER BY ticket_id`,
      runId
    )
    .map((row) => row.ticket_id)
}

/**
 * What a revision would do to the run's spent tickets that resets their retry budget: drop them from the plan (a
 * copy added under a new id starts with no attempts) or move them to a later sprint (adoption supersedes their spent
 * attempts). `current` is the revision the run executes now. A spent ticket `current` no longer plans was dropped by
 * an adoption already made (by the person, or by a session allowed to): it is not removed again, and it cannot come
 * back with a fresh budget, since a ticket keeps its id and its attempts in the run count against that id.
 */
export function retryBudgetResets(
  ctx: Ctx,
  input: { runId: string; current: PlanBundle; target: PlanBundle }
): { removed: string[]; movedLater: string[] } {
  const spent = spentTicketIds(ctx, input.runId)
  const before = new Set(input.current.tickets.map((ticket) => ticket.id))
  const after = new Set(input.target.tickets.map((ticket) => ticket.id))
  const later = new Set(ticketsMovedLater(input.current, input.target))
  return {
    removed: spent.filter((id) => before.has(id) && !after.has(id)),
    movedLater: spent.filter((id) => later.has(id))
  }
}

/**
 * How an agent changes a ticket that spent attempts without resetting its retry budget, for the refusals of a save
 * on run ownership and of an adoption without `allowSave`.
 */
export const KEEP_SPENT_TICKETS =
  'Instead, edit the ticket in place (update_ticket keeps its id and its spent attempts), add new tickets for the parts you split off, or retry it with retry_ticket. If it truly must be removed or moved to a later sprint, the person saves and adopts that plan in the desktop app (or an orchestrator launched with allowSave does).'

/**
 * A session that saves only on run ownership (no `plan.save`, so not the desktop and not an orchestrator with
 * `allowSave`; the same split `requireSaveAuthority` in `plans.ts` makes) may not adopt a revision that resets a
 * spent ticket's retry budget. The save already refused such a draft, but a ticket can be moved or removed while
 * unspent and then fail on the pinned revision before the adoption: this repeats the check on the attempts as they
 * are now, inside the adoption's transaction. Retries past the limits are the person's to grant.
 */
function assertNoBudgetReset(ctx: Ctx, input: Reconciliation): void {
  if (ctx.session.role === 'desktop' || ctx.session.capabilities.has('plan.save')) {
    return
  }
  const { removed, movedLater } = retryBudgetResets(ctx, { runId: input.run.id, current: input.current, target: input.target })
  if (removed.length === 0 && movedLater.length === 0) {
    return
  }
  const index = indexBundle(input.current)
  const labels = [...removed, ...movedLater].map((id) => ticketLabel(index, id)).join(', ')
  fail(
    'unauthorized',
    `This revision removes or moves to a later sprint tickets with spent attempts in this run (${labels}), which would give them a fresh retry budget. ${KEEP_SPENT_TICKETS}`,
    { removed, movedLater }
  )
}

/**
 * A ticket that moved to a later sprint starts it with a fresh retry budget, so a leftover does not arrive at its
 * limit: its failed, rejected and abandoned attempts are superseded, which keeps them in history but stops them
 * counting. Accepted attempts are never touched here.
 */
function grantFreshBudgets(ctx: Ctx, input: Reconciliation): string[] {
  const now = ctx.clock.nowIso()
  return ticketsMovedLater(input.current, input.target).filter(
    (ticketId) =>
      ctx.db.run(
        `UPDATE attempts SET superseded_at = ?, updated_at = ?
         WHERE run_id = ? AND ticket_id = ? AND superseded_at IS NULL AND ${SPENT_ATTEMPT_SQL}`,
        now,
        now,
        input.run.id,
        ticketId
      ).changes > 0
  )
}

/**
 * Earlier sprints are closed for this run, so a changed ticket there could never be redone: refuse
 * unless the orchestrator explicitly carries its old acceptance forward.
 */
function assertNoClosedSprintRework(ctx: Ctx, input: Reconciliation & { activeSprintId: string }): void {
  const before = ticketHashes(input.current)
  const after = ticketHashes(input.target)
  const index = indexBundle(input.target)
  const activeOrdinal = index.sprints.get(input.activeSprintId)?.ordinal ?? 0
  const accepted = ctx.db.all<{ ticket_id: string }>(
    `SELECT DISTINCT ticket_id FROM attempts WHERE run_id = ? AND state = 'accepted' AND superseded_at IS NULL
     ORDER BY ticket_id`,
    input.run.id
  )
  const closed = accepted
    .map((row) => row.ticket_id)
    .filter((id) => {
      const next = after.get(id)
      const changed = next !== undefined && next !== before.get(id) && !input.carryForward.has(id)
      return changed && (index.sprintOf.get(id)?.ordinal ?? activeOrdinal) < activeOrdinal
    })
  if (closed.length > 0) {
    const labels = closed.map((id) => ticketLabel(index, id)).join(', ')
    const pronoun = closed.length === 1 ? 'it' : 'them'
    fail(
      'conflict',
      `${labels} changed in a sprint this run already passed. Carry ${pronoun} forward or start a new run to redo ${pronoun}.`,
      { tickets: closed }
    )
  }
}

/**
 * The delivery hold of an earlier sprint is the person's to lift (by a waiver), so no adoption may drop or change
 * the `delivery` of a sprint before the run's active one while that delivery is neither verified nor waived.
 * Applies to approve-with-redraft too, which adopts through here.
 */
function assertNoDeliveryBypass(ctx: Ctx, input: Reconciliation): void {
  const activeOrdinal = input.current.sprints.find((sprint) => sprint.id === input.run.active_sprint_id)?.ordinal
  if (activeOrdinal === undefined) {
    return
  }
  const deliveries = loadDeliveryChecks(ctx, input.run.id)
  for (const sprint of sortedSprints(input.current)) {
    if (sprint.ordinal >= activeOrdinal || sprint.delivery === undefined || deliverySatisfied(sprint.id, deliveries)) {
      continue
    }
    const next = input.target.sprints.find((item) => item.id === sprint.id)?.delivery
    if (next === undefined || contentHash(next) !== contentHash(sprint.delivery)) {
      fail('conflict', `Sprint ${sprint.ordinal}'s delivery is not verified: only the person can waive it`, {
        sprintId: sprint.id,
        ordinal: sprint.ordinal
      })
    }
  }
}

/** Same sprint id if it survives, else the same ordinal, else the last sprint. */
function chooseActiveSprint(activeSprintId: string | null, current: PlanBundle, target: PlanBundle): string {
  const sprints = sortedSprints(target)
  const ordinal = current.sprints.find((sprint) => sprint.id === activeSprintId)?.ordinal
  const match =
    sprints.find((sprint) => sprint.id === activeSprintId) ?? sprints.find((sprint) => sprint.ordinal === ordinal)
  return (match ?? sprints[sprints.length - 1]).id
}

/**
 * Switches a run to the epic's newer saved revision while it runs, waits at a checkpoint or is paused, with no
 * open attempts. Grants bound to the old revision stop matching because their binding names it. In a folder of
 * repositories, a repository the adopted revision names for the first time is bound to the epic branch now.
 * `reason` is required of every session but the desktop's, and is recorded masked on `run.revision_adopted`.
 */
export function adoptRevision(
  ctx: Ctx,
  input: { runId: string; revisionId: string; carryForward?: string[]; reason?: string }
): AdoptionResult {
  requireCapability(ctx.session, 'run.adopt')
  const reason = adoptionReason(ctx, input.reason)
  ctx.assertBranch()
  return ctx.db.tx(() => {
    const run = loadRun(ctx, input.runId)
    requireOwnedRun(ctx, run)
    requireAdoptableRun(ctx, run)
    const { bundle: target, number: revisionNumber } = loadTargetBundle(ctx, run, input.revisionId)
    const current = loadBundle(ctx, run.revision_id)
    const carryForward = new Set(input.carryForward ?? [])
    const activeSprintId = chooseActiveSprint(run.active_sprint_id, current, target)
    assertNoClosedSprintRework(ctx, { run, current, target, carryForward, activeSprintId })
    assertNoDeliveryBypass(ctx, { run, current, target, carryForward })
    assertNoBudgetReset(ctx, { run, current, target, carryForward })
    const { kept, superseded } = reconcileAcceptances(ctx, { run, current, target, carryForward })
    const freshBudget = grantFreshBudgets(ctx, { run, current, target, carryForward })
    ctx.db.run(
      'UPDATE runs SET revision_id = ?, active_sprint_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
      input.revisionId,
      activeSprintId,
      ctx.clock.nowIso(),
      run.id
    )
    appendEvent(ctx, {
      kind: 'run.revision_adopted',
      epicId: run.epic_id,
      runId: run.id,
      payload: {
        from: run.revision_id,
        to: input.revisionId,
        revisionNumber,
        kept,
        superseded,
        freshBudget,
        adoptedBy: ctx.session.role,
        reason
      }
    })
    enqueueOutbox(ctx, { kind: 'run_history', epicId: run.epic_id, runId: run.id })
    bindRepositoryBranches(ctx, run.epic_id, input.revisionId, null)
    if (superseded.length > 0) {
      enqueueOutbox(ctx, { kind: 'epic_state', epicId: run.epic_id })
    }
    return { runId: run.id, kept, superseded, freshBudget, activeSprintId }
  })
}
