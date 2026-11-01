/**
 * Pull requests of a folder's GitHub repository: the open ones (cached 60 s per folder), checking one out, and the
 * GitHub URLs for creating one and for a commit. The repository is the one the upstream's remote, else `origin`,
 * names on github.com (as configured, if a rewrite such as `insteadOf` points it at a mirror). API calls go through
 * the session-bound client, so a 401 signs the account out and fails `auth_required`; fetches authenticate as
 * sync does. Nothing GitHub answers is used as a URL: main builds every URL from the repository and the number.
 */
import { randomUUID } from 'node:crypto'
import type { CheckoutPullRequestRequest, CompareUrl, PullRequestInfo, PullRequestSummary } from '../../shared/github/pullRequests'
import type { RepoState } from '../../shared/git/status'
import { checkBranchName, refArg } from '../git/args'
import { listBranches, switchBranch } from '../git/branches'
import type { CredentialSession } from '../git/credentials'
import { GitError, GitInputError } from '../git/errors'
import { currentBranch } from '../git/refs'
import { parseGithubRemote, resolveSyncRemote, type SyncRemote } from '../git/remotes'
import type { GitRunner } from '../git/runner'
import { readRepository, readRepoState } from '../git/status'
import { networkAuth } from '../git/sync'
import { PULL_REQUEST_PAGE_SIZE, type GithubClient, type GithubPullRequest } from './client'
import { GithubError } from './errors'

/** How long a folder's open pull requests are answered from memory. */
const CACHE_MS = 60_000
/** At most this many pages of `PULL_REQUEST_PAGE_SIZE` are read (300 pull requests). */
const MAX_PAGES = 3
const HEADS = 'refs/heads/'

interface PullRequestDeps {
  runner: GitRunner
  session: CredentialSession
  client: Pick<GithubClient, 'listOpenPullRequests'>
  /** Milliseconds; `Date.now` in the app. */
  now?: () => number
  /** Where the person's own ssh settings are read from; `process.env` in the app. */
  env?: NodeJS.ProcessEnv
}

export interface PullRequests {
  /** The open pull requests and the current branch's one; signed out on a GitHub repository, `auth_required`. */
  get(folder: string, refresh: boolean): Promise<PullRequestInfo>
  checkout(folder: string, request: CheckoutPullRequestRequest): Promise<RepoState>
  compareUrl(folder: string): Promise<CompareUrl>
  commitUrl(folder: string, oid: string): Promise<string>
}

interface GithubRepository {
  owner: string
  repo: string
}

/** What the operations read of a folder's repository. */
interface Target {
  root: string
  branch: string | null
  ahead: number
  /** The upstream's branch on its remote (`main`), or null without an upstream. */
  upstreamBranch: string | null
  /** Null when the repository has neither an upstream remote nor `origin`. */
  sync: SyncRemote | null
  repository: GithubRepository | null
}

interface CacheEntry {
  /** The account and repository the answer is for: another of either is a miss. */
  key: string
  at: number
  open: PullRequestSummary[]
}

interface Context extends PullRequestDeps {
  now: () => number
  cache: Map<string, CacheEntry>
}

async function syncRemoteOrNull(runner: GitRunner, root: string, branch: string | null): Promise<SyncRemote | null> {
  try {
    return await resolveSyncRemote(runner, root, branch)
  } catch (error) {
    if (error instanceof GitError && error.code === 'remote_not_found') {
      return null
    }
    throw error
  }
}

/** The github.com repository of `remote`: its URL as git uses it, else as configured (before an `insteadOf` rewrite). */
async function githubRepository(runner: GitRunner, root: string, remote: SyncRemote['remote']): Promise<GithubRepository | null> {
  const rewritten = parseGithubRemote(remote.fetchUrl)
  if (rewritten !== null) {
    return rewritten
  }
  const configured = await runner.run({ cwd: root, args: ['config', '--get', `remote.${remote.name}.url`], kind: 'read', acceptExitCodes: [0, 1, 2] })
  return configured.code === 0 ? parseGithubRemote(configured.stdout.trim()) : null
}

async function readTarget(runner: GitRunner, folder: string): Promise<Target> {
  const status = await readRepository(runner, folder)
  const sync = await syncRemoteOrNull(runner, status.root, status.branch.name)
  const upstreamRef = sync?.upstreamRef ?? null
  return {
    root: status.root,
    branch: status.branch.name,
    ahead: status.branch.ahead,
    upstreamBranch: upstreamRef !== null && upstreamRef.startsWith(HEADS) ? upstreamRef.slice(HEADS.length) : null,
    sync,
    repository: sync === null ? null : await githubRepository(runner, status.root, sync.remote)
  }
}

function requireGithub(target: Target): GithubRepository {
  if (target.repository === null) {
    throw new GitInputError('This repository has no remote on GitHub.')
  }
  return target.repository
}

function repositoryUrl(repository: GithubRepository): string {
  return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`
}

/** A branch name as a URL path: each segment encoded, the slashes kept. */
function branchPath(name: string): string {
  return name.split('/').map(encodeURIComponent).join('/')
}

function summarize(pull: GithubPullRequest, repository: GithubRepository): PullRequestSummary {
  const headRepo = pull.head.repo?.full_name ?? null
  return {
    number: pull.number,
    title: pull.title,
    author: pull.user?.login ?? 'ghost',
    isDraft: pull.draft === true,
    url: `${repositoryUrl(repository)}/pull/${pull.number}`,
    updatedAt: pull.updated_at,
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    headRepoFullName: headRepo,
    fromFork: headRepo === null || headRepo.toLowerCase() !== `${repository.owner}/${repository.repo}`.toLowerCase()
  }
}

/** Up to `MAX_PAGES` pages, stopping at the first one that is not full; a pull request seen twice is kept once. */
async function readPages(client: PullRequestDeps['client'], repository: GithubRepository): Promise<GithubPullRequest[]> {
  const byNumber = new Map<number, GithubPullRequest>()
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const pulls = await client.listOpenPullRequests(repository.owner, repository.repo, page)
    for (const pull of pulls) {
      byNumber.set(pull.number, byNumber.get(pull.number) ?? pull)
    }
    if (pulls.length < PULL_REQUEST_PAGE_SIZE) {
      break
    }
  }
  return [...byNumber.values()]
}

/** The folder's cached answer when it is for this account and repository and less than `CACHE_MS` old. */
function freshCache(context: Context, folder: string, key: string): PullRequestSummary[] | null {
  const cached = context.cache.get(folder)
  if (cached === undefined || cached.key !== key) {
    return null
  }
  const age = context.now() - cached.at
  return age >= 0 && age < CACHE_MS ? cached.open : null
}

/** The open pull requests, from the cache unless `refresh`; `auth_required` signed out (the cache included). */
async function openPullRequests(context: Context, folder: string, repository: GithubRepository, refresh: boolean): Promise<PullRequestSummary[]> {
  const login = context.session.getAccount()?.login
  if (login === undefined || context.session.getToken() === null) {
    throw new GithubError('auth_required')
  }
  const key = `${login}\u0000${repository.owner}/${repository.repo}`.toLowerCase()
  const cached = refresh ? null : freshCache(context, folder, key)
  if (cached !== null) {
    return cached
  }
  const open = (await readPages(context.client, repository)).map((pull) => summarize(pull, repository))
  context.cache.set(folder, { key, at: context.now(), open })
  return open
}

/** The open pull request from this repository whose head is the current branch or its upstream branch. */
function currentOf(open: readonly PullRequestSummary[], target: Target): PullRequestSummary | null {
  if (target.branch === null) {
    return null
  }
  const names = [target.branch, target.upstreamBranch]
  return open.find((pull) => !pull.fromFork && names.includes(pull.headRef)) ?? null
}

async function getPullRequests(context: Context, folder: string, refresh: boolean): Promise<PullRequestInfo> {
  const target = await readTarget(context.runner, folder)
  if (target.repository === null) {
    return { repository: null, current: null, open: [] }
  }
  const open = await openPullRequests(context, folder, target.repository, refresh)
  return { repository: target.repository, current: currentOf(open, target), open }
}

async function requireBranchName(runner: GitRunner, root: string, name: string): Promise<void> {
  let safe = true
  try {
    refArg(name)
  } catch {
    safe = false
  }
  if (!safe || !(await checkBranchName(runner, root, name)).valid) {
    throw new GitInputError("The pull request's branch name is not one Git accepts.")
  }
}

/** Where a checkout happens: the repository, the remote the pull request is fetched from, and the switch rule. */
interface Place {
  root: string
  remote: SyncRemote['remote']
  uncommitted: CheckoutPullRequestRequest['uncommitted']
}

/** `git fetch <remote> <refspec>` with the sync credentials. */
async function fetchRef(context: Context, place: Place, refspec: string): Promise<void> {
  const auth = await networkAuth(context, place.root, place.remote.fetchUrl)
  try {
    await context.runner.run({
      cwd: place.root,
      args: [...auth.args, 'fetch', '--progress', '--', place.remote.name, refspec],
      kind: 'network',
      env: auth.env,
      redact: auth.redact
    })
  } catch (error) {
    throw auth.failure(error)
  }
}

/** Same repository: fetch the head branch, then switch to the local branch tracking it (created when missing). */
async function checkoutBranch(context: Context, place: Place, headRef: string): Promise<RepoState> {
  await requireBranchName(context.runner, place.root, headRef)
  await fetchRef(context, place, `+${HEADS}${headRef}:refs/remotes/${place.remote.name}/${headRef}`)
  return switchBranch(context.runner, place.root, { name: `${place.remote.name}/${headRef}`, uncommitted: place.uncommitted })
}

async function revParse(runner: GitRunner, root: string, ref: string): Promise<string | null> {
  const result = await runner.run({ cwd: root, args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], kind: 'read', acceptExitCodes: [0, 1] })
  return result.code === 0 ? result.stdout.trim() : null
}

async function isAncestor(runner: GitRunner, root: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runner.run({ cwd: root, args: ['merge-base', '--is-ancestor', ancestor, descendant], kind: 'read', acceptExitCodes: [0, 1] })
  return result.code === 0
}

/** Creates `pr/<n>` at `oid` and switches to it; when the switch fails, a branch it left unused is deleted again. */
async function createPullBranch(runner: GitRunner, place: Place, local: string, oid: string): Promise<RepoState> {
  await runner.run({ cwd: place.root, args: ['branch', '--no-track', local, oid], kind: 'write' })
  try {
    return await switchBranch(runner, place.root, { name: local, uncommitted: place.uncommitted })
  } catch (error) {
    if ((await currentBranch(runner, place.root)) !== local) {
      await runner.run({ cwd: place.root, args: ['branch', '-D', '--', local], kind: 'write' })
    }
    throw error
  }
}

/**
 * The commit `refs/pull/<n>/head` points at, fetched into a private ref unique to this checkout that is deleted again,
 * so an overlapping checkout of the same pull request cannot delete it. Not FETCH_HEAD: another fetch (Source control's
 * background fetch) may rewrite that between this fetch and the read.
 */
async function fetchPullHead(context: Context, place: Place, number: number): Promise<string> {
  const ref = `refs/dm/pull/${number}/${randomUUID()}`
  try {
    await fetchRef(context, place, `+refs/pull/${number}/head:${ref}`)
    const oid = await revParse(context.runner, place.root, ref)
    if (oid === null) {
      throw new GitError('git_failed', '', 'Git fetched no commit for the pull request.')
    }
    return oid
  } finally {
    await context.runner.run({ cwd: place.root, args: ['update-ref', '-d', ref], kind: 'write' })
  }
}

/**
 * Fork (or unknown head): fetch `refs/pull/<n>/head` and switch to `pr/<n>`, created there, or fast-forwarded
 * there when it exists. A rewritten pull request fails `rejected_non_fast_forward` before anything changes.
 */
async function checkoutPullRef(context: Context, place: Place, number: number): Promise<RepoState> {
  const { runner } = context
  const local = `pr/${number}`
  const oid = await fetchPullHead(context, place, number)
  const existing = await revParse(runner, place.root, `${HEADS}${local}`)
  if (existing === null) {
    return createPullBranch(runner, place, local, oid)
  }
  if (!(await isAncestor(runner, place.root, existing, oid))) {
    throw new GitError('rejected_non_fast_forward', '', `The pull request was rewritten, so ${local} cannot fast-forward. Delete ${local} to check it out again.`)
  }
  await switchBranch(runner, place.root, { name: local, uncommitted: place.uncommitted })
  if (existing !== oid) {
    await runner.run({ cwd: place.root, args: ['merge', '--ff-only', oid], kind: 'write' })
  }
  return readRepoState(runner, place.root)
}

/** The open pull request `number`: from the cache, else asked again; null when it is not open (or not on GitHub). */
async function findOpen(context: Context, folder: string, target: Target, number: number): Promise<PullRequestSummary | null> {
  if (target.repository === null) {
    return null
  }
  const cached = (await openPullRequests(context, folder, target.repository, false)).find((pull) => pull.number === number)
  return cached ?? (await openPullRequests(context, folder, target.repository, true)).find((pull) => pull.number === number) ?? null
}

async function checkoutPullRequest(context: Context, folder: string, request: CheckoutPullRequestRequest): Promise<RepoState> {
  const target = await readTarget(context.runner, folder)
  const remote = target.sync?.remote
  if (remote === undefined) {
    throw new GitError('remote_not_found', '', 'This repository has no upstream remote and no origin.')
  }
  if (remote.name.startsWith('-')) {
    throw new GitInputError('A remote whose name starts with "-" cannot be used here. Rename it first.')
  }
  const pull = await findOpen(context, folder, target, request.number)
  const place: Place = { root: target.root, remote, uncommitted: request.uncommitted }
  return pull !== null && !pull.fromFork ? checkoutBranch(context, place, pull.headRef) : checkoutPullRef(context, place, request.number)
}

/** GitHub lacks the branch's commits: no upstream, an upstream under another name or gone, or commits ahead of it. */
async function needsPush(runner: GitRunner, target: Target): Promise<boolean> {
  if (target.upstreamBranch !== target.branch || target.ahead > 0) {
    return true
  }
  const upstream = await runner.run({ cwd: target.root, args: ['rev-parse', '--verify', '--quiet', '@{upstream}'], kind: 'read', acceptExitCodes: [0, 1, 128] })
  return upstream.code !== 0
}

async function compareUrl(runner: GitRunner, folder: string): Promise<CompareUrl> {
  const target = await readTarget(runner, folder)
  const repository = requireGithub(target)
  if (target.branch === null) {
    throw new GitInputError('Switch to a branch first: a detached HEAD has no pull request to create.')
  }
  if (await needsPush(runner, target)) {
    return { kind: 'needs_push' }
  }
  const base = (await listBranches(runner, target.root)).defaultBranch
  // Without a known default branch, GitHub compares against the repository's own default.
  const range = base === null ? branchPath(target.branch) : `${branchPath(base)}...${branchPath(target.branch)}`
  return { kind: 'url', url: `${repositoryUrl(repository)}/compare/${range}?expand=1` }
}

export function createPullRequests(deps: PullRequestDeps): PullRequests {
  const context: Context = { ...deps, now: deps.now ?? Date.now, cache: new Map() }
  return {
    get: (folder, refresh) => getPullRequests(context, folder, refresh),
    checkout: (folder, request) => checkoutPullRequest(context, folder, request),
    compareUrl: (folder) => compareUrl(deps.runner, folder),
    commitUrl: async (folder, oid) => `${repositoryUrl(requireGithub(await readTarget(deps.runner, folder)))}/commit/${encodeURIComponent(oid)}`
  }
}
