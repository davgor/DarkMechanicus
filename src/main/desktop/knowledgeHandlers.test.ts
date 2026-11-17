import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { nodeFs } from '../../core/repo/nodeFs'
import { createGitRepo } from '../../test/gitRepo'
import { gitIn, put, scratchDir } from '../../test/gitScratch'
import { createTempRepo } from '../../test/tempRepo'
import { GitError } from '../git/errors'
import { createGitRunner, type GitRunner } from '../git/runner'
import { createKnowledgeHandlers, type KnowledgeHandlers } from './knowledgeHandlers'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function fact(id: string): string {
  return ['---', `id: ${id}`, 'type: convention', `title: Title ${id}`, '---', '', `Body of ${id}.`, ''].join('\n')
}

interface World {
  handlers: KnowledgeHandlers
  dmHome: string
  /** The tracked folder. */
  folder: string
  /** Its own knowledge layer's folder. */
  repoKnowledge: string
  /** What the next folder picks answer, in order; null cancels. */
  picks: Array<string | null>
}

function createWorld(gitRunner: GitRunner = createGitRunner()): World {
  const repo = createTempRepo()
  const home = scratchDir('dm-home-')
  cleanups.push(repo.cleanup, home.cleanup)
  const picks: Array<string | null> = []
  const handlers = createKnowledgeHandlers({
    registry: {
      resolve: (path) => (path === repo.root ? repo.root : null),
      storageMode: () => 'repo'
    },
    dmHome: home.path,
    fs: nodeFs,
    gitRunner,
    pickKnowledgeRepository: async () => picks.shift() ?? null
  })
  return { handlers, dmHome: home.path, folder: repo.root, repoKnowledge: repo.layout.knowledgeDir, picks }
}

/** A Git repository whose `knowledge/` holds one committed fact, one commit ahead of its upstream and one file uncommitted. */
function overallRepository(): string {
  const repo = createGitRepo()
  const bare = scratchDir()
  cleanups.push(repo.cleanup, bare.cleanup)
  gitIn(bare.path, 'init', '-q', '--bare', '-b', 'main')
  repo.git('remote', 'add', 'origin', bare.path)
  repo.git('push', '-q', '-u', 'origin', 'main')
  put(repo.root, 'knowledge/team/style.md', fact('team.style'))
  repo.git('add', 'knowledge')
  repo.git('commit', '-q', '-m', 'knowledge')
  put(repo.root, 'notes.txt', 'uncommitted\n')
  return repo.root
}

const pointerFile = (world: World): string => join(world.dmHome, 'knowledge.json')
const nonBuiltin = (world: World): unknown =>
  world.handlers.knowledgeStatus(world.folder).then((status) => status.diagnostics.filter((d) => d.layer !== 'builtin'))

describe('knowledge:status', () => {
  it('shows no overall repository, the folder layer count and its diagnostics', async () => {
    const world = createWorld()
    put(world.repoKnowledge, 'local.md', fact('local'))
    put(world.repoKnowledge, 'broken.md', 'no frontmatter here\n')

    const status = await world.handlers.knowledgeStatus(world.folder)

    expect(status.layers.overall).toEqual({ configured: false, path: null, count: 0 })
    expect(status.layers.repo).toEqual({ path: world.repoKnowledge, count: 1 })
    expect(status.layers.builtin.count).toEqual(expect.any(Number))
    expect(status.git).toBeNull()
    expect(status.diagnostics.filter((d) => d.layer === 'repo')).toEqual([
      { layer: 'repo', path: '.darkmechanicus/knowledge/broken.md', message: expect.any(String) }
    ])
  })

  it('refuses a folder that is not tracked', async () => {
    const world = createWorld()
    await expect(world.handlers.knowledgeStatus('/somewhere/else')).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(world.handlers.knowledgeStatus(42)).rejects.toBeInstanceOf(DomainError)
  })

  it('reports the Git state as unavailable when the pointed-at folder is no longer a repository', async () => {
    const world = createWorld()
    const plain = scratchDir()
    cleanups.push(plain.cleanup)
    put(plain.path, 'knowledge/notes.md', fact('team.notes'))
    put(world.dmHome, 'knowledge.json', JSON.stringify({ repository: plain.path }))

    const status = await world.handlers.knowledgeStatus(world.folder)

    expect(status.layers.overall).toEqual({ configured: true, path: plain.path, count: 1 })
    expect(status.git).toEqual({ state: 'unavailable', reason: 'The folder is not a Git repository.' })
  })
})

describe('knowledge:choose-repository', () => {
  it('writes the pointer for a Git work tree and then reports its path, Git state and facts', async () => {
    const world = createWorld()
    const overall = overallRepository()
    world.picks.push(overall)

    expect(await world.handlers.chooseKnowledgeRepository()).toEqual({ outcome: 'set', repository: overall })

    expect(JSON.parse(readFileSync(pointerFile(world), 'utf8'))).toEqual({ repository: overall })
    const status = await world.handlers.knowledgeStatus(world.folder)
    expect(status.layers.overall).toEqual({ configured: true, path: overall, count: 1 })
    expect(status.git).toEqual({ state: 'ok', branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, dirty: true })
    expect(await nonBuiltin(world)).toEqual([])
  })

  it('refuses a folder that is not a Git work tree and leaves the pointer alone', async () => {
    const world = createWorld()
    const plain = scratchDir()
    cleanups.push(plain.cleanup)
    world.picks.push(plain.path)

    const result = await world.handlers.chooseKnowledgeRepository()

    expect(result).toEqual({ outcome: 'refused', reason: `${plain.path} is not a Git work tree. Choose the folder of a cloned repository.` })
    expect(existsSync(pointerFile(world))).toBe(false)
  })

  it('refuses the .git folder of a repository, which is inside Git but not a work tree', async () => {
    const world = createWorld()
    world.picks.push(join(overallRepository(), '.git'))

    expect(await world.handlers.chooseKnowledgeRepository()).toMatchObject({ outcome: 'refused' })
    expect(existsSync(pointerFile(world))).toBe(false)
  })

  it('keeps the current pointer when the picker is cancelled', async () => {
    const world = createWorld()
    const overall = overallRepository()
    world.picks.push(overall, null)
    await world.handlers.chooseKnowledgeRepository()

    expect(await world.handlers.chooseKnowledgeRepository()).toEqual({ outcome: 'cancelled' })
    expect(JSON.parse(readFileSync(pointerFile(world), 'utf8'))).toEqual({ repository: overall })
  })
})

describe('knowledge:clear-repository', () => {
  it('removes the pointer, so the status shows no overall repository again', async () => {
    const world = createWorld()
    world.picks.push(overallRepository())
    await world.handlers.chooseKnowledgeRepository()

    await world.handlers.clearKnowledgeRepository()

    expect(existsSync(pointerFile(world))).toBe(false)
    const status = await world.handlers.knowledgeStatus(world.folder)
    expect(status.layers.overall).toEqual({ configured: false, path: null, count: 0 })
    expect(status.git).toBeNull()
    await world.handlers.clearKnowledgeRepository()
  })
})

describe('knowledge handlers when Git cannot run', () => {
  /** A world whose pointer names a plain folder, whose Git state `gitRunner` reads. */
  function pointedWorld(gitRunner: GitRunner): World {
    const world = createWorld(gitRunner)
    const plain = scratchDir()
    cleanups.push(plain.cleanup)
    put(world.dmHome, 'knowledge.json', JSON.stringify({ repository: plain.path }))
    return world
  }

  const failingRunner = (error: unknown): GitRunner => ({
    run: () => Promise.reject(error)
  })

  it('says Git was not found, in the status and when choosing a repository, and writes no pointer', async () => {
    const missing = scratchDir()
    cleanups.push(missing.cleanup)
    const world = createWorld(createGitRunner({ gitPath: join(missing.path, 'no-such-git') }))
    world.picks.push(missing.path)

    expect(await world.handlers.chooseKnowledgeRepository()).toEqual({ outcome: 'refused', reason: 'Git was not found on this computer.' })
    expect(existsSync(pointerFile(world))).toBe(false)

    put(world.dmHome, 'knowledge.json', JSON.stringify({ repository: missing.path }))
    const status = await world.handlers.knowledgeStatus(world.folder)
    expect(status.git).toEqual({ state: 'unavailable', reason: 'Git was not found on this computer.' })
  })

  it('shows why Git failed as the unavailable reason, or the error text when it has no message', async () => {
    const timedOut = pointedWorld(failingRunner(new GitError('timeout', '', 'git rev-parse timed out')))
    expect((await timedOut.handlers.knowledgeStatus(timedOut.folder)).git).toEqual({
      state: 'unavailable',
      reason: 'git rev-parse timed out'
    })

    const blank = pointedWorld(failingRunner(new Error('')))
    expect((await blank.handlers.knowledgeStatus(blank.folder)).git).toEqual({ state: 'unavailable', reason: 'Error' })
  })

  it('fails the choice on an unexpected error, without writing the pointer', async () => {
    const world = createWorld(failingRunner(new Error('spawn exploded')))
    const plain = scratchDir()
    cleanups.push(plain.cleanup)
    world.picks.push(plain.path)

    await expect(world.handlers.chooseKnowledgeRepository()).rejects.toThrow('spawn exploded')
    expect(existsSync(pointerFile(world))).toBe(false)
  })
})
