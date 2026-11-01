// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { RenderHookResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ListKanbanCardsInput } from '../../../shared/domain/api'
import { errorMessage } from '../api/dm'
import { FakeDm } from '../__mocks__/fakeDm'
import { settle } from '../__mocks__/settle'
import { FakeBoard, cardSummary, doneCard } from './__mocks__/fixtures'
import { useKanbanBoard } from './useKanbanBoard'
import type { KanbanBoardModel } from './useKanbanBoard'

afterEach(cleanup)

interface Props {
  path: string
  token: number
}

let dm: FakeDm
let board: FakeBoard
/** What the hook reported through `onError`. */
let errors: string[]

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  board = new FakeBoard(dm)
  errors = []
})

function mount(): RenderHookResult<KanbanBoardModel, Props> {
  return renderHook((props: Props) => useKanbanBoard(props.path, props.token, (error) => errors.push(errorMessage(error))), {
    initialProps: { path: '/a', token: 0 }
  })
}

const keys = (model: KanbanBoardModel, lane: 'backlog' | 'done'): string[] => model.board?.lanes[lane].map((card) => card.key) ?? []
const pageCalls = (): unknown[] => dm.callsOf('listKanbanCards').filter((call) => (call.input as ListKanbanCardsInput).doneCursor !== undefined).map((call) => call.input)

describe('useKanbanBoard folder change', () => {
  beforeEach(() => {
    const other = new FakeBoard(dm)
    board.open = [cardSummary({ id: 'kc_a', key: 'DM-1' })]
    other.open = [cardSummary({ id: 'kc_b', key: 'DM-2' })]
    dm.handlers.listKanbanCards = (input, folder) => (folder === '/a' ? board : other).list(input as ListKanbanCardsInput)
  })

  it("drops the previous folder's late board", async () => {
    const hold = dm.holdNext('listKanbanCards')
    const view = mount()
    view.rerender({ path: '/b', token: 0 })
    await settle()
    expect(keys(view.result.current, 'backlog')).toEqual(['DM-2'])
    hold.resolve()
    await settle()
    expect(keys(view.result.current, 'backlog')).toEqual(['DM-2'])
  })

  it("drops the previous folder's late failure", async () => {
    const hold = dm.holdNext('listKanbanCards')
    const view = mount()
    view.rerender({ path: '/b', token: 0 })
    await settle()
    dm.failures.listKanbanCards = { code: 'not_found', message: 'Folder is gone.' }
    hold.resolve()
    await settle()
    expect(view.result.current.status).toBe('ready')
    expect(view.result.current.error).toBeNull()
    expect(errors).toEqual([])
  })
})

describe('useKanbanBoard Show more guards', () => {
  it('asks for nothing when Done has no further page', async () => {
    board.done = [doneCard(1)]
    const view = mount()
    await settle()
    act(() => view.result.current.showMore())
    await settle()
    expect(dm.callsOf('listKanbanCards').map((call) => call.input)).toEqual([{ doneLimit: 20 }])
    expect(view.result.current.loadingMore).toBe(false)
  })

  it('asks for nothing before the board has loaded', async () => {
    board.done = Array.from({ length: 25 }, (_, index) => doneCard(index + 1))
    const hold = dm.holdNext('listKanbanCards')
    const view = mount()
    act(() => view.result.current.showMore())
    hold.resolve()
    await settle()
    expect(pageCalls()).toEqual([])
    expect(keys(view.result.current, 'done')).toHaveLength(20)
  })

  it('asks for one page while a Show more is still in flight', async () => {
    board.done = Array.from({ length: 45 }, (_, index) => doneCard(index + 1))
    const view = mount()
    await settle()
    const hold = dm.holdNext('listKanbanCards')
    act(() => view.result.current.showMore())
    expect(view.result.current.loadingMore).toBe(true)
    act(() => view.result.current.showMore())
    hold.resolve()
    await settle()
    expect(pageCalls()).toEqual([{ doneLimit: 20, doneCursor: '20' }])
    expect(keys(view.result.current, 'done')).toHaveLength(40)
  })
})

describe('useKanbanBoard Show more answers', () => {
  beforeEach(() => {
    board.done = Array.from({ length: 45 }, (_, index) => doneCard(index + 1))
  })

  it('drops a page that answers after the board was read again', async () => {
    const view = mount()
    await settle()
    const hold = dm.holdNext('listKanbanCards')
    act(() => view.result.current.showMore())
    view.rerender({ path: '/a', token: 1 })
    await settle()
    hold.resolve()
    await settle()
    expect(keys(view.result.current, 'done')).toHaveLength(20)
    expect(view.result.current.loadingMore).toBe(false)
  })

  it('reports a failed page and keeps the rows shown', async () => {
    const view = mount()
    await settle()
    dm.failures.listKanbanCards = { code: 'internal', message: 'Database locked.' }
    act(() => view.result.current.showMore())
    await settle()
    expect(errors).toEqual(['Database locked.'])
    expect(view.result.current.loadingMore).toBe(false)
    expect(view.result.current.status).toBe('ready')
    expect(keys(view.result.current, 'done')).toHaveLength(20)
  })

  it('stays quiet about a page that fails after the board was read again', async () => {
    const view = mount()
    await settle()
    const hold = dm.holdNext('listKanbanCards')
    act(() => view.result.current.showMore())
    view.rerender({ path: '/a', token: 1 })
    await settle()
    dm.failures.listKanbanCards = { code: 'internal', message: 'Database locked.' }
    hold.resolve()
    await settle()
    expect(errors).toEqual([])
    expect(keys(view.result.current, 'done')).toHaveLength(20)
  })
})
