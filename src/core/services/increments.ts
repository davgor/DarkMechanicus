/**
 * Sprint increments in a run: what verification reads before git is asked (the sprint, the epic branch,
 * the sprint's accepted work, the previous increment), and how the verdicts stored with acceptance-node
 * attempts are read back for the gate and the views. The git questions themselves are in `incrementVerify`.
 */
import type { EpicBranch, PlanBundle, SprintDef } from '../../shared/domain/bundle'
import type { AttemptOutputs, SprintIncrement, SprintIncrementView } from '../../shared/domain/views'
import type { AttemptState } from '../../shared/domain/status'
import type { Ctx } from '../context'
import { parseJson } from '../db/database'
import { acceptanceNodeOf, isAcceptanceTicket, workTicketsOf } from '../plan/acceptance'
import { sortedSprints } from '../plan/graph'
import { type AttemptRow, loadAttempt, loadBundle, requireRun } from './execution'
import type { IncrementContext } from './incrementVerify'

/** The attempt columns increments read. */
interface IncrementAttempt {
  id: string
  ticket_id: string
  state: AttemptState
  superseded_at: string | null
  increment_json: string | null
}

export function incrementOf(attempt: Pick<IncrementAttempt, 'increment_json'> | undefined): SprintIncrement | null {
  return parseJson<SprintIncrement | null>(attempt?.increment_json, null)
}

/**
 * The attempt that stands for a ticket: its accepted attempt, else its submission awaiting review. An
 * attempt an adopted revision superseded never stands. Attempts are in the order they were made.
 */
export function standingAttempt<T extends IncrementAttempt>(attempts: readonly T[], ticketId: string): T | undefined {
  const own = attempts.filter((attempt) => attempt.ticket_id === ticketId && attempt.superseded_at === null)
  return own.filter((attempt) => attempt.state === 'accepted').at(-1) ?? own.filter((attempt) => attempt.state === 'submitted').at(-1)
}

/** The nearest earlier sprint whose standing acceptance attempt carries a passing verdict. */
function previousIncrement(bundle: PlanBundle, sprint: SprintDef, attempts: AttemptRow[]): IncrementContext['previous'] {
  const earlier = sortedSprints(bundle)
    .filter((item) => item.ordinal < sprint.ordinal)
    .reverse()
  for (const item of earlier) {
    const node = acceptanceNodeOf(bundle, item.id)
    const verdict = node === undefined ? null : incrementOf(standingAttempt(attempts, node.id))
    if (verdict?.passed === true) {
      return { sprintId: item.id, commit: verdict.commit }
    }
  }
  return null
}

/** Every commit the accepted, current work attempts of the sprint's work tickets recorded, once each. */
function acceptedWorkCommits(bundle: PlanBundle, sprint: SprintDef, attempts: AttemptRow[]): string[] {
  const ids = new Set(workTicketsOf(bundle, sprint.id).map((ticket) => ticket.id))
  const recorded = attempts
    .filter((attempt) => ids.has(attempt.ticket_id) && attempt.kind === 'work')
    .filter((attempt) => attempt.state === 'accepted' && attempt.superseded_at === null)
    .flatMap((attempt) => parseJson<AttemptOutputs | null>(attempt.outputs_json, null)?.commits ?? [])
  return [...new Set(recorded)]
}

/**
 * What verifying the increment named by this attempt needs, or null when the attempt is not on a sprint's
 * acceptance node (or does not exist). Read-only; the git questions come after.
 */
export function incrementContextOf(ctx: Ctx, attemptId: string): IncrementContext | null {
  const row = ctx.db.get<{ id: string }>('SELECT id FROM attempts WHERE id = ?', attemptId)
  if (row === undefined) {
    return null
  }
  const attempt = loadAttempt(ctx, row.id)
  const run = requireRun(ctx, attempt.run_id)
  const bundle = loadBundle(ctx, run.revision_id)
  const sprint = bundle.sprints.find((item) => item.ticketIds.includes(attempt.ticket_id))
  const ticket = bundle.tickets.find((item) => item.id === attempt.ticket_id)
  if (sprint === undefined || ticket === undefined || !isAcceptanceTicket(ticket)) {
    return null
  }
  const attempts = ctx.db.all<AttemptRow>('SELECT * FROM attempts WHERE run_id = ? ORDER BY rowid', run.id)
  const epic = ctx.db.get<{ branch_json: string | null }>('SELECT branch_json FROM epics WHERE id = ?', run.epic_id)
  return {
    sprintId: sprint.id,
    epicBranch: parseJson<EpicBranch | null>(epic?.branch_json, null),
    previous: previousIncrement(bundle, sprint, attempts),
    workCommits: acceptedWorkCommits(bundle, sprint, attempts)
  }
}

/**
 * The attempt whose increment a sprint shows: the standing acceptance attempt when it named one, else the
 * latest current attempt that did (a rejected one still has a verdict worth reading).
 */
function shownAttempt(attempts: AttemptRow[], ticketId: string): AttemptRow | undefined {
  const standing = standingAttempt(attempts, ticketId)
  if (standing !== undefined && standing.increment_json !== null) {
    return standing
  }
  const named = attempts.filter((attempt) => attempt.ticket_id === ticketId && attempt.superseded_at === null)
  return named.filter((attempt) => attempt.increment_json !== null).at(-1)
}

/** The increment each sprint with an acceptance node named, in sprint order; sprints that named none are left out. */
export function sprintIncrementViews(bundle: PlanBundle, attempts: AttemptRow[]): SprintIncrementView[] {
  return sortedSprints(bundle).flatMap((sprint) => {
    const node = acceptanceNodeOf(bundle, sprint.id)
    const attempt = node === undefined ? undefined : shownAttempt(attempts, node.id)
    const increment = incrementOf(attempt)
    if (node === undefined || attempt === undefined || increment === null) {
      return []
    }
    return [
      {
        sprintId: sprint.id,
        sprintOrdinal: sprint.ordinal,
        ticketId: node.id,
        key: node.key,
        attemptId: attempt.id,
        attemptState: attempt.state,
        increment
      }
    ]
  })
}

/** One sprint's increment as the views show it, read from the run's own plan and attempts. */
export function sprintIncrementOf(ctx: Ctx, runId: string, sprintId: string): SprintIncrementView | undefined {
  const run = requireRun(ctx, runId)
  const attempts = ctx.db.all<AttemptRow>('SELECT * FROM attempts WHERE run_id = ? ORDER BY rowid', runId)
  return sprintIncrementViews(loadBundle(ctx, run.revision_id), attempts).find((view) => view.sprintId === sprintId)
}
