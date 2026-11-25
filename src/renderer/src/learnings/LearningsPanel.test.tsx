// @vitest-environment jsdom
import { cleanup, fireEvent, render, type RenderResult, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KanbanAttemptView } from '../../../shared/domain/kanban'
import type { RunView } from '../../../shared/domain/views'
import { FakeDm } from '../__mocks__/fakeDm'
import { folderView } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ToastProvider } from '../app/toasts'
import { runView } from '../epic/__mocks__/fixtures'
import { cardView } from '../kanban/__mocks__/fixtures'
import type { SourceTarget } from './learningSources'
import { LearningsPanel } from './LearningsPanel'
import { historyEntry, LearningStore, learningView, SOURCE } from './__mocks__/learningFixtures'

let dm: FakeDm
let store: LearningStore
let opened: (string | null)[]
let sources: SourceTarget[]

const folder = folderView({ path: '/a', name: 'alpha' })

/** The learning's source run: it belongs to epic ep_src and holds the rejected attempt the learning cites. */
function sourceRun(patch: Partial<RunView> = {}): RunView {
  return runView({
    id: SOURCE.runId,
    number: 3,
    epicId: 'ep_src',
    activeSprintId: null,
    activeSprintOrdinal: null,
    increments: [{ sprintId: SOURCE.sprintId, sprintOrdinal: 2 } as RunView['increments'][number]],
    tickets: [{ ...runView().tickets[0]!, ticketId: 'tk_src', key: 'DM-77' }],
    attempts: [{ ...runView().attempts[0]!, id: 'at_rejected', ticketId: 'tk_src', number: 2 }],
    ...patch
  })
}

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  opened = []
  sources = []
  store = new LearningStore(dm, [
    learningView(),
    learningView({ id: 'lr_old', title: 'Old rule', state: 'retired', retiredAt: '2026-02-01T10:00:00.000Z', retiredReason: 'Superseded', revision: 2 })
  ])
  dm.handlers.getRun = () => sourceRun()
  // Only the id and number of the card attempt are read for its link label.
  const attempt = { id: SOURCE.attemptId, number: 1, state: 'accepted' } as KanbanAttemptView
  dm.handlers.getKanbanCard = () => cardView({ id: SOURCE.cardId, key: 'DM-9', title: 'Sprint 2 learnings', attempts: [attempt] })
})

afterEach(cleanup)

function Panel({ learningId, token }: { learningId: string | null; token: number }): JSX.Element {
  return (
    <ToastProvider scheduler={new ManualScheduler()}>
      <LearningsPanel
        folder={folder}
        learningId={learningId}
        refreshToken={token}
        onOpenLearning={(id) => opened.push(id)}
        onOpenSource={(target) => sources.push(target)}
        onBack={() => undefined}
      />
    </ToastProvider>
  )
}

async function renderPanel(learningId: string | null = null, token = 0): Promise<RenderResult> {
  const result = render(<Panel learningId={learningId} token={token} />)
  await settle()
  return result
}

const list = (): ReturnType<typeof within> => within(screen.getByRole('region', { name: 'Learning list' }))
const detail = (): ReturnType<typeof within> => within(screen.getByRole('region', { name: 'Learning detail' }))
const row = (label: string): HTMLElement => {
  const value = detail().getAllByText(label, { selector: 'dt' })[0]?.nextElementSibling
  if (!(value instanceof HTMLElement)) throw new Error(`No ${label} row`)
  return value
}

describe('Learnings list', () => {
  it('lists active learnings by default, then retired and all on request', async () => {
    await renderPanel()
    expect(dm.callsOf('listLearnings').map((call) => call.input)).toEqual([{ state: 'active' }])
    expect(list().getByRole('button', { name: /Run the migration tests/ })).toBeTruthy()
    expect(list().queryByRole('button', { name: /Old rule/ })).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: 'Retired' }))
    await settle()
    expect(list().getByRole('button', { name: /Old rule/ })).toBeTruthy()
    expect(list().queryByRole('button', { name: /Run the migration tests/ })).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    await settle()
    expect(list().getAllByRole('button')).toHaveLength(2)
  })

  it('searches with the typed query', async () => {
    await renderPanel()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search learnings' }), { target: { value: 'nothing matches' } })
    await settle()
    expect(dm.callsOf('listLearnings').at(-1)?.input).toEqual({ state: 'active', query: 'nothing matches' })
    expect(list().getByText('No active learnings')).toBeTruthy()
  })

  it('shows loading, then an error when the list cannot be read', async () => {
    const hold = dm.holdNext('listLearnings')
    await renderPanel()
    expect(list().getByRole('status').textContent).toBe('Loading learnings…')
    dm.failures.listLearnings = { code: 'internal', message: 'database is locked' }
    hold.resolve()
    await settle()
    expect(list().getByRole('alert').textContent).toBe('The learnings could not be read.')
  })
})

describe('Learnings list states and refresh', () => {
  it('says so when the folder has no learnings', async () => {
    store.learnings = []
    await renderPanel()
    expect(list().getByText('No active learnings')).toBeTruthy()
    expect(detail().getByText(/Choose a learning/)).toBeTruthy()
  })

  it('opens a learning through the route', async () => {
    await renderPanel()
    fireEvent.click(list().getByRole('button', { name: /Run the migration tests/ }))
    expect(opened).toEqual(['lr_1'])
  })

  it('reloads the list and the open learning when the refresh token changes', async () => {
    const { rerender } = await renderPanel('lr_1', 0)
    store.learnings = [learningView({ title: 'Run the migration tests twice', revision: 2 })]
    rerender(<Panel learningId="lr_1" token={1} />)
    await settle()
    expect(dm.callsOf('listLearnings')).toHaveLength(2)
    expect(dm.callsOf('getLearning')).toHaveLength(2)
    expect(list().getByRole('button', { name: /Run the migration tests twice/ })).toBeTruthy()
    expect(row('Revision').textContent).toBe('2')
  })
})

describe('Learning detail', () => {
  it('shows content, applicability, lifecycle and history', async () => {
    store.history.lr_1 = [historyEntry(), historyEntry({ seq: 2, kind: 'retired', reason: 'No longer applies', revision: 2 })]
    await renderPanel('lr_1')
    expect(detail().getByRole('heading', { name: 'Run the migration tests' })).toBeTruthy()
    expect(detail().getByText('Run the migration upgrade tests before submitting a schema change.')).toBeTruthy()
    expect(detail().getByText('The attempt evidence lists the migration test run.')).toBeTruthy()
    expect(row('Roles').textContent).toBe('worker')
    expect(row('Events').textContent).toBe('ticket.claimed')
    expect(row('Paths').textContent).toBe('src/core/db/**')
    expect(row('State').textContent).toBe('Active')
    const history = within(detail().getByRole('region', { name: 'History' })).getAllByRole('listitem')
    expect(history.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Published'),
      expect.stringContaining('No longer applies')
    ])
  })

  it('links the source run, sprint, card and attempt from the learning’s own source ids', async () => {
    await renderPanel('lr_1')
    expect(dm.callsOf('getRun').map((call) => call.input)).toEqual([{ runId: SOURCE.runId }])
    expect(dm.callsOf('getKanbanCard').map((call) => call.input)).toEqual([{ cardId: SOURCE.cardId }])
    fireEvent.click(within(row('Run')).getByRole('button', { name: 'Run #3' }))
    fireEvent.click(within(row('Sprint')).getByRole('button', { name: 'Sprint 2' }))
    fireEvent.click(within(row('Card')).getByRole('button', { name: 'DM-9 Sprint 2 learnings' }))
    fireEvent.click(within(row('Attempt')).getByRole('button', { name: 'Attempt #1' }))
    expect(sources).toEqual([
      { kind: 'epic', epicId: 'ep_src' },
      { kind: 'epic', epicId: 'ep_src' },
      { kind: 'card', cardId: SOURCE.cardId },
      { kind: 'card', cardId: SOURCE.cardId }
    ])
    expect(row('Run').textContent).toContain(SOURCE.runId)
  })

  it('opens cited ordinary evidence at its ticket attempt', async () => {
    await renderPanel('lr_1')
    const evidence = within(detail().getByRole('list', { name: 'Evidence' }))
    fireEvent.click(evidence.getByRole('button', { name: 'DM-77 attempt #2' }))
    expect(sources).toEqual([{ kind: 'ticket', epicId: 'ep_src', ticketId: 'tk_src', attemptId: 'at_rejected' }])
  })
})

describe('Learning detail without targets and replacement links', () => {
  it('shows plain ids when the folder holds neither the source run nor the card', async () => {
    dm.handlers.getRun = () => null
    dm.failures.getKanbanCard = { code: 'not_found', message: 'No card' }
    await renderPanel('lr_1')
    expect(detail().queryAllByRole('button', { name: /Run #|Sprint \d|DM-77/ })).toEqual([])
    expect(row('Run').textContent).toContain(SOURCE.runId)
    expect(row('Sprint').textContent).toContain(SOURCE.sprintId)
    expect(row('Card').textContent).toContain(SOURCE.cardId)
    expect(row('Attempt').textContent).toContain(SOURCE.attemptId)
    expect(within(detail().getByRole('list', { name: 'Evidence' })).getByText('at_rejected')).toBeTruthy()
  })

  it('links a retired learning to its successor and back', async () => {
    store.learnings = [
      learningView({ id: 'lr_old', state: 'retired', replacedBy: 'lr_new', retiredAt: '2026-02-01T10:00:00.000Z', retiredReason: 'Sharper rule', revision: 2 }),
      learningView({ id: 'lr_new', replaces: 'lr_old' })
    ]
    const { rerender } = await renderPanel('lr_old')
    expect(row('Reason').textContent).toBe('Sharper rule')
    expect(detail().queryByRole('button', { name: 'Retire…' })).toBeNull()
    fireEvent.click(within(row('Replaced by')).getByRole('button', { name: 'lr_new' }))
    rerender(<Panel learningId="lr_new" token={0} />)
    await settle()
    fireEvent.click(within(row('Replaces')).getByRole('button', { name: 'lr_old' }))
    expect(opened).toEqual(['lr_new', 'lr_old'])
  })

  it('shows an error when the open learning cannot be read', async () => {
    dm.failures.getLearning = { code: 'not_found', message: 'No learning' }
    await renderPanel('lr_gone')
    expect(detail().getByRole('alert').textContent).toBe('This learning could not be read.')
  })
})

describe('Retiring and replacing', () => {
  it('retires at the shown revision with a one-line reason, then refreshes list and detail', async () => {
    await renderPanel('lr_1')
    fireEvent.click(detail().getByRole('button', { name: 'Retire…' }))
    const submit = detail().getByRole('button', { name: 'Retire at revision 1' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(detail().getByLabelText('Reason (one line)'), { target: { value: '  No longer applies  ' } })
    fireEvent.click(submit)
    await settle()
    expect(dm.callsOf('retireLearning').map((call) => call.input)).toEqual([{ learningId: 'lr_1', expectedRevision: 1, reason: 'No longer applies' }])
    expect(dm.callsOf('listLearnings')).toHaveLength(2)
    expect(row('State').textContent).toBe('Retired')
    expect(list().queryByRole('button', { name: /Run the migration tests/ })).toBeNull()
  })

  it('replaces with new content and the reason, then opens the successor', async () => {
    await renderPanel('lr_1')
    fireEvent.click(detail().getByRole('button', { name: 'Replace…' }))
    fireEvent.change(detail().getByLabelText('New rule'), { target: { value: 'Run the migration upgrade and downgrade tests.' } })
    fireEvent.click(detail().getByRole('checkbox', { name: 'orchestrator' }))
    fireEvent.change(detail().getByLabelText('Reason (one line)'), { target: { value: 'Downgrades broke too' } })
    fireEvent.click(detail().getByRole('button', { name: 'Replace at revision 1' }))
    await settle()
    expect(dm.callsOf('replaceLearning').map((call) => call.input)).toEqual([
      {
        learningId: 'lr_1',
        expectedRevision: 1,
        reason: 'Downgrades broke too',
        replacement: {
          title: 'Run the migration tests',
          rule: 'Run the migration upgrade and downgrade tests.',
          check: 'The attempt evidence lists the migration test run.',
          applicability: { roles: ['worker', 'orchestrator'], events: ['ticket.claimed'], paths: ['src/core/db/**'] }
        }
      }
    ])
    expect(opened).toEqual(['lr_100'])
    expect(list().getByRole('button', { name: /Run the migration tests/ })).toBeTruthy()
  })
})

describe('Stale revisions and refused changes', () => {
  it('keeps the draft on a stale revision and reloads the learning on request', async () => {
    await renderPanel('lr_1')
    fireEvent.click(detail().getByRole('button', { name: 'Replace…' }))
    fireEvent.change(detail().getByLabelText('New title'), { target: { value: 'Run every migration test' } })
    fireEvent.change(detail().getByLabelText('Reason (one line)'), { target: { value: 'Broader' } })
    dm.failures.replaceLearning = { code: 'conflict', message: 'Learning lr_1 changed while it was being retired.' }
    fireEvent.click(detail().getByRole('button', { name: 'Replace at revision 1' }))
    await settle()
    expect(detail().getByRole('alert').textContent).toContain('changed since you opened it')
    expect((detail().getByLabelText('New title') as HTMLInputElement).value).toBe('Run every migration test')
    expect((detail().getByLabelText('Reason (one line)') as HTMLInputElement).value).toBe('Broader')

    store.learnings = [learningView({ revision: 2 })]
    fireEvent.click(detail().getByRole('button', { name: 'Reload learning' }))
    await settle()
    expect(dm.callsOf('getLearning')).toHaveLength(2)
    expect(row('Revision').textContent).toBe('2')
  })

  it('reports any other failure as its message', async () => {
    await renderPanel('lr_1')
    fireEvent.click(detail().getByRole('button', { name: 'Retire…' }))
    fireEvent.change(detail().getByLabelText('Reason (one line)'), { target: { value: 'Done' } })
    dm.failures.retireLearning = { code: 'unauthorized', message: 'Only a person at the desktop may retire or replace a learning.' }
    fireEvent.click(detail().getByRole('button', { name: 'Retire at revision 1' }))
    await settle()
    expect(detail().getByRole('alert').textContent).toBe('Only a person at the desktop may retire or replace a learning.')
  })
})
