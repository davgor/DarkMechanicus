import { describe, expect, it } from 'vitest'
import type { GithubAccountView } from '../../../shared/github/api'
import { FakeGithub } from './fakeGithub'

const OCTOCAT: GithubAccountView = { login: 'octocat', name: 'The Octocat' }

function listen(github: FakeGithub): { accounts: Array<GithubAccountView | null>; stop: () => void } {
  const accounts: Array<GithubAccountView | null> = []
  const stop = github.onAccountChanged((account) => accounts.push(account))
  return { accounts, stop }
}

describe('FakeGithub', () => {
  it('keeps a sign-in pending until the test finishes it, then broadcasts the account like main', async () => {
    const github = new FakeGithub()
    const heard = listen(github)
    expect(await github.getAccount()).toEqual({ ok: true, data: null })
    const pending = github.signIn()
    expect(github.signIn()).toBe(pending)
    github.finishSignIn({ ok: true, data: OCTOCAT })
    expect(await pending).toEqual({ ok: true, data: OCTOCAT })
    expect(heard.accounts).toEqual([OCTOCAT])
    expect(await github.getAccount()).toEqual({ ok: true, data: OCTOCAT })
    expect(github.calls).toEqual(['getAccount', 'signIn', 'signIn', 'getAccount'])
  })

  it('answers at once with signInResult when a test sets it; a failure broadcasts nothing', async () => {
    const github = new FakeGithub()
    const heard = listen(github)
    github.signInResult = { ok: false, error: { code: 'gh_not_signed_in', message: 'Not signed in.' } }
    expect(await github.signIn()).toEqual({ ok: false, error: { code: 'gh_not_signed_in', message: 'Not signed in.' } })
    expect(heard.accounts).toEqual([])
    github.signInResult = { ok: true, data: OCTOCAT }
    expect(await github.signIn()).toEqual({ ok: true, data: OCTOCAT })
    expect(heard.accounts).toEqual([OCTOCAT])
  })

  it('reports account changes from main, signs out with a broadcast, and unsubscribes', async () => {
    const github = new FakeGithub()
    const heard = listen(github)
    github.changeAccount(OCTOCAT)
    expect(await github.signOut()).toEqual({ ok: true, data: null })
    expect(heard.accounts).toEqual([OCTOCAT, null])
    heard.stop()
    github.changeAccount(OCTOCAT)
    expect(heard.accounts).toEqual([OCTOCAT, null])
  })

  it('signOut ends a pending sign-in with cancelled, like main', async () => {
    const github = new FakeGithub()
    const pending = github.signIn()
    await github.signOut()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(github.signIn()).not.toBe(pending)
  })
})

describe('FakeGithub repositories', () => {
  it('lists the repositories a test sets while signed in, recording each request, and is auth_required signed out', async () => {
    const github = new FakeGithub()
    const repository = { fullName: 'octocat/Hello-World', owner: 'octocat', name: 'Hello-World', private: false, fork: false, description: null, cloneUrl: 'https://github.com/octocat/Hello-World.git', pushedAt: null }
    github.repositories = [repository]
    expect(await github.listRepositories()).toMatchObject({ ok: false, error: { code: 'auth_required' } })
    github.changeAccount(OCTOCAT)
    expect(await github.listRepositories({ refresh: true })).toEqual({ ok: true, data: [repository] })
    expect(github.listRequests).toEqual([undefined, { refresh: true }])
    expect(github.calls).toEqual(['listRepositories', 'listRepositories'])
  })
})
