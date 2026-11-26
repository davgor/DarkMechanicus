/** DM-938: read-only manifest verification against real temporary repositories. */
import { afterEach, describe, expect, it } from 'vitest'
import type { LearningBranchManifest } from '../../shared/domain/kanban'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { createGitAdapter } from '../repo/git'
import { learningBranchName, verifyLearningManifests } from './learningBranches'

const EPIC = 'epic/x'
const KEY = 'DM-7'

interface Scene {
  repo: GitRepo
  /** The completed sprint increment on the epic branch. */
  increment: string
  /** The isolated learning branch's tip: one guardrail commit on top of the increment. */
  tip: string
  branch: string
}

const repos: GitRepo[] = []
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

function scene(repoName: string | null = null): Scene {
  const repo = createGitRepo()
  repos.push(repo)
  repo.branch(EPIC)
  const increment = repo.commit('sprint 1 increment')
  const branch = learningBranchName(KEY, repoName)
  repo.branch(branch)
  const tip = repo.commit('guardrail')
  repo.switchTo(EPIC)
  return { repo, increment, tip, branch }
}

const baseOf = (s: Scene, repo: string | null = null) => ({ repo, branch: EPIC, commit: s.increment, attemptId: 'at_x' })
const manifestOf = (s: Scene, repo: string | null = null, patch: Partial<LearningBranchManifest> = {}): LearningBranchManifest => ({
  repo,
  base: s.increment,
  branch: s.branch,
  commit: s.tip,
  ...patch
})

const statuses = (checks: { name: string; status: string }[]): Record<string, string> =>
  Object.fromEntries(checks.map((item) => [item.name, item.status]))

describe('learningBranchName', () => {
  it('is deterministic per card and repository, and safe for a ref', () => {
    expect(learningBranchName(KEY, null)).toBe('learnings/DM-7/root')
    expect(learningBranchName(KEY, 'web-app')).toBe('learnings/DM-7/web-app')
    expect(learningBranchName(KEY, '..odd name..lock')).toBe('learnings/DM-7/odd-name-lock')
    expect(learningBranchName(KEY, 'web-app')).toBe(learningBranchName(KEY, 'web-app'))
  })

  it('names a repository whose name has no ref-safe character "repo"', () => {
    expect(learningBranchName(KEY, '...')).toBe('learnings/DM-7/repo')
    expect(learningBranchName(KEY, '--')).toBe('learnings/DM-7/repo')
  })
})

describe('verifyLearningManifests', () => {
  it('passes a valid manifest: base, isolated branch, existing commit descending from the base and equal to the tip', async () => {
    const s = scene()
    const head = s.repo.rev('HEAD')
    const proof = await verifyLearningManifests(() => createGitAdapter(s.repo.root), { cardKey: KEY, bases: [baseOf(s)], manifests: [manifestOf(s)] })
    expect(proof.reasons).toEqual([])
    expect(proof.passed).toBe(true)
    expect(proof.manifests).toEqual([expect.objectContaining({ repo: null, base: s.increment, branch: s.branch, commit: s.tip, passed: true })])
    expect(proof.manifests[0]?.checks.every((item) => item.status === 'passed')).toBe(true)
    // Read-only: nothing was checked out, merged or moved.
    expect(s.repo.rev('HEAD')).toBe(head)
    expect(s.repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe(EPIC)
    expect(s.repo.rev(s.branch)).toBe(s.tip)
    expect(s.repo.rev(EPIC)).toBe(s.increment)
  })

  it('accepts an abbreviated base and commit, storing the full ids', async () => {
    const s = scene()
    const proof = await verifyLearningManifests(() => createGitAdapter(s.repo.root), {
      cardKey: KEY,
      bases: [baseOf(s)],
      manifests: [manifestOf(s, null, { base: s.increment.slice(0, 10), commit: s.tip.slice(0, 10) })]
    })
    expect(proof.passed).toBe(true)
    expect(proof.manifests[0]).toMatchObject({ base: s.increment, commit: s.tip })
  })
})

describe('verifyLearningManifests: refusals', () => {
  it('refuses a wrong base', async () => {
    const s = scene()
    const parent = s.repo.rev(`${s.increment}~1`)
    const proof = await verifyLearningManifests(() => createGitAdapter(s.repo.root), { cardKey: KEY, bases: [baseOf(s)], manifests: [manifestOf(s, null, { base: parent })] })
    expect(proof.passed).toBe(false)
    expect(statuses(proof.manifests[0]?.checks ?? [])).toMatchObject({ 'Names the recorded base': 'failed', 'Descends from the base': 'passed' })
  })

  it('refuses a missing branch and a branch other than the isolated one', async () => {
    const s = scene()
    s.repo.git('branch', 'other', s.tip)
    const git = createGitAdapter(s.repo.root)
    const missing = await verifyLearningManifests(() => git, { cardKey: KEY, bases: [baseOf(s)], manifests: [manifestOf(s, null, { branch: 'learnings/DM-8/root' })] })
    expect(statuses(missing.manifests[0]?.checks ?? [])).toMatchObject({ 'Names the isolated branch': 'failed', 'Matches the branch tip': 'failed' })
    expect(missing.reasons.join(' ')).toContain('Branch learnings/DM-8/root was not found')
    const other = await verifyLearningManifests(() => git, { cardKey: KEY, bases: [baseOf(s)], manifests: [manifestOf(s, null, { branch: 'other' })] })
    expect(other.passed).toBe(false)
    expect(statuses(other.manifests[0]?.checks ?? [])).toMatchObject({ 'Names the isolated branch': 'failed', 'Matches the branch tip': 'passed' })
  })

  it('refuses a missing commit', async () => {
    const s = scene()
    const proof = await verifyLearningManifests(() => createGitAdapter(s.repo.root), {
      cardKey: KEY,
      bases: [baseOf(s)],
      manifests: [manifestOf(s, null, { commit: 'f'.repeat(40) })]
    })
    expect(proof.passed).toBe(false)
    expect(statuses(proof.manifests[0]?.checks ?? [])).toMatchObject({ 'Commit exists': 'failed', 'Descends from the base': 'skipped', 'Matches the branch tip': 'skipped' })
  })

  it('refuses an unrelated commit even when the branch points at it', async () => {
    const s = scene()
    s.repo.switchTo('main')
    s.repo.git('switch', '--orphan', 'unrelated')
    const unrelated = s.repo.commit('unrelated root')
    s.repo.git('branch', '-f', s.branch, unrelated)
    s.repo.switchTo(EPIC)
    const proof = await verifyLearningManifests(() => createGitAdapter(s.repo.root), { cardKey: KEY, bases: [baseOf(s)], manifests: [manifestOf(s, null, { commit: unrelated })] })
    expect(proof.passed).toBe(false)
    expect(statuses(proof.manifests[0]?.checks ?? [])).toMatchObject({ 'Descends from the base': 'failed', 'Matches the branch tip': 'passed' })
  })
})

describe('verifyLearningManifests: branch tips and folders of repositories', () => {
  it('refuses a commit that is not the branch tip', async () => {
    const s = scene()
    s.repo.switchTo(s.branch)
    s.repo.commit('later guardrail')
    s.repo.switchTo(EPIC)
    const proof = await verifyLearningManifests(() => createGitAdapter(s.repo.root), { cardKey: KEY, bases: [baseOf(s)], manifests: [manifestOf(s)] })
    expect(proof.passed).toBe(false)
    expect(statuses(proof.manifests[0]?.checks ?? [])).toMatchObject({ 'Descends from the base': 'passed', 'Matches the branch tip': 'failed' })
  })

  it('verifies each repository of a folder of repositories with its own adapter and requires exactly one manifest per base', async () => {
    const api = scene('api')
    const web = scene('web')
    const gitFor = (repo: string | null) => createGitAdapter(repo === 'api' ? api.repo.root : web.repo.root)
    const bases = [baseOf(api, 'api'), baseOf(web, 'web')]
    const valid = await verifyLearningManifests(gitFor, { cardKey: KEY, bases, manifests: [manifestOf(web, 'web'), manifestOf(api, 'api')] })
    expect(valid.passed).toBe(true)
    expect(valid.manifests.map((item) => item.repo)).toEqual(['api', 'web'])

    const uncovered = await verifyLearningManifests(gitFor, { cardKey: KEY, bases, manifests: [manifestOf(api, 'api')] })
    expect(uncovered.passed).toBe(false)
    expect(uncovered.reasons).toEqual(['No manifest covers repository web (increment ' + web.increment.slice(0, 7) + ').'])

    const doubled = await verifyLearningManifests(gitFor, { cardKey: KEY, bases, manifests: [manifestOf(api, 'api'), manifestOf(web, 'web'), manifestOf(web, 'web')] })
    expect(doubled.reasons).toEqual(['2 manifests name repository web; give exactly one.'])

    const stray = await verifyLearningManifests(gitFor, { cardKey: KEY, bases, manifests: [manifestOf(api, 'api'), manifestOf(web, 'web'), manifestOf(web, 'docs')] })
    expect(stray.reasons).toEqual(['The manifest for repository docs names no affected repository of this card.'])

    // A commit only the other repository has is unknown here (fixture commits are deterministic, so make a distinct one).
    api.repo.switchTo(api.branch)
    const apiOnly = api.repo.commit('api-only guardrail')
    api.repo.switchTo(EPIC)
    const crossed = await verifyLearningManifests(gitFor, { cardKey: KEY, bases, manifests: [manifestOf(api, 'api', { commit: apiOnly }), manifestOf(web, 'web', { commit: apiOnly })] })
    expect(crossed.passed).toBe(false)
    expect(statuses(crossed.manifests[1]?.checks ?? [])).toMatchObject({ 'Commit exists': 'failed' })
  })
})
