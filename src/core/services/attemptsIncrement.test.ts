/** Submitting an acceptance node: the verdict the command layer verified is stored with the submission. */
import { afterEach, describe, expect, it } from 'vitest'
import type { IncrementRef } from '../../shared/domain/api'
import type { PlanBundle } from '../../shared/domain/bundle'
import { makeBundle, tid } from '../../test/bundles'
import { incrementVerdict, seedAttempt, seedRun, type SeededRun } from '../../test/checkpointSeed'
import { attemptRow, claim, domainError, lastEventPayload, startedRun } from '../../test/execution'
import { copyGitRepo, createGitRepo, type GitRepo } from '../../test/gitRepo'
import { useTemplate } from '../../test/gitTemplate'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { DomainError } from '../errors'
import { createGitAdapter } from '../repo/git'
import { acceptAttempt, reconcileAttempt, rejectAttempt, submitAttempt } from './attempts'
import { attemptView } from './execution'
import { incrementContextOf, repositoryIncrementsOf } from './increments'
import { verifyIncrement, verifyRepositoryIncrements } from './incrementVerify'

const NAMED = { branch: 'epic/x', commit: 'c'.repeat(40) }

/** Sprint = {DM-1, DM-2}; DM-2 is the acceptance node, which requires DM-1. */
function plan(): PlanBundle {
  const bundle = makeBundle([[1, 2]])
  bundle.tickets = bundle.tickets.map((ticket) => (ticket.id === tid(2) ? { ...ticket, kind: 'acceptance' as const } : ticket))
  return bundle
}

/** A run whose work ticket is accepted, with the acceptance node claimed. */
function nodeClaim(ctx: TestCtx) {
  const { runId } = startedRun(ctx, { bundle: plan() })
  const work = claim(ctx, runId, 1)
  submitAttempt(ctx, { attemptId: work.attempt.id, claimToken: work.packet.claimToken, outputs: { summary: 'done' } })
  acceptAttempt(ctx, { attemptId: work.attempt.id })
  return { runId, node: claim(ctx, runId, 2), work }
}

describe('submitAttempt on an acceptance node that names an increment', () => {
  it('stores the verified verdict with the submission and shows it on the attempt', () => {
    const ctx = createTestCtx()
    const { node } = nodeClaim(ctx)
    const verdict = incrementVerdict()
    const view = submitAttempt(
      ctx,
      { attemptId: node.attempt.id, claimToken: node.packet.claimToken, outputs: { summary: 'Merged.' }, increment: NAMED },
      verdict
    )
    expect(view.state).toBe('submitted')
    expect(view.increment).toEqual(verdict)
    expect(attemptView(attemptRow(ctx, node.attempt.id)).increment).toEqual(verdict)
    expect(JSON.parse(attemptRow(ctx, node.attempt.id).increment_json ?? 'null')).toEqual(verdict)
  })

  it('records the commit and the verdict in the submitted event', () => {
    const ctx = createTestCtx()
    const { node } = nodeClaim(ctx)
    submitAttempt(
      ctx,
      { attemptId: node.attempt.id, claimToken: node.packet.claimToken, outputs: { summary: 'Merged.' }, increment: NAMED },
      incrementVerdict({ passed: false, reasons: ['not squashed'] })
    )
    expect(lastEventPayload(ctx, 'attempt.submitted')).toMatchObject({
      attemptId: node.attempt.id,
      increment: { commit: 'c'.repeat(40), passed: false }
    })
  })

  it('stores a failed verdict instead of rejecting the submission, so the gate stays unmet and the node can be retried', () => {
    const ctx = createTestCtx()
    const { node, runId } = nodeClaim(ctx)
    const failed = incrementVerdict({ passed: false, reasons: ['Commit ccccccc has 2 parents (a merge commit).'] })
    const view = submitAttempt(
      ctx,
      { attemptId: node.attempt.id, claimToken: node.packet.claimToken, outputs: { summary: 'Merged.' }, increment: NAMED },
      failed
    )
    expect(view).toMatchObject({ state: 'submitted', increment: { passed: false, reasons: failed.reasons } })
    expect(attemptRow(ctx, node.attempt.id).state).toBe('submitted')
    rejectAttempt(ctx, { attemptId: node.attempt.id, reasons: failed.reasons })
    expect(claim(ctx, runId, 2).attempt).toMatchObject({ number: 2, state: 'claimed' })
  })
})

describe('submitAttempt without an increment, or with one it must refuse', () => {
  it('leaves the verdict empty when the node names none, and for every work ticket', () => {
    const ctx = createTestCtx()
    const { node, work } = nodeClaim(ctx)
    expect(attemptRow(ctx, work.attempt.id).increment_json).toBeNull()
    const view = submitAttempt(ctx, { attemptId: node.attempt.id, claimToken: node.packet.claimToken, outputs: { summary: 'Done.' } })
    expect(Object.keys(view)).not.toContain('increment')
    expect(attemptRow(ctx, node.attempt.id).increment_json).toBeNull()
  })

  it('refuses a work ticket that names an increment, leaving its claim open', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: plan() })
    const work = claim(ctx, runId, 1)
    const input = { attemptId: work.attempt.id, claimToken: work.packet.claimToken, outputs: { summary: 'done' }, increment: NAMED }
    const error = domainError(() => submitAttempt(ctx, input, incrementVerdict()))
    expect(error.code).toBe('invalid_input')
    expect(error.message).toContain('DM-1')
    expect(attemptRow(ctx, work.attempt.id).state).toBe('claimed')
    expect(attemptRow(ctx, work.attempt.id).increment_json).toBeNull()
  })

  it('refuses to store an increment nobody verified', () => {
    const ctx = createTestCtx()
    const { node } = nodeClaim(ctx)
    const input = { attemptId: node.attempt.id, claimToken: node.packet.claimToken, outputs: { summary: 'Merged.' }, increment: NAMED }
    expect(domainError(() => submitAttempt(ctx, input)).code).toBe('internal')
    expect(attemptRow(ctx, node.attempt.id).state).toBe('claimed')
  })

  it("refuses to store a folder's per-repository verdicts for a single repository's increment", () => {
    const ctx = createTestCtx()
    const { node } = nodeClaim(ctx)
    const input = { attemptId: node.attempt.id, claimToken: node.packet.claimToken, outputs: { summary: 'Merged.' }, increment: NAMED }
    const error = domainError(() => submitAttempt(ctx, input, [{ ...incrementVerdict(), repo: 'alpha' }]))
    expect([error.code, error.message]).toEqual(['internal', 'The increment was not verified before it was stored.'])
    expect(attemptRow(ctx, node.attempt.id)).toMatchObject({ state: 'claimed', increment_json: null })
  })

  it('checks the claim token before anything about the increment', () => {
    const ctx = createTestCtx()
    const { node } = nodeClaim(ctx)
    const input = { attemptId: node.attempt.id, claimToken: `${node.attempt.id}.wrong`, outputs: { summary: 'Merged.' }, increment: NAMED }
    expect(domainError(() => submitAttempt(ctx, input, incrementVerdict())).code).toBe('stale_claim')
    expect(attemptRow(ctx, node.attempt.id).increment_json).toBeNull()
  })
})

describe('submitAttempt with an idempotency key', () => {
  it('returns the stored submission for a repeat, and refuses the key for a different increment', () => {
    const ctx = createTestCtx()
    const { node } = nodeClaim(ctx)
    const input = {
      attemptId: node.attempt.id,
      claimToken: node.packet.claimToken,
      outputs: { summary: 'Merged.' },
      increment: NAMED,
      idempotencyKey: 'submit-node-1'
    }
    const first = submitAttempt(ctx, input, incrementVerdict())
    expect(submitAttempt(ctx, input, incrementVerdict({ passed: false, reasons: ['changed'] }))).toEqual(first)
    const other = { ...input, increment: { ...NAMED, commit: 'd'.repeat(40) } }
    expect(domainError(() => submitAttempt(ctx, other, incrementVerdict())).code).toBe('idempotency_mismatch')
  })
})

describe('reconcileAttempt resubmitting an acceptance node', () => {
  it('stores no increment, so the gate stays unmet until a submission names one', () => {
    const ctx = createTestCtx()
    const { node } = nodeClaim(ctx)
    ctx.clock.advanceSeconds(3600)
    const view = reconcileAttempt(ctx, {
      attemptId: node.attempt.id,
      resolution: 'resubmit',
      outputs: { summary: 'Finished after the lease ran out.' }
    })
    expect(view.state).toBe('submitted')
    expect(Object.keys(view)).not.toContain('increment')
  })
})

const EPIC = 'epic/multi'
const REPOS = ['alpha', 'beta', 'gamma'] as const
/** The repository each work ticket targets; DM-3 and DM-6 are the acceptance nodes. */
const REPO_OF: Record<number, string> = { 1: 'alpha', 2: 'beta', 4: 'alpha', 5: 'gamma' }

/** Sprint 1 = {DM-1 alpha, DM-2 beta, DM-3}; sprint 2 = {DM-4 alpha, DM-5 gamma, DM-6}; gamma is untouched in sprint 1. */
function folderPlan(): PlanBundle {
  const bundle = makeBundle([
    [1, 2, 3],
    [4, 5, 6]
  ])
  bundle.tickets = bundle.tickets.map((ticket, index) => {
    const repo = REPO_OF[index + 1]
    if (repo !== undefined) {
      return { ...ticket, repo, title: `${repo} - ${ticket.title}` }
    }
    return { ...ticket, kind: 'acceptance' as const }
  })
  return bundle
}

type RepoName = (typeof REPOS)[number]

interface Folder {
  ctx: TestCtx
  run: SeededRun
  repos: Record<RepoName, GitRepo>
  /** Each repository's epic branch start commit, as bound for the run. */
  start: Record<RepoName, string>
  /** Sprint 1's work in alpha (squashed) and beta (squashed or merged), already on their epic branches. */
  work: { alpha: Landed; beta: Landed }
}

/** A worker's commits on `branch` off the epic branch, squashed onto the epic branch as the sprint's increment. */
function land(repo: GitRepo, branch: string, messages: string[]): { commits: string[]; squash: string } {
  repo.branch(branch)
  const commits = messages.map((message) => repo.commit(message))
  repo.switchTo(EPIC)
  return { commits, squash: repo.squash(branch, `sprint: ${branch}`) }
}

/** The acceptance node's attempt, live and claimed, with its claim token. */
function liveNode(folder: Folder, ticket: number): { attemptId: string; claimToken: string } {
  const attemptId = seedAttempt(folder.ctx, folder.run, { ticket, state: 'running' })
  folder.ctx.db.run("UPDATE attempts SET claim_secret = 'secret', lease_expires_at = ? WHERE id = ?", '2999-01-01T00:00:00.000Z', attemptId)
  return { attemptId, claimToken: `${attemptId}.secret` }
}

/** What `submit_attempt` does with `increments`: verify each touched repository's increment in it, then submit. */
async function submitIncrements(folder: Folder, node: { attemptId: string; claimToken: string }, increments: IncrementRef[]) {
  const { ctx } = folder
  const entries = repositoryIncrementsOf(ctx, node.attemptId, increments)
  const verified = entries === null ? undefined : await verifyRepositoryIncrements((repo) => ctx.gitFor(repo), entries, ctx.clock.nowIso())
  return submitAttempt(ctx, { ...node, outputs: { summary: 'Landed.' }, increments }, verified)
}

function named(repo: string, commit: string): IncrementRef {
  return { repo, branch: EPIC, commit }
}

type Landed = { commits: string[]; squash: string }
/** How beta's sprint 1 work reached the epic branch. */
type BetaShape = 'squash' | 'merge'

/** A template repository on the epic branch, and its start commit. */
interface Started {
  repo: GitRepo
  start: string
}

/** A template repository with the sprint 1 work landed in it. */
interface Built extends Started {
  work: Landed
}

/**
 * alpha, beta and gamma, each with the epic branch at its own start commit, and sprint 1's work landed: in alpha
 * squashed, and in beta both squashed and merged (a repository for each). Built once for the file; each test copies
 * the three it uses, so their commit ids are the template's.
 */
const folderTemplate = useTemplate((templateCleanups) => {
  const started = (name: RepoName): Started => {
    const repo = createGitRepo()
    templateCleanups.push(repo.cleanup)
    const start = repo.commit(`${name} history`)
    repo.branch(EPIC)
    return { repo, start }
  }
  const alpha = started('alpha')
  const squashed = started('beta')
  const merged = started('beta')
  const gamma = started('gamma')
  merged.repo.branch('w2')
  const commits = [merged.repo.commit('beta one')]
  merged.repo.switchTo(EPIC)
  merged.repo.commit('beta moves on')
  const mergeWork = { commits, squash: merged.repo.merge('w2') }
  return {
    alpha: { ...alpha, work: land(alpha.repo, 'w1', ['alpha one', 'alpha two']) },
    beta: { squash: { ...squashed, work: land(squashed.repo, 'w2', ['beta one']) }, merge: { ...merged, work: mergeWork } },
    gamma
  } satisfies { alpha: Built; beta: Record<BetaShape, Built>; gamma: Started }
})

/**
 * alpha, beta and gamma as real repositories (copies of `folderTemplate`'s), each with the epic branch bound at its own
 * start commit and sprint 1's work landed in alpha and beta.
 */
function createFolder(beta: BetaShape): Folder {
  const template = folderTemplate()
  const sources: Record<RepoName, Started> = { alpha: template.alpha, beta: template.beta[beta], gamma: template.gamma }
  const repos: Record<RepoName, GitRepo> = {
    alpha: copyGitRepo(sources.alpha.repo),
    beta: copyGitRepo(sources.beta.repo),
    gamma: copyGitRepo(sources.gamma.repo)
  }
  const gitFor = (repo: string | null) => {
    const found = REPOS.find((name) => name === repo)
    if (found === undefined) {
      throw new Error(`No repository ${String(repo)}`)
    }
    return createGitAdapter(repos[found].root)
  }
  const ctx = createTestCtx({ repositories: [...REPOS], gitFor })
  const run = seedRun(ctx, { bundle: folderPlan(), branch: { repository: null, name: EPIC, startCommit: null } })
  const start: Record<RepoName, string> = { alpha: sources.alpha.start, beta: sources.beta.start, gamma: sources.gamma.start }
  const bound = REPOS.map((name) => ({ repository: name, name: EPIC, startCommit: start[name] }))
  ctx.db.run('UPDATE epics SET repository_branches_json = ? WHERE id = ?', JSON.stringify(bound), run.epicId)
  return { ctx, run, repos, start, work: { alpha: template.alpha.work, beta: template.beta[beta].work } }
}

/** A fresh folder per test (`createFolder`), its repositories removed after the test. */
function useFolder(): (beta?: BetaShape) => Folder {
  let opened: Folder | undefined
  afterEach(() => {
    for (const repo of opened === undefined ? [] : Object.values(opened.repos)) {
      repo.cleanup()
    }
    opened = undefined
  })
  return (beta = 'squash') => {
    opened ??= createFolder(beta)
    return opened
  }
}

/** Sprint 1's work (landed in the folder's alpha and beta) recorded: each work ticket accepted, and DM-3 claimed. */
function sprintOne(folder: Folder) {
  const { alpha, beta } = folder.work
  seedAttempt(folder.ctx, folder.run, { ticket: 1, state: 'accepted', commits: alpha.commits })
  seedAttempt(folder.ctx, folder.run, { ticket: 2, state: 'accepted', commits: beta.commits })
  return { alpha, beta, node: liveNode(folder, 3) }
}

describe('submitAttempt in a folder of repositories: one verified increment per touched repository', () => {
  const openFolder = useFolder()

  it('verifies both squashed increments, each in its own repository, and stores the verdicts with their repositories', async () => {
    const folder = openFolder()
    const { alpha, beta, node } = sprintOne(folder)
    // Named out of order: the verdicts come back in repository name order.
    const view = await submitIncrements(folder, node, [named('beta', beta.squash), named('alpha', alpha.squash)])
    expect(view.state).toBe('submitted')
    expect(Object.keys(view)).not.toContain('increment')
    expect(view.increments).toMatchObject([
      { repo: 'alpha', branch: EPIC, commit: alpha.squash, base: { kind: 'epic_start', commit: folder.start.alpha }, passed: true },
      { repo: 'beta', branch: EPIC, commit: beta.squash, base: { kind: 'epic_start', commit: folder.start.beta }, passed: true }
    ])
    expect(JSON.parse(attemptRow(folder.ctx, node.attemptId).increment_json ?? 'null')).toEqual(view.increments)
    expect(lastEventPayload(folder.ctx, 'attempt.submitted')).toMatchObject({
      increments: [
        { repo: 'alpha', commit: alpha.squash, passed: true },
        { repo: 'beta', commit: beta.squash, passed: true }
      ],
      passed: true
    })
  })

  it("fails the node's increment when beta's is a merge commit, and names beta", async () => {
    const folder = openFolder('merge')
    const { alpha, beta, node } = sprintOne(folder)
    const view = await submitIncrements(folder, node, [named('alpha', alpha.squash), named('beta', beta.squash)])
    expect(view.state).toBe('submitted')
    expect(view.increments?.map((verdict) => [verdict.repo, verdict.passed])).toEqual([
      ['alpha', true],
      ['beta', false]
    ])
    const failed = view.increments?.find((verdict) => !verdict.passed)
    expect(failed?.repo).toBe('beta')
    expect(failed?.reasons.join(' ')).toContain('2 parents')
    expect(lastEventPayload(folder.ctx, 'attempt.submitted')).toMatchObject({ passed: false })
  })
})

describe('submitAttempt in a folder of repositories: a later sprint, measured per repository', () => {
  const openFolder = useFolder()

  it("checks a second sprint's increment against that repository's previous increment, and an untouched one against its start", async () => {
    const folder = openFolder()
    const first = sprintOne(folder)
    await submitIncrements(folder, first.node, [named('alpha', first.alpha.squash), named('beta', first.beta.squash)])
    folder.ctx.db.run("UPDATE attempts SET state = 'accepted' WHERE id = ?", first.node.attemptId)
    const alpha = land(folder.repos.alpha, 'w4', ['alpha three'])
    const gamma = land(folder.repos.gamma, 'w5', ['gamma one'])
    seedAttempt(folder.ctx, folder.run, { ticket: 4, state: 'accepted', commits: alpha.commits })
    seedAttempt(folder.ctx, folder.run, { ticket: 5, state: 'accepted', commits: gamma.commits })
    const node = liveNode(folder, 6)
    // alpha's own context: its sprint 1 increment, and only the commits of the work tickets that target alpha.
    const alphaContext = incrementContextOf(folder.ctx, node.attemptId, 'alpha')
    expect(alphaContext).toMatchObject({
      epicBranch: { repository: 'alpha', name: EPIC, startCommit: folder.start.alpha },
      previous: { commit: first.alpha.squash },
      workCommits: alpha.commits
    })
    const view = await submitIncrements(folder, node, [named('alpha', alpha.squash), named('gamma', gamma.squash)])
    expect(view.increments).toMatchObject([
      { repo: 'alpha', parent: first.alpha.squash, base: { kind: 'previous_increment', commit: first.alpha.squash }, passed: true },
      { repo: 'gamma', base: { kind: 'epic_start', commit: folder.start.gamma }, passed: true }
    ])
    // Naming sprint 1's alpha increment again fails: it is already part of alpha's previous increment.
    if (alphaContext === null) {
      throw new Error('alpha has no increment context')
    }
    const repeated = await verifyIncrement(folder.ctx.gitFor('alpha'), alphaContext, named('alpha', first.alpha.squash), 'now')
    expect(repeated.passed).toBe(false)
    expect(repeated.reasons.join(' ')).toContain("already part of the previous sprint's increment")
  })

  it('measures against the start commit when the earlier sprint failed in any one repository', async () => {
    const folder = openFolder('merge')
    const first = sprintOne(folder)
    await submitIncrements(folder, first.node, [named('alpha', first.alpha.squash), named('beta', first.beta.squash)])
    folder.ctx.db.run("UPDATE attempts SET state = 'accepted' WHERE id = ?", first.node.attemptId)
    seedAttempt(folder.ctx, folder.run, { ticket: 4, state: 'accepted', commits: [] })
    const node = liveNode(folder, 6)
    expect(incrementContextOf(folder.ctx, node.attemptId, 'alpha')?.previous).toBeNull()
  })
})

describe('submitAttempt in a folder of repositories: refusals', () => {
  const openFolder = useFolder()

  it.each<[string, (alpha: string, beta: string) => IncrementRef[], string]>([
    ['a touched repository left out', (alpha) => [named('alpha', alpha)], 'no increment names "beta"'],
    ['an untouched repository', (alpha, beta) => [named('alpha', alpha), named('beta', beta), named('gamma', alpha)], '"gamma", which this sprint did not touch'],
    ['an unknown repository', (alpha, beta) => [named('alpha', alpha), named('beta', beta), named('delta', alpha)], '"delta", which is not a repository'],
    ['a duplicate repository', (alpha, beta) => [named('alpha', alpha), named('alpha', alpha), named('beta', beta)], 'more than one increment names "alpha"'],
    ['an increment without its repository', (alpha, beta) => [named('alpha', alpha), { branch: EPIC, commit: beta }], 'names no repository']
  ])('refuses %s with invalid_input, before git is asked, leaving the claim open', async (_label, increments, message) => {
    const folder = openFolder()
    const { alpha, beta, node } = sprintOne(folder)
    const refs = increments(alpha.squash, beta.squash)
    expect(repositoryIncrementsOf(folder.ctx, node.attemptId, refs)).toBeNull()
    const error = await submitIncrements(folder, node, refs).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DomainError)
    expect(error).toMatchObject({ code: 'invalid_input' })
    expect((error as DomainError).message).toContain('DM-3')
    expect((error as DomainError).message).toContain(message)
    expect(attemptRow(folder.ctx, node.attemptId)).toMatchObject({ state: 'running', increment_json: null })
  })

  it('refuses a singular increment with invalid_input', () => {
    const folder = openFolder()
    const { alpha, node } = sprintOne(folder)
    const input = { ...node, outputs: { summary: 'Landed.' }, increment: { branch: EPIC, commit: alpha.squash } }
    const error = domainError(() => submitAttempt(folder.ctx, input, incrementVerdict()))
    expect([error.code, error.message]).toEqual([
      'invalid_input',
      'DM-3: this project is a folder of repositories: name increments, one { repo, branch, commit } per repository the sprint touched, not a single increment.'
    ])
    expect(attemptRow(folder.ctx, node.attemptId).increment_json).toBeNull()
  })

  it('refuses to store verdicts that do not cover every named repository', async () => {
    const folder = openFolder()
    const { alpha, beta, node } = sprintOne(folder)
    const increments = [named('alpha', alpha.squash), named('beta', beta.squash)]
    const input = { ...node, outputs: { summary: 'Landed.' }, increments }
    expect(domainError(() => submitAttempt(folder.ctx, input, [{ ...incrementVerdict(), repo: 'alpha' }])).code).toBe('internal')
    expect(domainError(() => submitAttempt(folder.ctx, input, incrementVerdict())).code).toBe('internal')
    expect(attemptRow(folder.ctx, node.attemptId).increment_json).toBeNull()
  })
})

describe('submitAttempt in a single repository refuses the folder shapes', () => {
  it('refuses increments, and an increment that names a repository, with invalid_input', () => {
    const ctx = createTestCtx()
    const { node } = nodeClaim(ctx)
    const base = { attemptId: node.attempt.id, claimToken: node.packet.claimToken, outputs: { summary: 'Merged.' } }
    const plural = domainError(() => submitAttempt(ctx, { ...base, increments: [NAMED] }, [incrementVerdict()]))
    expect([plural.code, plural.message]).toEqual([
      'invalid_input',
      'DM-2: this project is a single repository: name the increment as increment { branch, commit }, not increments.'
    ])
    const withRepo = domainError(() => submitAttempt(ctx, { ...base, increment: { ...NAMED, repo: 'alpha' } }, incrementVerdict()))
    expect(withRepo.code).toBe('invalid_input')
    expect(withRepo.message).toContain('"alpha"')
    expect(attemptRow(ctx, node.attempt.id)).toMatchObject({ state: 'claimed', increment_json: null })
  })
})
