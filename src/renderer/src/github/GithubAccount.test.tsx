// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { githubKit, renderWithGithub } from '../__mocks__/githubKit'
import type { GithubKit } from '../__mocks__/githubKit'
import { settle } from '../__mocks__/settle'
import { useGithub } from './GithubAccount'
import { SignInPrompt } from './SignInPrompt'

let kit: GithubKit

beforeEach(() => {
  kit = githubKit()
})

afterEach(cleanup)

function Who({ label }: { label: string }): JSX.Element {
  const { account } = useGithub()
  return <p data-testid={label}>{account === null ? 'nobody' : account.login}</p>
}

describe('GithubAccountProvider', () => {
  it('loads the stored account once for every consumer', async () => {
    kit.github.account = { login: 'octocat', name: null }
    renderWithGithub(kit, <><Who label="one" /><Who label="two" /></>)
    await settle()
    expect(screen.getByTestId('one').textContent).toBe('octocat')
    expect(screen.getByTestId('two').textContent).toBe('octocat')
    expect(kit.github.calls.filter((call) => call === 'getAccount')).toHaveLength(1)
  })

  it('updates two mounted consumers when main reports an account change', async () => {
    renderWithGithub(kit, <><Who label="one" /><Who label="two" /></>)
    await settle()
    expect(screen.getByTestId('one').textContent).toBe('nobody')
    act(() => kit.github.changeAccount({ login: 'hubot', name: 'Hubot' }))
    expect(screen.getByTestId('one').textContent).toBe('hubot')
    expect(screen.getByTestId('two').textContent).toBe('hubot')
    await act(async () => {
      await kit.github.signOut()
    })
    expect(screen.getByTestId('one').textContent).toBe('nobody')
    expect(screen.getByTestId('two').textContent).toBe('nobody')
  })
})

describe('SignInPrompt', () => {
  it('names the purpose and opens the sign-in dialog', async () => {
    renderWithGithub(kit, <SignInPrompt purpose="push this branch" />)
    await settle()
    expect(screen.getByText('Sign in to GitHub to push this branch')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await settle()
    const dialog = screen.getByRole('dialog', { name: 'Sign in to GitHub' })
    expect(within(dialog).getByRole('button', { name: 'Use my GitHub CLI login' })).toBeTruthy()
    expect(kit.github.calls).not.toContain('signIn')
  })
})
