import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryFs } from '../../test/memoryFs'
import { createTempRepo, linkDirectory, type TempRepo } from '../../test/tempRepo'
import { findRepositoryRoot } from './discovery'
import { nodeFs } from './nodeFs'

const OUTER = resolve('/work/outer')
const INNER = join(OUTER, 'packages', 'inner')

describe('findRepositoryRoot (in-memory)', () => {
  it('prefers the nearest ancestor holding .darkmechanicus/project.json over a closer .git', () => {
    const fs = createMemoryFs()
    fs.put(join(OUTER, '.darkmechanicus', 'project.json'), '{}')
    fs.mkdirp(join(INNER, '.git'))
    fs.mkdirp(join(INNER, 'src', 'deep'))
    expect(findRepositoryRoot(join(INNER, 'src', 'deep'), fs)).toBe(OUTER)
  })

  it('finds the start directory itself when it holds the project file', () => {
    const fs = createMemoryFs()
    fs.put(join(INNER, '.darkmechanicus', 'project.json'), '{}')
    expect(findRepositoryRoot(INNER, fs)).toBe(INNER)
  })

  it('ignores a .darkmechanicus directory without project.json', () => {
    const fs = createMemoryFs()
    fs.mkdirp(join(INNER, '.darkmechanicus', 'epics'))
    fs.mkdirp(join(OUTER, '.git'))
    expect(findRepositoryRoot(INNER, fs)).toBe(OUTER)
  })

  it('falls back to the nearest .git directory or .git file', () => {
    const dirRepo = createMemoryFs()
    dirRepo.mkdirp(join(OUTER, '.git'))
    dirRepo.mkdirp(join(INNER, 'src'))
    expect(findRepositoryRoot(join(INNER, 'src'), dirRepo)).toBe(OUTER)

    const worktree = createMemoryFs()
    worktree.mkdirp(join(OUTER, '.git'))
    worktree.put(join(INNER, '.git'), 'gitdir: ../../.git/worktrees/inner\n')
    worktree.mkdirp(join(INNER, 'src'))
    expect(findRepositoryRoot(join(INNER, 'src'), worktree)).toBe(INNER)
  })

  it('returns the canonical start when no marker exists', () => {
    const fs = createMemoryFs()
    fs.mkdirp(join(INNER, 'src'))
    fs.mkdirp(resolve('/real/place'))
    fs.symlink(resolve('/alias'), resolve('/real/place'))
    expect(findRepositoryRoot(join(INNER, 'src'), fs)).toBe(join(INNER, 'src'))
    expect(findRepositoryRoot(resolve('/alias'), fs)).toBe(resolve('/real/place'))
  })

  it('resolves a relative start against the working directory', () => {
    const fs = createMemoryFs()
    fs.mkdirp(resolve('.'))
    expect(findRepositoryRoot('.', fs)).toBe(resolve('.'))
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
    expect(findRepositoryRoot(join(repo.root, 'src', 'nested'), nodeFs)).toBe(repo.root)
  })

  it('canonicalizes a start reached through a linked directory', () => {
    repo = createTempRepo()
    mkdirSync(join(repo.outside, '.git'))
    mkdirSync(join(repo.outside, 'nested'))
    linkDirectory(repo.outside, join(repo.root, 'alias'))
    expect(findRepositoryRoot(join(repo.root, 'alias', 'nested'), nodeFs)).toBe(repo.outside)
  })
})
