// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConflictState } from '../../../shared/git/conflicts'
import type { FileChange, RepoState, RepoStatus } from '../../../shared/git/status'
import { ToastProvider } from '../app/toasts'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeGit } from '../__mocks__/fakeGit'
import { FakeGithub } from '../__mocks__/fakeGithub'
import { folderView } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { GithubAccountProvider } from '../github/GithubAccount'
import { useConflicts } from './ConflictsPanel'
import { SourceControlView } from './SourceControlView'

const FOLDER = '/work/alpha'
const OTHER = '/work/beta'

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

const change = (path: string, kind: FileChange['kind'] = 'modified'): FileChange => ({ path, oldPath: null, kind })

function repoStatus(root: string, files: FileChange[], inProgress: RepoStatus['inProgress'] = 'merge'): RepoStatus {
  return {
    root,
    branch: { name: 'main', headOid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0 },
    files,
    inProgress,
    lastFetchedAt: null,
    remote: null
  }
}

const state = (files: FileChange[], inProgress: RepoStatus['inProgress'] = 'merge'): RepoState => ({
  kind: 'repository',
  status: repoStatus(FOLDER, files, inProgress)
})

const CONFLICTS: ConflictState = {
  ourBranch: 'main',
  theirLabel: 'topic',
  mineSide: 'ours',
  files: [
    { path: 'a.ts', kind: 'both_modified', markers: 0 },
    { path: 'b.ts', kind: 'deleted_by_them', markers: 1 }
  ]
}

async function mount(conflicts: ConflictState = CONFLICTS): Promise<void> {
  git.setState(FOLDER, state([change('a.ts', 'conflicted'), change('b.ts', 'conflicted')]))
  git.setConflicts(FOLDER, conflicts)
  render(
    <ToastProvider scheduler={scheduler}>
      <GithubAccountProvider>
        <SourceControlView folder={folderView({ path: FOLDER, name: 'alpha' })} scheduler={scheduler} />
      </GithubAccountProvider>
    </ToastProvider>
  )
  await settle()
}

async function refresh(): Promise<void> {
  act(() => scheduler.fireIntervals(5000))
  await settle()
}

const rowOf = (path: string): HTMLElement =>
  within(screen.getByRole('list', { name: 'Conflicted files' })).getByText(path).closest('li') as HTMLElement
const button = (name: string | RegExp, scope: HTMLElement = document.body): HTMLButtonElement =>
  within(scope).getByRole('button', { name }) as HTMLButtonElement

describe('conflict reading failures', () => {
  it('shows why the conflicts could not be read, and clears it once a read succeeds', async () => {
    const working = git.getConflicts.bind(git)
    git.getConflicts = () => Promise.resolve({ ok: false, error: { code: 'git_failed', message: 'index.lock exists.' } })
    await mount()
    expect(screen.getByRole('alert').textContent).toBe('index.lock exists.')
    git.getConflicts = working
    await refresh()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Merging topic into main: 2 conflicted files')).toBeTruthy()
  })

  it('says git did not answer when an action rejects with something other than an Error', async () => {
    await mount()
    git.resolveWith = () => Promise.reject('gone')
    fireEvent.click(button('Use mine (main)', rowOf('a.ts')))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('Git did not answer.')
    expect(button('Use mine (main)', rowOf('a.ts')).disabled).toBe(false)
  })

  it('shows main refusing Mark resolved because markers came back since the last read', async () => {
    await mount()
    git.markResolved = () => Promise.resolve({ ok: false, error: { code: 'conflict_markers_remain', message: 'a.ts still has conflict markers.' } })
    fireEvent.click(button('Mark resolved', rowOf('a.ts')))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('a.ts still has conflict markers.')
    expect(within(rowOf('a.ts')).queryByText('Resolved')).toBeNull()
  })
})

describe('Abort merge failure', () => {
  it('keeps the dialog open with main’s reason, ready to try again or cancel', async () => {
    await mount()
    git.abortMerge = () => Promise.resolve({ ok: false, error: { code: 'git_failed', message: 'Could not reset the index.' } })
    fireEvent.click(button('Abort merge'))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(button('Abort merge', dialog))
    await settle()
    expect(within(dialog).getByRole('alert').textContent).toBe('Could not reset the index.')
    expect(button('Abort merge', dialog).disabled).toBe(false)
    expect(screen.getByText('Merging topic into main: 2 conflicted files')).toBeTruthy()
    fireEvent.click(button('Cancel', dialog))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('resolved files git no longer lists', () => {
  it('keeps the row as Resolved but cannot show a diff for it', async () => {
    await mount()
    git.setState(FOLDER, state([change('a.ts')]))
    git.setConflicts(FOLDER, { ...CONFLICTS, files: [] })
    await refresh()
    expect(within(rowOf('b.ts')).getByText('Resolved')).toBeTruthy()
    expect(button(/^b\.ts/, rowOf('b.ts')).disabled).toBe(true)
    expect(button(/^a\.ts/, rowOf('a.ts')).disabled).toBe(false)
  })
})

describe('useConflicts on a folder switch', () => {
  it('never shows the previous folder’s remembered files for the new folder', async () => {
    git.setState(FOLDER, state([change('a.ts', 'conflicted')]))
    git.setState(OTHER, { kind: 'repository', status: repoStatus(OTHER, [change('z.ts', 'conflicted')]) })
    const seen: string[][] = []
    const { rerender } = renderHook(({ folder }) => {
      const model = useConflicts(folder, folder === FOLDER ? repoStatus(FOLDER, [change('a.ts', 'conflicted')]) : repoStatus(OTHER, [change('z.ts', 'conflicted')]), 0)
      seen.push(model.rows.map((row) => row.path))
      return model
    }, { initialProps: { folder: FOLDER } })
    await settle()
    expect(seen.at(-1)).toEqual(['a.ts'])
    const switchedAt = seen.length
    rerender({ folder: OTHER })
    await settle()
    expect(seen.slice(switchedAt).some((rows) => rows.includes('a.ts'))).toBe(false)
    expect(seen.at(-1)).toEqual(['z.ts'])
  })
})
