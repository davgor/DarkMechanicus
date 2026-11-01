// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import type { BoundFunctions, queries } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { FakeGit } from '../__mocks__/fakeGit'
import { githubKit, renderWithGithub } from '../__mocks__/githubKit'
import type { GithubKit } from '../__mocks__/githubKit'
import { repository } from '../__mocks__/githubRepository'
import { settle } from '../__mocks__/settle'
import { CloneDialog } from './CloneDialog'

let kit: GithubKit
let git: FakeGit
let cloned: TrackedFolderView[]
let closes: number

beforeEach(() => {
  kit = githubKit()
  git = new FakeGit()
  window.git = git
  git.cloneParent = '/Users/me/GitHub'
  cloned = []
  closes = 0
})

afterEach(cleanup)

async function open(): Promise<void> {
  renderWithGithub(
    kit,
    <CloneDialog
      onClose={() => {
        closes += 1
      }}
      onCloned={(folder) => cloned.push(folder)}
    />
  )
  await settle()
}

const dialog = (): BoundFunctions<typeof queries> => within(screen.getByRole('dialog', { name: 'Clone a repository' }))

async function cloneUrl(url: string): Promise<void> {
  fireEvent.click(dialog().getByRole('tab', { name: 'URL' }))
  fireEvent.change(dialog().getByLabelText('Repository URL or owner/repo'), { target: { value: url } })
  fireEvent.click(dialog().getByRole('button', { name: 'Clone' }))
  await settle()
}

function cloneCalls(): Array<{ url: string; name: string; operationId: string }> {
  return git.calls.filter((call) => call.method === 'clone').map((call) => call.request as { url: string; name: string; operationId: string })
}

describe('CloneDialog GitHub.com tab', () => {
  it('opens on GitHub.com and asks to sign in while signed out', async () => {
    await open()
    expect(dialog().getByRole('tab', { name: 'GitHub.com' }).getAttribute('aria-selected')).toBe('true')
    expect(dialog().getByText('Sign in to GitHub to see your repositories')).toBeTruthy()
    expect(dialog().getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(kit.github.calls).not.toContain('listRepositories')
  })

  it('lists the account’s repositories by owner, with private and fork marks', async () => {
    kit.github.account = { login: 'octocat', name: null }
    kit.github.repositories = [
      repository({ owner: 'octocat', name: 'Hello-World' }),
      repository({ owner: 'acme', name: 'rockets', private: true }),
      repository({ owner: 'octocat', name: 'Spoon-Knife', fork: true })
    ]
    await open()
    const list = within(dialog().getByRole('listbox', { name: 'Repositories' }))
    expect(list.getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual(['octocat', 'acme'])
    expect(within(list.getByRole('group', { name: 'octocat' })).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Hello-World',
      'Spoon-Knife fork'
    ])
    const rockets = list.getByRole('option', { name: /rockets/ })
    expect(within(rockets).getByLabelText('Private')).toBeTruthy()
    expect(list.getByRole('option', { name: /Hello-World/ }).querySelector('[aria-label="Private"]')).toBeNull()
  })

  it('filters the list and asks GitHub again on Refresh', async () => {
    kit.github.account = { login: 'octocat', name: null }
    kit.github.repositories = [repository({ owner: 'octocat', name: 'Hello-World' }), repository({ owner: 'acme', name: 'rockets' })]
    await open()
    fireEvent.change(dialog().getByLabelText('Filter repositories'), { target: { value: 'rock' } })
    expect(dialog().getAllByRole('option').map((option) => option.textContent)).toEqual(['rockets'])
    fireEvent.change(dialog().getByLabelText('Filter repositories'), { target: { value: 'nothing-like-it' } })
    expect(dialog().getByText('No repositories match.')).toBeTruthy()
    kit.github.repositories = [repository({ owner: 'acme', name: 'rockets-2' })]
    fireEvent.change(dialog().getByLabelText('Filter repositories'), { target: { value: '' } })
    fireEvent.click(dialog().getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(kit.github.listRequests.at(-1)).toEqual({ refresh: true })
    expect(dialog().getAllByRole('option').map((option) => option.textContent)).toEqual(['rockets-2'])
  })

})

describe('CloneDialog GitHub.com choices', () => {
  it('clones the chosen repository by its clone URL under its name', async () => {
    kit.github.account = { login: 'octocat', name: null }
    kit.github.repositories = [repository({ owner: 'acme', name: 'rockets' })]
    await open()
    expect(dialog().getByRole('button', { name: 'Clone' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(dialog().getByRole('option', { name: /rockets/ }))
    expect(dialog().getByRole('option', { name: /rockets/ }).getAttribute('aria-selected')).toBe('true')
    expect((dialog().getByLabelText('Name') as HTMLInputElement).value).toBe('rockets')
    fireEvent.click(dialog().getByRole('button', { name: 'Clone' }))
    await settle()
    expect(cloneCalls()).toEqual([expect.objectContaining({ url: 'https://github.com/acme/rockets.git', name: 'rockets' })])
  })

  it('shows the sign-in prompt when the list answers auth_required', async () => {
    kit.github.account = { login: 'octocat', name: null }
    kit.github.listRepositories = () => Promise.resolve({ ok: false, error: { code: 'auth_required', message: 'Sign in again.' } })
    await open()
    expect(dialog().getByText('Sign in to GitHub to see your repositories')).toBeTruthy()
  })

  it('shows any other list failure with its message', async () => {
    kit.github.account = { login: 'octocat', name: null }
    kit.github.listRepositories = () => Promise.resolve({ ok: false, error: { code: 'network_unreachable', message: 'GitHub could not be reached.' } })
    await open()
    expect(dialog().getByRole('alert').textContent).toContain('GitHub could not be reached.')
  })
})

describe('CloneDialog URL tab and local path', () => {
  it('accepts a URL or owner/repo and defaults the name from it', async () => {
    await open()
    fireEvent.click(dialog().getByRole('tab', { name: 'URL' }))
    const input = dialog().getByLabelText('Repository URL or owner/repo')
    fireEvent.change(input, { target: { value: 'octocat/Hello-World' } })
    expect((dialog().getByLabelText('Name') as HTMLInputElement).value).toBe('Hello-World')
    fireEvent.change(input, { target: { value: 'https://github.com/octocat/Spoon-Knife.git' } })
    expect((dialog().getByLabelText('Name') as HTMLInputElement).value).toBe('Spoon-Knife')
  })

  it('shows the full target path, following the name and the chosen parent', async () => {
    git.pickedCloneParent = '/Volumes/work'
    await open()
    fireEvent.click(dialog().getByRole('tab', { name: 'URL' }))
    fireEvent.change(dialog().getByLabelText('Repository URL or owner/repo'), { target: { value: 'octocat/Hello-World' } })
    expect(dialog().getByTestId('clone-target').textContent).toBe('/Users/me/GitHub/Hello-World')
    fireEvent.change(dialog().getByLabelText('Name'), { target: { value: 'hello' } })
    expect(dialog().getByTestId('clone-target').textContent).toBe('/Users/me/GitHub/hello')
    fireEvent.click(dialog().getByRole('button', { name: 'Choose…' }))
    await settle()
    expect(dialog().getByTestId('clone-target').textContent).toBe('/Volumes/work/hello')
  })

  it('keeps the parent when the folder dialog is dismissed, and needs one before cloning', async () => {
    git.cloneParent = null
    await open()
    expect(dialog().getByText('Choose a folder to clone into.')).toBeTruthy()
    fireEvent.click(dialog().getByRole('tab', { name: 'URL' }))
    fireEvent.change(dialog().getByLabelText('Repository URL or owner/repo'), { target: { value: 'octocat/Hello-World' } })
    expect(dialog().getByRole('button', { name: 'Clone' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(dialog().getByRole('button', { name: 'Choose…' }))
    await settle()
    expect(dialog().getByText('Choose a folder to clone into.')).toBeTruthy()
  })
})

describe('CloneDialog cloning', () => {
  it('shows progress for its own operation, and Cancel stops it in the clone parent', async () => {
    git.holdClones = true
    await open()
    await cloneUrl('octocat/Hello-World')
    const [call] = cloneCalls()
    expect(call).toEqual(expect.objectContaining({ url: 'octocat/Hello-World', name: 'Hello-World' }))
    act(() => {
      git.emitProgress({ folder: '/Users/me/GitHub', operationId: call?.operationId ?? '', operation: 'clone', phase: 'Receiving objects', percent: 42 })
      git.emitProgress({ folder: '/Users/me/GitHub', operationId: 'someone-else', operation: 'clone', phase: 'Resolving deltas', percent: 99 })
    })
    expect(dialog().getByRole('progressbar', { name: 'Clone progress' }).getAttribute('aria-valuenow')).toBe('42')
    expect(dialog().getByText('Receiving objects 42%')).toBeTruthy()
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel clone' }))
    await settle()
    expect(git.calls.filter((c) => c.method === 'cancelOperation')).toEqual([
      { method: 'cancelOperation', folder: '/Users/me/GitHub', operationId: call?.operationId }
    ])
    expect(dialog().queryByRole('progressbar')).toBeNull()
    expect(dialog().queryByRole('alert')).toBeNull()
    expect(cloned).toEqual([])
  })

  it('uses a new operation id for every clone', async () => {
    git.cloneError = { code: 'git_failed', message: 'Git failed.' }
    await open()
    await cloneUrl('octocat/Hello-World')
    fireEvent.click(dialog().getByRole('button', { name: 'Clone' }))
    await settle()
    const [first, second] = cloneCalls()
    expect(first?.operationId).toBeTruthy()
    expect(first?.operationId).not.toBe(second?.operationId)
  })

  it('hands the new folder over on success', async () => {
    await open()
    await cloneUrl('https://github.com/octocat/Hello-World')
    expect(cloned.map((folder) => folder.path)).toEqual(['/Users/me/GitHub/Hello-World'])
  })

  it('cancels a running clone when the dialog is closed', async () => {
    git.holdClones = true
    await open()
    await cloneUrl('octocat/Hello-World')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await settle()
    expect(git.calls.some((c) => c.method === 'cancelOperation')).toBe(true)
    expect(closes).toBe(1)
  })
})

describe('CloneDialog errors', () => {
  it.each(['auth_required', 'auth_failed'] as const)('shows the sign-in prompt for %s', async (code) => {
    git.cloneError = { code, message: 'Authentication failed.' }
    await open()
    await cloneUrl('acme/private-thing')
    expect(dialog().getByText('Sign in to GitHub to clone this repository')).toBeTruthy()
  })

  it('names an existing target', async () => {
    git.cloneError = { code: 'target_exists', message: 'The folder already exists.' }
    await open()
    await cloneUrl('octocat/Hello-World')
    expect(dialog().getByRole('alert').textContent).toBe('/Users/me/GitHub/Hello-World already exists')
  })

  it('shows any other failure with git’s detail', async () => {
    git.cloneError = { code: 'invalid_input', message: 'That URL can’t be cloned.', detail: 'file: URLs are not allowed' }
    await open()
    await cloneUrl('file:///etc')
    const alert = dialog().getByRole('alert')
    expect(alert.textContent).toContain('That URL can’t be cloned.')
    expect(alert.textContent).toContain('file: URLs are not allowed')
    expect(cloned).toEqual([])
  })
})
