// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import type { RenderHookResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { errorMessage } from '../api/dm'
import type { Tokens } from '../app/eventRouting'
import { FakeDm } from '../__mocks__/fakeDm'
import { settle } from '../__mocks__/settle'
import { FakeBoard, cardSummary } from './__mocks__/fixtures'
import { useKanbanCounts } from './useKanbanCounts'
import type { KanbanCounts } from './useKanbanCounts'

afterEach(cleanup)

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

const tokensAt = (token: number): Tokens => ({ folders: { '/a': token }, epics: {} })

function mount(): RenderHookResult<KanbanCounts, { tokens: Tokens }> {
  return renderHook((props: { tokens: Tokens }) => useKanbanCounts({ paths: ['/a'], tokens: props.tokens, onError: (error) => errors.push(errorMessage(error)) }), {
    initialProps: { tokens: tokensAt(0) }
  })
}

const cards = (count: number): FakeBoard['open'] => Array.from({ length: count }, (_, index) => cardSummary({ id: `kc_${index}`, key: `DM-${index}` }))

describe('useKanbanCounts', () => {
  it('reports a failed read and leaves the folder without a count', async () => {
    dm.failures.listKanbanCards = { code: 'not_found', message: 'Folder is gone.' }
    const view = mount()
    await settle()
    expect(errors).toEqual(['Folder is gone.'])
    expect(view.result.current).toEqual({})
  })

  it('keeps the newest count when an older read answers late', async () => {
    board.open = cards(1)
    const hold = dm.holdNext('listKanbanCards')
    const view = mount()
    view.rerender({ tokens: tokensAt(1) })
    await settle()
    expect(view.result.current).toEqual({ '/a': 1 })
    board.open = cards(3)
    hold.resolve()
    await settle()
    expect(view.result.current).toEqual({ '/a': 1 })
    expect(dm.callsOf('listKanbanCards').map((call) => call.input)).toEqual([{ doneLimit: 1 }, { doneLimit: 1 }])
  })

  it('stays quiet when an older read fails late', async () => {
    board.open = cards(2)
    const hold = dm.holdNext('listKanbanCards')
    const view = mount()
    view.rerender({ tokens: tokensAt(1) })
    await settle()
    dm.failures.listKanbanCards = { code: 'internal', message: 'Database locked.' }
    hold.resolve()
    await settle()
    expect(errors).toEqual([])
    expect(view.result.current).toEqual({ '/a': 2 })
  })
})

describe('useKanbanCounts: what counts', () => {
  it('counts the cards of every open lane, Backlog, In progress and Ready for review, and no Done card', async () => {
    board.open = [
      cardSummary({ id: 'kc_1', key: 'DM-1', lane: 'backlog' }),
      cardSummary({ id: 'kc_2', key: 'DM-2', lane: 'in_progress' }),
      cardSummary({ id: 'kc_3', key: 'DM-3', lane: 'in_progress' }),
      cardSummary({ id: 'kc_4', key: 'DM-4', lane: 'ready_for_review' })
    ]
    board.done = [cardSummary({ id: 'kc_5', key: 'DM-5', lane: 'done' })]

    const view = mount()
    await settle()

    expect(view.result.current).toEqual({ '/a': 4 })
  })
})
