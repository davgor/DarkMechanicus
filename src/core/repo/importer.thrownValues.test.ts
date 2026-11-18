/** A filesystem that fails with a bare value rather than an Error still has that failure reported for the file it hit. */
import { describe, expect, it } from 'vitest'
import type { MemoryFs } from '../../test/memoryFs'
import { copyTracked, createRepoEnv, createStubGit, importerDeps, initProject, type RepoEnv, saveRevision } from '../../test/repoEnv'
import { idOf } from '../../test/repoFixtures'
import { reconcileRepository } from './importer'
import { importObservations } from './observationImport'
import { ownedPaths } from './paths'

const EPIC = idOf('epic', 1)

/** The memory filesystem, except that reading a file whose path ends with `suffix` throws the string `EIO`. */
function failingReads(fs: MemoryFs, suffix: string): MemoryFs {
  const failing: MemoryFs = Object.create(fs) as MemoryFs
  failing.readFile = (path) => {
    if (path.endsWith(suffix)) {
      // Native bindings may reject with a bare value; the importer must report it as it came.
      throw 'EIO'
    }
    return fs.readFile(path)
  }
  return failing
}

/** A saved epic exported by another machine and copied into this checkout, not imported yet. */
function pulledEpic(): RepoEnv {
  const source = createRepoEnv({ root: '/source' })
  initProject(source)
  saveRevision(source, { epicId: EPIC, revisionId: idOf('revision', 1), number: 1 })
  const env = createRepoEnv({ root: '/clone' })
  copyTracked(source, env)
  return env
}

describe('reconcileRepository and a bare thrown value', () => {
  it('rejects the epic whose pointer read failed, with the value as its message', () => {
    const env = pulledEpic()
    const result = reconcileRepository({ ...importerDeps(env, createStubGit()), fs: failingReads(env.fs, 'current.json') })
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/epics/${EPIC}`, message: 'EIO' }])
    expect(result.imported).toEqual([])
  })
})

describe('importObservations and a bare thrown value', () => {
  it('rejects the observation file whose read failed, with the value as its message', () => {
    const env = createRepoEnv()
    initProject(env)
    const name = 'mo_01m7gg00000000000000000001.json'
    env.fs.put(`${ownedPaths(env.layout).observationsDir(null)}/${name}`, '{}')
    const deps = { ...importerDeps(env, createStubGit()), fs: failingReads(env.fs, name) }
    expect(importObservations(deps, env.clock.nowIso())).toEqual({ imported: [], rejected: [{ path: `.darkmechanicus/observations/${name}`, message: 'EIO' }] })
  })
})
