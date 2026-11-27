/**
 * Sprint delivery checks: the orchestrator's record that a sprint's increment reached its delivery target (and, when
 * the sprint asks, a release and the installed app). Git verification is asynchronous and the store is not, so the
 * command reads the delivery context (`deliveryContextOf`), asks git (`verifyDelivery`) outside any transaction, and
 * then `recordDelivery` re-applies every refusal inside the transaction, because the run may have changed during the
 * await, before it stores the verdict in `delivery_checks`.
 */
import type { RecordDeliveryInput } from '../../shared/domain/api'
import type { PlanBundle, SprintDef, SprintDelivery } from '../../shared/domain/bundle'
import { isActiveRunState } from '../../shared/domain/status'
import type { DeliveryCheckView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { toJson } from '../db/database'
import { fail } from '../errors'
import { sortedSprints } from '../plan/graph'
import type { DeliveryVerdict } from './deliveryVerify'
import { isRepositoryFolder } from './epicBranches'
import { appendEvent } from './events'
import { loadBundle, loadDeliveryChecks, type AttemptRow, type RunRow } from './execution'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { sprintIncrementViews } from './increments'
import { enqueueOutbox } from './outbox'
import { requireOwnedRun } from './runs'

/** What a delivery is verified against: the sprint's declaration and its accepted, passing increment. */
interface DeliveryRecordContext {
  run: RunRow
  delivery: SprintDelivery
  increment: { commit: string }
}

/** What the command proved against git before the store: the verdict, and the adapter's check that nothing moved. */
interface VerifiedDelivery {
  /** The increment commit the verdict was made for. */
  increment: string
  verdict: DeliveryVerdict
  assertCurrent?: () => void
}

/** A delivery is recorded while the run is active, or once it completed for its final sprint. */
function requireRecordingState(run: RunRow, sprints: readonly SprintDef[], sprintId: string): void {
  if (isActiveRunState(run.state) || (run.state === 'completed' && sprints.at(-1)?.id === sprintId)) {
    return
  }
  fail('run_not_active', `The run is ${run.state}; delivery checks need an active run, or a completed one for its final sprint.`, {
    runId: run.id,
    state: run.state
  })
}

/**
 * The sprint whose delivery is recorded: in the run's pinned plan, declaring a delivery, and past its checkpoint (an
 * earlier ordinal than the active sprint's, or the final sprint of a completed run).
 */
function deliveringSprint(run: RunRow, bundle: PlanBundle, sprintId: string): { sprint: SprintDef; delivery: SprintDelivery } {
  const sprints = sortedSprints(bundle)
  requireRecordingState(run, sprints, sprintId)
  const sprint = sprints.find((item) => item.id === sprintId)
  if (sprint === undefined) {
    fail('not_found', `Sprint ${sprintId} is not part of this run's pinned plan.`, { sprintId })
  }
  const { delivery } = sprint
  if (delivery === undefined) {
    fail('invalid_input', `Sprint ${sprint.ordinal} declares no delivery.`, { sprintId: sprint.id })
  }
  const active = sprints.find((item) => item.id === run.active_sprint_id)
  if (run.state !== 'completed' && (active === undefined || sprint.ordinal >= active.ordinal)) {
    fail('unauthorized_transition', `Sprint ${sprint.ordinal} has not passed its checkpoint yet; delivery follows the approval.`, {
      sprintId: sprint.id
    })
  }
  return { sprint, delivery }
}

/**
 * Applies every refusal and returns the sprint's delivery and passing increment. Read-only, so the command can call it
 * before asking git, and `recordDelivery` again inside its transaction.
 */
export function deliveryContextOf(ctx: Ctx, input: Pick<RecordDeliveryInput, 'runId' | 'sprintId'>): DeliveryRecordContext {
  requireCapability(ctx.session, 'run.delivery')
  const run = requireOwnedRun(ctx, input.runId)
  const bundle = loadBundle(ctx, run.revision_id)
  const { sprint, delivery } = deliveringSprint(run, bundle, input.sprintId)
  if (isRepositoryFolder(ctx)) {
    fail('invalid_input', 'A folder of repositories cannot record a sprint delivery: delivery checks cover a single repository.', {
      sprintId: sprint.id
    })
  }
  const attempts = ctx.db.all<AttemptRow>('SELECT * FROM attempts WHERE run_id = ? ORDER BY rowid', run.id)
  const increment = sprintIncrementViews(bundle, attempts).find(
    (view) => view.sprintId === sprint.id && view.attemptState === 'accepted' && view.increment.passed
  )
  if (increment === undefined) {
    fail('invalid_input', `Sprint ${sprint.ordinal} has no accepted acceptance-node attempt with a passing increment.`, {
      sprintId: sprint.id
    })
  }
  return { run, delivery, increment: { commit: increment.increment.commit } }
}

function insertDeliveryCheck(ctx: Ctx, run: RunRow, input: RecordDeliveryInput, verdict: DeliveryVerdict): string {
  const id = ctx.ids.next('deliveryCheck')
  const last = ctx.db.get<{ number: number | null }>('SELECT MAX(number) AS number FROM delivery_checks WHERE run_id = ?', run.id)
  // The caller's own observations go after the server's checks; a skipped entry counts as not passed.
  const caller = (input.checks ?? []).map((check) => ({ name: check.name, status: check.status, detail: check.detail ?? '' }))
  const unpassed = caller.filter((check) => check.status !== 'passed')
  const stored = {
    checks: [...verdict.checks, ...caller],
    reasons: [...verdict.reasons, ...unpassed.map((check) => `${check.name}: ${check.detail === '' ? check.status : check.detail}`)],
    releaseVersion: verdict.releaseVersion,
    installedVersion: verdict.installedVersion
  }
  ctx.db.run(
    `INSERT INTO delivery_checks (id, run_id, number, sprint_id, kind, commit_ref, release_tag, verdict_json, recorded_by, created_at)
     VALUES (?, ?, ?, ?, 'check', ?, ?, ?, ?, ?)`,
    id,
    run.id,
    (last?.number ?? 0) + 1,
    input.sprintId,
    input.commit,
    input.releaseTag ?? null,
    toJson(stored),
    ctx.session.label,
    ctx.clock.nowIso()
  )
  return id
}

/**
 * Orchestrator: stores the verdict the command made against git as the sprint's newest delivery check. It passes only
 * when every server check and every caller entry passed. A failed verdict is stored, not thrown.
 */
export function recordDelivery(ctx: Ctx, input: RecordDeliveryInput, verified: VerifiedDelivery): DeliveryCheckView {
  requireCapability(ctx.session, 'run.delivery')
  return withIdempotency(ctx, { command: 'recordDelivery', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    const { run, increment } = deliveryContextOf(ctx, input)
    if (increment.commit !== verified.increment) {
      fail('conflict', 'The sprint\'s accepted increment changed during verification. Record the delivery again.', { sprintId: input.sprintId })
    }
    verified.assertCurrent?.()
    const id = insertDeliveryCheck(ctx, run, input, verified.verdict)
    const view = loadDeliveryChecks(ctx, run.id).find((item) => item.id === id) ?? fail('internal', `Delivery check ${id} was not stored.`)
    appendEvent(ctx, {
      kind: 'run.delivery_recorded',
      epicId: run.epic_id,
      runId: run.id,
      payload: { deliveryCheckId: view.id, sprintId: view.sprintId, passed: view.passed }
    })
    enqueueOutbox(ctx, { kind: 'run_history', epicId: run.epic_id, runId: run.id })
    return view
  })
}
