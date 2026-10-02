// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { boardImport, boardOpenEpic, EPIC_A, NO_BOARD } from '../__mocks__/fixtures'
import type { BoardImportView } from '../../../shared/domain/views'
import { BoardPreview } from './BoardPreview'
import { boardFound, importButtonLabel, newEpicCount } from './boardImport'

afterEach(cleanup)

function rowsOf(name: string): string[] {
  const group = screen.getByRole(name === 'Done epics' ? 'group' : 'region', { name })
  return within(group)
    .queryAllByRole('listitem')
    .map((item) => item.textContent ?? '')
}

describe('BoardPreview groups', () => {
  it('lists each open epic with its open tickets, the sub-tickets done on the board, its file and what an import does', () => {
    render(<BoardPreview view={boardImport()} />)
    expect(rowsOf('Open epics')).toEqual([
      '014Cross-host validation and releaseTo import2 open tickets · 1 done on the boardboard/in-progress/014-cross-host-release.md'
    ])
    expect(screen.getByRole('region', { name: 'Open epics' }).querySelector('.pill-ready')?.textContent).toBe('To import')
  })

  it('lists done epics as left in Git history and not imported', () => {
    render(<BoardPreview view={boardImport()} />)
    expect(screen.getByRole('group', { name: 'Done epics' }).querySelector('summary')?.textContent).toBe(
      'Done epics 2left in Git history, not imported'
    )
    expect(rowsOf('Done epics')).toEqual(['008Desktop experience mockups', '013Sprint checkpoints and recovery'])
  })

  it('keeps the done epics folded unless asked to show them', () => {
    render(<BoardPreview view={boardImport()} />)
    expect((screen.getByRole('group', { name: 'Done epics' }) as HTMLDetailsElement).open).toBe(false)
    cleanup()
    render(<BoardPreview view={boardImport()} doneExpanded />)
    expect((screen.getByRole('group', { name: 'Done epics' }) as HTMLDetailsElement).open).toBe(true)
  })

  it('lists skipped files with their reasons, or says none were skipped', () => {
    render(<BoardPreview view={boardImport()} />)
    expect(rowsOf('Skipped files')).toEqual(['board/backlog/notes.txt is not a Markdown file'])
    cleanup()
    render(<BoardPreview view={boardImport({ skipped: [] })} />)
    expect(within(screen.getByRole('region', { name: 'Skipped files' })).getByText('None: every file in board/ was read.')).toBeTruthy()
  })

  it('says when no epic is open', () => {
    render(<BoardPreview view={boardImport({ open: [] })} />)
    expect(within(screen.getByRole('region', { name: 'Open epics' })).getByText('None: every epic on the board is done.')).toBeTruthy()
  })
})

describe('BoardPreview after an import', () => {
  it('marks epics an import created or found and opens them', () => {
    const opened: string[] = []
    const view = boardImport({
      open: [
        boardOpenEpic({ state: 'created', epicId: EPIC_A }),
        boardOpenEpic({ boardId: '021', title: 'Standalone', kind: 'standalone', state: 'imported', epicId: 'ep_0000000000000000000000000b', doneTickets: [], ticketCount: 1, sourcePath: 'board/backlog/021-standalone.md' })
      ]
    })
    render(<BoardPreview view={view} onOpenEpic={(id) => opened.push(id)} />)
    const region = within(screen.getByRole('region', { name: 'Open epics' }))
    expect(region.getAllByText(/^(Imported now|Already imported)$/).map((pill) => pill.className)).toEqual([
      'pill pill-accepted',
      'pill pill-waiting'
    ])
    expect(region.getByText('1 open ticket')).toBeTruthy()
    fireEvent.click(region.getAllByRole('button', { name: 'Open epic' })[0] as HTMLElement)
    expect(opened).toEqual([EPIC_A])
  })

  it('names the ticket files of an epic without an epic file', () => {
    const orphan = boardOpenEpic({
      kind: 'orphan',
      sourcePath: null,
      sourcePaths: ['board/backlog/090.1-a.md', 'board/backlog/090.2-b.md'],
      doneTickets: []
    })
    render(<BoardPreview view={boardImport({ open: [orphan] })} />)
    expect(screen.getByText('2 ticket files, no epic file')).toBeTruthy()
  })
})
describe('board import helpers', () => {
  const imported = boardImport({ open: [boardOpenEpic({ state: 'imported', epicId: EPIC_A }), boardOpenEpic({ boardId: '021' })] })

  it('finds a board when it has any epic or skipped file', () => {
    expect(boardFound(NO_BOARD)).toBe(false)
    expect(boardFound({ ...NO_BOARD, skipped: [{ path: 'board', reason: 'is a link' }] })).toBe(true)
    expect(boardFound({ ...NO_BOARD, done: boardImport().done })).toBe(true)
  })

  it('counts the epics an import would create', () => {
    expect(newEpicCount(imported)).toBe(1)
    expect(newEpicCount(boardImport({ open: [] }))).toBe(0)
  })

  it('labels the import button with that count', () => {
    const views: BoardImportView[] = [imported, boardImport({ open: [boardOpenEpic(), boardOpenEpic({ boardId: '021' })] })]
    expect(views.map((view) => importButtonLabel(newEpicCount(view)))).toEqual([
      'Import 1 epic as a draft',
      'Import 2 epics as drafts'
    ])
  })
})
