// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { RenderHookResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RepoState } from '../../../shared/git/status'
import { deferred } from '../__mocks__/deferred'
import { FakeGit } from '../__mocks__/fakeGit'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { BACKGROUND_FETCH_MS, useSync } from './useSync'
import type { RunningSync, SyncFailure, SyncOperation } from './useSync'

const FOLDER = '/work/alpha'
const STATE: RepoState = {
  kind: 'repository',
  status: {
    root: FOLDER,
    branch: { name: 'main', headOid: 'a'.repeat(40), upstream: 'origin/main', ahead: 0, behind: 0 },
    files: [],
    inProgress: null,
    lastFetchedAt: null,
    remote: { name: 'origin', githubHttps: true }
  }
}

let git: FakeGit
let scheduler: ManualScheduler
let refreshes: number

beforeEach(() => {
  git = new FakeGit()
  git.setState(FOLDER, STATE)
  window.git = git
  scheduler = new ManualScheduler()
  refreshes = 0
})

afterEach(cleanup)

/** What these tests read of the hook's model. */
interface Sync {
  running: RunningSync | null
  failure: SyncFailure | null
  warning: string | null
  run(operation: SyncOperation): void
  cancel(): void
}

function mount(signedIn = true): RenderHookResult<Sync, unknown> {
  return renderHook(() => useSync({ folderPath: FOLDER, scheduler, signedIn, githubHttps: true, onRefresh: () => (refreshes += 1) }))
}

const fetches = (): number => git.calls.filter((call) => call.method === 'fetch').length

/** Makes fetch wait until the test lets it succeed. */
function holdFetch(): { finish(): void } {
  const gate = deferred()
  git.fetch = async (folder, request) => {
    git.calls.push({ method: 'fetch', folder, request })
    await gate.promise
    return { ok: true, data: STATE }
  }
  return { finish: () => gate.resolve() }
}

describe('useSync failures', () => {
  it('shows an other error without detail as detail null', async () => {
    const { result } = mount()
    git.syncError = { code: 'network_unreachable', message: 'Offline.' }
    act(() => result.current.run('fetch'))
    await settle()
    expect(result.current.failure).toEqual({ kind: 'other', message: 'Offline.', detail: null })
  })

  it('does not call a rejected sign-in revoked while signed out', async () => {
    const { result } = mount(false)
    git.syncError = { code: 'auth_failed', message: 'Denied.' }
    act(() => result.current.run('push'))
    await settle()
    expect(result.current.failure).toEqual({ kind: 'auth', revoked: false })
  })

  it('turns a thrown Error into a git_failed failure with its message', async () => {
    const { result } = mount()
    git.pull = () => Promise.reject(new Error('The IPC channel closed.'))
    act(() => result.current.run('pull'))
    await settle()
    expect(result.current.failure).toEqual({ kind: 'other', message: 'The IPC channel closed.', detail: null })
    expect(result.current.running).toBeNull()
    expect(refreshes).toBe(1)
  })

  it('says git did not answer when the call rejects with something other than an Error', async () => {
    const { result } = mount()
    git.push = () => Promise.reject('gone')
    act(() => result.current.run('push'))
    await settle()
    expect(result.current.failure).toEqual({ kind: 'other', message: 'Git did not answer.', detail: null })
  })
})

describe('useSync while running', () => {
  it('ignores a second run until the first ends, and cancel does nothing when idle', async () => {
    const { result } = mount(false)
    act(() => result.current.cancel())
    expect(git.calls.filter((call) => call.method === 'cancelOperation')).toHaveLength(0)
    const fetch = holdFetch()
    act(() => result.current.run('fetch'))
    act(() => result.current.run('fetch'))
    expect(fetches()).toBe(1)
    fetch.finish()
    await settle()
    expect(result.current.running).toBeNull()
    act(() => result.current.run('fetch'))
    expect(fetches()).toBe(2)
  })

  it('ignores progress from another folder for the same operation id', () => {
    const { result } = mount(false)
    holdFetch()
    act(() => result.current.run('fetch'))
    const id = result.current.running?.id ?? ''
    act(() => git.emitProgress({ folder: '/work/beta', operationId: id, operation: 'fetch', phase: 'Elsewhere', percent: 10 }))
    expect(result.current.running).toMatchObject({ phase: null, percent: null })
  })

  it('skips the background fetch while an operation runs', async () => {
    const { result } = mount()
    const fetch = holdFetch()
    act(() => result.current.run('fetch'))
    act(() => scheduler.fireIntervals(BACKGROUND_FETCH_MS))
    expect(fetches()).toBe(1)
    fetch.finish()
    await settle()
    act(() => scheduler.fireIntervals(BACKGROUND_FETCH_MS))
    await settle()
    expect(fetches()).toBe(2)
  })
})

describe('useSync background fetch', () => {
  it('keeps the last warning when a background fetch is cancelled, but still refreshes', async () => {
    const { result } = mount()
    git.syncError = { code: 'network_unreachable', message: 'Offline.' }
    act(() => scheduler.fireIntervals(BACKGROUND_FETCH_MS))
    await settle()
    expect(result.current.warning).toBe('Offline.')
    git.syncError = { code: 'cancelled', message: 'Cancelled.' }
    act(() => scheduler.fireIntervals(BACKGROUND_FETCH_MS))
    await settle()
    expect(result.current.warning).toBe('Offline.')
    expect(result.current.failure).toBeNull()
    expect(refreshes).toBe(2)
  })
})
