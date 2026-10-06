// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileDiff } from '../../../shared/git/diff'
import type { FileChange, RepoState, RepoStatus } from '../../../shared/git/status'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeGit } from '../__mocks__/fakeGit'
import { folderView } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ToastProvider } from '../app/toasts'
import { SourceControlView } from './SourceControlView'

const FOLDER = '/work/alpha'
const folder = folderView({ path: FOLDER, name: 'alpha' })

let git: FakeGit
let dm: FakeDm
let scheduler: ManualScheduler

beforeEach(() => {
  git = new FakeGit()
  dm = new FakeDm()
  scheduler = new ManualScheduler()
  window.git = git
  window.dm = dm
})

afterEach(cleanup)

function status(files: FileChange[] = [], patch: Partial<RepoStatus> = {}): RepoState {
  return {
    kind: 'repository',
    status: {
      root: FOLDER,
      branch: { name: 'main', headOid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0 },
      files,
      inProgress: null,
      ...patch
    }
  }
}

const change = (path: string, kind: FileChange['kind'] = 'modified', oldPath: string | null = null): FileChange => ({ path, oldPath, kind })

function textDiff(path: string, added: string): FileDiff {
  return {
    path,
    oldPath: null,
    oldMode: null,
    newMode: null,
    hash: 'h',
    kind: 'text',
    hunks: [{ header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ kind: 'add', text: added, oldNumber: null, newNumber: 1, noNewlineAtEnd: false }] }]
  }
}

function renderView(ui: JSX.Element): ReturnType<typeof render> {
  return render(<ToastProvider scheduler={scheduler}>{ui}</ToastProvider>)
}

async function mount(): Promise<void> {
  renderView(<SourceControlView folder={folder} scheduler={scheduler} />)
  await settle()
}

describe('SourceControlView states', () => {
  it('shows loading until Git answers', () => {
    git.setState(FOLDER, status())
    renderView(<SourceControlView folder={folder} scheduler={scheduler} />)
    expect(screen.getByRole('status').textContent).toContain('Reading the repository')
  })

  it('says Git is not installed and opens the download page', async () => {
    git.setState(FOLDER, { kind: 'git_missing' })
    const open = vi.spyOn(dm, 'openExternal')
    await mount()
    expect(screen.getByRole('heading', { name: 'Git isn’t installed' })).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: 'Download Git' }))
    expect(open).toHaveBeenCalledWith('https://git-scm.com/downloads')
  })

  it('offers to initialize a folder that is not a repository, then shows the empty repository', async () => {
    git.setState(FOLDER, { kind: 'not_repository' })
    await mount()
    expect(screen.getByRole('heading', { name: 'This folder isn’t a Git repository' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Initialize repository' }))
    await settle()
    expect(git.calls.filter((call) => call.method === 'initRepository')).toHaveLength(1)
    expect(screen.getByText('0 changed files')).toBeTruthy()
    expect(screen.getByText('No local changes')).toBeTruthy()
    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getByText('No commits yet')).toBeTruthy()
  })

  it('shows an error with Retry, and recovers when Git answers', async () => {
    await mount()
    expect(screen.getByRole('heading', { name: 'Couldn’t read this folder’s Git state' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('not tracked')
    git.setState(FOLDER, status())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(screen.getByText('0 changed files')).toBeTruthy()
  })
})

describe('SourceControlView repository', () => {
  it('shows the branch, and no root when it is the folder (slashes and case aside)', async () => {
    git.setState(FOLDER, status([], { root: '/work/alpha/' }))
    await mount()
    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.queryByText(/Repository root/)).toBeNull()
  })

  it('does not call a forward-slash root of a Windows folder different', async () => {
    const windows = folderView({ path: 'C:\\Users\\me\\alpha', name: 'alpha' })
    git.setState(windows.path, status([], { root: 'c:/Users/me/alpha' }))
    renderView(<SourceControlView folder={windows} scheduler={scheduler} />)
    await settle()
    expect(screen.queryByText(/Repository root/)).toBeNull()
  })

  it('shows the repository root when it differs from the folder', async () => {
    git.setState(FOLDER, status([], { root: '/work' }))
    await mount()
    expect(screen.getByText('Repository root: /work')).toBeTruthy()
  })

  it('shows a detached HEAD with the short object id', async () => {
    git.setState(FOLDER, status([], { branch: { name: null, headOid: 'abcdef1234567890', upstream: null, ahead: 0, behind: 0 } }))
    await mount()
    expect(screen.getByText('Detached HEAD at abcdef1')).toBeTruthy()
  })

  it('shows an unborn branch with no name as No commits yet', async () => {
    git.setState(FOLDER, status([], { branch: { name: null, headOid: null, upstream: null, ahead: 0, behind: 0 } }))
    await mount()
    expect(screen.getByText('No commits yet')).toBeTruthy()
  })

})

describe('SourceControlView changes', () => {
  it('lists each change with its directory, name, badge and old path', async () => {
    git.setState(
      FOLDER,
      status([
        change('src/app.ts', 'modified'),
        change('docs/new.md', 'added'),
        change('old.txt', 'deleted'),
        change('src/renamed.ts', 'renamed', 'src/was.ts'),
        change('notes.txt', 'untracked'),
        change('clash.ts', 'conflicted'),
        change('mode.sh', 'typechange')
      ])
    )
    await mount()
    expect(screen.getByText('7 changed files')).toBeTruthy()
    const list = within(screen.getByRole('list'))
    const row = (name: string): HTMLElement => list.getByText(name).closest('li') as HTMLElement
    expect(within(row('app.ts')).getByText('src/').className).toContain('source-dir')
    expect(within(row('app.ts')).getByText('M')).toBeTruthy()
    expect(within(row('new.md')).getByText('A')).toBeTruthy()
    expect(within(row('old.txt')).getByText('D')).toBeTruthy()
    expect(within(row('renamed.ts')).getByText('R')).toBeTruthy()
    expect(within(row('renamed.ts')).getByText('src/was.ts')).toBeTruthy()
    expect(within(row('notes.txt')).getByText('?')).toBeTruthy()
    expect(within(row('clash.ts')).getByText('!')).toBeTruthy()
    expect(within(row('mode.sh')).getByText('U')).toBeTruthy()
  })

})

describe('SourceControlView diffs', () => {
  it('shows the diff of the selected file and keeps the selection across a refresh while it is listed', async () => {
    git.setState(FOLDER, status([change('a.ts'), change('b.ts')]))
    git.setDiff(FOLDER, 'a.ts', textDiff('a.ts', 'alpha line'))
    git.setDiff(FOLDER, 'b.ts', textDiff('b.ts', 'beta line'))
    await mount()
    expect(screen.getByText('Select a file to see its changes')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /b\.ts/ }))
    await settle()
    expect(screen.getByText('beta line')).toBeTruthy()
    expect(git.calls.find((call) => call.method === 'getWorkingDiff')?.request).toEqual({ path: 'b.ts', oldPath: null, kind: 'modified', force: false })

    git.setState(FOLDER, status([change('b.ts'), change('c.ts')]))
    act(() => scheduler.fireIntervals(5000))
    await settle()
    expect(screen.getByText('beta line')).toBeTruthy()
    expect(screen.getByRole('button', { name: /b\.ts/ }).getAttribute('aria-pressed')).toBe('true')

    git.setState(FOLDER, status([change('c.ts')]))
    act(() => scheduler.fireIntervals(5000))
    await settle()
    expect(screen.getByText('Select a file to see its changes')).toBeTruthy()
  })

  it('asks again with force when a large diff is shown anyway', async () => {
    git.setState(FOLDER, status([change('big.bin')]))
    git.setDiff(FOLDER, 'big.bin', { path: 'big.bin', oldPath: null, oldMode: null, newMode: null, hash: 'h', kind: 'too_large', bytes: 5 * 1024 * 1024 })
    await mount()
    fireEvent.click(screen.getByRole('button', { name: /big\.bin/ }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Show anyway' }))
    await settle()
    const requests = git.calls.filter((call) => call.method === 'getWorkingDiff').map((call) => (call.request as { force?: boolean } | undefined)?.force)
    expect(requests).toEqual([false, true])
  })

  it('shows the error when a diff cannot be read', async () => {
    git.setState(FOLDER, status([change('a.ts')]))
    await mount()
    fireEvent.click(screen.getByRole('button', { name: /a\.ts/ }))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('No diff set')
  })
})

describe('SourceControlView refresh', () => {
  const stateCalls = (): number => git.calls.filter((call) => call.method === 'getState').length

  it('reads the state every 5 seconds', async () => {
    git.setState(FOLDER, status())
    await mount()
    expect(scheduler.intervals()).toContain(5000)
    expect(stateCalls()).toBe(1)
    git.setState(FOLDER, status([change('late.ts')]))
    act(() => scheduler.fireIntervals(5000))
    await settle()
    expect(stateCalls()).toBe(2)
    expect(screen.getByText('1 changed file')).toBeTruthy()
  })

  it('reads the state when the window regains focus', async () => {
    git.setState(FOLDER, status())
    await mount()
    git.setState(FOLDER, status([change('focus.ts')]))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await settle()
    expect(stateCalls()).toBe(2)
    expect(screen.getByText('focus.ts')).toBeTruthy()
  })

  it('stops the timer when it unmounts', async () => {
    git.setState(FOLDER, status())
    const view = renderView(<SourceControlView folder={folder} scheduler={scheduler} />)
    await settle()
    view.unmount()
    expect(scheduler.intervals()).toEqual([])
  })
})
