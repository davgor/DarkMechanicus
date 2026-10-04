/** Increment verification against a real temporary repository: squashed, merged, off-branch and rebased shapes. */
import { afterEach, describe, expect, it } from 'vitest'
import type { SprintIncrement } from '../../shared/domain/views'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { createGitAdapter } from '../repo/git'
import { type IncrementContext, verifyIncrement } from './incrementVerify'

const NOW = '2026-03-01T10:00:00.000Z'
const EPIC = 'epic/x'

interface Scene {
  repo: GitRepo
  /** The commit the epic branch started from. */
  start: string
  context: IncrementContext
}

/** A repository with the epic branch checked out at its start commit, and a context describing it. */
function newScene(patch: Partial<IncrementContext> = {}): Scene {
  const repo = createGitRepo()
  const start = repo.rev('main')
  repo.branch(EPIC)
  const context: IncrementContext = {
    sprintId: 'sp_one',
    epicBranch: { repository: null, name: EPIC, startCommit: start },
    previous: null,
    workCommits: [],
    ...patch
  }
  return { repo, start, context }
}

/** Branches off the epic branch, commits `messages` there, and returns to the epic branch. */
function work(repo: GitRepo, branch: string, messages: string[]): string[] {
  repo.branch(branch)
  const commits = messages.map((message) => repo.commit(message))
  repo.switchTo(EPIC)
  return commits
}

function verify(scene: Scene, commit: string, branch = EPIC): Promise<SprintIncrement> {
  return verifyIncrement(createGitAdapter(scene.repo.root), scene.context, { branch, commit }, NOW)
}

function statusOf(result: SprintIncrement, name: string): string | undefined {
  return result.checks.find((check) => check.name === name)?.status
}

function useScene(patch: () => Partial<IncrementContext> = () => ({})): () => Scene {
  let scene: Scene | undefined
  afterEach(() => {
    scene?.repo.cleanup()
    scene = undefined
  })
  return () => {
    scene ??= newScene(patch())
    return scene
  }
}

describe('verifyIncrement: one squashed commit on the epic branch', () => {
  const scene = useScene()

  it('passes, and records the full commit, its parent, and the epic start it came after', async () => {
    const { repo, start, context } = scene()
    context.workCommits = work(repo, 'w1', ['one', 'two'])
    const squashed = repo.squash('w1', 'sprint 1')
    const result = await verify(scene(), squashed)
    expect(result).toMatchObject({
      branch: EPIC,
      commit: squashed,
      parent: start,
      base: { kind: 'epic_start', commit: start },
      passed: true,
      reasons: [],
      verifiedAt: NOW
    })
    expect(result.checks.map((check) => check.status)).toEqual(Array(6).fill('passed'))
  })

  it('accepts an abbreviated commit and stores the full id', async () => {
    const { repo, context } = scene()
    context.workCommits = work(repo, 'w1', ['one'])
    const squashed = repo.squash('w1', 'sprint 1')
    expect((await verify(scene(), squashed.slice(0, 10))).commit).toBe(squashed)
  })

  it('measures a later sprint against the previous increment', async () => {
    const { repo, context } = scene()
    work(repo, 'w1', ['one'])
    const first = repo.squash('w1', 'sprint 1')
    context.previous = { sprintId: 'sp_zero', commit: first }
    context.workCommits = work(repo, 'w2', ['two'])
    const second = repo.squash('w2', 'sprint 2')
    const result = await verify(scene(), second)
    expect(result).toMatchObject({ passed: true, parent: first, base: { kind: 'previous_increment', commit: first } })
  })
})

describe('verifyIncrement: a merged sprint', () => {
  const scene = useScene()

  it('fails a merge commit for having two parents, and names the worker commits that are still reachable', async () => {
    const { repo, context } = scene()
    context.workCommits = work(repo, 'w1', ['one', 'two'])
    repo.commit('epic moves on')
    const merged = repo.merge('w1')
    const result = await verify(scene(), merged)
    expect(result.passed).toBe(false)
    expect(result.parent).toBeNull()
    expect(statusOf(result, 'One parent')).toBe('failed')
    expect(statusOf(result, 'Squashed, not merged')).toBe('failed')
    expect(result.reasons).toHaveLength(2)
    expect(result.reasons[0]).toContain('2 parents')
    expect(result.reasons[1]).toContain(context.workCommits[0]?.slice(0, 7))
  })

  it('fails a fast-forward, where the epic branch now holds the worker commits themselves', async () => {
    const { repo, context } = scene()
    context.workCommits = work(repo, 'w1', ['one', 'two'])
    repo.git('merge', '--ff-only', '-q', 'w1')
    const tip = repo.rev(EPIC)
    const result = await verify(scene(), tip)
    expect(result.passed).toBe(false)
    expect(statusOf(result, 'One parent')).toBe('passed')
    expect(statusOf(result, 'On the epic branch')).toBe('passed')
    expect(result.reasons).toEqual([expect.stringContaining('merged rather than squashed')])
  })
})

describe('verifyIncrement: a commit that is not an increment of the epic branch', () => {
  const scene = useScene()

  it('fails a commit that is not on the epic branch', async () => {
    const { repo } = scene()
    const [off] = work(repo, 'w1', ['one'])
    const result = await verify(scene(), off ?? '')
    expect(result.passed).toBe(false)
    expect(statusOf(result, 'On the epic branch')).toBe('failed')
    expect(result.reasons[0]).toContain(`not reachable from ${EPIC}`)
  })

  it('fails a commit the repository does not have, and skips the checks that need it', async () => {
    const result = await verify(scene(), 'f'.repeat(40))
    expect(result.passed).toBe(false)
    expect(result.commit).toBe('f'.repeat(40))
    expect(statusOf(result, 'Commit exists')).toBe('failed')
    for (const name of ['One parent', 'On the epic branch', 'After the base commit']) {
      expect(statusOf(result, name)).toBe('skipped')
    }
    expect(result.reasons).toEqual([expect.stringContaining('was not found')])
  })

  it('fails a root commit, which has no parent', async () => {
    const { repo } = scene()
    repo.git('checkout', '-q', '--orphan', 'rooted')
    repo.git('rm', '-rf', '-q', '--', '.')
    const root = repo.commit('a root commit')
    repo.git('branch', '-f', EPIC, 'rooted')
    const result = await verify(scene(), root)
    expect(statusOf(result, 'One parent')).toBe('failed')
    expect(result.reasons.join(' ')).toContain('no parent')
  })
})

describe('verifyIncrement: the named branch', () => {
  const scene = useScene()

  it('fails when the submission names a branch other than the epic branch', async () => {
    const { repo, context } = scene()
    context.workCommits = work(repo, 'w1', ['one'])
    const squashed = repo.squash('w1', 'sprint 1')
    const result = await verify(scene(), squashed, 'other-branch')
    expect(result.passed).toBe(false)
    expect(result.branch).toBe('other-branch')
    expect(result.reasons).toEqual([expect.stringContaining(`integration branch is "${EPIC}"`)])
  })

  it('fails when the epic has no branch at all', async () => {
    const { repo, context } = scene()
    context.epicBranch = null
    context.workCommits = work(repo, 'w1', ['one'])
    const squashed = repo.squash('w1', 'sprint 1')
    const result = await verify(scene(), squashed)
    expect(result.passed).toBe(false)
    expect(statusOf(result, 'Epic branch')).toBe('failed')
    expect(statusOf(result, 'On the epic branch')).toBe('skipped')
    expect(statusOf(result, 'Squashed, not merged')).toBe('skipped')
    expect(result.reasons[0]).toContain('no integration branch')
  })

  it('fails when the epic branch is not in the repository', async () => {
    const { repo } = scene()
    const commit = repo.commit('one on the epic branch')
    const missing = { repository: null, name: 'epic/gone', startCommit: null }
    const result = await verifyIncrement(
      createGitAdapter(repo.root),
      { sprintId: 'sp_one', epicBranch: missing, previous: null, workCommits: [commit] },
      { branch: 'epic/gone', commit },
      NOW
    )
    expect(result.passed).toBe(false)
    expect(statusOf(result, 'On the epic branch')).toBe('failed')
    expect(statusOf(result, 'Squashed, not merged')).toBe('skipped')
    expect(result.reasons).toEqual([expect.stringContaining('epic/gone')])
  })
})

describe('verifyIncrement: coming after the base', () => {
  const scene = useScene()

  it('fails the epic start commit itself for sprint 1', async () => {
    const { start } = scene()
    const result = await verify(scene(), start)
    expect(result.passed).toBe(false)
    expect(statusOf(result, 'After the base commit')).toBe('failed')
    expect(result.reasons.join(' ')).toContain('start commit')
  })

  it('fails the previous increment named again for a later sprint', async () => {
    const { repo, context } = scene()
    work(repo, 'w1', ['one'])
    const first = repo.squash('w1', 'sprint 1')
    context.previous = { sprintId: 'sp_zero', commit: first }
    const result = await verify(scene(), first)
    expect(result.passed).toBe(false)
    expect(statusOf(result, 'After the base commit')).toBe('failed')
    expect(result.reasons.join(' ')).toContain("previous sprint's increment")
  })

  it('fails a commit older than the epic start', async () => {
    const { repo, context } = scene()
    const older = repo.rev(EPIC)
    repo.commit('epic head moves')
    const head = repo.rev(EPIC)
    context.epicBranch = { repository: null, name: EPIC, startCommit: head }
    const result = await verify(scene(), older)
    expect(statusOf(result, 'After the base commit')).toBe('failed')
  })
})

describe('verifyIncrement: an epic branch without a start commit', () => {
  const scene = useScene(() => ({ epicBranch: { repository: null, name: EPIC, startCommit: null } }))

  it('skips the base check, says why, and still passes a squashed commit', async () => {
    const { repo, context } = scene()
    context.workCommits = work(repo, 'w1', ['one'])
    const squashed = repo.squash('w1', 'sprint 1')
    const result = await verify(scene(), squashed)
    expect(result).toMatchObject({ passed: true, reasons: [], base: { kind: 'none', commit: null } })
    const base = result.checks.find((check) => check.name === 'After the base commit')
    expect(base).toMatchObject({ status: 'skipped' })
    expect(base?.detail).toContain('no start commit')
  })

  it('still measures a later sprint against the previous increment', async () => {
    const { repo, context } = scene()
    work(repo, 'w1', ['one'])
    const first = repo.squash('w1', 'sprint 1')
    context.previous = { sprintId: 'sp_zero', commit: first }
    work(repo, 'w2', ['two'])
    const second = repo.squash('w2', 'sprint 2')
    expect(await verify(scene(), second)).toMatchObject({ passed: true, base: { kind: 'previous_increment' } })
  })
})

describe('verifyIncrement: the commits the sprint recorded', () => {
  const scene = useScene()

  it('skips the squash check when no accepted work recorded a commit hash', async () => {
    const { repo, context } = scene()
    context.workCommits = ['not a hash', 'HEAD~1']
    work(repo, 'w1', ['one'])
    const squashed = repo.squash('w1', 'sprint 1')
    const result = await verify(scene(), squashed)
    expect(result.passed).toBe(true)
    expect(statusOf(result, 'Squashed, not merged')).toBe('skipped')
  })

  it('does not count recorded commits the repository no longer has, but says so', async () => {
    const { repo, context } = scene()
    context.workCommits = [...work(repo, 'w1', ['one']), 'f'.repeat(40)]
    const squashed = repo.squash('w1', 'sprint 1')
    const result = await verify(scene(), squashed)
    expect(result.passed).toBe(true)
    const check = result.checks.find((item) => item.name === 'Squashed, not merged')
    expect(check?.status).toBe('passed')
    expect(check?.detail).toContain('1 recorded commit is not in this repository')
  })

  it('looks at each recorded commit once and finds one anywhere in the list', async () => {
    const { repo, context } = scene()
    const [first, second] = work(repo, 'w1', ['one', 'two'])
    repo.git('merge', '--ff-only', '-q', 'w1')
    context.workCommits = [first ?? '', second ?? '', second ?? '', 'zzz']
    const result = await verify(scene(), repo.rev(EPIC))
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0]).toContain('2 commits')
  })
})
