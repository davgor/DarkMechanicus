// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GitResult } from '../../../shared/git/api'
import type { FileChange, RepoState, RepoStatus } from '../../../shared/git/status'
import type { PullRequestInfo, PullRequestSummary } from '../../../shared/github/pullRequests'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeGit } from '../__mocks__/fakeGit'
import { FakeGithub } from '../__mocks__/fakeGithub'
import { folderView } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ToastProvider } from '../app/toasts'
import { GithubAccountProvider } from '../github/GithubAccount'
import { SourceControlView } from './SourceControlView'

const FOLDER = '/work/alpha'
const REPOSITORY = { owner: 'octo', repo: 'app' }
const COMPARE = 'https://github.com/octo/app/compare/main...feature?expand=1'

let git: FakeGit
let dm: FakeDm
let github: FakeGithub

beforeEach(() => {
  window.localStorage.clear()
  git = new FakeGit()
  dm = new FakeDm()
  github = new FakeGithub()
  github.account = { login: 'ada', name: null }
  window.git = git
  window.dm = dm
  window.github = github
})

afterEach(cleanup)

function status(branch: Partial<RepoStatus['branch']> = {}, files: FileChange[] = []): RepoStatus {
  return {
    root: FOLDER,
    branch: { name: 'feature', headOid: 'a'.repeat(40), upstream: 'origin/feature', ahead: 0, behind: 0, ...branch },
    files,
    inProgress: null,
    lastFetchedAt: null,
    remote: { name: 'origin', githubHttps: true }
  }
}

function pull(number: number, patch: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number,
    title: `Pull request ${number}`,
    author: 'grace',
    isDraft: false,
    url: `https://github.com/octo/app/pull/${number}`,
    updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    baseRef: 'main',
    headRef: `topic-${number}`,
    headRepoFullName: 'octo/app',
    fromFork: false,
    ...patch
  }
}

function onGithub(open: PullRequestSummary[], current: PullRequestSummary | null = null): void {
  git.setPullRequests(FOLDER, { ok: true, data: { repository: REPOSITORY, current, open } })
}

const SIGNED_OUT: GitResult<PullRequestInfo> = { ok: false, error: { code: 'auth_required', message: 'Sign in to GitHub.' } }

async function mount(value: RepoStatus = status()): Promise<void> {
  const state: RepoState = { kind: 'repository', status: value }
  git.setState(FOLDER, state)
  git.setBranches(FOLDER, { current: value.branch.name, defaultBranch: 'main', branches: [] })
  const scheduler = new ManualScheduler()
  render(
    <ToastProvider scheduler={scheduler}>
      <GithubAccountProvider>
        <SourceControlView folder={folderView({ path: FOLDER, name: 'alpha' })} scheduler={scheduler} />
      </GithubAccountProvider>
    </ToastProvider>
  )
  await settle()
}

const toolbar = (): HTMLElement => document.querySelector<HTMLElement>('.source-toolbar') as HTMLElement
const calls = (method: string): unknown[] => git.calls.filter((call) => call.method === method)

describe('the toolbar pull request', () => {
  it('shows #N and the title of the branch pull request, with a draft badge, and opens it', async () => {
    const current = pull(12, { title: 'Add search', isDraft: true })
    onGithub([current], current)
    await mount()
    const pill = within(toolbar()).getByRole('button', { name: /#12 Add search/ })
    expect(within(pill).getByText('Draft')).toBeTruthy()
    fireEvent.click(pill)
    expect(dm.opened).toEqual(['https://github.com/octo/app/pull/12'])
  })

  it('offers Create pull request that opens the compare page', async () => {
    onGithub([pull(3)])
    git.setCompareUrl(FOLDER, { kind: 'url', url: COMPARE })
    await mount()
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Create pull request' }))
    await settle()
    expect(calls('push')).toEqual([])
    expect(dm.opened).toEqual([COMPARE])
  })

  it('pushes first with Push and create pull request, showing progress, then opens the compare page', async () => {
    onGithub([])
    git.setCompareUrl(FOLDER, { kind: 'needs_push' })
    await mount(status({ upstream: null }))
    let finish: (result: GitResult<RepoState>) => void = () => undefined
    git.push = (folder, request) => {
      git.calls.push({ method: 'push', folder, request })
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Push and create pull request' }))
    await settle()
    const [call] = calls('push') as Array<{ request: { operationId: string } }>
    git.emitProgress({ folder: FOLDER, operation: 'push', operationId: call.request.operationId, phase: 'Writing objects', percent: 40 })
    await settle()
    expect(within(toolbar()).getByRole('status').textContent).toContain('Writing objects 40%')
    expect(dm.opened).toEqual([])
    git.setCompareUrl(FOLDER, { kind: 'url', url: COMPARE })
    await act(async () => finish({ ok: true, data: { kind: 'repository', status: status() } }))
    await settle()
    expect(dm.opened).toEqual([COMPARE])
  })
})

describe('Create pull request edges', () => {
  it('shows the push failure and opens nothing', async () => {
    onGithub([])
    git.setCompareUrl(FOLDER, { kind: 'needs_push' })
    await mount(status({ upstream: null }))
    git.syncError = { code: 'git_failed', message: 'The remote hung up.' }
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Push and create pull request' }))
    await settle()
    expect(within(toolbar()).getByRole('alert').textContent).toContain('The remote hung up.')
    expect(dm.opened).toEqual([])
  })

  it('shows no Create pull request on the default branch', async () => {
    onGithub([])
    git.setCompareUrl(FOLDER, { kind: 'url', url: COMPARE })
    await mount(status({ name: 'main', upstream: 'origin/main' }))
    expect(within(toolbar()).queryByRole('button', { name: /pull request/ })).toBeNull()
  })
})

describe('the toolbar outside a signed-in GitHub repository', () => {
  it('shows nothing for a repository that is not on GitHub', async () => {
    await mount()
    expect(within(toolbar()).queryByRole('button', { name: /pull request/i })).toBeNull()
    expect(within(toolbar()).queryByText(/Sign in/)).toBeNull()
    expect(calls('getCompareUrl')).toEqual([])
  })

  it('signed out, shows a link that opens the sign-in dialog', async () => {
    github.account = null
    git.setPullRequests(FOLDER, SIGNED_OUT)
    await mount()
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Sign in to see pull requests' }))
    await settle()
    expect(screen.getByRole('dialog', { name: /Sign in/ })).toBeTruthy()
  })
})

async function openPullRequests(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /Current branch/ }))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Pull requests' }))
  await settle()
}

const pullList = (): HTMLElement => screen.getByRole('listbox', { name: 'Pull requests' })

describe('the branch menu Pull requests view', () => {
  it('lists the open pull requests with number, title, author, draft and fork labels', async () => {
    onGithub([pull(7, { isDraft: true }), pull(9, { fromFork: true, headRepoFullName: 'grace/app' })])
    await mount()
    await openPullRequests()
    const rows = within(pullList()).getAllByRole('option')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('#7')
    expect(rows[0].textContent).toContain('Pull request 7')
    expect(rows[0].textContent).toContain('grace')
    expect(rows[0].textContent).toContain('2h ago')
    expect(within(rows[0]).getByText('Draft')).toBeTruthy()
    expect(within(rows[1]).getByText('Fork')).toBeTruthy()
  })

  it('filters with the same input, by number or title', async () => {
    onGithub([pull(7, { title: 'Fix login' }), pull(9, { title: 'Add search' })])
    await mount()
    await openPullRequests()
    fireEvent.change(screen.getByRole('textbox', { name: /Filter/ }), { target: { value: 'search' } })
    expect(within(pullList()).getAllByRole('option').map((row) => row.textContent)).toEqual([expect.stringContaining('Add search')])
    fireEvent.change(screen.getByRole('textbox', { name: /Filter/ }), { target: { value: '#7' } })
    expect(within(pullList()).getAllByRole('option').map((row) => row.textContent)).toEqual([expect.stringContaining('Fix login')])
  })

  it('asks GitHub again with Refresh', async () => {
    onGithub([pull(7)])
    await mount()
    await openPullRequests()
    onGithub([pull(7), pull(8)])
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(git.calls).toContainEqual({ method: 'getPullRequests', folder: FOLDER, request: { refresh: true } })
    expect(within(pullList()).getAllByRole('option')).toHaveLength(2)
  })
})

describe('checking out a pull request', () => {
  it('checks a pull request out at once without changes', async () => {
    onGithub([pull(7)])
    await mount()
    await openPullRequests()
    fireEvent.click(within(pullList()).getByRole('option', { name: /#7/ }))
    await settle()
    expect(calls('checkoutPullRequest')).toEqual([{ method: 'checkoutPullRequest', folder: FOLDER, request: { number: 7, uncommitted: 'bring' } }])
  })

  it('with changes, asks the same stash or bring question as a branch switch', async () => {
    onGithub([pull(7)])
    await mount(status({}, [{ path: 'a.ts', oldPath: null, kind: 'modified', staged: false } as unknown as FileChange]))
    await openPullRequests()
    fireEvent.click(within(pullList()).getByRole('option', { name: /#7/ }))
    await settle()
    const dialog = screen.getByRole('dialog', { name: 'Switch to #7 Pull request 7' })
    expect(calls('checkoutPullRequest')).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave my changes on feature' }))
    await settle()
    expect(calls('checkoutPullRequest')).toEqual([{ method: 'checkoutPullRequest', folder: FOLDER, request: { number: 7, uncommitted: 'stash' } }])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('signed out, shows the sign-in prompt', async () => {
    github.account = null
    git.setPullRequests(FOLDER, SIGNED_OUT)
    await mount()
    await openPullRequests()
    expect(screen.getByText('Sign in to GitHub to see pull requests')).toBeTruthy()
  })

  it('has no Pull requests switch for a repository that is not on GitHub', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: /Current branch/ }))
    await settle()
    expect(screen.queryByRole('button', { name: 'Pull requests' })).toBeNull()
  })
})

describe('View on GitHub in History', () => {
  async function openCommitMenu(): Promise<void> {
    git.setHistory(FOLDER, [
      { oid: 'b'.repeat(40), shortOid: 'bbbbbbb', parents: [], authorName: 'Ada', authorEmail: 'a@b.c', authoredAt: new Date().toISOString(), summary: 'First', body: '', unpushed: false }
    ])
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for First' }))
  }

  it('opens the commit on GitHub', async () => {
    onGithub([])
    await openCommitMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'View on GitHub' }))
    await settle()
    expect(dm.opened).toEqual([`https://github.com/octo/app/commit/${'b'.repeat(40)}`])
  })

  it('is offered signed out on a GitHub repository', async () => {
    github.account = null
    git.setPullRequests(FOLDER, SIGNED_OUT)
    await openCommitMenu()
    expect(screen.getByRole('menuitem', { name: 'View on GitHub' })).toBeTruthy()
  })

  it('is absent for a repository that is not on GitHub', async () => {
    await openCommitMenu()
    expect(screen.queryByRole('menuitem', { name: 'View on GitHub' })).toBeNull()
  })
})
