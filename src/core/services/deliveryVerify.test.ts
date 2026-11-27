/** Delivery verification against real temporary repositories: fast-forward, squash, release tags and installed builds. */
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SprintDelivery } from '../../shared/domain/bundle'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { createStubGit } from '../../test/repoEnv'
import { createGitAdapter } from '../repo/git'
import type { GitAdapter } from '../repo/types'
import { compareVersions, type DeliveryClaim, type DeliveryContext, type DeliveryVerdict, verifyDelivery } from './deliveryVerify'

const NOW = '2026-03-01T10:00:00.000Z'
const EPIC = 'epic/x'
const SHARED = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n') + '\n'
const NAMES = ['Delivered commit exists', 'On the target branch', 'Carries the increment', 'Release tag', 'Release version', 'Installed app version']
const FULL: SprintDelivery = { target: 'main', release: true, verifyInstalled: true }
const PACKAGED_13 = { version: '1.3.0', packaged: true }

/** Writes `files` and commits them as one commit on the current branch; returns its id. */
function commitFiles(repo: GitRepo, files: Record<string, string>, message: string): string {
  for (const [path, text] of Object.entries(files)) {
    writeFileSync(join(repo.root, path), text)
    repo.git('add', '--', path)
  }
  repo.git('commit', '-q', '-m', message)
  return repo.rev('HEAD')
}

interface Scene {
  repo: GitRepo
  /** The sprint's increment: one commit on the epic branch adding two files and editing the first line of shared.txt. */
  increment: string
}

/** main holds package.json 1.2.0 and shared.txt; the epic branch holds the increment; main is checked out. */
function newScene(): Scene {
  const repo = createGitRepo()
  commitFiles(repo, { 'package.json': '{"name":"app","version":"1.2.0"}\n', 'shared.txt': SHARED }, 'package')
  repo.branch(EPIC)
  const increment = commitFiles(repo, { 'feature.txt': 'feature\n', 'other.txt': 'other\n', 'shared.txt': SHARED.replace('one', 'ONE') }, 'increment')
  repo.switchTo('main')
  return { repo, increment }
}

function useScene(): () => Scene {
  let scene: Scene | undefined
  afterEach(() => {
    scene?.repo.cleanup()
    scene = undefined
  })
  return () => {
    scene ??= newScene()
    return scene
  }
}

/** Publishes `commit` as origin/main and tags it v1.2.0. */
function publish(repo: GitRepo, commit: string, tag = 'v1.2.0'): void {
  repo.git('update-ref', 'refs/remotes/origin/main', commit)
  repo.git('tag', tag, commit)
}

function contextOf(scene: Scene, patch: Partial<DeliveryContext> = {}): DeliveryContext {
  return { delivery: FULL, increment: { commit: scene.increment }, installed: PACKAGED_13, ...patch }
}

function verify(scene: Scene, claim: DeliveryClaim, patch: Partial<DeliveryContext> = {}, git?: GitAdapter): Promise<DeliveryVerdict> {
  return verifyDelivery(git ?? createGitAdapter(scene.repo.root), contextOf(scene, patch), claim, NOW)
}

function named(verdict: DeliveryVerdict, name: string): { status: string; detail: string } | undefined {
  return verdict.checks.find((item) => item.name === name)
}

describe('verifyDelivery: the increment reached the target', () => {
  const scene = useScene()

  it('passes every check for the increment fast-forwarded onto main', async () => {
    const { repo, increment } = scene()
    repo.git('merge', '--ff-only', '-q', EPIC)
    publish(repo, increment)
    const verdict = await verify(scene(), { commit: increment, releaseTag: 'v1.2.0', observedInstalledVersion: '1.3.0' })
    expect(verdict.checks.map((item) => item.name)).toEqual(NAMES)
    expect(verdict.checks.every((item) => item.status === 'passed')).toBe(true)
    expect(verdict).toMatchObject({ passed: true, reasons: [], releaseVersion: '1.2.0', installedVersion: '1.3.0', verifiedAt: NOW })
  })

  it('passes a squash merge made after an unrelated main commit, comparing every changed path', async () => {
    const { repo } = scene()
    repo.commit('unrelated main work')
    const merged = repo.squash(EPIC, 'deliver')
    publish(repo, merged)
    const verdict = await verify(scene(), { commit: merged, releaseTag: 'v1.2.0' })
    expect(named(verdict, 'Carries the increment')).toEqual({ name: 'Carries the increment', status: 'passed', detail: 'squash-merged: 3 files match' })
    expect(verdict.passed).toBe(true)
  })

  it('passes a squash merge after main edited a file the increment also changed (merged with target changes)', async () => {
    const { repo } = scene()
    commitFiles(repo, { 'shared.txt': SHARED.replace('seven', 'SEVEN') }, 'main edits shared.txt')
    const merged = repo.squash(EPIC, 'deliver')
    publish(repo, merged)
    expect(repo.git('show', `${merged}:shared.txt`)).toContain('ONE')
    const verdict = await verify(scene(), { commit: merged, releaseTag: 'v1.2.0' })
    expect(named(verdict, 'Carries the increment')).toMatchObject({ status: 'passed', detail: 'squash-merged: 2 files match; merged with target changes: shared.txt' })
    expect(verdict.passed).toBe(true)
  })
})

describe('verifyDelivery: the increment did not reach the target', () => {
  const scene = useScene()

  it('fails when main is missing one changed file, naming the path', async () => {
    const { repo } = scene()
    repo.git('merge', '--squash', '-q', EPIC)
    repo.git('rm', '-q', '--cached', '--', 'other.txt')
    repo.git('commit', '-q', '-m', 'deliver without other.txt')
    rmSync(join(repo.root, 'other.txt'))
    const merged = repo.rev('HEAD')
    publish(repo, merged)
    const verdict = await verify(scene(), { commit: merged, releaseTag: 'v1.2.0' })
    const carries = named(verdict, 'Carries the increment')
    expect(carries?.status).toBe('failed')
    expect(carries?.detail).toContain('other.txt')
    expect(carries?.detail).not.toContain('feature.txt')
    expect(verdict.passed).toBe(false)
    expect(verdict.reasons).toEqual([carries?.detail])
  })

  it('fails a squash merge whose content differs where main did not change the path', async () => {
    const { repo } = scene()
    repo.git('merge', '--squash', '-q', EPIC)
    const merged = commitFiles(repo, { 'feature.txt': 'changed during the merge\n' }, 'deliver with a changed feature.txt')
    publish(repo, merged)
    const verdict = await verify(scene(), { commit: merged, releaseTag: 'v1.2.0' })
    expect(named(verdict, 'Carries the increment')).toMatchObject({ status: 'failed' })
    expect(named(verdict, 'Carries the increment')?.detail).toContain('feature.txt')
  })

  it('fails without refs/remotes/origin/main, telling the recorder to fetch', async () => {
    const { repo, increment } = scene()
    repo.git('merge', '--ff-only', '-q', EPIC)
    repo.git('tag', 'v1.2.0', increment)
    const verdict = await verify(scene(), { commit: increment, releaseTag: 'v1.2.0' })
    expect(named(verdict, 'On the target branch')).toMatchObject({ status: 'failed', detail: 'origin/main is unknown here: run git fetch origin first' })
    expect(verdict.passed).toBe(false)
  })

  it('fails a commit that is not on origin/main and one that is not in the repository', async () => {
    const { repo, increment } = scene()
    publish(repo, repo.rev('main'))
    const off = await verify(scene(), { commit: increment, releaseTag: 'v1.2.0' })
    expect(named(off, 'On the target branch')?.status).toBe('failed')
    const missing = await verify(scene(), { commit: 'f'.repeat(40), releaseTag: 'v1.2.0' })
    expect(missing.checks.slice(0, 3).map((item) => item.status)).toEqual(['failed', 'failed', 'failed'])
    const option = await verify(scene(), { commit: '--all' })
    expect(named(option, 'Delivered commit exists')?.status).toBe('failed')
  })
})

describe('verifyDelivery: release tag and version', () => {
  const scene = useScene()

  function fastForward(): string {
    const { repo, increment } = scene()
    repo.git('merge', '--ff-only', '-q', EPIC)
    repo.git('update-ref', 'refs/remotes/origin/main', increment)
    return increment
  }

  it('fails a missing tag, and a tag that is not vN.N.N or names nothing', async () => {
    const commit = fastForward()
    const missing = await verify(scene(), { commit, releaseTag: 'v1.2.0' })
    expect(named(missing, 'Release tag')).toMatchObject({ status: 'failed', detail: 'The tag v1.2.0 is not in this repository.' })
    expect(named(missing, 'Release version')?.status).toBe('failed')
    expect(missing.releaseVersion).toBeNull()
    const bad = await verify(scene(), { commit, releaseTag: '1.2.0' })
    expect(named(bad, 'Release tag')?.status).toBe('failed')
    const none = await verify(scene(), { commit })
    expect(named(none, 'Release tag')).toMatchObject({ status: 'failed', detail: 'No release tag was named.' })
  })

  it('fails a tag that does not contain the delivered commit', async () => {
    const { repo } = scene()
    const commit = fastForward()
    repo.git('tag', 'v1.2.0', repo.rev(`${commit}^`))
    const verdict = await verify(scene(), { commit, releaseTag: 'v1.2.0' })
    expect(named(verdict, 'Release tag')).toMatchObject({ status: 'failed', detail: 'The tag v1.2.0 does not contain the delivered commit.' })
  })

  it('fails a tag whose package.json says 1.1.0', async () => {
    const { repo } = scene()
    fastForward()
    const tagged = commitFiles(repo, { 'package.json': '{"name":"app","version":"1.1.0"}\n' }, 'version 1.1.0')
    repo.git('tag', 'v1.2.0', tagged)
    const verdict = await verify(scene(), { commit: scene().increment, releaseTag: 'v1.2.0' })
    expect(named(verdict, 'Release tag')?.status).toBe('passed')
    expect(named(verdict, 'Release version')).toMatchObject({ status: 'failed', detail: 'package.json at v1.2.0 says 1.1.0, not 1.2.0.' })
    expect(verdict.releaseVersion).toBeNull()
    expect(named(verdict, 'Installed app version')?.status).toBe('failed')
  })
})

describe('verifyDelivery: installed app version', () => {
  const scene = useScene()

  async function installed(patch: Partial<DeliveryContext>, observed?: string): Promise<DeliveryVerdict> {
    const { repo, increment } = scene()
    if (repo.rev('main') !== increment) {
      repo.git('merge', '--ff-only', '-q', EPIC)
      publish(repo, increment)
    }
    return verify(scene(), { commit: increment, releaseTag: 'v1.2.0', ...(observed === undefined ? {} : { observedInstalledVersion: observed }) }, patch)
  }

  it('fails an older, unpackaged, unknown or disagreeing installed build and passes packaged 1.3.0', async () => {
    const older = await installed({ installed: { version: '1.1.0', packaged: true } })
    expect(named(older, 'Installed app version')).toMatchObject({ status: 'failed', detail: 'The installed app runs 1.1.0, not 1.2.0 or later.' })
    const unpackaged = await installed({ installed: { version: '1.3.0', packaged: false } })
    expect(named(unpackaged, 'Installed app version')?.detail).toBe('record from a session started by the installed app (get_capabilities server.packaged)')
    const unknown = await installed({ installed: null })
    expect(named(unknown, 'Installed app version')?.status).toBe('failed')
    expect(unknown.installedVersion).toBeNull()
    const disagree = await installed({}, '1.2.5')
    expect(named(disagree, 'Installed app version')?.detail).toContain('installed versions disagree')
    const garbage = await installed({ installed: { version: '1.3', packaged: true } })
    expect(named(garbage, 'Installed app version')?.status).toBe('failed')
    for (const verdict of [older, unpackaged, unknown, disagree, garbage]) {
      expect(verdict.passed).toBe(false)
    }
    const ok = await installed({}, '1.3.0')
    expect(named(ok, 'Installed app version')?.status).toBe('passed')
    expect(ok).toMatchObject({ passed: true, installedVersion: '1.3.0', releaseVersion: '1.2.0' })
    const equal = await installed({ installed: { version: '1.2.0', packaged: true } })
    expect(equal.passed).toBe(true)
  })

  it('leaves the release and installed checks out when the delivery does not ask for them', async () => {
    const { repo, increment } = scene()
    repo.git('merge', '--ff-only', '-q', EPIC)
    repo.git('update-ref', 'refs/remotes/origin/main', increment)
    const verdict = await verify(scene(), { commit: increment }, { delivery: { target: 'main', release: false, verifyInstalled: false }, installed: null })
    expect(verdict.checks.map((item) => item.name)).toEqual(NAMES.slice(0, 3))
    expect(verdict).toMatchObject({ passed: true, releaseVersion: null, installedVersion: null })
  })
})

describe('verifyDelivery: fail-closed on answers git could not give', () => {
  const scene = useScene()

  function squashed(): string {
    const { repo } = scene()
    repo.commit('unrelated main work')
    const merged = repo.squash(EPIC, 'deliver')
    publish(repo, merged)
    return merged
  }

  it('fails every check when git answers nothing', async () => {
    const verdict = await verifyDelivery(createStubGit(), contextOf(scene()), { commit: 'a'.repeat(40), releaseTag: 'v1.2.0', observedInstalledVersion: '1.3.0' }, NOW)
    expect(verdict.checks.map((item) => [item.name, item.status])).toEqual(NAMES.map((name) => [name, 'failed']))
    expect(verdict.passed).toBe(false)
    expect(verdict.reasons).toHaveLength(NAMES.length)
  })

  it('fails when showFile answers null for a path listFiles still lists', async () => {
    const merged = squashed()
    const real = createGitAdapter(scene().repo.root)
    const git: GitAdapter = { ...real, showFile: async (ref, path) => (path === 'feature.txt' ? null : real.showFile(ref, path)) }
    const verdict = await verify(scene(), { commit: merged, releaseTag: 'v1.2.0' }, {}, git)
    expect(named(verdict, 'Carries the increment')).toMatchObject({ status: 'failed', detail: 'Git could not read these paths: feature.txt.' })
    expect(verdict.passed).toBe(false)
  })

  it('fails when isAncestor, changedPaths or mergeBase cannot answer', async () => {
    const merged = squashed()
    const real = createGitAdapter(scene().repo.root)
    const claim = { commit: merged, releaseTag: 'v1.2.0' }
    for (const git of [
      { ...real, isAncestor: async () => null },
      { ...real, changedPaths: async () => null },
      { ...real, mergeBase: async () => null }
    ] satisfies GitAdapter[]) {
      const verdict = await verify(scene(), claim, {}, git)
      expect(named(verdict, 'Carries the increment')?.status).toBe('failed')
      expect(verdict.passed).toBe(false)
    }
  })

  it('counts a path deleted at both commits as a match', async () => {
    const { repo } = scene()
    repo.switchTo(EPIC)
    repo.git('rm', '-q', '--', 'other.txt')
    repo.git('commit', '-q', '-m', 'second increment deletes other.txt')
    const increment = repo.rev('HEAD')
    repo.switchTo('main')
    const merged = repo.squash(EPIC, 'deliver')
    publish(repo, merged)
    const verdict = await verifyDelivery(createGitAdapter(repo.root), { ...contextOf(scene()), increment: { commit: increment } }, { commit: merged, releaseTag: 'v1.2.0' }, NOW)
    expect(named(verdict, 'Carries the increment')).toMatchObject({ status: 'passed', detail: 'squash-merged: 1 files match' })
  })
})

describe('compareVersions', () => {
  it('compares major.minor.patch numerically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1)
  })

  it('refuses anything that is not exactly N.N.N', () => {
    expect(compareVersions('1.2', '1.2.0')).toBeNull()
    expect(compareVersions('1.2.0', 'v1.2.0')).toBeNull()
    expect(compareVersions('1.2.0-beta', '1.2.0')).toBeNull()
  })
})
