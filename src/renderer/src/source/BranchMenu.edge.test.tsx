// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BranchInfo, BranchList } from '../../../shared/git/branches'
import type { FileChange, RepoStatus } from '../../../shared/git/status'
import { FakeGit } from '../__mocks__/fakeGit'
import { settle } from '../__mocks__/settle'
import { BranchMenu } from './BranchMenu'

const FOLDER = '/work/alpha'
const CHANGED: FileChange[] = [{ path: 'a.ts', oldPath: null, kind: 'modified' }]

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

const LIST: BranchList = {
  current: 'main',
  defaultBranch: 'main',
  branches: [
    local('main', 30, { isCurrent: true }),
    local('feature-a', 29),
    local('feature-b', 28),
    { ...local('origin/remote-only', 20), kind: 'remote', remote: 'origin' }
  ]
}

function status(branch: string | null, files: FileChange[] = []): RepoStatus {
  return {
    root: FOLDER,
    branch: { name: branch, headOid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0 },
    files,
    inProgress: null,
    lastFetchedAt: null,
    remote: null
  }
}

interface MountOptions {
  branch?: string | null
  files?: FileChange[]
  tracked?: boolean
}

async function mount({ branch = 'main', files = [], tracked = true }: MountOptions = {}): Promise<void> {
  const value = status(branch, files)
  if (tracked) git.setState(FOLDER, { kind: 'repository', status: value })
  git.setBranches(FOLDER, { ...LIST, current: branch })
  render(<BranchMenu folderPath={FOLDER} status={value} label={branch ?? 'HEAD (detached)'} onRefresh={() => (refreshes += 1)} />)
  await settle()
}

const toggle = (): HTMLElement => screen.getByRole('button', { name: /Current branch/ })
const filter = (): HTMLElement => screen.getByRole('textbox', { name: 'Filter branches' })
const selected = (): string[] =>
  screen.getAllByRole('option').filter((option) => option.getAttribute('aria-selected') === 'true').map((option) => option.textContent ?? '')
const callsOf = (method: string): unknown[] => git.calls.filter((call) => call.method === method).map((call) => call.request)
const menuItems = (): string[] => screen.queryAllByRole('menuitem').map((item) => item.textContent ?? '')

async function open(): Promise<void> {
  fireEvent.click(toggle())
  await settle()
}

async function press(key: string): Promise<void> {
  fireEvent.keyDown(filter(), { key })
  await settle()
}

describe('BranchMenu popover edges', () => {
  it('closes on a press outside the menu but not on one inside, and when its button is pressed again', async () => {
    await mount()
    await open()
    fireEvent.mouseDown(filter())
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    await settle()
    expect(screen.queryByRole('listbox')).toBeNull()
    await open()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    await open()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the selection inside the list at both ends', async () => {
    await mount()
    await open()
    await press('ArrowUp')
    expect(selected()).toEqual(['main'])
    for (let step = 0; step < 6; step += 1) await press('ArrowDown')
    expect(selected()).toEqual(['remote-only'])
  })

  it('says nothing matches, and Enter or another key then does nothing', async () => {
    await mount()
    await open()
    fireEvent.change(filter(), { target: { value: 'zzz' } })
    await settle()
    expect(screen.getByText('No branches match')).toBeTruthy()
    await press('Enter')
    await press('a')
    expect(git.calls.filter((call) => call.method === 'switchBranch')).toEqual([])
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('choosing the current branch only closes the popover', async () => {
    await mount()
    await open()
    fireEvent.click(screen.getByRole('option', { name: 'main' }))
    await settle()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(callsOf('switchBranch')).toEqual([])
    expect(refreshes).toBe(0)
  })
})

describe('BranchMenu list failures', () => {
  it('shows why the branches could not be listed', async () => {
    await mount({ tracked: false })
    await open()
    expect(screen.getByRole('alert').textContent).toBe('That folder is not tracked by Dark Mechanicus.')
    expect(screen.queryAllByRole('option')).toEqual([])
    expect(screen.queryByText('No branches match')).toBeNull()
  })

  it('names git as silent when listing fails without an error', async () => {
    await mount()
    git.listBranches = () => Promise.reject(Object.assign(Object.create(null) as object, { reason: 'closed' }))
    await open()
    expect(screen.getByRole('alert').textContent).toBe('Git did not answer.')
  })
})

describe('BranchMenu row menus', () => {
  it('offers only a merge for a remote-only branch', async () => {
    await mount()
    await open()
    fireEvent.contextMenu(screen.getByRole('option', { name: 'remote-only' }))
    expect(menuItems()).toEqual(['Merge into main'])
  })

  it('offers rename and delete but no merge for a local branch on a detached HEAD', async () => {
    await mount({ branch: null })
    await open()
    fireEvent.contextMenu(screen.getByRole('option', { name: 'feature-a' }))
    expect(menuItems()).toEqual(['Rename…', 'Delete…'])
    expect(screen.getByRole('button', { name: 'New branch' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Choose a branch to merge/ })).toBeNull()
  })

  it('has no row menu in the merge picker', async () => {
    await mount()
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Choose a branch to merge into main…' }))
    await settle()
    expect(screen.getByText('Merge into main')).toBeTruthy()
    fireEvent.contextMenu(screen.getByRole('option', { name: 'feature-a' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('button', { name: 'New branch' })).toBeNull()
  })
})

describe('BranchMenu dialogs edges', () => {
  it('names the commit when switching away from a detached HEAD with changes', async () => {
    await mount({ branch: null, files: CHANGED })
    await open()
    fireEvent.click(screen.getByRole('option', { name: 'feature-a' }))
    await settle()
    expect(screen.getByRole('dialog').textContent).toContain('You have changes on this commit.')
    expect(screen.getByRole('button', { name: 'Leave my changes on this commit' })).toBeTruthy()
  })

  it('cancelling a dialog closes it without changing anything', async () => {
    await mount({ files: CHANGED })
    await open()
    fireEvent.click(screen.getByRole('option', { name: 'feature-a' }))
    await settle()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(callsOf('switchBranch')).toEqual([])
    expect(refreshes).toBe(0)
  })
})
