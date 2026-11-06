/** The per-repository operation lock: one operation at a time per canonical repository root, others in parallel. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scratchDir } from '../../test/gitScratch'
import { linkDirectory } from '../../test/tempRepo'
import { GitError } from './errors'
import { createOperationLocks } from './operationLock'
import type { GitRunner } from './runner'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

/** Answers `rev-parse --show-toplevel` with the root `roots` gives a folder, or fails like git outside a repository. */
function topLevelRunner(roots: Record<string, string>): GitRunner {
  return {
    run: async (request) => {
      const root = roots[request.cwd]
      if (root === undefined) {
        throw new GitError('not_repository', 'fatal: not a git repository')
      }
      return { code: 0, stdout: `${root}\n`, stderr: '' }
    }
  }
}

interface Held {
  started: boolean
  finish(): void
  /** The work to hand the lock: marks `started`, then holds the lock until `finish()`. */
  work(): Promise<string>
}

function held(value: string): Held {
  let finish: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const entry: Held = {
    started: false,
    finish: () => finish(),
    work: async () => {
      entry.started = true
      await done
      return value
    }
  }
  return entry
}

/** Lets every pending promise callback (and the fake runner's answers) run. */
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function repositoryDirs(): { root: string; sub: string; link: string; other: string } {
  const dir = scratchDir('dm-lock-')
  cleanups.push(dir.cleanup)
  const root = join(dir.path, 'repo')
  const sub = join(root, 'sub')
  const other = join(dir.path, 'other')
  mkdirSync(sub, { recursive: true })
  mkdirSync(other)
  const link = join(dir.path, 'link')
  linkDirectory(root, link)
  return { root, sub, link, other }
}

describe('createOperationLocks', () => {
  it('runs one operation at a time in a repository, however its folder is named, in request order', async () => {
    const { root, sub, link } = repositoryDirs()
    // The subfolder is in the repository; the symlink names the same root by another path.
    const locks = createOperationLocks(topLevelRunner({ [root]: root, [sub]: root, [link]: link }))
    const [first, second, third] = [held('first'), held('second'), held('third')]
    const results = [locks.run(root, first.work), locks.run(sub, second.work), locks.run(link, third.work)]
    await drain()
    expect([first.started, second.started, third.started]).toEqual([true, false, false])
    first.finish()
    await drain()
    expect([second.started, third.started]).toEqual([true, false])
    second.finish()
    await drain()
    expect(third.started).toBe(true)
    third.finish()
    expect(await Promise.all(results)).toEqual(['first', 'second', 'third'])
  })

  it('runs operations in different repositories at the same time', async () => {
    const { root, other } = repositoryDirs()
    const locks = createOperationLocks(topLevelRunner({ [root]: root, [other]: other }))
    const [first, second] = [held('first'), held('second')]
    const results = [locks.run(root, first.work), locks.run(other, second.work)]
    await drain()
    expect([first.started, second.started]).toEqual([true, true])
    first.finish()
    second.finish()
    expect(await Promise.all(results)).toEqual(['first', 'second'])
  })
})

describe('createOperationLocks after a failure, and outside a repository', () => {
  it('passes a failure on and lets the next operation run', async () => {
    const { root } = repositoryDirs()
    const locks = createOperationLocks(topLevelRunner({ [root]: root }))
    const failing = locks.run(root, () => Promise.reject(new Error('boom')))
    const next = held('next')
    const result = locks.run(root, next.work)
    await expect(failing).rejects.toThrow('boom')
    await drain()
    expect(next.started).toBe(true)
    next.finish()
    expect(await result).toBe('next')
  })

  it('still locks a folder git finds no repository in, under the folder itself', async () => {
    const { other } = repositoryDirs()
    const locks = createOperationLocks(topLevelRunner({}))
    const [first, second] = [held('first'), held('second')]
    const results = [locks.run(other, first.work), locks.run(other, second.work)]
    await drain()
    expect([first.started, second.started]).toEqual([true, false])
    first.finish()
    await drain()
    expect(second.started).toBe(true)
    second.finish()
    expect(await Promise.all(results)).toEqual(['first', 'second'])
  })
})
