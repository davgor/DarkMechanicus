// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BranchInfo, BranchList } from '../../../shared/git/branches'
import type { FileChange, RepoStatus } from '../../../shared/git/status'
import { FakeGit } from '../__mocks__/fakeGit'
import { settle } from '../__mocks__/settle'
import { BranchMenu } from './BranchMenu'
import { groupBranches } from './branchGroups'

const FOLDER = '/work/alpha'

let git: FakeGit
let refreshes: number

beforeEach(() => {
  git = new FakeGit()
  window.git = git
  refreshes = 0
})

afterEach(cleanup)

function local(name: string, day: number, patch: Partial<BranchInfo> = {}): BranchInfo {
  const lastCommitAt = `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`
  return { name, kind: 'local', remote: null, upstream: null, ahead: 0, behind: 0, lastCommitAt, isCurrent: false, ...patch }
}

function remote(name: string, day: number): BranchInfo {
  return { ...local(name, day), kind: 'remote', remote: 'origin' }
}

const LIST: BranchList = {
  current: 'main',
  defaultBranch: 'main',
  branches: [
    local('main', 30, { isCurrent: true, upstream: 'origin/main' }),
    local('feature-a', 29, { upstream: 'origin/feature-a' }),
    local('feature-b', 28),
    local('fix-c', 27),
    local('fix-d', 26),
    local('chore-e', 25),
    local('chore-f', 24),
    local('old-g', 2),
    remote('origin/main', 30),
    remote('origin/feature-a', 29),
    remote('origin/remote-only', 20)
  ]
}

function status(files: FileChange[] = []): RepoStatus {
  return {
    root: FOLDER,
    branch: { name: 'main', headOid: 'a'.repeat(40), upstream: 'origin/main', ahead: 0, behind: 0 },
    files,
    inProgress: null,
    lastFetchedAt: null,
    remote: { name: 'origin', githubHttps: true }
  }
}

async function mount(files: FileChange[] = []): Promise<void> {
  const value = status(files)
  git.setState(FOLDER, { kind: 'repository', status: value })
  git.setBranches(FOLDER, LIST)
  render(<BranchMenu folderPath={FOLDER} status={value} label="main" onRefresh={() => (refreshes += 1)} />)
  await settle()
}

async function open(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /Current branch/ }))
  await settle()
}

const filter = (): HTMLElement => screen.getByRole('textbox', { name: 'Filter branches' })
const optionNames = (group: string): string[] =>
  within(screen.getByRole('group', { name: group }))
    .getAllByRole('option')
    .map((option) => option.textContent ?? '')
const callsOf = (method: string): unknown[] => git.calls.filter((call) => call.method === method).map((call) => call.request)

async function type(element: HTMLElement, value: string): Promise<void> {
  fireEvent.change(element, { target: { value } })
  await settle()
}

async function press(key: string): Promise<void> {
  fireEvent.keyDown(filter(), { key })
  await settle()
}

async function rowMenu(name: string, item: string): Promise<void> {
  fireEvent.contextMenu(screen.getByRole('option', { name }))
  fireEvent.click(screen.getByRole('menuitem', { name: item }))
  await settle()
}

describe('groupBranches', () => {
  it('splits default, the 5 most recent and the rest, with remote-only branches under their remote', () => {
    const groups = groupBranches(LIST, '', false)
    expect(groups.map((group) => [group.title, group.entries.map((entry) => entry.label)])).toEqual([
      ['Default branch', ['main']],
      ['Recent branches', ['feature-a', 'feature-b', 'fix-c', 'fix-d', 'chore-e']],
      ['Other branches', ['chore-f', 'old-g']],
      ['origin', ['remote-only']]
    ])
    expect(groups[3]?.entries[0]?.target).toBe('origin/remote-only')
  })

  it('filters case-insensitively, drops empty groups and can leave the current branch out', () => {
    expect(groupBranches(LIST, 'FIX', false).map((group) => group.title)).toEqual(['Recent branches'])
    expect(groupBranches(LIST, 'ma', true)).toEqual([])
  })

  it('takes a remote-only default branch from its remote', () => {
    const list: BranchList = { current: null, defaultBranch: 'main', branches: [remote('origin/main', 3)] }
    expect(groupBranches(list, '', false).map((group) => [group.title, group.entries.map((entry) => entry.target)])).toEqual([
      ['Default branch', ['origin/main']]
    ])
  })
})

describe('BranchMenu popover', () => {
  it('shows the current branch and opens a grouped list with the filter focused', async () => {
    await mount()
    expect(screen.getByRole('button', { name: /Current branch/ }).textContent).toContain('main')
    await open()
    expect(document.activeElement).toBe(filter())
    expect(optionNames('Default branch')).toEqual(['main'])
    expect(optionNames('Recent branches')).toHaveLength(5)
    expect(optionNames('origin')).toEqual(['remote-only'])
    expect(screen.getByRole('button', { name: 'New branch' })).toBeTruthy()
  })

  it('filters while typing', async () => {
    await mount()
    await open()
    await type(filter(), 'fea')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['feature-a', 'feature-b'])
  })

  it('moves with the arrow keys and switches with Enter, at once when there are no changes', async () => {
    await mount()
    await open()
    await press('ArrowDown')
    await press('ArrowDown')
    await press('ArrowUp')
    await press('ArrowDown')
    expect(screen.getByRole('option', { name: 'feature-b' }).getAttribute('aria-selected')).toBe('true')
    await press('Enter')
    expect(callsOf('switchBranch')).toEqual([{ name: 'feature-b', uncommitted: 'bring' }])
    expect(refreshes).toBe(1)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('checks out a remote-only branch by its remote name', async () => {
    await mount()
    await open()
    fireEvent.click(screen.getByRole('option', { name: 'remote-only' }))
    await settle()
    expect(callsOf('switchBranch')).toEqual([{ name: 'origin/remote-only', uncommitted: 'bring' }])
  })

  it('closes on Escape', async () => {
    await mount()
    await open()
    await press('Escape')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('switching with changes', () => {
  const changed = [{ path: 'a.ts', oldPath: null, kind: 'modified' as const }]

  it('asks whether to leave the changes or bring them', async () => {
    await mount(changed)
    await open()
    fireEvent.click(screen.getByRole('option', { name: 'feature-a' }))
    await settle()
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('You have changes on main')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave my changes on main' }))
    await settle()
    expect(callsOf('switchBranch')).toEqual([{ name: 'feature-a', uncommitted: 'stash' }])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(refreshes).toBe(1)
  })

  it('keeps the dialog open with the reason when git refuses to bring them', async () => {
    await mount(changed)
    await open()
    fireEvent.click(screen.getByRole('option', { name: 'feature-a' }))
    await settle()
    git.branchError = { code: 'local_changes_would_be_overwritten', message: 'Your changes to a.ts would be overwritten.' }
    fireEvent.click(screen.getByRole('button', { name: 'Bring my changes to feature-a' }))
    await settle()
    expect(callsOf('switchBranch')).toEqual([{ name: 'feature-a', uncommitted: 'bring' }])
    expect(screen.getByRole('dialog').textContent).toContain('Your changes to a.ts would be overwritten.')
    expect(refreshes).toBe(0)
  })
})

describe('branch dialogs', () => {
  it('validates a new branch name live and creates it from the chosen base', async () => {
    await mount()
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'New branch' }))
    await settle()
    const name = screen.getByRole('textbox', { name: 'Name' })
    await type(name, 'bad name')
    expect(screen.getByRole('dialog').textContent).toContain('not a valid branch name')
    expect(screen.getByRole('button', { name: 'Create branch' }).hasAttribute('disabled')).toBe(true)
    await type(name, 'feat/x')
    expect(screen.getByRole('dialog').textContent).toContain('Will be created as feat/x')
    fireEvent.click(screen.getByRole('radio', { name: 'Default branch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create branch' }))
    await settle()
    expect(callsOf('createBranch')).toEqual([{ name: 'feat/x', startPoint: 'default' }])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(refreshes).toBe(1)
  })

  it('shows why creating failed and stays open', async () => {
    await mount()
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'New branch' }))
    await type(screen.getByRole('textbox', { name: 'Name' }), 'feature-a')
    git.branchError = { code: 'branch_exists', message: 'A branch named feature-a already exists.' }
    fireEvent.click(screen.getByRole('button', { name: 'Create branch' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('already exists')
  })
})

describe('rename and delete dialogs', () => {
  it('renames from the row menu with the same validation', async () => {
    await mount()
    await open()
    await rowMenu('feature-b', 'Rename…')
    const name = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
    expect(name.value).toBe('feature-b')
    await type(name, 'a..b')
    expect(screen.getByRole('button', { name: 'Rename' }).hasAttribute('disabled')).toBe(true)
    await type(name, 'feature-renamed')
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await settle()
    expect(callsOf('renameBranch')).toEqual([{ from: 'feature-b', to: 'feature-renamed' }])
  })

  it('deletes with the remote branch and asks again before forcing an unmerged one', async () => {
    await mount()
    await open()
    await rowMenu('feature-a', 'Delete…')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Also delete origin/feature-a' }))
    git.branchError = { code: 'branch_not_fully_merged', message: 'feature-a is not fully merged.' }
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await settle()
    expect(screen.getByRole('dialog').textContent).toContain('not fully merged')
    git.branchError = null
    fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }))
    await settle()
    expect(callsOf('deleteBranch')).toEqual([
      { name: 'feature-a', deleteRemote: true, force: false },
      { name: 'feature-a', deleteRemote: true, force: true }
    ])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(refreshes).toBe(1)
  })

  it('offers no remote checkbox without an upstream and no rename or delete for the current branch', async () => {
    await mount()
    await open()
    fireEvent.contextMenu(screen.getByRole('option', { name: 'main' }))
    expect(screen.queryByRole('menuitem', { name: 'Delete…' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Merge into/ })).toBeNull()
    await rowMenu('feature-b', 'Delete…')
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})

describe('merging', () => {
  it('merges from the row menu and refreshes on a conflict so the conflict view takes over', async () => {
    await mount()
    await open()
    git.branchError = { code: 'merge_conflicts', message: 'The merge has conflicts.' }
    await rowMenu('feature-a', 'Merge into main')
    expect(callsOf('mergeIntoCurrent')).toEqual([{ branch: 'feature-a' }])
    expect(refreshes).toBe(1)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('shows other merge failures', async () => {
    await mount()
    await open()
    git.branchError = { code: 'git_failed', message: 'Merge failed.' }
    await rowMenu('feature-a', 'Merge into main')
    expect(screen.getByRole('alert').textContent).toContain('Merge failed.')
  })

  it('merges a branch chosen in the picker, which filters the same way and leaves out the current branch', async () => {
    await mount()
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Choose a branch to merge into main…' }))
    await settle()
    expect(screen.queryByRole('option', { name: 'main' })).toBeNull()
    await type(filter(), 'old')
    await press('Enter')
    expect(callsOf('mergeIntoCurrent')).toEqual([{ branch: 'old-g' }])
    expect(callsOf('switchBranch')).toEqual([])
    expect(refreshes).toBe(1)
  })
})
