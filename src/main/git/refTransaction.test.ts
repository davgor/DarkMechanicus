/** DM-949: the held `update-ref --stdin` transaction: symbolic-ref verification, single ending and refused commits. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { openRefTransaction } from './refTransaction'
import { createGitRunner, type GitRunner } from './runner'

const runner = createGitRunner()
const cleanups: Array<() => void> = []

beforeEach(() => isolateGitConfig(cleanups))

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function repository(): { repo: GitRepo; gitDir: string; first: string; second: string } {
  const repo = createGitRepo()
  cleanups.push(repo.cleanup)
  const first = repo.commit('first')
  const second = repo.commit('second')
  return { repo, gitDir: repo.git('rev-parse', '--absolute-git-dir'), first, second }
}

describe('openRefTransaction', () => {
  it('verifies the symbolic HEAD itself with --no-deref, and refuses to prepare when HEAD names another branch', async () => {
    const { repo, gitDir, second } = repository()
    const branch = repo.git('symbolic-ref', 'HEAD')
    const held = await openRefTransaction(runner, { gitDir, message: 'verify', noDeref: true, commands: [`symref-verify HEAD ${branch}`] })
    await held.commit()
    expect([repo.git('symbolic-ref', 'HEAD'), repo.rev('HEAD')]).toEqual([branch, second])
    await expect(openRefTransaction(runner, { gitDir, message: 'verify', noDeref: true, commands: ['symref-verify HEAD refs/heads/elsewhere'] }))
      .rejects.toMatchObject({ name: 'GitError' })
    expect(repo.git('symbolic-ref', 'HEAD')).toBe(branch)
  })

  it('ends the transaction once: a commit after an abort changes nothing and reports no confirmation', async () => {
    const { repo, gitDir, first, second } = repository()
    const held = await openRefTransaction(runner, { gitDir, message: 'test', noDeref: false, commands: [`update HEAD ${first} ${second}`] })
    await held.abort()
    await held.abort()
    await expect(held.commit()).rejects.toThrow(/did not confirm the commit/)
    expect(repo.rev('HEAD')).toBe(second)
  })

  it('rethrows the runner failure of a commit and leaves the ref where it was', async () => {
    const { repo, gitDir, first, second } = repository()
    const refused = new Error('git exited while committing')
    const failing: GitRunner = {
      run: (request) => runner.run(request).then((result) => (request.args.includes('--stdin') ? Promise.reject(refused) : result))
    }
    const held = await openRefTransaction(failing, { gitDir, message: 'test', noDeref: false, commands: [`update refs/heads/other ${first} ${'0'.repeat(40)}`] })
    await expect(held.commit()).rejects.toBe(refused)
    expect(repo.git('rev-parse', '--verify', '--quiet', 'refs/heads/other') === second).toBe(false)
  })
})
