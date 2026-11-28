// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LearningIntegrationSummaryView } from '../../../shared/domain/learnings'
import { FakeDm } from '../__mocks__/fakeDm'
import { folderView } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ToastProvider } from '../app/toasts'
import { LearningsPanel } from './LearningsPanel'
import { historyEntry, LearningStore, learningView } from './__mocks__/learningFixtures'

let dm: FakeDm
let store: LearningStore
let opened: (string | null)[]

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  opened = []
  store = new LearningStore(dm, [])
  dm.handlers.getRun = () => null
  dm.failures.getKanbanCard = { code: 'not_found', message: 'No card' }
})

afterEach(cleanup)

async function renderPanel(learningId: string): Promise<void> {
  render(
    <ToastProvider scheduler={new ManualScheduler()}>
      <LearningsPanel
        folder={folderView({ path: '/a', name: 'alpha' })}
        learningId={learningId}
        refreshToken={0}
        onOpenLearning={(id) => opened.push(id)}
        onOpenSource={() => undefined}
        onBack={() => undefined}
      />
    </ToastProvider>
  )
  await settle()
}

const detail = (): HTMLElement => screen.getByRole('region', { name: 'Learning detail' })
const row = (scope: HTMLElement, label: string): HTMLElement => {
  const value = within(scope).getAllByText(label, { selector: 'dt' })[0]?.nextElementSibling
  if (!(value instanceof HTMLElement)) throw new Error(`No ${label} row`)
  return value
}

describe('Learning detail applicability and history links', () => {
  it('says None, Any event and Any path for empty applicability lists', async () => {
    store.learnings = [learningView({ applicability: { roles: [], events: [], paths: [] } })]
    await renderPanel('lr_1')
    const applies = within(detail()).getByLabelText('Applies to')
    expect(row(applies, 'Roles').textContent).toBe('None')
    expect(row(applies, 'Events').textContent).toBe('Any event')
    expect(row(applies, 'Paths').textContent).toBe('Any path')
  })

  it('links a history entry to its related learning', async () => {
    store.learnings = [learningView({ id: 'lr_new', replaces: 'lr_old' })]
    store.history.lr_new = [historyEntry({ learningId: 'lr_new', kind: 'created_by_replacement', relatedId: 'lr_old', reason: 'Sharper rule' })]
    await renderPanel('lr_new')
    const history = within(within(detail()).getByRole('region', { name: 'History' }))
    const entry = history.getByRole('listitem')
    expect(entry.textContent).toContain('Replaces lr_old')
    expect(entry.textContent).toContain('Sharper rule')
    fireEvent.click(within(entry).getByRole('button', { name: 'lr_old' }))
    expect(opened).toEqual(['lr_old'])
  })
})

describe('Learning detail evidence', () => {
  it('shows each evidence item with its content hash (DM-983)', async () => {
    const hashes = [`sha256:${'c'.repeat(64)}`, `sha256:${'d'.repeat(64)}`]
    store.learnings = [learningView({ evidence: [
      { kind: 'rejected_attempt', sourceId: 'at_rejected', contentHash: hashes[0]! },
      { kind: 'retro_action', sourceId: 'rp_report/action-1', contentHash: hashes[1]! }
    ] })]
    await renderPanel('lr_1')
    const items = within(within(detail()).getByRole('list', { name: 'Evidence' })).getAllByRole('listitem')
    expect(items.map((item) => within(item).getByTitle('Content hash').textContent)).toEqual(hashes)
    expect(items[0]!.textContent).toBe(`rejected_attempt at_rejected${hashes[0]!}`)
  })
})

describe('Learning detail integration', () => {
  it('says no integration is recorded when the source card has none on this clone', async () => {
    store.learnings = [learningView()]
    await renderPanel('lr_1')
    expect(within(detail()).getByRole('region', { name: 'Integration' }).textContent).toContain('No integration of the source card is recorded on this clone.')
  })

  it('lists each target repository, the root by name, with its landed head when it has one', async () => {
    const integration: LearningIntegrationSummaryView = {
      operationId: 'li_01m877ym5kj3nydv11sna2t15f',
      state: 'published',
      failure: null,
      targets: [
        { repository: null, branch: 'epic/x', baseCommit: 'a'.repeat(40), oldHead: null, newHead: '0123456789abcdef'.repeat(2) + 'aaaaaaaa', state: 'integrated' },
        { repository: 'web', branch: 'main', baseCommit: 'b'.repeat(40), oldHead: null, newHead: null, state: 'pending' }
      ]
    }
    store.learnings = [learningView({ integration })]
    await renderPanel('lr_1')
    const section = within(detail()).getByRole('region', { name: 'Integration' })
    expect(within(section).getByText('li_01m877ym5kj3nydv11sna2t15f')).toBeTruthy()
    expect(row(section, 'Repository root').textContent).toBe('Integrated on epic/x at 0123456789ab (base aaaaaaa)')
    expect(row(section, 'web').textContent).toBe('Pending on main (base bbbbbbb)')
  })
})

describe('Learnings empty filters and unticked applicability', () => {
  it('says No learnings, not No active learnings, when the retired filter finds none', async () => {
    store.learnings = [learningView()]
    await renderPanel('lr_1')
    fireEvent.click(screen.getByRole('radio', { name: 'Retired' }))
    await settle()
    const list = within(screen.getByRole('region', { name: 'Learning list' }))
    expect(list.getByText('No learnings')).toBeTruthy()
    expect(list.queryByText('No active learnings')).toBeNull()
  })

  it('replaces with a role and an event unticked, sending neither', async () => {
    store.learnings = [learningView()]
    await renderPanel('lr_1')
    const scope = within(detail())
    fireEvent.click(scope.getByRole('button', { name: 'Replace…' }))
    const worker = scope.getByRole('checkbox', { name: 'worker' }) as HTMLInputElement
    fireEvent.click(worker)
    fireEvent.click(scope.getByRole('checkbox', { name: 'ticket.claimed' }))
    expect(worker.checked).toBe(false)
    fireEvent.change(scope.getByLabelText('Reason (one line)'), { target: { value: 'Applies everywhere' } })
    fireEvent.click(scope.getByRole('button', { name: 'Replace at revision 1' }))
    await settle()
    expect(dm.callsOf('replaceLearning').map((call) => call.input)).toMatchObject([
      { learningId: 'lr_1', reason: 'Applies everywhere', replacement: { applicability: { roles: [], events: [], paths: ['src/core/db/**'] } } }
    ])
  })
})
