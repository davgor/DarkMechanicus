// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deferred } from '../__mocks__/deferred'
import { FakeDm } from '../__mocks__/fakeDm'
import { boardRemoval, folderView } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import type { BoardRemovalResultView } from '../../../shared/domain/views'
import { ToastProvider } from '../app/toasts'
import { BoardRemoval } from './BoardRemoval'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  dm.boardRemoval = boardRemoval()
})

afterEach(cleanup)

const folder = folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })

function renderRemoval(): BoardRemovalResultView[] {
  const removed: BoardRemovalResultView[] = []
  render(
    <ToastProvider scheduler={new ManualScheduler()}>
      <BoardRemoval folder={folder} onRemoved={(result) => removed.push(result)} />
    </ToastProvider>
  )
  return removed
}

const section = (): HTMLElement => screen.getByRole('region', { name: 'Remove the old board workflow' })

async function review(): Promise<void> {
  fireEvent.click(within(section()).getByRole('button', { name: 'Review files to remove' }))
  await settle()
}

/** Every path a "Will be deleted" list shows, folder and file name joined back together. */
function listedPaths(): string[] {
  const list = within(section()).getByRole('region', { name: 'Files to delete' })
  return Array.from(list.querySelectorAll('.removal-group')).flatMap((group) => {
    const dir = group.querySelector('.removal-folder')?.textContent ?? ''
    return Array.from(group.querySelectorAll('.removal-file')).map((file) => `${dir}${file.textContent ?? ''}`)
  })
}

describe('BoardRemoval offer', () => {
  it('explains what can go and reads nothing until asked', async () => {
    renderRemoval()
    await settle()
    expect(within(section()).getByText(/the board-only skills/)).toBeTruthy()
    expect(within(section()).getByText(/nothing is committed/)).toBeTruthy()
    expect(dm.calls).not.toContain('previewBoardRemoval')
  })

  it('lists every file it will delete, grouped by folder, and deletes nothing yet', async () => {
    renderRemoval()
    await review()
    expect(dm.calls).toContain('previewBoardRemoval')
    expect(listedPaths()).toEqual(boardRemoval().remove)
    expect(within(section()).getByText('board/done/')).toBeTruthy()
    expect(within(section()).getByRole('heading', { name: 'Will be deleted 5' })).toBeTruthy()
    expect(dm.boardRemovals).toEqual([])
  })

})

describe('BoardRemoval review lists', () => {
  it('lists files that still mention the board for editing by hand, with their lines, apart from the deletions', async () => {
    renderRemoval()
    await review()
    const byHand = within(section()).getByRole('region', { name: 'Still mentions the board, edit by hand' })
    expect(within(byHand).getByText('README.md')).toBeTruthy()
    expect(within(byHand).getByText('lines 29, 37, 39, 40, 41')).toBeTruthy()
    expect(within(byHand).getByText('.ai-instructions.md')).toBeTruthy()
    expect(within(byHand).getByText('line 52')).toBeTruthy()
    expect(within(byHand).getByText(/never deleted/)).toBeTruthy()
    expect(listedPaths()).not.toContain('README.md')
  })

  it('lists what it leaves in place, and why', async () => {
    renderRemoval()
    await review()
    const kept = within(section()).getByRole('region', { name: 'Left in place' })
    expect(within(kept).getByText('.cursor/skills/collapse-epic')).toBeTruthy()
    expect(within(kept).getByText('its SKILL.md does not refer to the board')).toBeTruthy()
  })

  it('says there is nothing to delete, and offers no deletion, when no file is left', async () => {
    dm.boardRemoval = boardRemoval({ remove: [], kept: [] })
    renderRemoval()
    await review()
    expect(within(section()).getByText(/Nothing to delete/)).toBeTruthy()
    expect(within(section()).queryByRole('button', { name: /^Delete/ })).toBeNull()
    expect(within(section()).getByRole('region', { name: 'Still mentions the board, edit by hand' })).toBeTruthy()
  })

  it('goes back to the offer when the list could not be read', async () => {
    dm.rejects.previewBoardRemoval = 'Repository folder not found'
    renderRemoval()
    await review()
    expect(within(section()).getByRole('button', { name: 'Review files to remove' })).toBeTruthy()
    expect(screen.getByText('Repository folder not found')).toBeTruthy()
  })
})

describe('BoardRemoval confirmation', () => {
  it('asks before deleting, saying Git history keeps only committed files, and Cancel deletes nothing', async () => {
    renderRemoval()
    await review()
    fireEvent.click(within(section()).getByRole('button', { name: 'Delete 5 files…' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete 5 files?' })
    expect(within(dialog).getByText(/can be recovered from Git history only if they were committed/)).toBeTruthy()
    expect(within(dialog).getByText('~/code/alpha')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep them' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await settle()
    expect(dm.boardRemovals).toEqual([])
    expect(listedPaths()).toEqual(boardRemoval().remove)
  })

  it('deletes exactly the listed files once confirmed, then shows what it did', async () => {
    dm.boardRemovalResult = {
      removed: boardRemoval().remove,
      removedFolders: ['board/backlog', 'board/done', 'board/in-progress', 'board', '.claude/skills/complete-ticket'],
      kept: boardRemoval().kept,
      editByHand: boardRemoval().editByHand
    }
    const removed = renderRemoval()
    await review()
    fireEvent.click(within(section()).getByRole('button', { name: 'Delete 5 files…' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete 5 files' }))
    await settle()

    expect(dm.boardRemovals).toEqual([{ folder: '/a', paths: boardRemoval().remove }])
    expect(removed).toHaveLength(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(section()).getByText(/Removed 5 files and 5 folders\./)).toBeTruthy()
    expect(within(section()).getByText(/Nothing was committed/)).toBeTruthy()
    expect(within(section()).getByRole('region', { name: 'Still mentions the board, edit by hand' })).toBeTruthy()
    expect(within(section()).getByRole('region', { name: 'Left in place' })).toBeTruthy()
    expect(within(section()).queryByRole('button', { name: /^Delete/ })).toBeNull()
    expect(screen.getByText('Removed 5 files of the old board workflow. Nothing was committed.')).toBeTruthy()
  })

})

describe('BoardRemoval deletion', () => {
  it('shows the deletion as working until it finishes', async () => {
    dm.removalHold = deferred()
    renderRemoval()
    await review()
    fireEvent.click(within(section()).getByRole('button', { name: 'Delete 5 files…' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete 5 files' }))
    await settle()
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete 5 files' }).getAttribute('aria-busy')).toBe('true')
    dm.removalHold.resolve()
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports a refused deletion and keeps the list for another try', async () => {
    dm.rejects.removeBoardFiles = 'Import the board first: 1 open epic on it has not been imported yet.'
    const removed = renderRemoval()
    await review()
    fireEvent.click(within(section()).getByRole('button', { name: 'Delete 5 files…' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete 5 files' }))
    await settle()

    expect(removed).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Import the board first: 1 open epic on it has not been imported yet.')).toBeTruthy()
    expect(within(section()).getByRole('button', { name: 'Delete 5 files…' })).toBeTruthy()
  })
})
