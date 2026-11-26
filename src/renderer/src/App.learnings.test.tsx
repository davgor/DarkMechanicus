// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KanbanAttemptView } from '../../shared/domain/kanban'
import type { RunView } from '../../shared/domain/views'
import { AppHarness } from './__mocks__/appHarness'
import { folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'
import { runView } from './epic/__mocks__/fixtures'
import { cardView } from './kanban/__mocks__/fixtures'
import { LearningStore, learningView, SOURCE } from './learnings/__mocks__/learningFixtures'

let h: AppHarness
let store: LearningStore

/** The source run of the learning: epic ep_src, sprint 2, and the rejected attempt the learning cites. */
const SOURCE_RUN: RunView = runView({
  id: SOURCE.runId,
  number: 3,
  epicId: 'ep_src',
  activeSprintId: SOURCE.sprintId,
  activeSprintOrdinal: 2,
  tickets: [{ ...runView().tickets[0]!, ticketId: 'tk_src', key: 'DM-77' }],
  attempts: [{ ...runView().attempts[0]!, id: 'at_rejected', ticketId: 'tk_src', number: 2 }]
})

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  h.dm.folders = [folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })]
  store = new LearningStore(h.dm, [learningView()])
  h.dm.handlers.getRun = () => SOURCE_RUN
  // Only the id, number and state of the card attempt are read here (its link label, the board's attempt list).
  const attempt = { id: SOURCE.attemptId, number: 1, state: 'accepted' } as KanbanAttemptView
  h.dm.handlers.getKanbanCard = () => cardView({ id: SOURCE.cardId, key: 'DM-9', title: 'Sprint 2 learnings', attempts: [attempt] })
})

afterEach(cleanup)

const workspace = (): ReturnType<typeof within> => within(screen.getByRole('main', { name: 'Workspace' }))
const stored = (): unknown => JSON.parse(window.localStorage.getItem('dm.selection') ?? 'null')

async function openLearning(): Promise<void> {
  h.rememberEpicsTab('/a')
  h.mount()
  await settle()
  const knowledge = within(workspace().getByRole('region', { name: 'Knowledge' }))
  fireEvent.click(knowledge.getByRole('button', { name: 'Learnings' }))
  await settle()
  fireEvent.click(workspace().getByRole('button', { name: /Run the migration tests/ }))
  await settle()
}

describe('Knowledge → Learnings routing', () => {
  it('opens from the Knowledge card and persists the route with the open learning', async () => {
    await openLearning()
    expect(workspace().getByRole('heading', { level: 1, name: 'Learnings' })).toBeTruthy()
    expect(workspace().getByRole('heading', { name: 'Run the migration tests', level: 2 })).toBeTruthy()
    expect(stored()).toEqual({ folderPath: '/a', epicId: null, learnings: true, learningId: 'lr_1' })
  })

  it('restores the persisted route after a reload', async () => {
    window.localStorage.setItem('dm.selection', JSON.stringify({ folderPath: '/a', epicId: null, learnings: true, learningId: 'lr_1' }))
    h.mount()
    await settle()
    expect(workspace().getByRole('heading', { level: 1, name: 'Learnings' })).toBeTruthy()
    // The event feed's start-up baseline refreshes the open learning once more; every read is of the persisted one.
    expect(new Set(h.dm.callsOf('getLearning').map((call) => JSON.stringify(call.input)))).toEqual(new Set([JSON.stringify({ learningId: 'lr_1' })]))
  })

  it('goes back to the folder home', async () => {
    await openLearning()
    fireEvent.click(workspace().getByRole('button', { name: 'Knowledge' }))
    await settle()
    expect(stored()).toEqual({ folderPath: '/a', epicId: null })
    expect(workspace().getByRole('region', { name: 'Knowledge' })).toBeTruthy()
  })

  it('reloads the learnings when a card approval event arrives', async () => {
    await openLearning()
    const lists = h.dm.callsOf('listLearnings').length
    store.learnings = [learningView({ id: 'lr_2', title: 'Pin the toolchain' }), ...store.learnings]
    h.log('/a').append({ kind: 'kanban.approved', epicId: null })
    act(() => h.scheduler.fireIntervals(1500))
    await settle()
    expect(h.dm.callsOf('listLearnings').length).toBeGreaterThan(lists)
    expect(workspace().getByRole('button', { name: /Pin the toolchain/ })).toBeTruthy()
  })
})

describe('Learning source links', () => {
  it('opens the source run’s epic, never the epic on screen', async () => {
    await openLearning()
    fireEvent.click(workspace().getByRole('button', { name: 'Run #3' }))
    await settle()
    expect(stored()).toEqual({ folderPath: '/a', epicId: 'ep_src' })
    expect(screen.getByTestId('epic-stub').textContent).toContain('ep_src')
  })

  it('opens a cited attempt at its ticket’s Activity', async () => {
    await openLearning()
    fireEvent.click(workspace().getByRole('button', { name: 'DM-77 attempt #2' }))
    await settle()
    expect(JSON.parse(screen.getByTestId('epic-landing').textContent ?? 'null')).toEqual({ kind: 'ticket', epicId: 'ep_src', ticketId: 'tk_src', attemptId: 'at_rejected' })
  })

  it('opens the source card on the board', async () => {
    await openLearning()
    fireEvent.click(workspace().getByRole('button', { name: 'DM-9 Sprint 2 learnings' }))
    await settle()
    expect(stored()).toEqual({ folderPath: '/a', epicId: null, kanban: true, kanbanCardId: SOURCE.cardId })
  })
})
