/**
 * Verifies the increment a sprint's acceptance node names: the sprint reached the epic branch as one
 * squashed commit. It asks the Git adapter read-only questions only, and it never trusts the submission:
 * the branch it measures against is the epic's own, and the work commits it compares are the ones the
 * sprint's accepted work attempts recorded. The verdict is a list of checks; the increment passes unless
 * one of them failed, and a skipped check (one git could not be asked) does not count against it.
 */
import type { IncrementRef } from '../../shared/domain/api'
import type { EpicBranch } from '../../shared/domain/bundle'
import type { CheckStatus, SprintIncrement } from '../../shared/domain/views'
import type { GitAdapter } from '../repo/types'

/** What verification needs to know about the sprint and the epic, read from the run before git is asked. */
export interface IncrementContext {
  sprintId: string
  /** The epic's integration branch and start commit; null when no branch was bound. */
  epicBranch: EpicBranch | null
  /** The nearest earlier sprint's verified increment in this run, if any. */
  previous: { sprintId: string; commit: string } | null
  /** Every commit the sprint's accepted work attempts recorded. */
  workCommits: string[]
}

type Check = SprintIncrement['checks'][number]

interface Commit {
  commit: string
  parents: string[]
}

/** The answers every check draws on, gathered once. */
interface Subject {
  git: GitAdapter
  named: IncrementRef
  epic: EpicBranch | null
  /** `refs/heads/<epic branch>`: a full ref, so a tag of the same name can never stand in for the branch. */
  ref: string | null
  /** The named commit as git resolves it; null when the repository does not have it. */
  found: Commit | null
  /** The epic branch's tip; null when the branch is not in the repository. */
  tip: Commit | null
  base: SprintIncrement['base']
  workCommits: string[]
}

const NAME = {
  branch: 'Epic branch',
  exists: 'Commit exists',
  parent: 'One parent',
  reachable: 'On the epic branch',
  base: 'After the base commit',
  squashed: 'Squashed, not merged'
} as const

const COMMIT_HASH = /^[0-9a-fA-F]{7,64}$/
/** Recorded commits are looked up this many at a time. */
const BATCH = 8
const LISTED = 5

function check(name: string, status: CheckStatus, detail: string): Check {
  return { name, status, detail }
}

function short(commit: string): string {
  return commit.slice(0, 7)
}

function commits(count: number): string {
  return count === 1 ? '1 commit' : `${count} commits`
}

function baseOf(context: IncrementContext): SprintIncrement['base'] {
  if (context.previous !== null) {
    return { kind: 'previous_increment', commit: context.previous.commit }
  }
  const start = context.epicBranch?.startCommit ?? null
  return start === null ? { kind: 'none', commit: null } : { kind: 'epic_start', commit: start }
}

function branchCheck(subject: Subject): Check {
  const { epic, named } = subject
  if (epic === null) {
    return check(NAME.branch, 'failed', 'The epic has no integration branch; bind one with set_epic_branch before naming an increment.')
  }
  if (named.branch !== epic.name) {
    return check(NAME.branch, 'failed', `The increment names branch "${named.branch}", but the epic's integration branch is "${epic.name}".`)
  }
  return check(NAME.branch, 'passed', `Names the epic branch ${epic.name}.`)
}

function existsCheck(subject: Subject): Check {
  const { found, named } = subject
  return found === null
    ? check(NAME.exists, 'failed', `Commit ${named.commit} was not found in the repository.`)
    : check(NAME.exists, 'passed', `Commit ${short(found.commit)} exists.`)
}

function parentCheck(subject: Subject): Check {
  const { found } = subject
  if (found === null) {
    return check(NAME.parent, 'skipped', 'The commit was not found.')
  }
  const id = short(found.commit)
  if (found.parents.length === 1) {
    return check(NAME.parent, 'passed', `Commit ${id} has one parent, ${short(found.parents[0] ?? '')}.`)
  }
  const detail =
    found.parents.length === 0
      ? `Commit ${id} has no parent (a root commit); a sprint increment is one squashed commit on top of the branch.`
      : `Commit ${id} has ${found.parents.length} parents (a merge commit); squash the sprint onto the branch instead of merging it.`
  return check(NAME.parent, 'failed', detail)
}

async function reachableCheck(subject: Subject): Promise<Check> {
  const { epic, ref, found, tip } = subject
  if (epic === null || ref === null) {
    return check(NAME.reachable, 'skipped', 'The epic has no integration branch.')
  }
  if (found === null) {
    return check(NAME.reachable, 'skipped', 'The commit was not found.')
  }
  if (tip === null) {
    return check(NAME.reachable, 'failed', `The epic branch ${epic.name} was not found in the repository.`)
  }
  const reachable = await subject.git.isAncestor(found.commit, ref)
  if (reachable === true) {
    return check(NAME.reachable, 'passed', `Commit ${short(found.commit)} is reachable from ${epic.name}.`)
  }
  const detail =
    reachable === false
      ? `Commit ${short(found.commit)} is not reachable from ${epic.name}; land the sprint on that branch first.`
      : `Git could not tell whether commit ${short(found.commit)} is on ${epic.name}.`
  return check(NAME.reachable, 'failed', detail)
}

/** Previous increment: the commit must not already be part of what the earlier sprint delivered. */
async function afterPrevious(subject: Subject, found: Commit, previous: string): Promise<Check> {
  const inside = await subject.git.isAncestor(found.commit, previous)
  if (inside === false) {
    return check(NAME.base, 'passed', `Commit ${short(found.commit)} is not part of the previous sprint's increment ${short(previous)}.`)
  }
  const detail =
    inside === true
      ? `Commit ${short(found.commit)} is already part of the previous sprint's increment ${short(previous)}.`
      : `Commit ${short(found.commit)} cannot be compared with the previous sprint's increment ${short(previous)}: git does not have it.`
  return check(NAME.base, 'failed', detail)
}

/** Epic start: the commit must come strictly after the commit the epic branch started from. */
async function afterStart(subject: Subject, found: Commit, start: string): Promise<Check> {
  const [inside, descends] = await Promise.all([
    subject.git.isAncestor(found.commit, start),
    subject.git.isAncestor(start, found.commit)
  ])
  const id = short(found.commit)
  if (descends === null) {
    return check(NAME.base, 'failed', `The epic's start commit ${short(start)} was not found in the repository.`)
  }
  if (inside === true) {
    return check(NAME.base, 'failed', `Commit ${id} is the epic's start commit or older, so it adds nothing after the start commit.`)
  }
  if (descends === false) {
    return check(NAME.base, 'failed', `Commit ${id} does not come after the epic's start commit ${short(start)}.`)
  }
  return check(NAME.base, 'passed', `Commit ${id} comes after the epic's start commit ${short(start)}.`)
}

async function baseCheck(subject: Subject): Promise<Check> {
  const { found, base } = subject
  if (found === null) {
    return check(NAME.base, 'skipped', 'The commit was not found.')
  }
  if (base.kind === 'previous_increment' && base.commit !== null) {
    return afterPrevious(subject, found, base.commit)
  }
  if (base.kind === 'epic_start' && base.commit !== null) {
    return afterStart(subject, found, base.commit)
  }
  return check(
    NAME.base,
    'skipped',
    'The epic branch has no start commit and no earlier sprint has a verified increment, so there is no base to place the commit after.'
  )
}

async function reachableFrom(git: GitAdapter, candidates: string[], ref: string): Promise<(boolean | null)[]> {
  const answers: (boolean | null)[] = []
  for (let start = 0; start < candidates.length; start += BATCH) {
    answers.push(...(await Promise.all(candidates.slice(start, start + BATCH).map((commit) => git.isAncestor(commit, ref)))))
  }
  return answers
}

function listed(ids: string[]): string {
  const shown = ids.slice(0, LISTED).map(short).join(', ')
  return ids.length > LISTED ? `${shown} and ${ids.length - LISTED} more` : shown
}

/** The sprint was squashed, not merged: none of the commits its accepted work recorded is on the epic branch. */
async function squashedCheck(subject: Subject): Promise<Check> {
  const { epic, ref, tip } = subject
  const candidates = [...new Set(subject.workCommits.filter((item) => COMMIT_HASH.test(item)))]
  if (epic === null || ref === null) {
    return check(NAME.squashed, 'skipped', 'The epic has no integration branch.')
  }
  if (candidates.length === 0) {
    return check(NAME.squashed, 'skipped', 'No accepted work ticket of this sprint recorded a commit hash, so there is nothing to compare.')
  }
  if (tip === null) {
    return check(NAME.squashed, 'skipped', `The epic branch ${epic.name} was not found in the repository.`)
  }
  const answers = await reachableFrom(subject.git, candidates, ref)
  const merged = candidates.filter((_, index) => answers[index] === true)
  if (merged.length > 0) {
    const detail = `${commits(merged.length)} recorded by this sprint's accepted work ${merged.length === 1 ? 'is' : 'are'} reachable from ${epic.name}, so the sprint was merged rather than squashed: ${listed(merged)}.`
    return check(NAME.squashed, 'failed', detail)
  }
  const unknown = answers.filter((answer) => answer === null).length
  const missing = unknown === 0 ? '' : ` ${unknown} recorded ${unknown === 1 ? 'commit is' : 'commits are'} not in this repository and ${unknown === 1 ? 'was' : 'were'} not checked.`
  return check(NAME.squashed, 'passed', `None of the ${commits(candidates.length)} recorded by this sprint's accepted work is reachable from ${epic.name}.${missing}`)
}

/**
 * Checks the increment a sprint's acceptance node named and returns the verdict. Never throws for a
 * commit or branch git does not know: those are failed checks with a reason.
 */
export async function verifyIncrement(
  git: GitAdapter,
  context: IncrementContext,
  named: IncrementRef,
  verifiedAt: string
): Promise<SprintIncrement> {
  const epic = context.epicBranch
  const ref = epic === null ? null : `refs/heads/${epic.name}`
  const [found, tip] = await Promise.all([git.commitParents(named.commit), ref === null ? null : git.commitParents(ref)])
  const subject: Subject = { git, named, epic, ref, found, tip, base: baseOf(context), workCommits: context.workCommits }
  const checks = [
    branchCheck(subject),
    existsCheck(subject),
    parentCheck(subject),
    await reachableCheck(subject),
    await baseCheck(subject),
    await squashedCheck(subject)
  ]
  const failed = checks.filter((item) => item.status === 'failed')
  return {
    branch: named.branch,
    commit: found?.commit ?? named.commit,
    parent: found?.parents.length === 1 ? (found.parents[0] ?? null) : null,
    base: subject.base,
    passed: failed.length === 0,
    reasons: failed.map((item) => item.detail),
    checks,
    verifiedAt
  }
}
