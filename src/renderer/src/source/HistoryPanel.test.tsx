// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileDiff } from '../../../shared/git/diff'
import type { CommitSummary } from '../../../shared/git/history'
import type { RepoState } from '../../../shared/git/status'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeGit } from '../__mocks__/fakeGit'
import { folderView } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ToastProvider } from '../app/toasts'
import { SourceControlView } from './SourceControlView'

const FOLDER = '/work/alpha'
const OTHER = '/work/beta'
const HEAD = 'a'.repeat(40)

let git: FakeGit
let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  window.localStorage.clear()
  git = new FakeGit()
  writeText = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  window.git = git
  window.dm = new FakeDm()
})

afterEach(cleanup)

function repoState(folder: string, headOid: string | null = HEAD): RepoState {
  return { kind: 'repository', status: { root: folder, branch: { name: 'main', headOid, upstream: null, ahead: 0, behind: 0 }, files: [], inProgress: null } }
}

function commit(index: number, patch: Partial<CommitSummary> = {}): CommitSummary {
  const oid = index.toString(16).padStart(40, 'b')
  return {
    oid,
    shortOid: oid.slice(0, 7),
    parents: [],
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authoredAt: new Date(Date.now() - index * 3_600_000).toISOString(),
    summary: `Commit number ${index}`,
    body: '',
    unpushed: false,
    ...patch
  }
}

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

async function mount(folder = FOLDER): Promise<void> {
  const scheduler = new ManualScheduler()
  render(
    <ToastProvider scheduler={scheduler}>
      <SourceControlView folder={folderView({ path: folder, name: 'f' })} scheduler={scheduler} />
    </ToastProvider>
  )
  await settle()
}

async function openHistory(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'History' }))
  await settle()
}

describe('the Changes | History switcher', () => {
  it('opens on Changes, switches to History, and remembers the choice per folder', async () => {
    git.setState(FOLDER, repoState(FOLDER))
    git.setHistory(FOLDER, [commit(1)])
    await mount()
    const switcher = screen.getByRole('group', { name: 'Source control view' })
    expect(within(switcher).getByRole('button', { name: 'Changes' }).getAttribute('aria-pressed')).toBe('true')
    expect(git.calls.some((call) => call.method === 'getHistory')).toBe(false)
    await openHistory()
    expect(within(screen.getByRole('group', { name: 'Source control view' })).getByRole('button', { name: 'History' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('Commit number 1')).toBeTruthy()
    expect(JSON.parse(window.localStorage.getItem('dm.sourceTab') ?? '{}')).toEqual({ [FOLDER]: 'history' })
  })

  it('opens on the remembered choice of that folder only', async () => {
    window.localStorage.setItem('dm.sourceTab', JSON.stringify({ [FOLDER]: 'history' }))
    git.setState(FOLDER, repoState(FOLDER))
    git.setState(OTHER, repoState(OTHER))
    git.setHistory(FOLDER, [commit(1)])
    await mount(FOLDER)
    expect(screen.getByText('Commit number 1')).toBeTruthy()
    cleanup()
    await mount(OTHER)
    expect(screen.getByRole('button', { name: 'Changes' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('ignores a corrupt remembered choice', async () => {
    window.localStorage.setItem('dm.sourceTab', JSON.stringify({ [FOLDER]: 'bogus' }))
    git.setState(FOLDER, repoState(FOLDER))
    await mount()
    expect(screen.getByRole('button', { name: 'Changes' }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('the History list', () => {
  it('shows each commit with its summary, author, relative date and an unpushed marker', async () => {
    git.setState(FOLDER, repoState(FOLDER))
    git.setHistory(FOLDER, [commit(2, { unpushed: true }), commit(26)])
    await mount()
    await openHistory()
    const rows = within(screen.getByRole('list', { name: 'Commits' })).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByText('Commit number 2')).toBeTruthy()
    expect(within(rows[0] as HTMLElement).getByText(/Ada/)).toBeTruthy()
    expect(within(rows[0] as HTMLElement).getByText(/2h ago/)).toBeTruthy()
    expect(within(rows[0] as HTMLElement).getByLabelText('Not pushed')).toBeTruthy()
    expect(within(rows[1] as HTMLElement).queryByLabelText('Not pushed')).toBeNull()
    expect(within(rows[1] as HTMLElement).getByText(/1d 2h ago|1d ago/)).toBeTruthy()
  })

})

describe('the History list states', () => {
  it('says No commits yet on an unborn branch', async () => {
    git.setState(FOLDER, repoState(FOLDER, null))
    await mount()
    await openHistory()
    expect(screen.getAllByText('No commits yet').length).toBeGreaterThan(0)
    expect(screen.queryByRole('list', { name: 'Commits' })).toBeNull()
  })

  it('loads 100 commits, and 100 more when scrolled near the end, once', async () => {
    git.setState(FOLDER, repoState(FOLDER))
    git.setHistory(FOLDER, Array.from({ length: 150 }, (_, i) => commit(i + 1)))
    await mount()
    await openHistory()
    const requests = (): unknown[] => git.calls.filter((call) => call.method === 'getHistory').map((call) => call.request)
    expect(requests()).toEqual([{ skip: 0, limit: 100 }])
    const list = screen.getByTestId('commit-scroll')
    Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true })
    Object.defineProperty(list, 'scrollHeight', { value: 4000, configurable: true })
    list.scrollTop = 0
    fireEvent.scroll(list)
    await settle()
    expect(requests()).toHaveLength(1)
    list.scrollTop = 3500
    fireEvent.scroll(list)
    fireEvent.scroll(list)
    await settle()
    expect(requests()).toEqual([
      { skip: 0, limit: 100 },
      { skip: 100, limit: 100 }
    ])
    expect(within(screen.getByRole('list', { name: 'Commits' })).getAllByRole('listitem')).toHaveLength(150)
    fireEvent.scroll(list)
    await settle()
    expect(requests()).toHaveLength(2)
  })

  it('has a Copy SHA item in each commit menu', async () => {
    git.setState(FOLDER, repoState(FOLDER))
    const one = commit(1)
    git.setHistory(FOLDER, [one])
    await mount()
    await openHistory()
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${one.summary}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy SHA' }))
    await settle()
    expect(writeText).toHaveBeenCalledWith(one.oid)
  })
})

async function select(): Promise<CommitSummary> {
  const one = commit(1, { body: 'Why it changed.\nSecond line.', parents: ['c'.repeat(40)] })
  git.setState(FOLDER, repoState(FOLDER))
  git.setHistory(FOLDER, [one, commit(2)])
  git.setCommitFiles(FOLDER, one.oid, [
    { path: 'src/new.ts', oldPath: 'src/old.ts', kind: 'renamed' },
    { path: 'README.md', oldPath: null, kind: 'modified' }
  ])
  git.setCommitDiff(FOLDER, one.oid, 'src/new.ts', textDiff('src/new.ts', 'renamed line'))
  git.setCommitDiff(FOLDER, one.oid, 'README.md', textDiff('README.md', 'readme line'))
  await mount()
  await openHistory()
  fireEvent.click(screen.getByRole('button', { name: /^Commit number 1/ }))
  await settle()
  return one
}

describe('a selected commit', () => {
  it('shows its message, author, date, full SHA and files', async () => {
    const one = await select()
    const detail = screen.getByLabelText('Commit')
    expect(within(detail).getByRole('heading', { name: 'Commit number 1' })).toBeTruthy()
    expect(within(detail).getByText(/Why it changed\./).textContent).toContain('Second line.')
    expect(within(detail).getByText(/Ada/)).toBeTruthy()
    expect(within(detail).getByText(one.oid)).toBeTruthy()
    expect(within(detail).getByText('new.ts')).toBeTruthy()
    expect(within(detail).getByText('src/old.ts')).toBeTruthy()
    expect(within(detail).getByText('README.md')).toBeTruthy()
    expect(git.calls.filter((call) => call.method === 'getCommitFiles').map((call) => call.oid)).toEqual([one.oid])
  })

  it('copies the full SHA', async () => {
    const one = await select()
    fireEvent.click(within(screen.getByLabelText('Commit')).getByRole('button', { name: 'Copy' }))
    await settle()
    expect(writeText).toHaveBeenCalledWith(one.oid)
  })

  it('shows the diff of a selected file, renamed files included', async () => {
    const one = await select()
    fireEvent.click(screen.getByRole('button', { name: /src\/new\.ts/ }))
    await settle()
    expect(screen.getByText('renamed line')).toBeTruthy()
    expect(git.calls.filter((call) => call.method === 'getCommitDiff').map((call) => call.request)).toEqual([
      { oid: one.oid, path: 'src/new.ts', oldPath: 'src/old.ts', force: false }
    ])
    fireEvent.click(screen.getByRole('button', { name: /README\.md/ }))
    await settle()
    expect(screen.getByText('readme line')).toBeTruthy()
  })

  it('clears the file when another commit is selected', async () => {
    await select()
    fireEvent.click(screen.getByRole('button', { name: /README\.md/ }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Commit number 2/ }))
    await settle()
    expect(screen.queryByText('readme line')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Commit number 2' })).toBeTruthy()
  })

  it('reports a failed history read', async () => {
    git.setState(FOLDER, repoState(FOLDER))
    git.getHistory = () => Promise.resolve({ ok: false, error: { code: 'git_failed', message: 'boom' } })
    await mount()
    await openHistory()
    expect(screen.getByRole('alert').textContent).toContain('boom')
  })
})
