// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CommitRequest, GitResult } from '../../../shared/git/api'
import type { DiffLine, FileDiff } from '../../../shared/git/diff'
import type { FileChange, RepoState } from '../../../shared/git/status'
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
const HEAD = 'a'.repeat(40)
const RESET = 'a.ts changed, so its line selection was reset'

let git: FakeGit
let scheduler: ManualScheduler

beforeEach(() => {
  window.localStorage.clear()
  git = new FakeGit()
  scheduler = new ManualScheduler()
  window.git = git
  window.dm = new FakeDm()
  window.github = new FakeGithub()
})

afterEach(cleanup)

const change = (path: string): FileChange => ({ path, oldPath: null, kind: 'modified' })

function state(files: FileChange[]): RepoState {
  return {
    kind: 'repository',
    status: { root: FOLDER, branch: { name: 'main', headOid: HEAD, upstream: null, ahead: 0, behind: 0 }, files, inProgress: null, lastFetchedAt: null, remote: null }
  }
}

const added = (text: string, number: number): DiffLine => ({ kind: 'add', text, oldNumber: null, newNumber: number, noNewlineAtEnd: false })

/** Three added lines over two hunks: changed lines 0 and 1 in the first, 2 in the second. */
function diffOf(path: string, hash: string, word = 'line'): FileDiff {
  return {
    path,
    oldPath: null,
    oldMode: null,
    newMode: null,
    hash,
    kind: 'text',
    hunks: [
      { header: '@@ -0,0 +1,2 @@', oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: [added(`${word} 1`, 1), added(`${word} 2`, 2)] },
      { header: '@@ -8,0 +10,1 @@', oldStart: 8, oldLines: 0, newStart: 10, newLines: 1, lines: [added(`${word} 10`, 10)] }
    ]
  }
}

async function mount(): Promise<void> {
  git.setState(FOLDER, state([change('a.ts'), change('b.ts')]))
  git.setDiff(FOLDER, 'a.ts', diffOf('a.ts', 'h1'))
  git.setDiff(FOLDER, 'b.ts', diffOf('b.ts', 'hb', 'beta'))
  render(
    <ToastProvider scheduler={scheduler}>
      <GithubAccountProvider>
        <SourceControlView folder={folderView({ path: FOLDER, name: 'alpha' })} scheduler={scheduler} />
      </GithubAccountProvider>
    </ToastProvider>
  )
  await settle()
}

async function open(path: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${path.replace('.', '\\.')}`) }))
  await settle()
}

async function refresh(): Promise<void> {
  act(() => scheduler.fireIntervals(5000))
  await settle()
}

function toggleLine(name: string): void {
  fireEvent.mouseDown(screen.getByRole('checkbox', { name }))
  fireEvent.mouseUp(window)
}

const box = (path: string): HTMLInputElement => screen.getByRole('checkbox', { name: `Include ${path}` }) as HTMLInputElement
const header = (): HTMLInputElement => screen.getByRole('checkbox', { name: /changed files?$/ }) as HTMLInputElement
const lineState = (name: string): string | null => screen.getByRole('checkbox', { name }).getAttribute('aria-checked')
const commitButton = (): HTMLButtonElement => screen.getByRole('button', { name: /^Commit to/ }) as HTMLButtonElement
const commitRequests = (): CommitRequest[] => git.calls.filter((call) => call.method === 'commit').map((call) => call.request as CommitRequest)

async function commit(): Promise<void> {
  fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'Part of it' } })
  await settle()
  fireEvent.click(commitButton())
  await settle()
}

describe('the file checkbox with chosen lines', () => {
  it('is indeterminate when only some lines are included, with the header too', async () => {
    await mount()
    await open('a.ts')
    toggleLine('Include added line 2')
    expect(lineState('Include added line 2')).toBe('false')
    expect(box('a.ts').indeterminate).toBe(true)
    expect(box('a.ts').checked).toBe(false)
    expect(header().indeterminate).toBe(true)
    expect(screen.getByText('2 changed files')).toBeTruthy()
  })

  it('toggles all, then none, from the indeterminate state', async () => {
    await mount()
    await open('a.ts')
    toggleLine('Include added line 10')
    fireEvent.click(box('a.ts'))
    expect(box('a.ts').indeterminate).toBe(false)
    expect(box('a.ts').checked).toBe(true)
    expect(['1', '2', '10'].map((n) => lineState(`Include added line ${n}`))).toEqual(['true', 'true', 'true'])
    fireEvent.click(box('a.ts'))
    expect(box('a.ts').checked).toBe(false)
    expect(['1', '2', '10'].map((n) => lineState(`Include added line ${n}`))).toEqual(['false', 'false', 'false'])
    expect(document.querySelectorAll('.diff-excluded')).toHaveLength(3)
  })

  it('becomes unchecked when the last line is left out and checked when every line is back', async () => {
    await mount()
    await open('a.ts')
    toggleLine('Include hunk @@ -0,0 +1,2 @@')
    toggleLine('Include added line 10')
    expect(box('a.ts').checked).toBe(false)
    expect(box('a.ts').indeterminate).toBe(false)
    toggleLine('Include hunk @@ -8,0 +10,1 @@')
    expect(box('a.ts').indeterminate).toBe(true)
    toggleLine('Include hunk @@ -0,0 +1,2 @@')
    expect(box('a.ts').checked).toBe(true)
    expect(box('a.ts').indeterminate).toBe(false)
  })
})

describe('committing chosen lines', () => {
  it('sends the chosen lines with the diff hash, keeps the commit button enabled, and whole files as before', async () => {
    await mount()
    await open('a.ts')
    toggleLine('Include added line 2')
    fireEvent.click(box('b.ts'))
    await commit()
    expect(commitRequests()).toEqual([{ summary: 'Part of it', description: '', files: [{ path: 'a.ts', oldPath: null, lines: [0, 2], diffHash: 'h1' }] }])
  })

  it('can commit when the only included file is partly included', async () => {
    await mount()
    await open('a.ts')
    fireEvent.click(box('b.ts'))
    toggleLine('Include added line 1')
    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'x' } })
    await settle()
    expect(commitButton().disabled).toBe(false)
  })

  it('starts over from all lines after a commit, without the reset toast', async () => {
    await mount()
    await open('a.ts')
    toggleLine('Include added line 2')
    await commit()
    git.setDiff(FOLDER, 'a.ts', diffOf('a.ts', 'h2', 'left'))
    await refresh()
    expect(box('a.ts').checked).toBe(true)
    expect(box('a.ts').indeterminate).toBe(false)
    expect(screen.queryByText(RESET)).toBeNull()
  })
})

describe('a file that changes under its chosen lines', () => {
  it('keeps the chosen lines while the diff hash stays the same', async () => {
    await mount()
    await open('a.ts')
    toggleLine('Include added line 2')
    await refresh()
    expect(box('a.ts').indeterminate).toBe(true)
    expect(lineState('Include added line 2')).toBe('false')
    expect(screen.queryByText(RESET)).toBeNull()
  })

  it('resets the shown file to all lines with a toast when its hash changes', async () => {
    await mount()
    await open('a.ts')
    toggleLine('Include added line 2')
    git.setDiff(FOLDER, 'a.ts', diffOf('a.ts', 'h2', 'new'))
    await refresh()
    expect(screen.getByText('new 2')).toBeTruthy()
    expect(lineState('Include added line 2')).toBe('true')
    expect(box('a.ts').checked).toBe(true)
    expect(box('a.ts').indeterminate).toBe(false)
    expect(screen.getAllByText(RESET)).toHaveLength(1)
  })

  it('resets a file that is not shown when its hash changes', async () => {
    await mount()
    await open('a.ts')
    toggleLine('Include added line 2')
    await open('b.ts')
    expect(box('a.ts').indeterminate).toBe(true)
    git.setDiff(FOLDER, 'a.ts', diffOf('a.ts', 'h2'))
    await refresh()
    expect(box('a.ts').indeterminate).toBe(false)
    expect(box('a.ts').checked).toBe(true)
    expect(screen.getAllByText(RESET)).toHaveLength(1)
  })
})

describe('stale_selection', () => {
  it('refreshes the diff and resets the file with the same toast, committing nothing', async () => {
    await mount()
    await open('a.ts')
    toggleLine('Include added line 2')
    git.setDiff(FOLDER, 'a.ts', diffOf('a.ts', 'h2', 'edited'))
    await commit()
    expect(commitRequests()).toHaveLength(1)
    expect(screen.getAllByText(RESET)).toHaveLength(1)
    expect(screen.getByText('edited 2')).toBeTruthy()
    expect(box('a.ts').checked).toBe(true)
    expect(box('a.ts').indeterminate).toBe(false)
    expect(screen.queryByText(/changed after its lines were chosen/)).toBeNull()
    expect((screen.getByLabelText('Summary') as HTMLInputElement).value).toBe('Part of it')
  })

  it('shows the refusal inline when no chosen file turns out to have changed', async () => {
    await mount()
    await open('a.ts')
    toggleLine('Include added line 2')
    const refusal: GitResult<{ oid: string }> = { ok: false, error: { code: 'stale_selection', message: 'a.ts changed after its lines were chosen. Choose them again.' } }
    git.commit = () => Promise.resolve(refusal)
    await commit()
    expect(screen.getByRole('alert').textContent).toContain('changed after its lines were chosen')
    expect(screen.queryByText(RESET)).toBeNull()
  })
})
