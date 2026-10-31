import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryFs } from '../../test/memoryFs'
import { createTempRepo, linkDirectory, type TempRepo } from '../../test/tempRepo'
import { findRepositoryRoot } from './discovery'
import { dbProjectDir } from './storageMode'
import { nodeFs } from './nodeFs'

/** A Dark Mechanicus home directory with no database-only project in it. */
const NO_DB_PROJECTS = resolve('/home/dev/.darkmechanicus-empty')
const OUTER = resolve('/work/outer')
const INNER = join(OUTER, 'packages', 'inner')

describe('findRepositoryRoot (in-memory)', () => {
  it('prefers the nearest ancestor holding .darkmechanicus/project.json over a closer .git', () => {
    const fs = createMemoryFs()
    fs.put(join(OUTER, '.darkmechanicus', 'project.json'), '{}')
    fs.mkdirp(join(INNER, '.git'))
    fs.mkdirp(join(INNER, 'src', 'deep'))
    expect(findRepositoryRoot(join(INNER, 'src', 'deep'), fs, NO_DB_PROJECTS)).toBe(OUTER)
  })

  it('finds the start directory itself when it holds the project file', () => {
    const fs = createMemoryFs()
    fs.put(join(INNER, '.darkmechanicus', 'project.json'), '{}')
    expect(findRepositoryRoot(INNER, fs, NO_DB_PROJECTS)).toBe(INNER)
  })

  it('ignores a .darkmechanicus directory without project.json', () => {
    const fs = createMemoryFs()
    fs.mkdirp(join(INNER, '.darkmechanicus', 'epics'))
    fs.mkdirp(join(OUTER, '.git'))
    expect(findRepositoryRoot(INNER, fs, NO_DB_PROJECTS)).toBe(OUTER)
  })

  it('falls back to the nearest .git directory or .git file', () => {
    const dirRepo = createMemoryFs()
    dirRepo.mkdirp(join(OUTER, '.git'))
    dirRepo.mkdirp(join(INNER, 'src'))
    expect(findRepositoryRoot(join(INNER, 'src'), dirRepo, NO_DB_PROJECTS)).toBe(OUTER)

    const worktree = createMemoryFs()
    worktree.mkdirp(join(OUTER, '.git'))
    worktree.put(join(INNER, '.git'), 'gitdir: ../../.git/worktrees/inner\n')
    worktree.mkdirp(join(INNER, 'src'))
    expect(findRepositoryRoot(join(INNER, 'src'), worktree, NO_DB_PROJECTS)).toBe(INNER)
  })

  it('returns the canonical start when no marker exists', () => {
    const fs = createMemoryFs()
    fs.mkdirp(join(INNER, 'src'))
    fs.mkdirp(resolve('/real/place'))
    fs.symlink(resolve('/alias'), resolve('/real/place'))
    expect(findRepositoryRoot(join(INNER, 'src'), fs, NO_DB_PROJECTS)).toBe(join(INNER, 'src'))
    expect(findRepositoryRoot(resolve('/alias'), fs, NO_DB_PROJECTS)).toBe(resolve('/real/place'))
  })

  it('resolves a relative start against the working directory', () => {
    const fs = createMemoryFs()
    fs.mkdirp(resolve('.'))
    expect(findRepositoryRoot('.', fs, NO_DB_PROJECTS)).toBe(resolve('.'))
  })
})

describe('findRepositoryRoot (disk)', () => {
  let repo: TempRepo | undefined

  afterEach(() => {
    repo?.cleanup()
    repo = undefined
  })

  it('walks up to the project and returns its real path', () => {
    repo = createTempRepo()
    mkdirSync(join(repo.root, '.darkmechanicus'))
    writeFileSync(join(repo.root, '.darkmechanicus', 'project.json'), '{}')
    mkdirSync(join(repo.root, 'src', 'nested'), { recursive: true })
    expect(findRepositoryRoot(join(repo.root, 'src', 'nested'), nodeFs, NO_DB_PROJECTS)).toBe(repo.root)
  })

  it('canonicalizes a start reached through a linked directory', () => {
    repo = createTempRepo()
    mkdirSync(join(repo.outside, '.git'))
    mkdirSync(join(repo.outside, 'nested'))
    linkDirectory(repo.outside, join(repo.root, 'alias'))
    expect(findRepositoryRoot(join(repo.root, 'alias', 'nested'), nodeFs, NO_DB_PROJECTS)).toBe(repo.outside)
  })
})

describe('findRepositoryRoot and database-only projects', () => {
  const HOME = resolve('/home/dev/.darkmechanicus')

  /** Marks `dir` as a database-only project, the way initializing one does. */
  function makeDbProject(fs: ReturnType<typeof createMemoryFs>, dir: string): void {
    fs.put(join(dbProjectDir(dir, HOME), 'project.json'), '{}')
  }

  it('stops at a folder that is a database-only project, rather than walking up to its Git root', () => {
    const fs = createMemoryFs()
    fs.mkdirp(join(OUTER, '.git'))
    fs.mkdirp(join(INNER, 'src'))
    makeDbProject(fs, INNER)
    expect(findRepositoryRoot(join(INNER, 'src'), fs, HOME)).toBe(INNER)
  })

  it('finds a database-only project from the folder itself', () => {
    const fs = createMemoryFs()
    fs.mkdirp(join(OUTER, '.git'))
    fs.mkdirp(INNER)
    makeDbProject(fs, INNER)
    expect(findRepositoryRoot(INNER, fs, HOME)).toBe(INNER)
  })

  it('takes the nearest project whichever way it is set up', () => {
    const fs = createMemoryFs()
    fs.put(join(OUTER, '.darkmechanicus', 'project.json'), '{}')
    fs.mkdirp(join(INNER, 'src'))
    makeDbProject(fs, INNER)
    expect(findRepositoryRoot(join(INNER, 'src'), fs, HOME)).toBe(INNER)
  })

  it('still walks up to an outer repository project when the inner folder is not one', () => {
    const fs = createMemoryFs()
    fs.put(join(OUTER, '.darkmechanicus', 'project.json'), '{}')
    fs.mkdirp(join(INNER, 'src'))
    makeDbProject(fs, resolve('/somewhere/else'))
    expect(findRepositoryRoot(join(INNER, 'src'), fs, HOME)).toBe(OUTER)
  })

  it('falls back to Git when no folder in the chain is a project either way', () => {
    const fs = createMemoryFs()
    fs.mkdirp(join(OUTER, '.git'))
    fs.mkdirp(join(INNER, 'src'))
    expect(findRepositoryRoot(join(INNER, 'src'), fs, HOME)).toBe(OUTER)
  })
})
