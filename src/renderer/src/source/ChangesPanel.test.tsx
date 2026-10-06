// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GitResult } from '../../../shared/git/api'
import type { FileChange, RepoState, RepoStatus } from '../../../shared/git/status'
import { ToastProvider } from '../app/toasts'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeGit } from '../__mocks__/fakeGit'
import { folderView } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { SourceControlView } from './SourceControlView'

const FOLDER = '/work/alpha'
const HEAD = 'a'.repeat(40)
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

const change = (path: string, kind: FileChange['kind'] = 'modified'): FileChange => ({ path, oldPath: null, kind })

function status(files: FileChange[], patch: Partial<RepoStatus['branch']> = {}): RepoState {
  return {
    kind: 'repository',
    status: {
      root: FOLDER,
      branch: { name: 'main', headOid: HEAD, upstream: null, ahead: 0, behind: 0, ...patch },
      files,
      inProgress: null
    }
  }
}

async function mount(files: FileChange[] = [change('a.ts'), change('b.ts'), change('new.txt', 'untracked')]): Promise<void> {
  git.setState(FOLDER, status(files))
  render(
    <ToastProvider scheduler={scheduler}>
      <SourceControlView folder={folder} scheduler={scheduler} />
    </ToastProvider>
  )
  await settle()
}

async function refreshWith(state: RepoState): Promise<void> {
  git.setState(FOLDER, state)
  act(() => scheduler.fireIntervals(5000))
  await settle()
}

const box = (name: string): HTMLInputElement => screen.getByRole('checkbox', { name }) as HTMLInputElement
const header = (): HTMLInputElement => screen.getByRole('checkbox', { name: /changed files?$/ }) as HTMLInputElement
const commitCalls = (): FakeGit['calls'] => git.calls.filter((call) => call.method === 'commit')
const commitButton = (): HTMLButtonElement => screen.getByRole('button', { name: /^Commit to/ }) as HTMLButtonElement

async function type(label: string, value: string): Promise<void> {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
  await settle()
}

async function commitOne(oid = 'c'.repeat(40)): Promise<void> {
  git.commit = () => Promise.resolve({ ok: true, data: { oid } })
  await type('Summary', 'Ship it')
  await type('Description', 'Details here')
  fireEvent.click(commitButton())
  await settle()
}

describe('inclusion', () => {
  it('includes every file by default, new files too, and counts them in the header', async () => {
    await mount()
    expect(box('Include a.ts').checked).toBe(true)
    expect(box('Include b.ts').checked).toBe(true)
    expect(box('Include new.txt').checked).toBe(true)
    expect(header().checked).toBe(true)
    expect(screen.getByText('3 changed files')).toBeTruthy()
  })

  it('says 1 changed file in the singular', async () => {
    await mount([change('a.ts')])
    expect(screen.getByText('1 changed file')).toBeTruthy()
  })

  it('shows some as indeterminate and toggles all from the header', async () => {
    await mount()
    fireEvent.click(box('Include b.ts'))
    expect(box('Include b.ts').checked).toBe(false)
    expect(header().checked).toBe(false)
    expect(header().indeterminate).toBe(true)
    fireEvent.click(header())
    expect(header().indeterminate).toBe(false)
    expect(box('Include a.ts').checked).toBe(true)
    expect(box('Include b.ts').checked).toBe(true)
    fireEvent.click(header())
    expect(header().checked).toBe(false)
    expect(header().indeterminate).toBe(false)
    expect(box('Include a.ts').checked).toBe(false)
    expect(box('Include new.txt').checked).toBe(false)
  })

  it('survives a refresh, includes new files and drops files that disappear', async () => {
    await mount()
    fireEvent.click(box('Include b.ts'))
    await refreshWith(status([change('a.ts'), change('b.ts'), change('c.ts', 'untracked')]))
    expect(box('Include b.ts').checked).toBe(false)
    expect(box('Include c.ts').checked).toBe(true)
    await refreshWith(status([change('a.ts')]))
    await refreshWith(status([change('a.ts'), change('b.ts')]))
    expect(box('Include b.ts').checked).toBe(true)
  })

  it('selecting a row does not change its inclusion', async () => {
    await mount()
    fireEvent.click(box('Include a.ts'))
    fireEvent.click(screen.getByRole('button', { name: /a\.ts/ }))
    expect(box('Include a.ts').checked).toBe(false)
  })
})

describe('commit box', () => {
  it('is disabled without a summary or without an included file', async () => {
    await mount()
    expect(commitButton().disabled).toBe(true)
    expect(commitButton().textContent).toBe('Commit to main')
    await type('Summary', 'Fix it')
    expect(commitButton().disabled).toBe(false)
    fireEvent.click(header())
    expect(commitButton().disabled).toBe(true)
    fireEvent.keyDown(screen.getByLabelText('Summary'), { key: 'Enter', ctrlKey: true })
    await settle()
    expect(commitCalls()).toHaveLength(0)
  })

  it('treats a blank summary as no summary', async () => {
    await mount()
    await type('Summary', '   ')
    expect(commitButton().disabled).toBe(true)
  })

  it('warns when the summary passes 72 characters', async () => {
    await mount()
    await type('Summary', 'x'.repeat(72))
    expect(screen.queryByText(/72 characters/)).toBeNull()
    await type('Summary', 'x'.repeat(73))
    expect(screen.getByText(/72 characters/)).toBeTruthy()
  })

})

describe('commit', () => {
  it('commits only the included files with the message, then clears the box, refreshes and toasts', async () => {
    await mount()
    fireEvent.click(box('Include b.ts'))
    await type('Summary', 'Add things')
    await type('Description', 'Because.')
    const before = git.calls.filter((call) => call.method === 'getState').length
    fireEvent.click(commitButton())
    await settle()
    expect(commitCalls()).toEqual([
      {
        method: 'commit',
        folder: FOLDER,
        request: { summary: 'Add things', description: 'Because.', files: [{ path: 'a.ts', oldPath: null }, { path: 'new.txt', oldPath: null }] }
      }
    ])
    expect((screen.getByLabelText('Summary') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('')
    expect(git.calls.filter((call) => call.method === 'getState').length).toBeGreaterThan(before)
    expect(screen.getByText(/Committed fake-oi/)).toBeTruthy()
  })

  it('commits with Ctrl+Enter and with Cmd+Enter, but not with Enter alone', async () => {
    await mount()
    await type('Summary', 'One')
    fireEvent.keyDown(screen.getByLabelText('Summary'), { key: 'Enter', ctrlKey: true })
    await settle()
    expect(commitCalls()).toHaveLength(1)
    await type('Summary', 'Two')
    fireEvent.keyDown(screen.getByLabelText('Description'), { key: 'Enter', metaKey: true })
    await settle()
    expect(commitCalls()).toHaveLength(2)
    await type('Summary', 'Three')
    fireEvent.keyDown(screen.getByLabelText('Summary'), { key: 'Enter' })
    await settle()
    expect(commitCalls()).toHaveLength(2)
  })

})

describe('commit states', () => {
  it('is busy while committing', async () => {
    await mount()
    let release: (result: GitResult<{ oid: string }>) => void = () => undefined
    git.commit = () => new Promise((resolve) => { release = resolve })
    await type('Summary', 'Slow')
    fireEvent.click(commitButton())
    await settle()
    expect(commitButton().disabled).toBe(true)
    expect(commitButton().getAttribute('aria-busy')).toBe('true')
    await act(async () => release({ ok: true, data: { oid: 'd'.repeat(40) } }))
    await settle()
    expect(commitButton().getAttribute('aria-busy')).toBeNull()
  })

  it('shows a failure inline with the detail from git, and keeps the message', async () => {
    await mount()
    git.commit = () => Promise.resolve({ ok: false, error: { code: 'git_failed', message: 'Git could not commit.', detail: 'hook rejected the commit' } })
    await type('Summary', 'Nope')
    fireEvent.click(commitButton())
    await settle()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Git could not commit.')
    expect(within(alert).getByText('Details').closest('details')).toBeTruthy()
    expect(alert.textContent).toContain('hook rejected the commit')
    expect((screen.getByLabelText('Summary') as HTMLInputElement).value).toBe('Nope')
  })
})

describe('discard', () => {
  const rowOf = (name: string): HTMLElement => screen.getByText(name).closest('li') as HTMLElement
  const openRowMenu = (name: string): void => {
    fireEvent.click(within(rowOf(name)).getByRole('button', { name: 'File actions' }))
  }
  const discardCalls = (): FakeGit['calls'] => git.calls.filter((call) => call.method === 'discardChanges')

  it('asks first, naming the file and the Recycle Bin, and Cancel discards nothing', async () => {
    await mount()
    openRowMenu('b.ts')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Discard changes…' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('b.ts')).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('These changes will be moved to the Recycle Bin')
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(discardCalls()).toHaveLength(0)
  })

  it('discards the one file and refreshes the list', async () => {
    await mount()
    openRowMenu('b.ts')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Discard changes…' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard changes' }))
    await settle()
    expect(discardCalls()).toEqual([{ method: 'discardChanges', folder: FOLDER, request: { files: [change('b.ts')] } }])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('b.ts')).toBeNull()
    expect(screen.getByText('2 changed files')).toBeTruthy()
  })

})

describe('discard all and extras', () => {
  const rowOf = (name: string): HTMLElement => screen.getByText(name).closest('li') as HTMLElement
  const openRowMenu = (name: string): void => {
    fireEvent.click(within(rowOf(name)).getByRole('button', { name: 'File actions' }))
  }
  const discardCalls = (): FakeGit['calls'] => git.calls.filter((call) => call.method === 'discardChanges')

  it('discards all changes from the header menu', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Changes actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Discard all changes…' }))
    const dialog = within(screen.getByRole('dialog'))
    for (const name of ['a.ts', 'b.ts', 'new.txt']) {
      expect(dialog.getByText(name)).toBeTruthy()
    }
    fireEvent.click(dialog.getByRole('button', { name: 'Discard changes' }))
    await settle()
    const request = discardCalls().map((call) => call.request)[0]
    expect(request).toEqual({ files: [change('a.ts'), change('b.ts'), change('new.txt', 'untracked')] })
    expect(screen.getByText('0 changed files')).toBeTruthy()
  })

  it('says Trash on a Mac', async () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    try {
      await mount()
      openRowMenu('a.ts')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Discard changes…' }))
      expect(screen.getByRole('dialog').textContent).toContain('moved to the Trash')
    } finally {
      Reflect.deleteProperty(navigator, 'platform')
    }
  })

  it('shows a refusal in the dialog and keeps it open', async () => {
    await mount()
    git.discardChanges = () => Promise.resolve({ ok: false, error: { code: 'invalid_input', message: 'Resolve the conflict first.' } })
    openRowMenu('a.ts')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Discard changes…' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard changes' }))
    await settle()
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain('Resolve the conflict first.')
  })

  it('copies the file path', async () => {
    await mount()
    openRowMenu('a.ts')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy file path' }))
    await settle()
    expect(dm.copied).toEqual(['a.ts'])
  })
})

describe('undo strip', () => {
  it('offers Undo with the summary of the commit just made', async () => {
    await mount()
    expect(screen.queryByText(/Committed just now/)).toBeNull()
    await commitOne()
    expect(screen.getByText('Committed just now: Ship it')).toBeTruthy()
  })

  it('undoes, refills the summary and description and refreshes', async () => {
    await mount()
    await commitOne()
    git.undoneMessage = { summary: 'Ship it', description: 'Details here' }
    const before = git.calls.filter((call) => call.method === 'getState').length
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await settle()
    expect(git.calls.filter((call) => call.method === 'undoLastCommit')).toHaveLength(1)
    expect((screen.getByLabelText('Summary') as HTMLInputElement).value).toBe('Ship it')
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Details here')
    expect(screen.queryByText(/Committed just now/)).toBeNull()
    expect(git.calls.filter((call) => call.method === 'getState').length).toBeGreaterThan(before)
  })

  it('shows a refusal from Undo and keeps the strip', async () => {
    await mount()
    await commitOne()
    git.undoLastCommit = () => Promise.resolve({ ok: false, error: { code: 'invalid_input', message: 'That commit was already pushed.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('already pushed')
    expect(screen.getByText(/Committed just now/)).toBeTruthy()
  })
})

describe('undo strip lifetime', () => {
  it('stays while HEAD is that commit, and goes when HEAD moves on', async () => {
    await mount()
    await commitOne()
    await refreshWith(status([change('b.ts')], { headOid: 'c'.repeat(40) }))
    expect(screen.getByText(/Committed just now/)).toBeTruthy()
    await refreshWith(status([change('b.ts')], { headOid: 'e'.repeat(40) }))
    expect(screen.queryByText(/Committed just now/)).toBeNull()
  })

  it('goes once the commit is pushed', async () => {
    await mount()
    await commitOne()
    await refreshWith(status([], { headOid: 'c'.repeat(40), upstream: 'origin/main', ahead: 1 }))
    expect(screen.getByText(/Committed just now/)).toBeTruthy()
    await refreshWith(status([], { headOid: 'c'.repeat(40), upstream: 'origin/main', ahead: 0 }))
    expect(screen.queryByText(/Committed just now/)).toBeNull()
  })
})
