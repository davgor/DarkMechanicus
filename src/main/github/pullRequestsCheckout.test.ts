/**
 * Checking out pull requests and building GitHub URLs, on real temporary repositories with a local bare `origin`.
 * The origin is named by its github.com URL and rewritten (insteadOf) to the bare repository, as a mirror would be.
 * The code under test spawns dozens of git processes per checkout, so the tests themselves spawn few: each test
 * copies a repository pair built once per file, and teammates' and forks' commits are written straight into the
 * bare origin with one `git fast-import` each.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoState } from '../../shared/git/status'
import { createFakeHttp, jsonResponse, type FakeHttp } from '../../test/fakeHttp'
import { isolateGitConfig } from '../../test/gitRemotes'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { gitIn, put, scratchDir } from '../../test/gitScratch'
import { GitError, GitInputError } from '../git/errors'
import { createGitRunner, type GitRunner } from '../git/runner'
import { createSessionClient } from './client'
import { GithubError } from './errors'
import { createPullRequests, type PullRequests } from './pullRequests'

const GITHUB_URL = 'https://github.com/octo/repo.git'
const runner = createGitRunner()
const cleanups: Array<() => void> = []
const templateCleanups: Array<() => void> = []
/** Folders holding `repo` (on `main`, tracking `origin/main`) and its bare `origin.git`, by whether origin names GitHub. */
const templates = { github: '', plain: '' }

/** Builds one template pair: the only `git init`, initial commit and push in the file for that kind of origin. */
function buildTemplate(onGithub: boolean): string {
  const base = scratchDir('dm-pr-template-')
  templateCleanups.push(base.cleanup)
  const local = createGitRepo({ root: join(base.path, 'repo') })
  const bare = join(base.path, 'origin.git')
  gitIn(base.path, 'init', '-q', '--bare', '-b', 'main', bare)
  local.git('remote', 'add', 'origin', onGithub ? GITHUB_URL : bare)
  if (onGithub) {
    local.git('config', `url.${bare}.insteadOf`, GITHUB_URL)
  }
  local.git('push', '-q', '-u', 'origin', 'main')
  return base.path
}

beforeAll(() => {
  isolateGitConfig(templateCleanups)
  try {
    templates.github = buildTemplate(true)
    templates.plain = buildTemplate(false)
  } finally {
    vi.unstubAllEnvs()
  }
})

afterAll(() => {
  while (templateCleanups.length > 0) {
    templateCleanups.pop()?.()
  }
})

beforeEach(() => isolateGitConfig(cleanups))

afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

type Local = Pick<GitRepo, 'root' | 'git' | 'commit' | 'rev' | 'branch' | 'switchTo'>

/** The test's side of a copied repository, as `createGitRepo` would give it (its initial commit added file-1.txt). */
function openLocal(root: string): Local {
  const git = (...args: string[]): string => gitIn(root, ...args).trim()
  let counter = 1
  return {
    root,
    git,
    commit: (message) => {
      counter += 1
      const file = `file-${counter}.txt`
      put(root, file, `${message}\n${counter}\n`)
      git('add', '--', file)
      git('commit', '-q', '-m', message)
      return git('rev-parse', 'HEAD')
    },
    rev: (ref) => git('rev-parse', '--verify', `${ref}^{commit}`),
    branch: (name) => {
      git('checkout', '-q', '-b', name)
    },
    switchTo: (name) => {
      git('checkout', '-q', name)
    }
  }
}

/** A fresh copy of a template pair; the copy's config names its own bare origin. */
function copyTemplate(template: string): { local: Local; bare: string } {
  const dir = scratchDir('dm-pr-')
  cleanups.push(dir.cleanup)
  cpSync(template, dir.path, { recursive: true })
  const config = join(dir.path, 'repo', '.git', 'config')
  writeFileSync(config, readFileSync(config, 'utf8').replaceAll(template, dir.path))
  return { local: openLocal(join(dir.path, 'repo')), bare: join(dir.path, 'origin.git') }
}

interface Repos {
  local: Local
  /** The bare `origin`, where teammates' and forks' commits land. */
  bare: string
  http: FakeHttp
  prs: PullRequests
  signOut(): void
}

/** A repository on `main` tracking `origin/main`; origin is named by its github.com URL unless `onGithub` is false. */
function setup(onGithub = true, gitRunner: GitRunner = runner): Repos {
  const { local, bare } = copyTemplate(onGithub ? templates.github : templates.plain)
  const http = createFakeHttp()
  let token: string | null = 'gho_FAKE_TOKEN_checkout_1'
  const session = {
    getAccount: () => (token === null ? null : { login: 'octocat' }),
    getToken: () => token,
    signOut: () => {
      token = null
    }
  }
  const client = createSessionClient(session, { fetch: http.fetch, appVersion: '1' })
  const prs = createPullRequests({ runner: gitRunner, session, client, env: {} })
  return { local, bare, http, prs, signOut: session.signOut }
}

function apiPull(number: number, headRef: string, headRepo: string | null): unknown {
  return {
    number,
    title: `Pull ${number}`,
    user: { login: 'mona' },
    draft: false,
    updated_at: '2026-10-30T12:00:00Z',
    base: { ref: 'main' },
    head: { ref: headRef, repo: headRepo === null ? null : { full_name: headRepo } }
  }
}

/**
 * Writes a commit of `file` on top of `from` straight into the bare origin and points `ref` at it (forced, as a
 * fork's force-push would). Returns the new commit.
 */
function pushCommit(bare: string, ref: string, { from, file, content }: { from: string; file: string; content: string }): string {
  const message = `${file}: ${content.trim()}\n`
  const marks = join(bare, 'dm-test-marks')
  const stream = [
    `commit ${ref}\nmark :1\ncommitter Test <test@example.com> 1700000000 +0000\n`,
    `data ${Buffer.byteLength(message)}\n${message}from ${from}\n`,
    `M 100644 inline ${file}\ndata ${Buffer.byteLength(content)}\n${content}\n`
  ].join('')
  execFileSync('git', ['-C', bare, 'fast-import', '--quiet', '--force', `--export-marks=${marks}`], {
    input: stream,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  return readFileSync(marks, 'utf8').trim().split(' ')[1] ?? ''
}

function branchOf(state: RepoState): string | null {
  if (state.kind !== 'repository') {
    throw new Error(`expected a repository, got ${state.kind}`)
  }
  return state.status.branch.name
}

function upstreamOf(local: Local, branch: string): string {
  return gitIn(local.root, 'for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`).trim()
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error
  )
}

describe('checkoutPullRequest: same repository', () => {
  it('fetches the head branch and switches to a new local branch tracking it, then to the existing one', async () => {
    const { local, bare, http, prs } = setup()
    const tip = pushCommit(bare, 'refs/heads/feature/login', { from: 'main', file: 'login.txt', content: 'one\n' })
    http.answer(jsonResponse(200, [apiPull(1, 'feature/login', 'octo/repo')]))
    expect(branchOf(await prs.checkout(local.root, { number: 1, uncommitted: 'bring' }))).toBe('feature/login')
    expect(local.rev('HEAD')).toBe(tip)
    expect(upstreamOf(local, 'feature/login')).toBe('origin/feature/login')

    local.switchTo('main')
    expect(branchOf(await prs.checkout(local.root, { number: 1, uncommitted: 'bring' }))).toBe('feature/login')
    expect(http.requests).toHaveLength(1)
  })

  it('refuses a head branch name git would not accept, before fetching', async () => {
    const { local, http, prs } = setup()
    http.answer(jsonResponse(200, [apiPull(1, '-x', 'octo/repo')]))
    expect(await rejection(prs.checkout(local.root, { number: 1, uncommitted: 'bring' }))).toBeInstanceOf(GitInputError)
    expect(local.git('branch', '--show-current')).toBe('main')
  })
})

describe('checkoutPullRequest: fork', () => {
  it('checks out refs/pull/<n>/head as pr/<n> without an upstream', async () => {
    const { local, bare, http, prs } = setup()
    const first = pushCommit(bare, 'refs/pull/2/head', { from: 'main', file: 'fork.txt', content: 'one\n' })
    http.answer(jsonResponse(200, [apiPull(2, 'patch', 'fork/repo')]))
    expect(branchOf(await prs.checkout(local.root, { number: 2, uncommitted: 'bring' }))).toBe('pr/2')
    expect(local.rev('pr/2')).toBe(first)
    expect(upstreamOf(local, 'pr/2')).toBe('')
  })

  it('fast-forwards pr/<n> on a later checkout from another branch, asking GitHub once', async () => {
    const { local, bare, http, prs } = setup()
    const first = pushCommit(bare, 'refs/pull/2/head', { from: 'main', file: 'fork.txt', content: 'one\n' })
    http.answer(jsonResponse(200, [apiPull(2, 'patch', 'fork/repo')]))
    await prs.checkout(local.root, { number: 2, uncommitted: 'bring' })
    const second = pushCommit(bare, 'refs/pull/2/head', { from: first, file: 'fork.txt', content: 'two\n' })
    local.switchTo('main')
    expect(branchOf(await prs.checkout(local.root, { number: 2, uncommitted: 'bring' }))).toBe('pr/2')
    expect(local.rev('HEAD')).toBe(second)
    expect(http.requests).toHaveLength(1)
  })

  it('fast-forwards pr/<n> while it is the current branch', async () => {
    const { local, bare, http, prs } = setup()
    const first = pushCommit(bare, 'refs/pull/2/head', { from: 'main', file: 'fork.txt', content: 'one\n' })
    http.answer(jsonResponse(200, [apiPull(2, 'patch', 'fork/repo')]))
    await prs.checkout(local.root, { number: 2, uncommitted: 'bring' })
    const second = pushCommit(bare, 'refs/pull/2/head', { from: first, file: 'fork.txt', content: 'two\n' })
    expect(branchOf(await prs.checkout(local.root, { number: 2, uncommitted: 'bring' }))).toBe('pr/2')
    expect(local.rev('HEAD')).toBe(second)
    expect(local.git('status', '--porcelain')).toBe('')
  })

  it('returns rejected_non_fast_forward when the fork rewrote its branch, leaving pr/<n> and the current branch alone', async () => {
    const { local, bare, http, prs } = setup()
    const first = pushCommit(bare, 'refs/pull/2/head', { from: 'main', file: 'fork.txt', content: 'one\n' })
    http.answer(jsonResponse(200, [apiPull(2, 'patch', 'fork/repo')]))
    await prs.checkout(local.root, { number: 2, uncommitted: 'bring' })
    local.switchTo('main')
    pushCommit(bare, 'refs/pull/2/head', { from: 'main', file: 'fork.txt', content: 'rewritten\n' })
    const error = await rejection(prs.checkout(local.root, { number: 2, uncommitted: 'bring' }))
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).code).toBe('rejected_non_fast_forward')
    expect(local.rev('pr/2')).toBe(first)
    expect(local.git('branch', '--show-current')).toBe('main')
  })
})

describe('checkoutPullRequest: pr/<n> when the head is not a branch here', () => {
  it('checks out pr/<n> for a remote not on GitHub, without asking GitHub', async () => {
    const { local, bare, http, prs } = setup(false)
    const tip = pushCommit(bare, 'refs/pull/1/head', { from: 'main', file: 'fork.txt', content: 'one\n' })
    expect(branchOf(await prs.checkout(local.root, { number: 1, uncommitted: 'bring' }))).toBe('pr/1')
    expect(local.rev('pr/1')).toBe(tip)
    expect(http.requests).toEqual([])
  })

  it('checks out pr/<n> for a deleted fork, and for a pull request no longer open after asking GitHub again', async () => {
    const { local, bare, http, prs } = setup()
    pushCommit(bare, 'refs/pull/4/head', { from: 'main', file: 'gone.txt', content: 'one\n' })
    pushCommit(bare, 'refs/pull/5/head', { from: 'refs/pull/4/head', file: 'closed.txt', content: 'one\n' })
    http.answer(jsonResponse(200, [apiPull(4, 'patch', null)]))
    expect(branchOf(await prs.checkout(local.root, { number: 4, uncommitted: 'bring' }))).toBe('pr/4')
    http.answer(jsonResponse(200, [apiPull(4, 'patch', null)]))
    expect(branchOf(await prs.checkout(local.root, { number: 5, uncommitted: 'bring' }))).toBe('pr/5')
    expect(http.requests).toHaveLength(2)
  })

  it('checks out the fetched commit even when a background fetch rewrites FETCH_HEAD meanwhile, leaving no ref behind', async () => {
    let root = ''
    const racing: GitRunner = {
      run: async (request) => {
        const result = await runner.run(request)
        if (request.args.includes('fetch') && request.args.some((arg) => arg.includes('refs/pull/'))) {
          gitIn(root, 'fetch', '-q', 'origin')
        }
        return result
      }
    }
    const { local, bare, http, prs } = setup(true, racing)
    root = local.root
    const tip = pushCommit(bare, 'refs/pull/6/head', { from: 'main', file: 'fork.txt', content: 'one\n' })
    http.answer(jsonResponse(200, [apiPull(6, 'patch', 'fork/repo')]))
    expect(branchOf(await prs.checkout(local.root, { number: 6, uncommitted: 'bring' }))).toBe('pr/6')
    expect(local.rev('pr/6')).toBe(tip)
    expect(local.git('for-each-ref', 'refs/dm')).toBe('')
  })
})

describe('checkoutPullRequest: uncommitted changes and sign-in', () => {
  it('stashes the changes as dm-stash:<branch> with stash, and brings them along with bring', async () => {
    const { local, bare, http, prs } = setup()
    pushCommit(bare, 'refs/pull/2/head', { from: 'main', file: 'fork.txt', content: 'one\n' })
    http.answer(jsonResponse(200, [apiPull(2, 'patch', 'fork/repo')]))
    put(local.root, 'mine.txt', 'work\n')
    local.git('add', 'mine.txt')
    await prs.checkout(local.root, { number: 2, uncommitted: 'stash' })
    expect(local.git('status', '--porcelain')).toBe('')
    expect(local.git('stash', 'list', '--format=%s')).toContain('dm-stash:main')

    local.switchTo('main')
    put(local.root, 'mine2.txt', 'more\n')
    await prs.checkout(local.root, { number: 2, uncommitted: 'bring' })
    expect(local.git('branch', '--show-current')).toBe('pr/2')
    expect(local.git('status', '--porcelain')).toBe('?? mine2.txt')
  })

  it('changes nothing when git refuses to bring the changes, and leaves no pr/<n> behind', async () => {
    const { local, bare, http, prs } = setup()
    put(local.root, 'shared.txt', 'base\n')
    local.git('add', 'shared.txt')
    local.git('commit', '-q', '-m', 'shared')
    local.git('push', '-q', 'origin', 'main')
    pushCommit(bare, 'refs/pull/3/head', { from: 'main', file: 'shared.txt', content: 'theirs\n' })
    put(local.root, 'shared.txt', 'mine\n')
    http.answer(jsonResponse(200, [apiPull(3, 'patch', 'fork/repo')]))
    const error = await rejection(prs.checkout(local.root, { number: 3, uncommitted: 'bring' }))
    expect((error as GitError).code).toBe('local_changes_would_be_overwritten')
    expect(local.git('branch', '--list', 'pr/3')).toBe('')
    expect(local.git('status', '--porcelain')).toBe('M shared.txt')
  })

  it('returns auth_required for a GitHub repository while signed out', async () => {
    const { local, http, prs, signOut } = setup()
    signOut()
    const error = await rejection(prs.checkout(local.root, { number: 1, uncommitted: 'bring' }))
    expect((error as GithubError).code).toBe('auth_required')
    expect(http.requests).toEqual([])
  })
})

describe('getCompareUrl and getCommitUrl', () => {
  it("builds the compare URL against the default branch for a pushed branch, encoding the branch's name", async () => {
    const { local, prs } = setup()
    local.branch('feature/a#b')
    local.commit('work')
    local.git('push', '-q', '-u', 'origin', 'feature/a#b')
    await expect(prs.compareUrl(local.root)).resolves.toEqual({
      kind: 'url',
      url: 'https://github.com/octo/repo/compare/main...feature/a%23b?expand=1'
    })
  })

  it('returns needs_push for an unpublished branch, a branch ahead of its upstream, or one tracking another name', async () => {
    const { local, prs } = setup()
    local.branch('topic')
    await expect(prs.compareUrl(local.root)).resolves.toEqual({ kind: 'needs_push' })
    local.git('push', '-q', '-u', 'origin', 'topic')
    local.commit('unpushed')
    await expect(prs.compareUrl(local.root)).resolves.toEqual({ kind: 'needs_push' })
    local.git('switch', '-q', '-c', 'other', '--track', 'origin/main')
    await expect(prs.compareUrl(local.root)).resolves.toEqual({ kind: 'needs_push' })
  })

  it('builds the commit URL, and refuses both URLs for a repository not on GitHub', async () => {
    const { local, prs } = setup()
    const oid = local.rev('HEAD')
    await expect(prs.commitUrl(local.root, oid)).resolves.toBe(`https://github.com/octo/repo/commit/${oid}`)
    const plain = setup(false)
    expect(await rejection(plain.prs.commitUrl(plain.local.root, oid))).toBeInstanceOf(GitInputError)
    expect(await rejection(plain.prs.compareUrl(plain.local.root))).toBeInstanceOf(GitInputError)
  })

  it('refuses the compare URL on a detached HEAD', async () => {
    const { local, prs } = setup()
    local.git('switch', '-q', '--detach')
    expect(await rejection(prs.compareUrl(local.root))).toBeInstanceOf(GitInputError)
  })
})
