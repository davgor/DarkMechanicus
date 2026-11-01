/** The clone channels' request checks, and `cancelOperation` reaching a running clone, over a fake cloner. */
import { describe, expect, it } from 'vitest'
import type { CloneRequest, GitResult } from '../../shared/git/api'
import { trackedView } from '../../test/cloneRig'
import type { Cloner } from './clone'
import { GitError, GitInputError } from './errors'
import { createGitHandlers, type GitHandlers } from './handlers'
import type { GitRunner } from './runner'

const PARENT = '/home/u/clones'

interface FakeCloner extends Cloner {
  requests: CloneRequest[]
  cancels: Array<[string, string]>
  failWith: Error | null
}

function fakeCloner(): FakeCloner {
  const cloner: FakeCloner = {
    requests: [],
    cancels: [],
    failWith: null,
    getParent: () => PARENT,
    chooseParent: async () => `${PARENT}-picked`,
    clone: async (request) => {
      cloner.requests.push(request)
      if (cloner.failWith !== null) {
        throw cloner.failWith
      }
      return trackedView(`${PARENT}/${request.name}`)
    },
    cancel: (folder, operationId) => {
      cloner.cancels.push([folder, operationId])
      return folder === PARENT && operationId === 'cloning'
    }
  }
  return cloner
}

function setup(clones: Cloner | undefined): GitHandlers {
  const runner: GitRunner = { run: () => Promise.reject(new Error('git must not run')) }
  return createGitHandlers({
    registry: { resolve: (folder) => (folder === '/tracked' ? folder : null) },
    ...(clones === undefined ? {} : { clones }),
    runner,
    trashItem: () => Promise.resolve(),
    openPath: () => Promise.resolve(''),
    session: { getAccount: () => null, getToken: () => null },
    client: { listOpenPullRequests: () => Promise.reject(new Error('not used')) },
    onProgress: () => undefined,
    onUnexpectedError: () => undefined
  })
}

function codeOf(result: GitResult<unknown>): string | null {
  return result.ok ? null : result.error.code
}

describe('clone handlers', () => {
  it('pass a valid request to the cloner and return the tracked folder', async () => {
    const cloner = fakeCloner()
    const handlers = setup(cloner)
    expect(await handlers.getCloneParent()).toEqual({ ok: true, data: PARENT })
    expect(await handlers.chooseCloneParent()).toEqual({ ok: true, data: `${PARENT}-picked` })
    const request = { operationId: 'op', url: 'octocat/Hello-World', name: 'Hello-World' }
    expect(await handlers.clone(request)).toEqual({ ok: true, data: trackedView(`${PARENT}/Hello-World`) })
    expect(cloner.requests).toEqual([request])
  })

  it('refuse a request that is not exactly { operationId, url, name }: no folder, no file allowance from the renderer', async () => {
    const cloner = fakeCloner()
    const handlers = setup(cloner)
    const base = { operationId: 'op', url: 'octocat/Hello-World', name: 'x' }
    for (const request of [
      undefined,
      'octocat/Hello-World',
      { ...base, parent: '/etc' },
      { ...base, allowFileProtocol: true },
      { url: base.url, name: base.name },
      { ...base, url: 42 },
      { ...base, operationId: '' },
      { ...base, url: 'x'.repeat(10_000) }
    ]) {
      expect(codeOf(await handlers.clone(request)), JSON.stringify(request)?.slice(0, 80)).toBe('invalid_input')
    }
    expect(cloner.requests).toEqual([])
  })

  it("report the cloner's refusals and git failures with their codes", async () => {
    const cloner = fakeCloner()
    const handlers = setup(cloner)
    const request = { operationId: 'op', url: 'octocat/Hello-World', name: 'x' }
    cloner.failWith = new GitInputError('Choose the folder to clone into first.')
    expect(await handlers.clone(request)).toEqual({ ok: false, error: { code: 'invalid_input', message: 'Choose the folder to clone into first.' } })
    cloner.failWith = new GitError('target_exists', '', `${PARENT}/x already exists and is not an empty folder.`)
    expect(await handlers.clone(request)).toEqual({ ok: false, error: { code: 'target_exists', message: `${PARENT}/x already exists and is not an empty folder.` } })
  })

  it('are unavailable without a cloner', async () => {
    const handlers = setup(undefined)
    expect(codeOf(await handlers.getCloneParent())).toBe('git_failed')
    expect(codeOf(await handlers.clone({ operationId: 'op', url: 'octocat/Hello-World', name: 'x' }))).toBe('git_failed')
  })
})

describe('cancelOperation and clones', () => {
  it('cancels a running clone by its parent folder and id, which need not be tracked', async () => {
    const cloner = fakeCloner()
    const handlers = setup(cloner)
    expect(await handlers.cancelOperation(PARENT, 'cloning')).toEqual({ ok: true, data: { cancelled: true } })
    expect(cloner.cancels).toEqual([[PARENT, 'cloning']])
  })

  it('answers false for a clone into the clone parent that is no longer running, and is invalid_input for a bad id there', async () => {
    const cloner = fakeCloner()
    const handlers = setup(cloner)
    expect(await handlers.cancelOperation(PARENT, 'finished')).toEqual({ ok: true, data: { cancelled: false } })
    expect(codeOf(await handlers.cancelOperation(PARENT, ''))).toBe('invalid_input')
    expect(codeOf(await handlers.cancelOperation(PARENT, 42))).toBe('invalid_input')
  })

  it('otherwise keeps the tracked-folder rules of fetch, pull and push', async () => {
    const cloner = fakeCloner()
    const handlers = setup(cloner)
    expect(await handlers.cancelOperation('/tracked', 'op')).toEqual({ ok: true, data: { cancelled: false } })
    expect(codeOf(await handlers.cancelOperation('/elsewhere', 'cloning'))).toBe('unauthorized')
    expect(codeOf(await handlers.cancelOperation(42, 'cloning'))).toBe('invalid_input')
    expect(codeOf(await setup(undefined).cancelOperation(PARENT, 'cloning'))).toBe('unauthorized')
  })
})
