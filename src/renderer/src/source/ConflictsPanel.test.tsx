// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConflictState } from '../../../shared/git/conflicts'
import type { DiffLine } from '../../../shared/git/diff'
import type { FileChange, RepoState, RepoStatus } from '../../../shared/git/status'
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

function status(files: FileChange[], inProgress: RepoStatus['inProgress'] = 'merge'): RepoState {
  return {
    kind: 'repository',
    status: {
      root: FOLDER,
      branch: { name: 'main', headOid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0 },
      files,
      inProgress,
      lastFetchedAt: null,
      remote: null
    }
  }
}

const MERGE_FILES = [change('a.ts', 'conflicted'), change('b.ts', 'conflicted'), change('clean.ts')]
const MERGE_CONFLICTS: ConflictState = {
  ourBranch: 'main',
  theirLabel: 'topic',
  mineSide: 'ours',
  files: [
    { path: 'a.ts', kind: 'both_modified', markers: 2 },
    { path: 'b.ts', kind: 'deleted_by_them', markers: 0 }
  ]
}

async function mount(state: RepoState = status(MERGE_FILES), conflicts: ConflictState | null = MERGE_CONFLICTS): Promise<void> {
  git.setState(FOLDER, state)
  if (conflicts !== null) {
    git.setConflicts(FOLDER, conflicts)
  }
  render(
    <ToastProvider scheduler={scheduler}>
      <GithubAccountProvider>
        <SourceControlView folder={folder} scheduler={scheduler} />
      </GithubAccountProvider>
    </ToastProvider>
  )
  await settle()
}

async function refresh(): Promise<void> {
  act(() => scheduler.fireIntervals(5000))
  await settle()
}

const conflictList = (): HTMLElement => screen.getByRole('list', { name: 'Conflicted files' })
const rowOf = (path: string): HTMLElement => within(conflictList()).getByText(path).closest('li') as HTMLElement
const button = (name: string | RegExp, scope: HTMLElement = document.body): HTMLButtonElement =>
  within(scope).getByRole('button', { name }) as HTMLButtonElement
const callsOf = (method: string): FakeGit['calls'] => git.calls.filter((call) => call.method === method)

describe('merge banner', () => {
  it('names both sides and the number of conflicted files, and lists them first with their counts', async () => {
    await mount()
    expect(screen.getByText('Merging topic into main: 2 conflicted files')).toBeTruthy()
    expect(within(rowOf('a.ts')).getByText('2 conflicts')).toBeTruthy()
    expect(within(rowOf('b.ts')).getByText('0 conflicts')).toBeTruthy()
    const lists = screen.getAllByRole('list')
    expect(lists[0]).toBe(conflictList())
    expect(within(conflictList()).queryByText('clean.ts')).toBeNull()
    expect(screen.getByText('1 changed file')).toBeTruthy()
  })

  it('says 1 conflicted file, and 1 conflict, in the singular', async () => {
    await mount(status([change('a.ts', 'conflicted')]), { ...MERGE_CONFLICTS, files: [{ path: 'a.ts', kind: 'both_modified', markers: 1 }] })
    expect(screen.getByText('Merging topic into main: 1 conflicted file')).toBeTruthy()
    expect(within(rowOf('a.ts')).getByText('1 conflict')).toBeTruthy()
  })
})

describe('Commit merge and Abort merge', () => {
  it('replaces the commit box with Commit merge, enabled only once nothing is unresolved', async () => {
    await mount()
    expect(screen.queryByLabelText('Summary')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Commit to/ })).toBeNull()
    expect(button('Commit merge').disabled).toBe(true)
    git.setState(FOLDER, status([change('a.ts'), change('b.ts', 'deleted'), change('clean.ts')]))
    git.setConflicts(FOLDER, { ...MERGE_CONFLICTS, files: [] })
    await refresh()
    expect(screen.getByText('Merging topic into main: 0 conflicted files')).toBeTruthy()
    expect(within(rowOf('a.ts')).getByText('Resolved')).toBeTruthy()
    expect(within(rowOf('b.ts')).getByText('Resolved')).toBeTruthy()
    expect(button('Commit merge').disabled).toBe(false)
    fireEvent.click(button('Commit merge'))
    await settle()
    expect(callsOf('commitMerge')).toEqual([{ method: 'commitMerge', folder: FOLDER, request: {} }])
    expect(screen.queryByText(/Merging topic/)).toBeNull()
    expect(screen.getByLabelText('Summary')).toBeTruthy()
  })

  it('shows why Commit merge failed', async () => {
    await mount(status([change('a.ts')]), { ...MERGE_CONFLICTS, files: [] })
    git.commitMerge = () => Promise.resolve({ ok: false, error: { code: 'git_failed', message: 'The hook said no.' } })
    fireEvent.click(button('Commit merge'))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('The hook said no.')
  })

  it('asks before aborting the merge, and Cancel keeps it', async () => {
    await mount()
    fireEvent.click(button('Abort merge'))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('back to where it was before the merge')
    fireEvent.click(button('Cancel', dialog))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(callsOf('abortMerge')).toHaveLength(0)
    fireEvent.click(button('Abort merge'))
    fireEvent.click(button('Abort merge', screen.getByRole('dialog')))
    await settle()
    expect(callsOf('abortMerge')).toHaveLength(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText(/Merging topic/)).toBeNull()
    expect(screen.queryByRole('list', { name: 'Conflicted files' })).toBeNull()
  })
})

describe('conflicted file actions', () => {
  it('uses mine or theirs, naming the sides, and refreshes', async () => {
    await mount()
    fireEvent.click(button('Use mine (main)', rowOf('a.ts')))
    await settle()
    fireEvent.click(button('Use theirs (topic)', rowOf('b.ts')))
    await settle()
    expect(callsOf('resolveWith').map((call) => call.request)).toEqual([
      { path: 'a.ts', side: 'ours' },
      { path: 'b.ts', side: 'theirs' }
    ])
    expect(within(rowOf('a.ts')).getByText('Resolved')).toBeTruthy()
    expect(screen.getByText('Merging topic into main: 0 conflicted files')).toBeTruthy()
  })

  it('opens the file in the editor', async () => {
    await mount()
    fireEvent.click(button('Open in editor', rowOf('a.ts')))
    await settle()
    expect(callsOf('openInEditor')).toEqual([{ method: 'openInEditor', folder: FOLDER, path: 'a.ts' }])
  })

  it('disables Mark resolved while markers remain, and enables it once they are gone', async () => {
    await mount()
    expect(button('Mark resolved', rowOf('a.ts')).disabled).toBe(true)
    expect(button('Mark resolved', rowOf('b.ts')).disabled).toBe(false)
    git.setConflicts(FOLDER, { ...MERGE_CONFLICTS, files: [{ path: 'a.ts', kind: 'both_modified', markers: 0 }, MERGE_CONFLICTS.files[1]] })
    await refresh()
    expect(within(rowOf('a.ts')).getByText('0 conflicts')).toBeTruthy()
    fireEvent.click(button('Mark resolved', rowOf('a.ts')))
    await settle()
    expect(callsOf('markResolved').map((call) => call.request)).toEqual([{ path: 'a.ts' }])
  })

  it('shows a refusal from main', async () => {
    await mount()
    git.resolveWith = () => Promise.resolve({ ok: false, error: { code: 'invalid_input', message: 'a.ts is not a conflicted file.' } })
    fireEvent.click(button('Use mine (main)', rowOf('a.ts')))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('a.ts is not a conflicted file.')
  })

  it("shows the working file's diff, markers and all, when a conflicted file is selected", async () => {
    const line = (text: string, newNumber: number): DiffLine => ({ kind: 'add', text, oldNumber: null, newNumber, noNewlineAtEnd: false })
    const lines = [line('<<<<<<< HEAD', 1), line('mine', 2), line('=======', 3), line('theirs', 4), line('>>>>>>> topic', 5)]
    const hunk = { header: '@@ -1 +1,5 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 5, lines }
    git.setDiff(FOLDER, 'a.ts', { kind: 'text', path: 'a.ts', oldPath: null, oldMode: null, newMode: null, hash: 'h', hunks: [hunk] })
    await mount()
    fireEvent.click(button(/^a\.ts/, rowOf('a.ts')))
    await settle()
    expect(callsOf('getWorkingDiff').map((call) => call.request)).toEqual([{ path: 'a.ts', oldPath: null, kind: 'conflicted', force: false }])
    expect(within(screen.getByLabelText('Diff')).getByText('<<<<<<< HEAD')).toBeTruthy()
  })
})

describe('other operations and conflicts without a merge', () => {
  it('shows a banner with Abort for a rebase, cherry-pick or revert in progress', async () => {
    for (const operation of ['rebase', 'cherry-pick', 'revert'] as const) {
      git = new FakeGit()
      window.git = git
      await mount(status([change('x.ts', 'conflicted')], operation), null)
      expect(screen.getByText(`A ${operation} is in progress. Finish it in a terminal, or abort it here.`)).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Commit merge' })).toBeNull()
      expect(within(rowOf('x.ts')).getByText('1 conflict')).toBeTruthy()
      fireEvent.click(button('Abort'))
      await settle()
      expect(callsOf('abortOperation')).toHaveLength(1)
      expect(screen.queryByText(/is in progress/)).toBeNull()
      cleanup()
    }
  })

  it('lists the conflicts of a stash restore without a banner, with Use mine taking the stashed changes, and holds the commit box until they are resolved', async () => {
    await mount(status([change('a.ts', 'conflicted'), change('c.ts')], null), { ourBranch: 'main', theirLabel: null, mineSide: 'theirs', files: [{ path: 'a.ts', kind: 'both_modified', markers: 1 }] })
    expect(screen.queryByText(/Merging/)).toBeNull()
    expect(within(rowOf('a.ts')).getByText('1 conflict')).toBeTruthy()
    expect(button('Use theirs (main)', rowOf('a.ts'))).toBeTruthy()
    expect(screen.getByText('1 changed file')).toBeTruthy()
    expect(screen.queryByLabelText('Summary')).toBeNull()
    fireEvent.click(button('Use mine (stashed changes)', rowOf('a.ts')))
    await settle()
    expect(callsOf('resolveWith').map((call) => call.request)).toEqual([{ path: 'a.ts', side: 'theirs' }])
    expect(screen.queryByRole('list', { name: 'Conflicted files' })).toBeNull()
    expect(screen.getByLabelText('Summary')).toBeTruthy()
    expect(screen.getByText('2 changed files')).toBeTruthy()
  })

  it('shows conflicts that a pull, merge or stash restore left once the state is read again', async () => {
    await mount(status([change('a.ts')], null), null)
    expect(screen.queryByRole('list', { name: 'Conflicted files' })).toBeNull()
    expect(callsOf('getConflicts')).toHaveLength(0)
    git.setState(FOLDER, status([change('a.ts', 'conflicted')]))
    git.setConflicts(FOLDER, { ourBranch: 'main', theirLabel: 'origin/main', mineSide: 'ours', files: [{ path: 'a.ts', kind: 'both_modified', markers: 3 }] })
    await refresh()
    expect(screen.getByText('Merging origin/main into main: 1 conflicted file')).toBeTruthy()
    expect(within(rowOf('a.ts')).getByText('3 conflicts')).toBeTruthy()
  })
})

describe('a git am in progress', () => {
  it('names a git am in its banner, and its Abort aborts the operation', async () => {
    await mount(status([change('x.ts', 'conflicted')], 'am'), null)
    expect(screen.getByText('Applying patches (git am) is in progress. Finish it in a terminal, or abort it here.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Abort merge' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Commit merge' })).toBeNull()
    fireEvent.click(button('Abort'))
    await settle()
    expect(callsOf('abortOperation')).toHaveLength(1)
    expect(screen.queryByText(/is in progress/)).toBeNull()
  })
})

describe('red-team regressions in the view', () => {
  it('while a rebase replays a commit, Use mine takes the replayed commit (git calls it theirs) and Use theirs the upstream', async () => {
    await mount(status([change('x.ts', 'conflicted')], 'rebase'), { ourBranch: null, theirLabel: 'My change', mineSide: 'theirs', files: [{ path: 'x.ts', kind: 'both_modified', markers: 1 }] })
    fireEvent.click(button('Use mine (My change)', rowOf('x.ts')))
    await settle()
    expect(callsOf('resolveWith').map((call) => call.request)).toEqual([{ path: 'x.ts', side: 'theirs' }])
    git.setState(FOLDER, status([change('x.ts', 'conflicted')], 'rebase'))
    git.setConflicts(FOLDER, { ourBranch: null, theirLabel: 'My change', mineSide: 'theirs', files: [{ path: 'x.ts', kind: 'both_modified', markers: 1 }] })
    await refresh()
    fireEvent.click(button('Use theirs', rowOf('x.ts')))
    await settle()
    expect(callsOf('resolveWith').map((call) => call.request)).toEqual([
      { path: 'x.ts', side: 'theirs' },
      { path: 'x.ts', side: 'ours' }
    ])
  })

  it('at a rebase-merges merge step, Use mine keeps the rewritten branch (git ours) and Use theirs the merged-in side', async () => {
    const conflicts: ConflictState = { ourBranch: null, theirLabel: 'side', mineSide: 'ours', files: [{ path: 'x.ts', kind: 'both_modified', markers: 1 }] }
    await mount(status([change('x.ts', 'conflicted')], 'rebase'), conflicts)
    fireEvent.click(button('Use mine', rowOf('x.ts')))
    await settle()
    git.setState(FOLDER, status([change('x.ts', 'conflicted')], 'rebase'))
    git.setConflicts(FOLDER, conflicts)
    await refresh()
    fireEvent.click(button('Use theirs (side)', rowOf('x.ts')))
    await settle()
    expect(callsOf('resolveWith').map((call) => call.request)).toEqual([
      { path: 'x.ts', side: 'ours' },
      { path: 'x.ts', side: 'theirs' }
    ])
  })

  it('forgets the files of an operation that ended, so the next one starts fresh', async () => {
    await mount(status([change('a.ts', 'conflicted')]), { ourBranch: 'main', theirLabel: 'one', mineSide: 'ours', files: [{ path: 'a.ts', kind: 'both_modified', markers: 1 }] })
    git.setState(FOLDER, status([], null))
    await refresh()
    expect(screen.queryByRole('list', { name: 'Conflicted files' })).toBeNull()
    git.setState(FOLDER, status([change('b.ts', 'conflicted'), change('a.ts')]))
    git.setConflicts(FOLDER, { ourBranch: 'main', theirLabel: 'two', mineSide: 'ours', files: [{ path: 'b.ts', kind: 'both_modified', markers: 1 }] })
    await refresh()
    expect(screen.getByText('Merging two into main: 1 conflicted file')).toBeTruthy()
    expect(within(conflictList()).queryByText('a.ts')).toBeNull()
    expect(screen.getByText('1 changed file')).toBeTruthy()
  })
})
