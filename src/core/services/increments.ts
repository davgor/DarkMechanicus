/**
 * Sprint increments in a run: what verification reads before git is asked (the sprint, the epic branch,
 * the sprint's accepted work, the previous increment), and how the verdicts stored with acceptance-node
 * attempts are read back for the gate and the views. The git questions themselves are in `incrementVerify`.
 */
import type { IncrementRef, SubmitAttemptInput } from '../../shared/domain/api'
import type { EpicBranch, PlanBundle, SprintDef } from '../../shared/domain/bundle'
import type { AttemptOutputs, SprintIncrement, SprintIncrementView } from '../../shared/domain/views'
import { ACTIVE_RUN_STATES, type AttemptState, type RunState } from '../../shared/domain/status'
import type { Ctx } from '../context'
import { parseJson } from '../db/database'
import { acceptanceNodeOf, isAcceptanceTicket, workTicketsOf } from '../plan/acceptance'
import { sortedSprints } from '../plan/graph'
import { type AttemptRow, loadAttempt, loadBundle, requireRun } from './execution'
import type { IncrementContext, RepositoryIncrement } from './incrementVerify'

/** The attempt columns increments read. */
interface IncrementAttempt {
  id: string
  ticket_id: string
  state: AttemptState
  superseded_at: string | null
  increment_json: string | null
}

/**
 * The single verdict stored with an attempt of a single repository. Null for an attempt that named none, and for a
 * folder of repositories' array of verdicts (read by `repositoryIncrementsOf`), so a reader of the single shape
 * never takes one repository's verdict for the node's.
 */
export function incrementOf(attempt: Pick<IncrementAttempt, 'increment_json'> | undefined): SprintIncrement | null {
  const stored = parseJson<SprintIncrement | SprintIncrement[] | null>(attempt?.increment_json, null)
  return Array.isArray(stored) ? null : stored
}

/** The per-repository verdicts a folder of repositories' acceptance node stored, or null when it stored none or one verdict. */
export function storedRepositoryIncrements(attempt: Pick<IncrementAttempt, 'increment_json'> | undefined): SprintIncrement[] | null {
  const stored = parseJson<SprintIncrement | SprintIncrement[] | null>(attempt?.increment_json, null)
  return Array.isArray(stored) ? stored : null
}

/**
 * The attempt that stands for a ticket: its accepted attempt, else its submission awaiting review. An
 * attempt an adopted revision superseded never stands. Attempts are in the order they were made.
 */
export function standingAttempt<T extends IncrementAttempt>(attempts: readonly T[], ticketId: string): T | undefined {
  const own = attempts.filter((attempt) => attempt.ticket_id === ticketId && attempt.superseded_at === null)
  return own.filter((attempt) => attempt.state === 'accepted').at(-1) ?? own.filter((attempt) => attempt.state === 'submitted').at(-1)
}

/**
 * The nearest earlier sprint whose standing acceptance attempt carries a passing verdict. For repository `repo` of a
 * folder of repositories: the nearest earlier sprint whose standing acceptance attempt passed (every repository's
 * verdict passed) and touched `repo`, with `repo`'s own increment; an earlier sprint that did not touch it is skipped.
 */
function previousIncrement(bundle: PlanBundle, sprint: SprintDef, attempts: AttemptRow[], repo: string | null): IncrementContext['previous'] {
  const earlier = sortedSprints(bundle)
    .filter((item) => item.ordinal < sprint.ordinal)
    .reverse()
  for (const item of earlier) {
    const node = acceptanceNodeOf(bundle, item.id)
    const standing = node === undefined ? undefined : standingAttempt(attempts, node.id)
    const verdict = repo === null ? incrementOf(standing) : repositoryVerdict(storedRepositoryIncrements(standing), repo)
    if (verdict?.passed === true) {
      return { sprintId: item.id, commit: verdict.commit }
    }
  }
  return null
}

/** `repo`'s verdict among a node's per-repository verdicts, only when every one of them passed (fail closed). */
function repositoryVerdict(verdicts: SprintIncrement[] | null, repo: string): SprintIncrement | null {
  if (verdicts === null || verdicts.length === 0 || !verdicts.every((verdict) => verdict.passed === true)) {
    return null
  }
  return verdicts.find((verdict) => verdict.repo === repo) ?? null
}

/**
 * Every commit the accepted, current attempts of the sprint's work tickets recorded, once each; for repository `repo`,
 * only those of the work tickets that target it. A work ticket carried forward from an earlier run counts too: its
 * `carry_forward` attempt holds the earlier run's commits.
 */
function acceptedWorkCommits(bundle: PlanBundle, sprint: SprintDef, attempts: AttemptRow[], repo: string | null): string[] {
  const tickets = workTicketsOf(bundle, sprint.id).filter((ticket) => repo === null || ticket.repo === repo)
  const ids = new Set(tickets.map((ticket) => ticket.id))
  const recorded = attempts
    .filter((attempt) => ids.has(attempt.ticket_id))
    .filter((attempt) => attempt.state === 'accepted' && attempt.superseded_at === null)
    .flatMap((attempt) => parseJson<AttemptOutputs | null>(attempt.outputs_json, null)?.commits ?? [])
  return [...new Set(recorded)]
}

/**
 * The repositories a sprint touched: the `repo` of each of its work tickets with an accepted, current attempt, each
 * once, in name order. Read from the run that executes the sprint: the epic's active run, else its latest. Empty for
 * a sprint no run executes, and for a single repository (no ticket names a repository).
 */
export function touchedRepositories(ctx: Ctx, sprintId: string): string[] {
  const runs = ctx.db.all<{ id: string; revision_id: string; state: RunState }>('SELECT id, revision_id, state FROM runs ORDER BY rowid DESC')
  const active = runs.filter((run) => ACTIVE_RUN_STATES.includes(run.state))
  for (const run of [...active, ...runs.filter((run) => !active.includes(run))]) {
    const bundle = loadBundle(ctx, run.revision_id)
    if (!bundle.sprints.some((sprint) => sprint.id === sprintId)) {
      continue
    }
    const repoOf = new Map(workTicketsOf(bundle, sprintId).flatMap((ticket) => (ticket.repo === undefined ? [] : [[ticket.id, ticket.repo] as const])))
    const accepted = ctx.db.all<{ ticket_id: string }>(
      "SELECT ticket_id FROM attempts WHERE run_id = ? AND state = 'accepted' AND superseded_at IS NULL",
      run.id
    )
    return [...new Set(accepted.flatMap((attempt) => repoOf.get(attempt.ticket_id) ?? []))].sort()
  }
  return []
}

/**
 * What verifying the increment named by this attempt needs, or null when the attempt is not on a sprint's
 * acceptance node (or does not exist). Read-only; the git questions come after. With `repo` (a folder of
 * repositories), everything is that repository's: its bound epic branch (null when none is bound), its previous
 * increment, and the commits of the accepted work tickets that target it.
 */
export function incrementContextOf(ctx: Ctx, attemptId: string, repo: string | null = null): IncrementContext | null {
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
  const epic = ctx.db.get<{ branch_json: string | null; repository_branches_json: string | null }>(
    'SELECT branch_json, repository_branches_json FROM epics WHERE id = ?',
    run.epic_id
  )
  const epicBranch =
    repo === null
      ? parseJson<EpicBranch | null>(epic?.branch_json, null)
      : (parseJson<EpicBranch[]>(epic?.repository_branches_json, []).find((branch) => branch.repository === repo) ?? null)
  return {
    sprintId: sprint.id,
    epicBranch,
    previous: previousIncrement(bundle, sprint, attempts, repo),
    workCommits: acceptedWorkCommits(bundle, sprint, attempts, repo)
  }
}

/** Why a submission's increments cannot be taken, for an `invalid_input` refusal. */
interface IncrementRefusal {
  message: string
  details: Record<string, unknown>
}

/**
 * Checks the shape of the increments an acceptance node's submission names against the project, before git is asked.
 * A single repository takes `increment` alone, without a `repo`. A folder of repositories takes `increments` alone,
 * exactly one per repository the sprint touched (`touchedRepositories`); a singular `increment`, an entry without a
 * `repo`, an unknown, untouched or duplicate repository, and a touched repository left out are refused. Null when the
 * submission names nothing or is acceptable. The caller refuses with `invalid_input`, naming the ticket.
 */
export function incrementRefusal(ctx: Ctx, sprintId: string, input: Pick<SubmitAttemptInput, 'increment' | 'increments'>): IncrementRefusal | null {
  const listed = ctx.repositories()
  if (listed === null) {
    if (input.increments !== undefined) {
      return { message: 'this project is a single repository: name the increment as increment { branch, commit }, not increments.', details: {} }
    }
    const repo = input.increment?.repo
    return repo === undefined
      ? null
      : { message: `this project is a single repository: the increment can't name the repository ${JSON.stringify(repo)}.`, details: { repository: repo } }
  }
  if (input.increment !== undefined) {
    return {
      message: 'this project is a folder of repositories: name increments, one { repo, branch, commit } per repository the sprint touched, not a single increment.',
      details: {}
    }
  }
  return input.increments === undefined ? null : repositoriesRefusal(listed, touchedRepositories(ctx, sprintId), input.increments)
}

function repositoriesRefusal(listed: string[], touched: string[], increments: IncrementRef[]): IncrementRefusal | null {
  const seen = new Set<string>()
  for (const named of increments) {
    const repo = named.repo
    if (repo === undefined) {
      return { message: `the increment at commit ${named.commit} names no repository; each increment names its repo.`, details: { commit: named.commit } }
    }
    const quoted = JSON.stringify(repo)
    if (!listed.includes(repo)) {
      return { message: `an increment names ${quoted}, which is not a repository of this project.`, details: { repository: repo } }
    }
    if (!touched.includes(repo)) {
      return {
        message: `an increment names ${quoted}, which this sprint did not touch: no accepted work ticket of the sprint targets it.`,
        details: { repository: repo, touched }
      }
    }
    if (seen.has(repo)) {
      return { message: `more than one increment names ${quoted}; name one per repository.`, details: { repository: repo } }
    }
    seen.add(repo)
  }
  if (touched.length === 0) {
    return { message: 'the sprint touched no repository (no accepted work ticket targets one), so it has no increment to name.', details: { touched } }
  }
  const missing = touched.filter((repo) => !seen.has(repo))
  return missing.length === 0
    ? null
    : {
        message: `no increment names ${missing.map((repo) => JSON.stringify(repo)).join(', ')}, which this sprint touched; name one per touched repository.`,
        details: { missing, touched }
      }
}

/**
 * What verifying a folder of repositories' increments needs: each named increment with its repository's context, in
 * repository name order. Null when the attempt is not on an acceptance node, or `incrementRefusal` refuses the
 * submission (which `submitAttempt` then refuses after checking the claim), so git is never asked about a refused one.
 */
export function repositoryIncrementsOf(ctx: Ctx, attemptId: string, increments: IncrementRef[]): RepositoryIncrement[] | null {
  const own = incrementContextOf(ctx, attemptId)
  if (own === null || incrementRefusal(ctx, own.sprintId, { increments }) !== null) {
    return null
  }
  // Accepted, so the increments name exactly the touched repositories, once each: take them in that (name) order.
  const entries: RepositoryIncrement[] = []
  for (const repo of touchedRepositories(ctx, own.sprintId)) {
    const named = increments.find((item) => item.repo === repo)
    const context = incrementContextOf(ctx, attemptId, repo)
    if (named === undefined || context === null) {
      return null
    }
    entries.push({ repo, named, context })
  }
  return entries
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

/**
 * The increment each sprint with an acceptance node named, in sprint order; sprints that named none are left out. A
 * folder of repositories' sprint shows one view per repository it stored a verdict for, in repository name order.
 */
export function sprintIncrementViews(bundle: PlanBundle, attempts: AttemptRow[]): SprintIncrementView[] {
  return sortedSprints(bundle).flatMap((sprint) => {
    const node = acceptanceNodeOf(bundle, sprint.id)
    const attempt = node === undefined ? undefined : shownAttempt(attempts, node.id)
    if (node === undefined || attempt === undefined) {
      return []
    }
    const base = { sprintId: sprint.id, sprintOrdinal: sprint.ordinal, ticketId: node.id, key: node.key, attemptId: attempt.id, attemptState: attempt.state }
    const perRepository = storedRepositoryIncrements(attempt)
    if (perRepository !== null) {
      // Name order as `touchedRepositories` sorts them (code units), whatever order they were stored in.
      return [...perRepository]
        .sort((a, b) => ((a.repo ?? '') < (b.repo ?? '') ? -1 : 1))
        .map((increment) => ({ ...base, ...(increment.repo === undefined ? {} : { repo: increment.repo }), increment }))
    }
    const increment = incrementOf(attempt)
    return increment === null ? [] : [{ ...base, increment }]
  })
}
