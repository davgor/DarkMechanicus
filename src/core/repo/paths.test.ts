import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryFs, type MemoryFs } from '../../test/memoryFs'
import { domainErrorOf as captureError, idOf } from '../../test/repoFixtures'
import { createTempRepo, linkDirectory, type TempRepo } from '../../test/tempRepo'
import { resolveLayout } from './layout'
import { nodeFs } from './nodeFs'
import { assertContained, displayPath, ownedPaths } from './paths'

const EPIC = idOf('epic', 7)
const REVISION = idOf('revision', 8)
const RUN = idOf('run', 9)
const COMMENT = idOf('comment', 10)
const ROOT = resolve('/repo')
const layout = resolveLayout(ROOT)

function memoryRepo(): MemoryFs {
  const fs = createMemoryFs()
  fs.mkdirp(layout.dmDir)
  return fs
}

describe('ownedPaths', () => {
  const paths = ownedPaths(layout)

  it('builds every owned path from validated ids', () => {
    const epicDir = join(ROOT, '.darkmechanicus', 'epics', EPIC)
    expect(paths.epicDir(EPIC)).toBe(epicDir)
    expect(paths.snapshotsDir(EPIC)).toBe(join(epicDir, 'snapshots'))
    expect(paths.snapshotFile(EPIC, REVISION)).toBe(join(epicDir, 'snapshots', `${REVISION}.json`))
    expect(paths.epicPointerFile(EPIC)).toBe(join(epicDir, 'current.json'))
    expect(paths.epicStateFile(EPIC)).toBe(join(epicDir, 'state.json'))
    expect(paths.runDir(RUN)).toBe(join(ROOT, '.darkmechanicus', 'history', RUN))
    expect(paths.runHistoryFile(RUN)).toBe(join(ROOT, '.darkmechanicus', 'history', RUN, 'run.json'))
    expect(paths.profileFile('fast-lane-2')).toBe(join(ROOT, '.darkmechanicus', 'profiles', 'fast-lane-2.json'))
    expect(paths.commentsDir(EPIC)).toBe(join(epicDir, 'comments'))
    expect(paths.commentFile(EPIC, COMMENT)).toBe(join(epicDir, 'comments', `${COMMENT}.json`))
  })

  it.each([
    ['a ticket id used as an epic id', () => paths.epicDir(idOf('ticket', 1))],
    ['a traversal epic id', () => paths.epicPointerFile('../../etc')],
    ['a dotted epic id', () => paths.epicStateFile('ep_..')],
    ['a truncated epic id', () => paths.snapshotsDir('ep_0123')],
    ['an uppercase epic id', () => paths.epicDir(EPIC.toUpperCase())],
    ['an epic id used as a revision id', () => paths.snapshotFile(EPIC, EPIC)],
    ['a revision with a path separator', () => paths.snapshotFile(EPIC, `${REVISION}/x`)],
    ['a revision id used as a run id', () => paths.runHistoryFile(REVISION)],
    ['a traversal run id', () => paths.runDir('..')],
    ['a traversal epic id for comments', () => paths.commentsDir('../..')],
    ['a ticket id used as a comment id', () => paths.commentFile(EPIC, idOf('ticket', 1))],
    ['a traversal comment id', () => paths.commentFile(EPIC, '../../state')],
    ['a comment id with a separator', () => paths.commentFile(EPIC, `${COMMENT}/x`)],
    ['a comment filed under a comment id', () => paths.commentFile(COMMENT, COMMENT)]
  ])('rejects %s with unsafe_path', (_label, build) => {
    expect(captureError(build).code).toBe('unsafe_path')
  })

  it('accepts profile names up to 64 characters and rejects anything else', () => {
    const longest = `a${'b'.repeat(63)}`
    expect(paths.profileFile(longest)).toBe(join(layout.profilesDir, `${longest}.json`))
    expect(paths.profileFile('0')).toBe(join(layout.profilesDir, '0.json'))
    for (const name of [`${longest}c`, '', '-lead', 'Upper', 'dots.json', '../escape', 'a b']) {
      expect(captureError(() => paths.profileFile(name)).code).toBe('unsafe_path')
    }
  })

  it('rejects profile names that are not portable file names', () => {
    for (const name of ['trailing-', 'con', 'nul', 'com1', 'lpt9', 'x/y', 'x\\y']) {
      const error = captureError(() => paths.profileFile(name))
      expect([error.code, error.message]).toEqual(['unsafe_path', 'Refusing to build a repository path from an invalid profile name.'])
    }
    expect(paths.profileFile('con-1')).toBe(join(layout.profilesDir, 'con-1.json'))
  })
})

describe('displayPath', () => {
  it('renders repository-relative paths with forward slashes', () => {
    expect(displayPath(layout, join(layout.epicsDir, EPIC, 'current.json'))).toBe(`.darkmechanicus/epics/${EPIC}/current.json`)
  })
})

describe('assertContained (in-memory filesystem)', () => {
  it('accepts existing and not-yet-existing paths below .darkmechanicus', () => {
    const fs = memoryRepo()
    fs.put(join(layout.epicsDir, EPIC, 'current.json'), '{}')
    expect(assertContained(layout, fs, join(layout.epicsDir, EPIC, 'current.json'))).toBeUndefined()
    expect(assertContained(layout, fs, join(layout.epicsDir, EPIC, 'snapshots', 'new.json'))).toBeUndefined()
  })

  it('rejects paths that are not strictly inside .darkmechanicus', () => {
    const fs = memoryRepo()
    const outside = [
      layout.dmDir,
      ROOT,
      join(ROOT, 'src', 'index.ts'),
      join(layout.dmDir, '..', 'escape.json'),
      join(ROOT, '.darkmechanicus-evil', 'x.json'),
      resolve('/elsewhere/.darkmechanicus/x.json')
    ]
    for (const target of outside) {
      expect(captureError(() => assertContained(layout, fs, target)).code).toBe('unsafe_path')
    }
  })

  it('names the offending path relative to the repository', () => {
    const fs = memoryRepo()
    const error = captureError(() => assertContained(layout, fs, join(ROOT, 'src', 'x.ts')))
    expect(error.message).toContain('src/x.ts')
    expect(error.details).toEqual({ path: 'src/x.ts' })
  })

})

describe('assertContained links (in-memory filesystem)', () => {
  it('fails closed when .darkmechanicus is missing or is itself a link', () => {
    const missing = createMemoryFs()
    expect(captureError(() => assertContained(layout, missing, layout.projectFile)).code).toBe('unsafe_path')

    const linked = createMemoryFs()
    linked.mkdirp(resolve('/real-dm'))
    linked.symlink(layout.dmDir, resolve('/real-dm'))
    expect(captureError(() => assertContained(layout, linked, layout.projectFile)).code).toBe('unsafe_path')
  })

  it('rejects a symbolic link at any component, including the target itself', () => {
    const fs = memoryRepo()
    fs.mkdirp(resolve('/outside'))
    fs.symlink(layout.epicsDir, resolve('/outside'))
    const error = captureError(() => assertContained(layout, fs, join(layout.epicsDir, EPIC, 'current.json')))
    expect(error.code).toBe('unsafe_path')
    expect(error.message).toContain('.darkmechanicus/epics')

    const deep = memoryRepo()
    deep.put(resolve('/outside/secret.json'), '{}')
    deep.mkdirp(join(layout.epicsDir, EPIC))
    deep.symlink(join(layout.epicsDir, EPIC, 'current.json'), resolve('/outside/secret.json'))
    expect(captureError(() => assertContained(layout, deep, join(layout.epicsDir, EPIC, 'current.json'))).code).toBe('unsafe_path')
  })

  it('rejects a dangling link even though it does not exist yet', () => {
    const fs = memoryRepo()
    fs.symlink(join(layout.dmDir, 'history'), resolve('/nowhere'))
    expect(captureError(() => assertContained(layout, fs, join(layout.dmDir, 'history', RUN, 'run.json'))).code).toBe('unsafe_path')
  })

  it('rejects an unreported redirect whose real path leaves .darkmechanicus', () => {
    const fs = memoryRepo()
    fs.mkdirp(resolve('/outside'))
    fs.junction(layout.epicsDir, resolve('/outside'))
    expect(fs.isSymlink(layout.epicsDir)).toBe(false)
    const error = captureError(() => assertContained(layout, fs, join(layout.epicsDir, EPIC)))
    expect(error.code).toBe('unsafe_path')
    expect(error.message).toContain('resolves outside')
  })

  it('allows an unreported redirect that stays inside .darkmechanicus', () => {
    const fs = memoryRepo()
    fs.mkdirp(join(layout.dmDir, 'real-epics'))
    fs.junction(layout.epicsDir, join(layout.dmDir, 'real-epics'))
    expect(assertContained(layout, fs, join(layout.epicsDir, EPIC, 'state.json'))).toBeUndefined()
  })
})

describe('assertContained (disk)', () => {
  let repo: TempRepo | undefined

  afterEach(() => {
    repo?.cleanup()
    repo = undefined
  })

  it('rejects a linked directory that escapes the repository', () => {
    repo = createTempRepo()
    mkdirSync(repo.layout.dmDir)
    writeFileSync(join(repo.outside, 'current.json'), '{}')
    linkDirectory(repo.outside, repo.layout.epicsDir)
    const error = captureError(() => assertContained(repo?.layout ?? layout, nodeFs, join(repo?.layout.epicsDir ?? '', 'current.json')))
    expect(error.code).toBe('unsafe_path')
  })

  it('accepts plain directories on disk', () => {
    repo = createTempRepo()
    mkdirSync(join(repo.layout.epicsDir, EPIC), { recursive: true })
    expect(assertContained(repo.layout, nodeFs, join(repo.layout.epicsDir, EPIC, 'current.json'))).toBeUndefined()
  })
})
