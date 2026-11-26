import { describe, expect, it } from 'vitest'
import type { KanbanAttemptView } from '../../../shared/domain/kanban'
import type { RowView, RunView } from '../../../shared/domain/views'
import { runView } from '../epic/__mocks__/fixtures'
import { cardView } from '../kanban/__mocks__/fixtures'
import { evidenceLink, sourceLinks } from './learningSources'
import { SOURCE } from './__mocks__/learningFixtures'

const EPIC = { kind: 'epic', epicId: 'ep_src' } as const

function sourceRun(patch: Partial<RunView> = {}): RunView {
  return runView({
    id: SOURCE.runId,
    number: 3,
    epicId: 'ep_src',
    activeSprintId: null,
    activeSprintOrdinal: null,
    increments: [],
    tickets: [{ ...runView().tickets[0]!, ticketId: 'tk_src', key: 'DM-77' }],
    attempts: [
      { ...runView().attempts[0]!, id: 'at_known', ticketId: 'tk_src', number: 2 },
      { ...runView().attempts[0]!, id: 'at_orphan', ticketId: 'tk_gone', number: 4 }
    ],
    ...patch
  })
}

// Only the check id is read to find the row a row check belongs to.
const row = (number: number, checkId: string | null): RowView => ({ sprintId: SOURCE.sprintId, row: number, tickets: [], latestCheck: checkId === null ? null : ({ id: checkId } as RowView['latestCheck']) })

const sourceCard = (attempts: KanbanAttemptView[]) => cardView({ id: SOURCE.cardId, key: 'DM-9', title: 'Sprint 2 learnings', attempts })

describe('sourceLinks', () => {
  it('labels the active sprint by the run’s active ordinal and the card attempt by its number', () => {
    const run = sourceRun({ activeSprintId: SOURCE.sprintId, activeSprintOrdinal: 4 })
    const links = sourceLinks(SOURCE, run, sourceCard([{ id: SOURCE.attemptId, number: 3 } as KanbanAttemptView]))
    expect(links).toEqual([
      { name: 'Run', label: 'Run #3', id: SOURCE.runId, target: EPIC },
      { name: 'Sprint', label: 'Sprint 4', id: SOURCE.sprintId, target: EPIC },
      { name: 'Card', label: 'DM-9 Sprint 2 learnings', id: SOURCE.cardId, target: { kind: 'card', cardId: SOURCE.cardId } },
      { name: 'Attempt', label: 'Attempt #3', id: SOURCE.attemptId, target: { kind: 'card', cardId: SOURCE.cardId } }
    ])
  })

  it('labels a finished sprint by its increment ordinal', () => {
    const run = sourceRun({ activeSprintId: 'sp_other', activeSprintOrdinal: 5, increments: [{ sprintId: SOURCE.sprintId, sprintOrdinal: 2 } as RunView['increments'][number]] })
    expect(sourceLinks(SOURCE, run, null)[1]?.label).toBe('Sprint 2')
  })

  it('leaves a sprint the run records nothing about, and a missing card attempt, unnumbered', () => {
    const links = sourceLinks(SOURCE, sourceRun(), sourceCard([{ id: 'ka_other', number: 7 } as KanbanAttemptView]))
    expect(links[1]?.label).toBe('Sprint')
    expect(links[3]?.label).toBe('Card attempt')
  })

  it('shows plain rows without targets when neither the run nor the card is known', () => {
    expect(sourceLinks(SOURCE, null, null).map(({ label, target }) => ({ label, target }))).toEqual([
      { label: 'Run', target: null },
      { label: 'Sprint', target: null },
      { label: 'Learning card', target: null },
      { label: 'Card attempt', target: null }
    ])
  })
})

describe('evidenceLink', () => {
  const run = sourceRun({ rows: [row(1, null), row(2, 'rk_found')] })

  it('stays a plain id without a source run', () => {
    expect(evidenceLink('at_known:decision', null)).toEqual({ label: 'at_known:decision', target: null })
  })

  it('opens a known attempt at its ticket, reading only the id before any path suffix', () => {
    expect(evidenceLink('at_known/decision.reasons', run)).toEqual({ label: 'DM-77 attempt #2', target: { kind: 'ticket', epicId: 'ep_src', ticketId: 'tk_src', attemptId: 'at_known' } })
  })

  it('names an attempt whose ticket the run no longer lists generically', () => {
    expect(evidenceLink('at_orphan', run).label).toBe('Ticket attempt #4')
  })

  it('keeps an attempt the run does not hold as a plain id', () => {
    expect(evidenceLink('at_missing/failure', run)).toEqual({ label: 'at_missing/failure', target: null })
  })

  it('opens a row check at the epic, labelled by its row when found', () => {
    expect(evidenceLink('rk_found/checks', run)).toEqual({ label: 'Row 2 check', target: EPIC })
    expect(evidenceLink('rk_missing', run)).toEqual({ label: 'Row check', target: EPIC })
  })

  it('opens a sprint report at the epic and keeps any other id plain', () => {
    expect(evidenceLink('rp_report/wentPoorly/0', run)).toEqual({ label: 'Sprint report', target: EPIC })
    expect(evidenceLink('xx_unknown', run)).toEqual({ label: 'xx_unknown', target: null })
  })
})
