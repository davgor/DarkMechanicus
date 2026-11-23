import { describe, expect, it } from 'vitest'
import { cardSummary } from '../kanban/__mocks__/fixtures'
import { applyOutcome, editForm, initialEditor } from '../ticket/ticketForm'
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

it('drops the previous board and plan snapshots when a refresh exceeds the cache size limit', async () => {
  const memory = createViewMemory()
  const { id: cardId } = cardSummary()
  const board = { lanes: { backlog: [cardSummary()], in_progress: [], ready_for_review: [], done: [] }, doneTotal: 0, doneNextCursor: null }
  const largeBoard = { ...board, lanes: { ...board.lanes, backlog: Array.from({ length: 2001 }, (_, index) =>
    cardSummary({ id: cardId + '_' + index, key: 'DM-' + (index + 1) })) } }
  const data = await loadWorkspace(new FakeBackend().runner, 'ep_1')
  const plan = data.saved!
  const largePlan = { ...plan, bundle: { ...plan.bundle, tickets: Array.from({ length: 2001 }, (_, index) =>
    ({ ...plan.bundle.tickets[0], id: 'tk_' + index, key: 'DM-' + (index + 1) })) } }
  const initial = initialWorkspaceState()
  memory.saveBoard('project', board)
  memory.saveWorkspace('project', 'ep_1', workspaceReducer(initial, { type: 'load_succeeded', data, at: 1 }))
  expect(memory.board('project')).toBe(board)
  expect(memory.workspace('project', 'ep_1')?.data?.saved).toBe(plan)

  memory.saveBoard('project', largeBoard)
  memory.saveWorkspace('project', 'ep_1', workspaceReducer(initial, { type: 'load_succeeded', data: { ...data, saved: largePlan }, at: 2 }))
  expect(memory.board('project')).toBeUndefined()
  expect(memory.workspace('project', 'ep_1')).toBeUndefined()
})

it('keeps an unsuccessful Apply available on revisit and clears a successfully applied edit', () => {
  const memory = createViewMemory()
  const bundle = draftPlan().bundle
  const ticketId = bundle.tickets[0].id
  const initial = initialEditor(bundle, ticketId)
  const edited = editForm(initial, { ...initial.form!, title: 'New title' })
  const refused = applyOutcome(edited, { ok: false, code: 'internal', message: 'Draft could not be written' })
  memory.saveEditor('project', 'ep_1', ticketId, refused)
  expect(memory.editor('project', 'ep_1', ticketId)?.form?.title).toBe('New title')
  memory.saveEditor('project', 'ep_1', ticketId, applyOutcome(edited, { ok: true }))
  expect(memory.editor('project', 'ep_1', ticketId)).toBeUndefined()
})
