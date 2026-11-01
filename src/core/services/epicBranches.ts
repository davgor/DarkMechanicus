/**
 * The epic branch of a folder of repositories. The folder itself has no checkout, so the branch name comes from
 * the epic or from `start_run`, and the epic's `branch` is `{ repository: null, name, startCommit: null }`. Each
 * repository a work ticket of the run's saved plan names is bound to that name once, with its own start commit,
 * in `epics.repository_branches_json`.
 */
import type { EpicBranch, PlanBundle } from '../../shared/domain/bundle'
import type { Ctx } from '../context'
import { parseJson, toJson } from '../db/database'
import { fail } from '../errors'
import { appendEvent } from './events'
import { loadBundle } from './execution'
import { enqueueOutbox } from './outbox'

interface EpicBranchRow {
  branch_json: string | null
  repository_branches_json: string | null
}

/** True for a folder of repositories (the project lists its repositories), false for a single repository. */
export function isRepositoryFolder(ctx: Ctx): boolean {
  return ctx.repositories() !== null
}

/** Refuses a run of a folder of repositories whose epic has no branch name when none is supplied either. */
export function requireFolderBranchName(ctx: Ctx, epic: { id: string; branch_json: string | null }, requested: EpicBranch | null): void {
  if (isRepositoryFolder(ctx) && epic.branch_json === null && requested === null) {
    fail(
      'invalid_input',
      'Set the epic branch first: a folder of repositories has no checkout to take the branch name from.',
      { epicId: epic.id }
    )
  }
}

/** The repositories the plan's work tickets name, each once, in name order. */
function repositoriesOf(bundle: PlanBundle): string[] {
  const names = new Set<string>()
  for (const ticket of bundle.tickets) {
    if (ticket.kind !== 'acceptance' && ticket.repo !== undefined) {
      names.add(ticket.repo)
    }
  }
  return [...names].sort()
}

/**
 * Binds `name` in each repository the revision's work tickets name that `bound` does not hold yet. It starts at the
 * repository's existing branch of that name, else at its HEAD.
 */
function bindUnbound(ctx: Ctx, bound: EpicBranch[], revisionId: string, name: string): EpicBranch[] {
  const boundNames = new Set(bound.map((entry) => entry.repository))
  return repositoriesOf(loadBundle(ctx, revisionId))
    .filter((repository) => !boundNames.has(repository))
    .map((repository) => {
      const git = ctx.gitFor(repository)
      return { repository, name, startCommit: git.branchCommit(name) ?? git.head()?.commit ?? null }
    })
}

/**
 * Binds the epic branch of a folder of repositories: the epic's own branch when it has none (from `requestedName`),
 * and every repository the saved revision's work tickets name that is not bound yet. A bound repository is never
 * rebound. Does nothing for a single repository, or when there is no branch name to bind (callers that need one
 * refuse first with `requireFolderBranchName`). Appends `epic.branch_set` naming what it bound.
 */
export function bindRepositoryBranches(ctx: Ctx, epicId: string, revisionId: string, requestedName: string | null): void {
  if (!isRepositoryFolder(ctx)) {
    return
  }
  const row =
    ctx.db.get<EpicBranchRow>('SELECT branch_json, repository_branches_json FROM epics WHERE id = ?', epicId) ??
    fail('not_found', `Epic ${epicId} not found.`, { epicId })
  const existing = parseJson<EpicBranch | null>(row.branch_json, null)
  const name = existing?.name ?? requestedName
  if (name === null) {
    return
  }
  const branch = existing ?? { repository: null, name, startCommit: null }
  const bound = parseJson<EpicBranch[]>(row.repository_branches_json, [])
  const added = bindUnbound(ctx, bound, revisionId, name)
  if (existing !== null && added.length === 0) {
    return
  }
  const repositoryBranches = [...bound, ...added]
  ctx.db.run(
    'UPDATE epics SET branch_json = ?, repository_branches_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
    toJson(branch),
    repositoryBranches.length === 0 ? null : toJson(repositoryBranches),
    ctx.clock.nowIso(),
    epicId
  )
  appendEvent(ctx, { kind: 'epic.branch_set', epicId, payload: { branch, repositoryBranches: added } })
  enqueueOutbox(ctx, { kind: 'epic_state', epicId })
}
