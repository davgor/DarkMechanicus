import { describe, expect, it } from 'vitest'
import { cardSummary } from '../kanban/__mocks__/fixtures'
import { editForm, initialEditor } from '../ticket/ticketForm'
import { FakeBackend } from './__mocks__/fakeBackend'
import { draftPlan } from './__mocks__/fixtures'
import { loadWorkspace } from './workspaceLoad'
import { initialWorkspaceState, workspaceReducer } from './workspaceState'
import { createViewMemory } from './viewMemory'

it('evicts the oldest read snapshots while keeping recent selections', async () => {
  const memory = createViewMemory()
  const data = await loadWorkspace(new FakeBackend().runner, 'ep_1')
  const selection = data.saved?.bundle.tickets[0].id ?? ''
  const loaded = workspaceReducer(initialWorkspaceState(), { type: 'load_succeeded', data, at: 1 })
  const state = workspaceReducer(loaded, { type: 'select_ticket', ticketId: selection })
  for (let i = 0; i < 6; i += 1) memory.saveWorkspace('same-store', 'ep_' + i, state)
  expect(memory.workspace('same-store', 'ep_0')).toBeUndefined()
  expect(memory.workspace('same-store', 'ep_5')?.selectedTicketId).toBe(selection)
  expect(memory.workspace('changed-store', 'ep_5')).toBeUndefined()
})

it('keeps unsaved edits across snapshot pressure and discards old-store views on rebind', () => {
  const memory = createViewMemory()
  const bundle = draftPlan().bundle
  const ticketId = bundle.tickets[0].id
  const initial = initialEditor(bundle, ticketId)
  const edited = editForm(initial, { ...initial.form!, title: 'Unapplied work' })
  for (let i = 0; i < 40; i += 1) memory.saveEditor('old-store', 'ep_' + i, ticketId, edited)
  expect(memory.editor('old-store', 'ep_0', ticketId)?.form?.title).toBe('Unapplied work')
  const board = { lanes: { backlog: [cardSummary()], in_progress: [], ready_for_review: [], done: [] }, doneTotal: 0, doneNextCursor: null }
  memory.saveBoard('old-store', board)
  memory.saveBoard('new-store', board)
  expect(memory.board('old-store')).toBe(board)
  memory.retain(new Set(['new-store']))
  expect(memory.board('old-store')).toBeUndefined()
  expect(memory.editor('old-store', 'ep_0', ticketId)).toBeUndefined()
  expect(memory.board('new-store')).toBe(board)
  memory.saveEditor('new-store', 'ep_1', ticketId, edited)
  memory.discardEditors('new-store', 'ep_1')
  expect(memory.editor('new-store', 'ep_1', ticketId)).toBeUndefined()
})

describe('view memory', () => {
  it('remembers a view per folder and epic until it is forgotten', () => {
    const memory = createViewMemory()
    expect(memory.recall('/a', 'ep_1')).toBe(null)
    memory.remember('/a', 'ep_1', 'draft')
    memory.remember('/b', 'ep_1', 'saved')
    expect([memory.recall('/a', 'ep_1'), memory.recall('/b', 'ep_1'), memory.recall('/a', 'ep_2')]).toEqual(['draft', 'saved', null])
    memory.remember('/a', 'ep_1', null)
    expect([memory.recall('/a', 'ep_1'), memory.recall('/b', 'ep_1')]).toEqual([null, 'saved'])
  })
})
