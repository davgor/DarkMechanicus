/** A fetch against a real remote that stalls (an `ext::` remote helper that says one line and sleeps) ends with `timeout`. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitRepo } from '../../test/gitRepo'
import { scratchDir } from '../../test/gitScratch'
import { createGitRunner } from './runner'
import { createSync } from './sync'

const signedOut = { getAccount: () => null, getToken: () => null }
const cleanups: Array<() => void> = []
/**
 * The lowered stall limit; production uses 60 s. The stall clock starts when git is spawned, so the limit must
 * outlast git starting `git-remote-ext` and `sh` and the helper's first line reaching git's stderr, even on a
 * loaded machine; at 1 s that start-up alone sometimes ran out the clock, ending with an empty detail.
 */
const STALL_MS = 3000

beforeEach(() => {
  const home = scratchDir('dm-stall-home-')
  cleanups.push(home.cleanup)
  writeFileSync(join(home.path, 'gitconfig'), '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(home.path, 'gitconfig'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
})

afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

// Skipped on Windows: the remote helper is a POSIX shell command.
describe.skipIf(process.platform === 'win32')('a stalled remote (real git)', () => {
  it('ends a fetch that makes no progress with timeout and the helper’s last stderr line as the detail', async () => {
    const repo = createGitRepo()
    cleanups.push(repo.cleanup)
    // `% ` is a space inside an ext:: command; the helper writes one line to git's stderr, then never answers.
    repo.git('remote', 'add', 'origin', 'ext::sh -c echo% stalled-helper% waiting>&2;sleep% 30')
    repo.git('config', 'protocol.ext.allow', 'always')
    const sync = createSync({ runner: createGitRunner({ stallMs: STALL_MS }), session: signedOut, onProgress: () => undefined, env: {} })
    const started = Date.now()
    await expect(sync.run('fetch', repo.root, 'op-stall')).rejects.toMatchObject({
      code: 'timeout',
      detail: 'stalled-helper waiting',
      message: expect.stringMatching(/stalled/)
    })
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
