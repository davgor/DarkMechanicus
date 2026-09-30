// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { folderView } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import type { BranchEpicView } from '../../../shared/domain/views'
import { ToastProvider } from '../app/toasts'
import { BranchEpics } from './BranchEpics'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

function renderList(): void {
  render(
    <ToastProvider scheduler={new ManualScheduler()}>
      <BranchEpics folder={folderView({ path: '/a' })} />
    </ToastProvider>
  )
}

const entry = (patch: Partial<BranchEpicView>): BranchEpicView => ({
  branch: 'feature/x',
  epicId: 'ep_1',
  title: 'Cross-host validation',
  status: 'in_progress',
  revisionNumber: 3,
  presentLocally: false,
  ...patch
})

describe('BranchEpics', () => {
  it('is titled as read-only information about other branches', async () => {
    renderList()
    expect(screen.getByRole('heading', { name: 'Epics on other branches' })).toBeTruthy()
    expect(screen.getByText('Read-only. Switch branches in Git to work on them.')).toBeTruthy()
    await settle()
  })

  it('shows a loading note first', async () => {
    renderList()
    expect(screen.getByText('Loading…')).toBeTruthy()
    await settle()
  })

  it('says when no other branch has epics', async () => {
    dm.responses.listBranchEpics = []
    renderList()
    await settle()
    expect(screen.getByText('No epics are recorded on other local branches.')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('lists each epic with its branch, status, revision and presence', async () => {
    dm.responses.listBranchEpics = [
      entry({}),
      entry({ epicId: 'ep_2', title: 'Old idea', branch: 'main', status: 'completed', revisionNumber: null, presentLocally: true })
    ]
    renderList()
    await settle()
    const [first, second] = screen.getAllByRole('listitem')
    expect(within(first as HTMLElement).getByText('Cross-host validation')).toBeTruthy()
    expect(within(first as HTMLElement).getByText('feature/x')).toBeTruthy()
    expect(within(first as HTMLElement).getByText('In progress')).toBeTruthy()
    expect(within(first as HTMLElement).getByText('rev 3')).toBeTruthy()
    expect(within(first as HTMLElement).getByText('not on this checkout')).toBeTruthy()
    expect(within(second as HTMLElement).getByText('Completed')).toBeTruthy()
    expect(within(second as HTMLElement).queryByText(/^rev /)).toBeNull()
    expect(within(second as HTMLElement).getByText('on this checkout')).toBeTruthy()
  })

  it('explains a failure to read branches', async () => {
    dm.failures.listBranchEpics = { code: 'internal', message: 'git not found' }
    renderList()
    await settle()
    expect(screen.getByText('Could not read the other branches.')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('git not found')
  })
})
