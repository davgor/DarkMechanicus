// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitResult } from '../../../shared/git/api'
import type { GithubAccountView } from '../../../shared/github/api'
import { deferred } from '../__mocks__/deferred'
import { FakeGithub } from '../__mocks__/fakeGithub'
import { githubKit, renderWithGithub } from '../__mocks__/githubKit'
import { settle } from '../__mocks__/settle'
import { useGithub } from './GithubAccount'
import { useGithubAccount } from './useGithubAccount'

const OCTOCAT: GithubAccountView = { login: 'octocat', name: null }
const HUBOT: GithubAccountView = { login: 'hubot', name: 'Hubot' }

let github: FakeGithub

beforeEach(() => {
  github = new FakeGithub()
  window.github = github
})

afterEach(cleanup)

/** Makes getAccount answer only when the test settles it, with `answer`. */
function holdAccount(answer: () => Promise<GitResult<GithubAccountView | null>>): { finish(): void } {
  const gate = deferred()
  github.getAccount = async () => {
    await gate.promise
    return answer()
  }
  return { finish: () => gate.resolve() }
}

describe('useGithubAccount', () => {
  it('lets a change that arrives before the first answer win over that older answer', async () => {
    const answer = holdAccount(() => Promise.resolve({ ok: true, data: OCTOCAT }))
    const { result } = renderHook(() => useGithubAccount())
    expect(result.current).toEqual({ account: null, loaded: false })
    act(() => github.changeAccount(HUBOT))
    expect(result.current).toEqual({ account: HUBOT, loaded: true })
    answer.finish()
    await settle()
    expect(result.current).toEqual({ account: HUBOT, loaded: true })
  })

  it('treats a refused answer as signed out, but loaded', async () => {
    github.getAccount = () => Promise.resolve({ ok: false, error: { code: 'secure_storage_unavailable', message: 'No keychain.' } })
    const { result } = renderHook(() => useGithubAccount())
    await settle()
    expect(result.current).toEqual({ account: null, loaded: true })
  })

  it('treats a failed load as signed out, but loaded', async () => {
    github.getAccount = () => Promise.reject(new Error('IPC closed.'))
    const { result } = renderHook(() => useGithubAccount())
    await settle()
    expect(result.current).toEqual({ account: null, loaded: true })
  })

  it('keeps a change over a load that fails afterwards', async () => {
    const answer = holdAccount(() => Promise.reject(new Error('IPC closed.')))
    const { result } = renderHook(() => useGithubAccount())
    act(() => github.changeAccount(HUBOT))
    answer.finish()
    await settle()
    expect(result.current).toEqual({ account: HUBOT, loaded: true })
  })

  it('drops an answer or failure that lands after unmount, and stops listening', async () => {
    const answer = holdAccount(() => Promise.resolve({ ok: true, data: OCTOCAT }))
    const late = renderHook(() => useGithubAccount())
    const failing = holdAccount(() => Promise.reject(new Error('IPC closed.')))
    const lateFailure = renderHook(() => useGithubAccount())
    late.unmount()
    lateFailure.unmount()
    answer.finish()
    failing.finish()
    await settle()
    expect(late.result.current).toEqual({ account: null, loaded: false })
    expect(lateFailure.result.current).toEqual({ account: null, loaded: false })
    act(() => github.changeAccount(HUBOT))
    expect(late.result.current).toEqual({ account: null, loaded: false })
  })
})

function Who(): JSX.Element {
  const { account, signOut } = useGithub()
  return (
    <button type="button" onClick={signOut}>
      {account?.login ?? 'nobody'}
    </button>
  )
}

describe('useGithub', () => {
  it('refuses to work outside a GithubAccountProvider', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => render(<Who />)).toThrow('useGithub must be used inside a GithubAccountProvider')
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  it('signs out through main, and the consumer sees the account cleared', async () => {
    const kit = githubKit()
    kit.github.account = OCTOCAT
    renderWithGithub(kit, <Who />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'octocat' }))
    await settle()
    expect(kit.github.calls).toContain('signOut')
    expect(screen.getByRole('button', { name: 'nobody' })).toBeTruthy()
  })

  it('reports a sign-out main refused in a toast, keeping the account', async () => {
    const kit = githubKit()
    kit.github.account = OCTOCAT
    kit.github.signOut = () => Promise.resolve({ ok: false, error: { code: 'secure_storage_unavailable', message: 'Could not forget the token.' } })
    renderWithGithub(kit, <Who />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'octocat' }))
    await settle()
    expect(screen.getByText('Could not forget the token.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'octocat' })).toBeTruthy()
  })
})
