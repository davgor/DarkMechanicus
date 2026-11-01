/** The pull request handlers: input validation, tracked folders, and GitHub failures as results. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitResult } from '../../shared/git/api'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import type { GithubPullRequest } from '../github/client'
import { GithubError } from '../github/errors'
import { createGitHandlers, type GitHandlers } from './handlers'
import { createGitRunner } from './runner'

const cleanups: Array<() => void> = []
beforeEach(() => isolateGitConfig(cleanups))
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

const PULL: GithubPullRequest = {
  number: 1,
  title: 'Fix it',
  user: { login: 'mona' },
  draft: false,
  updated_at: '2026-10-30T12:00:00Z',
  base: { ref: 'main' },
  head: { ref: 'main', repo: { full_name: 'octo/repo' } }
}

function setup(options: { signedIn?: boolean; pages?: () => Promise<GithubPullRequest[]> } = {}): { handlers: GitHandlers; r: GitRepo; unexpected: unknown[] } {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  r.git('remote', 'add', 'origin', 'https://github.com/octo/repo.git')
  const unexpected: unknown[] = []
  const signedIn = options.signedIn ?? true
  const handlers = createGitHandlers({
    registry: { resolve: (folder) => (folder === r.root ? folder : null) },
    runner: createGitRunner(),
    trashItem: () => Promise.resolve(),
    openPath: () => Promise.resolve(''),
    session: { getAccount: () => (signedIn ? { login: 'octocat' } : null), getToken: () => (signedIn ? 'gho_FAKE' : null) },
    client: { listOpenPullRequests: options.pages ?? (() => Promise.resolve([PULL])) },
    onProgress: () => undefined,
    onUnexpectedError: (error) => unexpected.push(error)
  })
  return { handlers, r, unexpected }
}

function data<T>(result: GitResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`)
  }
  return result.data
}

function code(result: GitResult<unknown>): string {
  if (result.ok) {
    throw new Error('expected a failure')
  }
  return result.error.code
}

describe('pull request handlers', () => {
  it('returns the pull requests of a tracked folder, with the current branch one', async () => {
    const { handlers, r } = setup()
    const info = data(await handlers.getPullRequests(r.root, { refresh: true }))
    expect(info.repository).toEqual({ owner: 'octo', repo: 'repo' })
    expect(info.current?.number).toBe(1)
    expect(data(await handlers.getPullRequests(r.root, undefined)).open).toHaveLength(1)
  })

  it('reports a GitHub failure with its code and fixed message, never as unexpected', async () => {
    const signedOut = setup({ signedIn: false })
    const result = await signedOut.handlers.getPullRequests(signedOut.r.root, {})
    expect(result).toEqual({ ok: false, error: { code: 'auth_required', message: new GithubError('auth_required').message } })
    const failing = setup({ pages: () => Promise.reject(new GithubError('github_failed', 'GitHub answered 500.')) })
    expect(code(await failing.handlers.getPullRequests(failing.r.root, {}))).toBe('github_failed')
    expect([...signedOut.unexpected, ...failing.unexpected]).toEqual([])
  })

  it('validates every request and refuses an untracked folder', async () => {
    const { handlers, r } = setup()
    expect(code(await handlers.getPullRequests('/elsewhere', {}))).toBe('unauthorized')
    expect(code(await handlers.getPullRequests(r.root, { refresh: 'yes' }))).toBe('invalid_input')
    for (const request of [{ number: 0, uncommitted: 'bring' }, { number: 1.5, uncommitted: 'stash' }, { number: '1', uncommitted: 'bring' }, { number: 1, uncommitted: 'drop' }, { number: 1 }]) {
      expect(code(await handlers.checkoutPullRequest(r.root, request))).toBe('invalid_input')
    }
    expect(code(await handlers.getCommitUrl(r.root, 'not-an-oid'))).toBe('invalid_input')
    expect(code(await handlers.getCompareUrl('/elsewhere'))).toBe('unauthorized')
  })

  it('builds the URLs of a GitHub repository', async () => {
    const { handlers, r } = setup()
    const oid = r.rev('HEAD')
    expect(data(await handlers.getCommitUrl(r.root, oid))).toBe(`https://github.com/octo/repo/commit/${oid}`)
    expect(data(await handlers.getCompareUrl(r.root))).toEqual({ kind: 'needs_push' })
  })
})
