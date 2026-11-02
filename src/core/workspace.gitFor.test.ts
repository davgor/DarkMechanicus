/**
 * `gitFor`: one Git adapter per child repository of a folder of repositories, opened only for a listed,
 * present, real child directory of the project root, and a folder whose root is not a repository opens.
 */
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitRepo, type GitRepo } from '../test/gitRepo'
import { linkDirectory } from '../test/tempRepo'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { DomainError } from './errors'
import { createGitAdapter } from './repo/git'
import type { GitAdapter } from './repo/types'
import { openWorkspace, RepositoryWorkspace, type OpenWorkspaceOptions } from './workspace'

let harness: Harness
let alpha: GitRepo
let beta: GitRepo
const cores: RepositoryWorkspace[] = []
/** Roots the injected child factory was asked to open, in order. */
let opened: string[]

/** Real ids and clock, so sessions opened here never collide with each other or with the harness's. */
function options(extra: Partial<OpenWorkspaceOptions> = {}): OpenWorkspaceOptions {
  return {
    repoRoot: harness.root,
    role: 'orchestrator',
    label: 'gitFor test',
    transport: 'in_process',
    homeDir: harness.homeDir,
    ...extra
  }
}

/** A session on the folder; child adapters are real ones, and every root they open is recorded. */
function openCore(extra: Partial<OpenWorkspaceOptions> = {}): RepositoryWorkspace {
  const core = new RepositoryWorkspace(
    options({
      gitAt: (root: string): GitAdapter => {
        opened.push(root)
        return createGitAdapter(root)
      },
      ...extra
    })
  )
  cores.push(core)
  return core
}

function refusal(run: () => unknown): { code: string; message: string } {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof DomainError) {
      return { code: error.code, message: error.message }
    }
    throw error
  }
  throw new Error('expected a refusal')
}

beforeEach(async () => {
  harness = createHarness()
  opened = []
  alpha = createGitRepo({ root: join(harness.root, 'alpha') })
  beta = createGitRepo({ root: join(harness.root, 'beta') })
  beta.branch('feature')
  beta.commit('on feature')
  await harness.open('desktop').initializeRepository({ layout: 'multi_repo' })
})

afterEach(() => {
  for (const core of cores.splice(0)) {
    core.close()
  }
  harness.cleanup()
})

describe('gitFor on a folder of repositories', () => {
  it("opens an adapter rooted at the child repository that reports that repository's head", () => {
    const core = openCore()
    expect(core.gitFor('alpha').head()).toEqual({ branch: 'main', commit: alpha.rev('HEAD'), detached: false })
    expect(core.gitFor('beta').head()).toEqual({ branch: 'feature', commit: beta.rev('HEAD'), detached: false })
    expect(opened).toEqual([join(harness.root, 'alpha'), join(harness.root, 'beta')])
  })

  it('runs Git commands in the child repository', async () => {
    const core = openCore()
    expect(await core.gitFor('beta').listLocalBranches()).toEqual(expect.arrayContaining(['feature', 'main']))
    expect(await core.gitFor('alpha').listLocalBranches()).toEqual(['main'])
  })

  it('returns the root adapter for null', () => {
    const rootGit = createGitAdapter(harness.root)
    const core = openCore({ git: rootGit })
    expect(core.gitFor(null)).toBe(rootGit)
    expect(core.gitFor(null)).toBe(core.git)
    expect(opened).toEqual([])
  })

  it('caches the adapter per name', () => {
    const core = openCore()
    const first = core.gitFor('alpha')
    expect(core.gitFor('alpha')).toBe(first)
    expect(core.gitFor('beta')).not.toBe(first)
    expect(opened).toEqual([join(harness.root, 'alpha'), join(harness.root, 'beta')])
  })

  it('is offered to services on the command context', () => {
    const core = openCore()
    expect(core.ctx().gitFor('alpha')).toBe(core.gitFor('alpha'))
    expect(core.ctx().gitFor(null)).toBe(core.git)
  })
})

describe('gitFor refusals, before any adapter is built', () => {
  it.each(['gamma', '..', '.', 'alpha/../beta', 'alpha/', './alpha', '', 'ALPHA'])(
    'refuses %j, which is not a listed repository, before opening anything',
    (name) => {
      const core = openCore()
      expect(refusal(() => core.gitFor(name))).toMatchObject({ code: 'invalid_input' })
      expect(refusal(() => core.gitFor(name)).message).toContain(JSON.stringify(name))
      expect(opened).toEqual([])
    }
  )

  it('refuses a repository the project records as missing', async () => {
    rmSync(join(harness.root, 'alpha'), { recursive: true, force: true })
    await harness.open('planner').rescanRepositories()
    const core = openCore()
    expect(refusal(() => core.gitFor('alpha'))).toMatchObject({ code: 'invalid_input' })
    expect(refusal(() => core.gitFor('alpha')).message).toContain('alpha')
    expect(opened).toEqual([])
  })

  it('refuses a listed repository whose folder has gone since the last rescan', () => {
    const core = openCore()
    rmSync(join(harness.root, 'alpha'), { recursive: true, force: true })
    expect(refusal(() => core.gitFor('alpha'))).toMatchObject({ code: 'invalid_input' })
    expect(opened).toEqual([])
  })

  it('refuses a listed name that is a file rather than a directory', () => {
    const core = openCore()
    rmSync(join(harness.root, 'alpha'), { recursive: true, force: true })
    writeFileSync(join(harness.root, 'alpha'), 'not a repository\n')
    expect(refusal(() => core.gitFor('alpha'))).toMatchObject({ code: 'invalid_input' })
    expect(opened).toEqual([])
  })

  it('refuses a listed folder that no longer holds a Git repository', () => {
    const core = openCore()
    rmSync(join(harness.root, 'alpha', '.git'), { recursive: true, force: true })
    expect(refusal(() => core.gitFor('alpha'))).toMatchObject({ code: 'invalid_input' })
    expect(opened).toEqual([])
  })
})

describe('gitFor refuses links, before any adapter is built', () => {
  it('refuses a listed repository that has been replaced by a link to a repository outside the folder', () => {
    const outside = createGitRepo()
    try {
      const core = openCore()
      rmSync(join(harness.root, 'beta'), { recursive: true, force: true })
      linkDirectory(outside.root, join(harness.root, 'beta'))
      expect(refusal(() => core.gitFor('beta'))).toMatchObject({ code: 'unsafe_path' })
      expect(refusal(() => core.gitFor('beta')).message).toContain('beta')
      expect(opened).toEqual([])
    } finally {
      outside.cleanup()
    }
  })

  it('refuses a listed repository linked to a sibling inside the folder', () => {
    const core = openCore()
    rmSync(join(harness.root, 'beta'), { recursive: true, force: true })
    linkDirectory(join(harness.root, 'alpha'), join(harness.root, 'beta'))
    expect(refusal(() => core.gitFor('beta'))).toMatchObject({ code: 'unsafe_path' })
    expect(opened).toEqual([])
  })

  it('refuses a cached repository once it has been replaced by a link', () => {
    const core = openCore()
    core.gitFor('beta')
    const moved = join(harness.root, '.beta-moved')
    renameSync(join(harness.root, 'beta'), moved)
    linkDirectory(moved, join(harness.root, 'beta'))
    expect(refusal(() => core.gitFor('beta'))).toMatchObject({ code: 'unsafe_path' })
  })
})

describe('gitFor on a single repository', () => {
  it('refuses every name: the project lists no repositories', async () => {
    const single = createHarness()
    let core: RepositoryWorkspace | undefined
    try {
      await single.open('desktop', { mode: 'db' }).initializeRepository({ name: 'single' })
      core = new RepositoryWorkspace({ ...options(), repoRoot: single.root, homeDir: single.homeDir })
      const opened = core
      expect(refusal(() => opened.gitFor('alpha'))).toMatchObject({ code: 'invalid_input' })
    } finally {
      // Closed before its home folder is removed: Windows refuses to delete the database it still holds open.
      core?.close()
      single.cleanup()
    }
  })
})

describe('opening a folder of repositories with the real root adapter', () => {
  it('reads a checkout without a head and never reports the branch as moved', async () => {
    // No `git` option: the root adapter is the real one, on a root that holds no `.git`.
    const core = new RepositoryWorkspace(options())
    cores.push(core)
    expect(core.isInitialized()).toBe(true)
    expect(core.git.head()).toBeNull()
    expect(core.ctx().checkout()).toEqual({ branch: null, commit: null })
    expect(() => core.ctx().assertBranch()).not.toThrow()
    expect(core.reconcile()).toBeDefined()
    expect(core.ctx().checkout()).toEqual({ branch: null, commit: null })
    expect(() => core.ctx().assertBranch()).not.toThrow()
    expect(() => core.flush()).not.toThrow()

    const workspace = openWorkspace(options())
    try {
      expect((await workspace.getProject()).repositories).toEqual([
        { name: 'alpha', missing: false },
        { name: 'beta', missing: false }
      ])
      await expect(workspace.getStorageStatus()).resolves.toBeDefined()
    } finally {
      workspace.close()
    }
  })
})
