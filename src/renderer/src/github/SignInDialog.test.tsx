// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import type { BoundFunctions, queries } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GitErrorShape } from '../../../shared/git/api'
import { githubKit, renderWithGithub } from '../__mocks__/githubKit'
import type { GithubKit } from '../__mocks__/githubKit'
import { settle } from '../__mocks__/settle'
import { SignInPrompt } from './SignInPrompt'

let kit: GithubKit

beforeEach(() => {
  kit = githubKit()
})

afterEach(cleanup)

const USE_GH = 'Use my GitHub CLI login'

const dialog = (): BoundFunctions<typeof queries> => within(screen.getByRole('dialog', { name: 'Sign in to GitHub' }))

const signIns = (): number => kit.github.calls.filter((call) => call === 'signIn').length

async function openDialog(): Promise<void> {
  renderWithGithub(kit, <SignInPrompt purpose="push" />)
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await settle()
}

async function failWith(error: GitErrorShape): Promise<BoundFunctions<typeof queries>> {
  kit.github.signInResult = { ok: false, error }
  await openDialog()
  fireEvent.click(dialog().getByRole('button', { name: USE_GH }))
  await settle()
  return within(dialog().getByRole('alert'))
}

describe('SignInDialog', () => {
  it('explains the GitHub CLI login and waits for the button before signing in', async () => {
    await openDialog()
    expect(dialog().getByText(/signs in with this computer's GitHub CLI login/)).toBeTruthy()
    expect(signIns()).toBe(0)
    fireEvent.click(dialog().getByRole('button', { name: USE_GH }))
    await settle()
    expect(signIns()).toBe(1)
  })

  it('shows a waiting state while signing in, and the button cannot be pressed twice', async () => {
    await openDialog()
    const button = dialog().getByRole('button', { name: USE_GH })
    fireEvent.click(button)
    await settle()
    fireEvent.click(button)
    await settle()
    expect(signIns()).toBe(1)
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(dialog().getByText('Signing in with the GitHub CLI login…')).toBeTruthy()
  })

  it('closes on success and says who signed in', async () => {
    await openDialog()
    fireEvent.click(dialog().getByRole('button', { name: USE_GH }))
    await settle()
    act(() => kit.github.finishSignIn({ ok: true, data: { login: 'octocat', name: 'Mona' } }))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Signed in as @octocat')).toBeTruthy()
  })

  it('closes on Cancel without signing in', async () => {
    await openDialog()
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(signIns()).toBe(0)
  })

  it('closes on Cancel while signing in', async () => {
    await openDialog()
    fireEvent.click(dialog().getByRole('button', { name: USE_GH }))
    await settle()
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('SignInDialog failures', () => {
  it('links to cli.github.com when the GitHub CLI is not installed', async () => {
    const alert = await failWith({ code: 'gh_not_installed', message: 'gh missing' })
    expect(alert.getByText("GitHub CLI isn't installed.")).toBeTruthy()
    fireEvent.click(alert.getByRole('button', { name: 'Get the GitHub CLI' }))
    expect(kit.dm.opened).toEqual(['https://cli.github.com'])
  })

  it('shows gh auth login with Copy when gh is not signed in', async () => {
    const alert = await failWith({ code: 'gh_not_signed_in', message: 'The GitHub CLI is not signed in.' })
    expect(alert.getByText('The GitHub CLI is not signed in.')).toBeTruthy()
    expect(alert.getByText('gh auth login')).toBeTruthy()
    fireEvent.click(alert.getByRole('button', { name: 'Copy' }))
    expect(kit.dm.copied).toEqual(['gh auth login'])
  })

  it('shows the scope refresh command with Copy when the login lacks the repo scope', async () => {
    const alert = await failWith({ code: 'gh_missing_scope', message: 'The login lacks the repo scope.' })
    expect(alert.getByText('The login lacks the repo scope.')).toBeTruthy()
    fireEvent.click(alert.getByRole('button', { name: 'Copy' }))
    expect(kit.dm.copied).toEqual(['gh auth refresh -h github.com -s repo,workflow'])
  })

  it.each(['auth_failed', 'network_unreachable', 'secure_storage_unavailable'] as const)(
    'shows the message for %s, without a command',
    async (code) => {
      const alert = await failWith({ code, message: `main says ${code}` })
      expect(alert.getByText(`main says ${code}`)).toBeTruthy()
      expect(alert.queryByRole('button', { name: 'Copy' })).toBeNull()
    }
  )

  it('signs in again on Try again', async () => {
    await failWith({ code: 'network_unreachable', message: 'offline' })
    kit.github.signInResult = { ok: true, data: { login: 'octocat', name: null } }
    fireEvent.click(dialog().getByRole('button', { name: 'Try again' }))
    await settle()
    expect(signIns()).toBe(2)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Signed in as @octocat')).toBeTruthy()
  })
})
