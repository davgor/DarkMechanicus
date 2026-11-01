// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StashInfo } from '../../../shared/git/branches'
import type { RepoState } from '../../../shared/git/status'
import { ToastProvider } from '../app/toasts'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeGit } from '../__mocks__/fakeGit'
import { FakeGithub } from '../__mocks__/fakeGithub'
import { GithubAccountProvider } from '../github/GithubAccount'
import { folderView } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { SourceControlView } from './SourceControlView'

const FOLDER = '/work/alpha'
const folder = folderView({ path: FOLDER, name: 'alpha' })

const STASH: StashInfo = {
  ref: 'stash@{0}',
  branch: 'main',
  createdAt: '2026-10-30T12:00:00.000Z',
  files: [
    { path: 'src/a.ts', oldPath: null, kind: 'modified' },
    { path: 'notes.txt', oldPath: null, kind: 'added' }
  ]
}

const STATE: RepoState = {
  kind: 'repository',
  status: {
    root: FOLDER,
    branch: { name: 'main', headOid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0 },
    files: [],
    inProgress: null,
    lastFetchedAt: null,
    remote: null
  }
}

let git: FakeGit
let scheduler: ManualScheduler

beforeEach(() => {
  git = new FakeGit()
  scheduler = new ManualScheduler()
  window.git = git
  window.dm = new FakeDm()
  window.github = new FakeGithub()
})

afterEach(cleanup)

async function mount(stashes: StashInfo[]): Promise<void> {
  git.setState(FOLDER, STATE)
  git.setStashes(FOLDER, stashes)
  render(
    <ToastProvider scheduler={scheduler}>
      <GithubAccountProvider>
        <SourceControlView folder={folder} scheduler={scheduler} />
      </GithubAccountProvider>
    </ToastProvider>
  )
  await settle()
}

const row = (): HTMLElement => screen.getByRole('button', { name: /Stashed changes/ })
const refs = (method: string): unknown[] => git.calls.filter((call) => call.method === method).map((call) => call.ref)

async function expand(): Promise<HTMLElement> {
  fireEvent.click(row())
  await settle()
  return screen.getByRole('region', { name: 'Stashed changes' })
}

describe('Stashed changes', () => {
  it('has no row when the branch has no stash', async () => {
    await mount([])
    expect(git.calls.some((call) => call.method === 'listStashes')).toBe(true)
    expect(screen.queryByRole('button', { name: /Stashed changes/ })).toBeNull()
  })

  it('lists the stashed files when the row is selected', async () => {
    await mount([STASH])
    expect(row().getAttribute('aria-expanded')).toBe('false')
    const region = await expand()
    expect(within(region).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['src/a.ts', 'notes.txt'])
  })

  it('restores the stash and reads the state again', async () => {
    await mount([STASH])
    const region = await expand()
    const before = git.calls.filter((call) => call.method === 'getState').length
    git.setStashes(FOLDER, [])
    fireEvent.click(within(region).getByRole('button', { name: 'Restore' }))
    await settle()
    expect(refs('restoreStash')).toEqual(['stash@{0}'])
    expect(git.calls.filter((call) => call.method === 'getState').length).toBeGreaterThan(before)
    expect(screen.queryByRole('button', { name: /Stashed changes/ })).toBeNull()
  })

  it('shows why restoring failed', async () => {
    await mount([STASH])
    const region = await expand()
    git.branchError = { code: 'merge_conflicts', message: 'Restoring conflicts with your changes; the stash is kept.' }
    fireEvent.click(within(region).getByRole('button', { name: 'Restore' }))
    await settle()
    expect(within(region).getByRole('alert').textContent).toContain('the stash is kept')
  })

  it('discards only after confirming', async () => {
    await mount([STASH])
    const region = await expand()
    fireEvent.click(within(region).getByRole('button', { name: 'Discard…' }))
    await settle()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(refs('discardStash')).toEqual([])
    fireEvent.click(within(region).getByRole('button', { name: 'Discard…' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard stash' }))
    await settle()
    expect(refs('discardStash')).toEqual(['stash@{0}'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
