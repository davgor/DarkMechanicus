// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitErrorShape, GitResult } from '../../../shared/git/api'
import type { RepoState, RepoStatus } from '../../../shared/git/status'
import { FakeGit } from '../__mocks__/fakeGit'
import { githubKit, renderWithGithub } from '../__mocks__/githubKit'
import type { GithubKit } from '../__mocks__/githubKit'
import { settle } from '../__mocks__/settle'
import { SyncButton } from './SyncButton'
import { BACKGROUND_FETCH_MS } from './useSync'

const FOLDER = '/work/alpha'
const NOW = Date.parse('2026-10-31T12:00:00.000Z')
const GITHUB_REMOTE = { name: 'origin', githubHttps: true }

let kit: GithubKit
let git: FakeGit
let refreshes: number

beforeEach(() => {
  kit = githubKit()
  git = new FakeGit()
  window.git = git
  refreshes = 0
  let next = 0
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
    next += 1
    return `00000000-0000-4000-8000-00000000000${next}` as `${string}-${string}-${string}-${string}-${string}`
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function status(patch: Partial<RepoStatus> = {}, branch: Partial<RepoStatus['branch']> = {}): RepoStatus {
  return {
    root: FOLDER,
    branch: { name: 'main', headOid: 'a'.repeat(40), upstream: 'origin/main', ahead: 0, behind: 0, ...branch },
    files: [],
    inProgress: null,
    lastFetchedAt: null,
    remote: GITHUB_REMOTE,
    ...patch
  }
}

async function mount(value: RepoStatus): Promise<void> {
  const state: RepoState = { kind: 'repository', status: value }
  git.setState(FOLDER, state)
  renderWithGithub(kit, <SyncButton folderPath={FOLDER} status={value} scheduler={kit.scheduler} now={() => NOW} onRefresh={() => (refreshes += 1)} />)
  await settle()
}

const primary = (): HTMLButtonElement => screen.getByTestId('sync-primary')
const syncCalls = (): string[] => git.calls.filter((call) => ['fetch', 'pull', 'push'].includes(call.method)).map((call) => call.method)

/** Makes the next sync call wait until the test settles it with `finish`. */
function hold(method: 'fetch' | 'pull' | 'push'): { finish(result: GitResult<RepoState>): void } {
  let finish: (result: GitResult<RepoState>) => void = () => undefined
  git[method] = (folder, request) => {
    git.calls.push({ method, folder, request })
    return new Promise((resolve) => {
      finish = resolve
    })
  }
  return { finish: (result) => act(() => finish(result)) }
}

async function failWith(error: GitErrorShape, label = 'Push origin'): Promise<void> {
  git.syncError = error
  fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }))
  await settle()
}

describe('SyncButton primary action', () => {
  it('is a disabled No remote with a tooltip when there is no remote', async () => {
    await mount(status({ remote: null }, { upstream: null }))
    expect(primary().textContent).toContain('No remote')
    expect(primary().disabled).toBe(true)
    expect(primary().title).toContain('no remote')
  })

  it('publishes a branch without an upstream', async () => {
    await mount(status({}, { upstream: null }))
    expect(primary().textContent).toContain('Publish branch')
    fireEvent.click(primary())
    await settle()
    expect(syncCalls()).toEqual(['push'])
  })

  it('pulls when behind, showing both counts when also ahead', async () => {
    await mount(status({}, { behind: 3, ahead: 2 }))
    expect(primary().textContent).toContain('Pull origin')
    expect(primary().textContent).toContain('↓3')
    expect(primary().textContent).toContain('↑2')
    fireEvent.click(primary())
    await settle()
    expect(syncCalls()).toEqual(['pull'])
  })

  it('pushes when only ahead', async () => {
    await mount(status({}, { ahead: 2 }))
    expect(primary().textContent).toContain('Push origin')
    expect(primary().textContent).toContain('↑2')
    expect(primary().textContent).not.toContain('↓')
    fireEvent.click(primary())
    await settle()
    expect(syncCalls()).toEqual(['push'])
  })

  it('fetches when even, and names a remote other than origin', async () => {
    await mount(status({ remote: { name: 'upstream', githubHttps: false } }))
    expect(primary().textContent).toContain('Fetch upstream')
    fireEvent.click(primary())
    await settle()
    expect(syncCalls()).toEqual(['fetch'])
  })

  it('shows when the repository last fetched, or that it never has', async () => {
    await mount(status({ lastFetchedAt: new Date(NOW - 5 * 60_000).toISOString() }))
    expect(screen.getByText('Last fetched 5 minutes ago')).toBeTruthy()
    cleanup()
    await mount(status())
    expect(screen.getByText('Never fetched')).toBeTruthy()
  })
})

describe('SyncButton menu', () => {
  it('offers Fetch, Pull and Push at any time, each refreshing afterwards', async () => {
    await mount(status({}, { ahead: 1 }))
    for (const item of ['Fetch', 'Pull', 'Push']) {
      fireEvent.click(screen.getByRole('button', { name: 'More sync actions' }))
      fireEvent.click(screen.getByRole('menuitem', { name: item }))
      await settle()
    }
    expect(syncCalls()).toEqual(['fetch', 'pull', 'push'])
    expect(refreshes).toBe(3)
  })
})

describe('SyncButton progress', () => {
  it('shows the phase and percent of its own operation, cancels it, and refreshes when it ends', async () => {
    await mount(status())
    const fetch = hold('fetch')
    fireEvent.click(primary())
    await settle()
    expect(git.calls.at(-1)?.request).toEqual({ operationId: '00000000-0000-4000-8000-000000000001' })
    act(() => git.emitProgress({ folder: FOLDER, operationId: 'someone-else', operation: 'fetch', phase: 'Other', percent: 99 }))
    act(() => git.emitProgress({ folder: FOLDER, operationId: '00000000-0000-4000-8000-000000000001', operation: 'fetch', phase: 'Receiving objects', percent: 42 }))
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('42')
    expect(screen.getByText(/Receiving objects/).textContent).toContain('42%')
    expect(screen.queryByText(/Other/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await settle()
    expect(git.calls.at(-1)).toMatchObject({ method: 'cancelOperation', operationId: '00000000-0000-4000-8000-000000000001' })
    fetch.finish({ ok: false, error: { code: 'cancelled', message: 'Cancelled.' } })
    await settle()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(refreshes).toBe(1)
  })
})

describe('SyncButton errors', () => {
  it('offers Pull when the remote has commits the branch lacks', async () => {
    await mount(status({}, { ahead: 1 }))
    await failWith({ code: 'rejected_non_fast_forward', message: 'Rejected.' })
    expect(screen.getByRole('alert').textContent).toContain('The remote has commits you don’t have. Pull first.')
    git.syncError = null
    fireEvent.click(screen.getByRole('button', { name: 'Pull' }))
    await settle()
    expect(syncCalls()).toEqual(['push', 'pull'])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('asks to sign in on auth_required', async () => {
    await mount(status({}, { ahead: 1 }))
    await failWith({ code: 'auth_required', message: 'Sign in.' })
    expect(screen.getByText('Sign in to GitHub to push and pull')).toBeTruthy()
    expect(screen.queryByText(/revoked/)).toBeNull()
  })

  it('says the sign-in may have been revoked on auth_failed while signed in', async () => {
    kit.github.account = { login: 'octocat', name: null }
    await mount(status({}, { ahead: 1 }))
    await failWith({ code: 'auth_failed', message: 'Denied.' })
    expect(screen.getByText('Sign in to GitHub to push and pull')).toBeTruthy()
    expect(screen.getByText(/revoked/)).toBeTruthy()
  })

  it('only refreshes on merge conflicts, so the conflicted files show', async () => {
    await mount(status({}, { behind: 1 }))
    await failWith({ code: 'merge_conflicts', message: 'Conflicts.' }, 'Pull origin')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(refreshes).toBe(1)
  })

  it('shows other errors with git’s detail in a collapsible block, and dismisses them', async () => {
    await mount(status())
    await failWith({ code: 'network_unreachable', message: 'Couldn’t reach the remote.', detail: 'fatal: unable to access' }, 'Fetch origin')
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t reach the remote.')
    const details = screen.getByText('fatal: unable to access').closest('details')
    expect(details).not.toBeNull()
    expect(details?.open).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a stalled operation’s timeout like other failures, with git’s last line in the collapsible block', async () => {
    await mount(status())
    const message = 'The connection stalled: git made no progress for 60 seconds.'
    await failWith({ code: 'timeout', message, detail: 'Receiving objects: 20% (2/10)' }, 'Fetch origin')
    expect(screen.getByRole('alert').textContent).toContain(message)
    expect(screen.getByText('Receiving objects: 20% (2/10)').closest('details')).not.toBeNull()
  })
})

describe('SyncButton background fetch', () => {
  it('fetches every 10 minutes while signed in with an HTTPS github.com remote', async () => {
    kit.github.account = { login: 'octocat', name: null }
    await mount(status())
    expect(kit.scheduler.intervals()).toContain(BACKGROUND_FETCH_MS)
    expect(BACKGROUND_FETCH_MS).toBe(600_000)
    act(() => kit.scheduler.fireIntervals(BACKGROUND_FETCH_MS))
    await settle()
    expect(syncCalls()).toEqual(['fetch'])
    expect(refreshes).toBe(1)
  })

  it('does not fetch when signed out or for a non-GitHub-HTTPS remote', async () => {
    await mount(status())
    expect(kit.scheduler.intervals()).not.toContain(BACKGROUND_FETCH_MS)
    cleanup()
    kit.github.account = { login: 'octocat', name: null }
    await mount(status({ remote: { name: 'origin', githubHttps: false } }))
    expect(kit.scheduler.intervals()).not.toContain(BACKGROUND_FETCH_MS)
  })

  it('stops when the person signs out', async () => {
    kit.github.account = { login: 'octocat', name: null }
    await mount(status())
    await act(async () => {
      await window.github.signOut()
    })
    expect(kit.scheduler.intervals()).not.toContain(BACKGROUND_FETCH_MS)
  })

  it('fails quietly with a warning icon that carries the error', async () => {
    kit.github.account = { login: 'octocat', name: null }
    await mount(status())
    git.syncError = { code: 'network_unreachable', message: 'Couldn’t reach github.com.' }
    act(() => kit.scheduler.fireIntervals(BACKGROUND_FETCH_MS))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByLabelText('Background fetch failed').getAttribute('title')).toContain('Couldn’t reach github.com.')
    git.syncError = null
    act(() => kit.scheduler.fireIntervals(BACKGROUND_FETCH_MS))
    await settle()
    expect(screen.queryByLabelText('Background fetch failed')).toBeNull()
  })
})
