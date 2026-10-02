// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { boardImport, boardOpenEpic, EPIC_A, folderView, NO_BOARD } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import type { BoardImportView } from '../../../shared/domain/views'
import { ToastProvider } from '../app/toasts'
import { BoardImportCard } from './BoardImportCard'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

const folder = folderView({ path: '/a', name: 'alpha' })

interface Calls {
  imports: number
  opened: string[]
}

function renderCard(answer: () => Promise<BoardImportView | null>, version = 1): Calls {
  const calls: Calls = { imports: 0, opened: [] }
  const card = (current: number): JSX.Element => (
    <ToastProvider scheduler={new ManualScheduler()}>
      <BoardImportCard
        folder={folder}
        version={current}
        onImport={() => {
          calls.imports += 1
          return answer()
        }}
        onOpenEpic={(id) => calls.opened.push(id)}
      />
    </ToastProvider>
  )
  const { rerender } = render(card(version))
  rerenderCard = (next) => rerender(card(next))
  return calls
}

let rerenderCard: (version: number) => void = () => undefined

const card = (): HTMLElement => screen.getByRole('region', { name: 'Old-style board' })

describe('BoardImportCard preview', () => {
  it('shows nothing for a repository without an old board', async () => {
    dm.responses.previewBoardImport = NO_BOARD
    renderCard(() => Promise.resolve(null))
    await settle()
    expect(dm.callsOf('previewBoardImport').map((call) => call.folder)).toEqual(['/a'])
    expect(screen.queryByRole('region', { name: 'Old-style board' })).toBeNull()
  })

  it('previews the board and offers to import its new epics, saying what an import does', async () => {
    dm.responses.previewBoardImport = boardImport()
    renderCard(() => Promise.resolve(null))
    await settle()
    expect(within(card()).getByRole('region', { name: 'Open epics' })).toBeTruthy()
    expect(within(card()).getByRole('group', { name: 'Done epics' })).toBeTruthy()
    expect(within(card()).getByRole('region', { name: 'Skipped files' })).toBeTruthy()
    expect(within(card()).getByText(/as Backlog epics whose plans stay drafts until you review them and press Save/)).toBeTruthy()
    expect(within(card()).getByRole('button', { name: 'Import 1 epic as a draft' })).toBeTruthy()
  })

  it('says nothing new would be imported once every open epic was imported before', async () => {
    dm.responses.previewBoardImport = boardImport({ open: [boardOpenEpic({ state: 'imported', epicId: EPIC_A })] })
    renderCard(() => Promise.resolve(null))
    await settle()
    expect(within(card()).getByText('Already imported')).toBeTruthy()
    expect(within(card()).getByText('Nothing new to import: every open epic on the board has been imported.')).toBeTruthy()
    expect(within(card()).queryByRole('button', { name: /^Import / })).toBeNull()
  })

  it('reads the board again when the folder changes', async () => {
    dm.responses.previewBoardImport = boardImport()
    renderCard(() => Promise.resolve(null), 1)
    await settle()
    dm.responses.previewBoardImport = boardImport({ open: [boardOpenEpic({ state: 'imported', epicId: EPIC_A })] })
    rerenderCard(2)
    await settle()
    expect(dm.callsOf('previewBoardImport')).toHaveLength(2)
    expect(within(card()).getByText('Already imported')).toBeTruthy()
  })
})

describe('BoardImportCard import', () => {
  it('imports on request and shows what was created, with a way to open it', async () => {
    dm.responses.previewBoardImport = boardImport()
    const result = boardImport({ open: [boardOpenEpic({ state: 'created', epicId: EPIC_A })] })
    const calls = renderCard(() => Promise.resolve(result))
    await settle()
    fireEvent.click(within(card()).getByRole('button', { name: 'Import 1 epic as a draft' }))
    await settle()
    expect(calls.imports).toBe(1)
    expect(within(card()).getByText('Imported now')).toBeTruthy()
    expect(within(card()).queryByRole('button', { name: /^Import / })).toBeNull()
    expect(within(card()).getByText('Nothing new to import: every open epic on the board has been imported.')).toBeTruthy()
    fireEvent.click(within(card()).getByRole('button', { name: 'Open epic' }))
    expect(calls.opened).toEqual([EPIC_A])
  })

  it('keeps offering the import when it failed (the shell reported why)', async () => {
    dm.responses.previewBoardImport = boardImport()
    const calls = renderCard(() => Promise.resolve(null))
    await settle()
    fireEvent.click(within(card()).getByRole('button', { name: 'Import 1 epic as a draft' }))
    await settle()
    expect(calls.imports).toBe(1)
    expect(within(card()).getByRole('button', { name: 'Import 1 epic as a draft' })).toBeTruthy()
  })
})
