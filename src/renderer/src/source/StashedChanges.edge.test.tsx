// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StashInfo } from '../../../shared/git/branches'
import type { RepoStatus } from '../../../shared/git/status'
import { FakeGit } from '../__mocks__/fakeGit'
import { settle } from '../__mocks__/settle'
import { StashedChanges } from './StashedChanges'

const FOLDER = '/work/alpha'

const STASH: StashInfo = {
  ref: 'stash@{0}',
  branch: 'main',
  createdAt: '2026-10-30T12:00:00.000Z',
  files: [{ path: 'src/a.ts', oldPath: null, kind: 'modified' }]
}

let git: FakeGit
let refreshes: number

beforeEach(() => {
  git = new FakeGit()
  window.git = git
  refreshes = 0
})

afterEach(cleanup)

function status(branch: string | null): RepoStatus {
  return {
    root: FOLDER,
    branch: { name: branch, headOid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0 },
    files: [],
    inProgress: null,
    lastFetchedAt: null,
    remote: null
  }
}

async function mount(branch: string | null = 'main', tracked = true): Promise<void> {
  if (tracked) git.setState(FOLDER, { kind: 'repository', status: status(branch) })
  git.setStashes(FOLDER, [STASH])
  render(<StashedChanges folderPath={FOLDER} status={status(branch)} onRefresh={() => (refreshes += 1)} />)
  await settle()
}

const listings = (): number => git.calls.filter((call) => call.method === 'listStashes').length

async function expand(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: /Stashed changes/ }))
  await settle()
  return screen.getByRole('region', { name: 'Stashed changes' })
}

describe('Stashed changes edges', () => {
  it('counts a single file in the singular', async () => {
    await mount()
    expect(screen.getByRole('button', { name: /Stashed changes/ }).textContent).toBe('Stashed changes 1 file')
  })

  it('looks for no stash on a detached HEAD', async () => {
    await mount(null)
    expect(listings()).toBe(0)
    expect(screen.queryByRole('button', { name: /Stashed changes/ })).toBeNull()
  })

  it('shows no row when the stashes cannot be listed', async () => {
    await mount('main', false)
    expect(listings()).toBe(1)
    expect(screen.queryByRole('button', { name: /Stashed changes/ })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('refreshes after a conflicting restore but not after another failure', async () => {
    await mount()
    const region = await expand()
    git.branchError = { code: 'git_failed', message: 'fatal: index.lock exists.' }
    fireEvent.click(within(region).getByRole('button', { name: 'Restore' }))
    await settle()
    expect(within(region).getByRole('alert').textContent).toBe('fatal: index.lock exists.')
    expect(refreshes).toBe(0)
    git.branchError = { code: 'merge_conflicts', message: 'Restoring conflicts; the stash is kept.' }
    fireEvent.click(within(region).getByRole('button', { name: 'Restore' }))
    await settle()
    expect(refreshes).toBe(1)
    expect(within(region).getByRole('alert').textContent).toBe('Restoring conflicts; the stash is kept.')
  })

  it('keeps the discard dialog open with the reason when discarding fails', async () => {
    await mount()
    const region = await expand()
    fireEvent.click(within(region).getByRole('button', { name: 'Discard…' }))
    git.branchError = { code: 'git_failed', message: 'fatal: bad stash ref.' }
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard stash' }))
    await settle()
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('fatal: bad stash ref.')
    expect(refreshes).toBe(0)
  })
})
