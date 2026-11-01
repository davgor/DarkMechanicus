// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GitResult } from '../../../shared/git/api'
import type { BranchInfo, BranchNameCheck } from '../../../shared/git/branches'
import { FakeGit } from '../__mocks__/fakeGit'
import { settle } from '../__mocks__/settle'
import { DeleteDialog, NewBranchDialog, RenameDialog, SwitchDialog } from './BranchDialogs'

const FOLDER = '/work/alpha'

interface PendingCheck {
  name: string
  resolve(result: GitResult<BranchNameCheck>): void
  reject(reason: Error): void
}

let git: FakeGit
let closes: number
let dones: number

beforeEach(() => {
  git = new FakeGit()
  window.git = git
  git.setState(FOLDER, {
    kind: 'repository',
    status: {
      root: FOLDER,
      branch: { name: 'main', headOid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0 },
      files: [],
      inProgress: null,
      lastFetchedAt: null,
      remote: null
    }
  })
  closes = 0
  dones = 0
})

afterEach(cleanup)

const base = (): { folderPath: string; onClose(): void; onDone(): void } => ({
  folderPath: FOLDER,
  onClose: () => (closes += 1),
  onDone: () => (dones += 1)
})

/** Holds every name check until the test answers it, to order answers by hand. */
function holdNameChecks(): PendingCheck[] {
  const pending: PendingCheck[] = []
  git.checkBranchName = (_folder, name) =>
    new Promise((resolve, reject) => {
      pending.push({ name, resolve, reject })
    })
  return pending
}

const valid = (name: string): GitResult<BranchNameCheck> => ({ ok: true, data: { valid: true, normalized: name } })
const nameField = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
const button = (name: string): HTMLElement => screen.getByRole('button', { name })
const dialogText = (): string => screen.getByRole('dialog').textContent ?? ''

async function type(value: string): Promise<void> {
  fireEvent.change(nameField(), { target: { value } })
  await settle()
}

describe('branch name check', () => {
  it('shows nothing while empty or checking, and drops an answer for an older name', async () => {
    const pending = holdNameChecks()
    render(<NewBranchDialog {...base()} />)
    await settle()
    expect(pending).toEqual([])
    await type('fe')
    expect(dialogText()).not.toContain('Will be created')
    expect(dialogText()).not.toContain('not a valid branch name')
    expect(button('Create branch').hasAttribute('disabled')).toBe(true)
    await type('feat')
    pending[1]?.resolve(valid('feat'))
    await settle()
    pending[0]?.resolve({ ok: true, data: { valid: false, normalized: null } })
    await settle()
    expect(dialogText()).toContain('Will be created as feat')
    await type('')
    expect(dialogText()).not.toContain('Will be created')
    expect(button('Create branch').hasAttribute('disabled')).toBe(true)
  })

  it('treats a failed check as invalid, unless it was for an older name', async () => {
    const pending = holdNameChecks()
    render(<NewBranchDialog {...base()} />)
    await type('a')
    await type('ab')
    pending[0]?.reject(new Error('ipc closed'))
    await settle()
    expect(dialogText()).not.toContain('not a valid branch name')
    pending[1]?.reject(new Error('ipc closed'))
    await settle()
    expect(dialogText()).toContain('That is not a valid branch name.')
    expect(button('Create branch').hasAttribute('disabled')).toBe(true)
  })

  it('treats a valid verdict without a normalized name as invalid', async () => {
    const pending = holdNameChecks()
    render(<NewBranchDialog {...base()} />)
    await type('x')
    pending[0]?.resolve({ ok: true, data: { valid: true, normalized: null } })
    await settle()
    expect(dialogText()).toContain('That is not a valid branch name.')
  })
})

describe('rename dialog', () => {
  it('cannot rename to the same name, and shows why a rename failed', async () => {
    render(<RenameDialog {...base()} from="feature-a" />)
    await settle()
    expect(dialogText()).toContain('Will be renamed as feature-a')
    expect(button('Rename').hasAttribute('disabled')).toBe(true)
    await type('feature-z')
    git.branchError = { code: 'branch_exists', message: 'A branch named feature-z already exists.' }
    fireEvent.click(button('Rename'))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('A branch named feature-z already exists.')
    expect(dones).toBe(0)
    fireEvent.click(button('Cancel'))
    expect(closes).toBe(1)
  })
})

describe('delete and switch dialogs', () => {
  const branch: BranchInfo = {
    name: 'feature-a', kind: 'local', remote: null, upstream: null, ahead: 0, behind: 0,
    lastCommitAt: '2026-10-29T12:00:00.000Z', isCurrent: false
  }

  it('shows other delete failures without offering to force', async () => {
    render(<DeleteDialog {...base()} branch={branch} />)
    git.branchError = { code: 'git_failed', message: 'fatal: cannot lock ref.' }
    fireEvent.click(button('Delete'))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('fatal: cannot lock ref.')
    expect(screen.queryByRole('button', { name: 'Delete anyway' })).toBeNull()
    expect(git.calls.filter((call) => call.method === 'deleteBranch').map((call) => call.request)).toEqual([
      { name: 'feature-a', deleteRemote: false, force: false }
    ])
    expect(dones).toBe(0)
  })

  it('keeps the switch dialog open with the reason when leaving the changes fails', async () => {
    render(<SwitchDialog {...base()} current="main" target={{ label: 'remote-only', name: 'origin/remote-only' }} />)
    git.branchError = { code: 'git_failed', message: 'Could not stash your changes.' }
    fireEvent.click(button('Leave my changes on main'))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('Could not stash your changes.')
    expect(git.calls.filter((call) => call.method === 'switchBranch').map((call) => call.request)).toEqual([
      { name: 'origin/remote-only', uncommitted: 'stash' }
    ])
    expect(dones).toBe(0)
  })
})
