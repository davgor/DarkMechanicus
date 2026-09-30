// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { EPIC_A, epicDetail, epicSummary, folderView, storageStatus } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import type { CreateEpicInput } from '../../../shared/domain/api'
import type { EpicDetailView } from '../../../shared/domain/views'
import { ToastProvider } from '../app/toasts'
import type { EpicListState } from '../app/useEpicLists'
import { FolderHome } from './FolderHome'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

const folder = folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })
const list: EpicListState = {
  status: 'ready',
  epics: [epicSummary({ id: EPIC_A, title: 'Planning slice', status: 'backlog' })],
  error: null
}

interface Calls {
  opened: string[]
  created: CreateEpicInput[]
  flush: number
  reconcile: number
}

function renderHome(create: () => Promise<EpicDetailView | null> = () => Promise.resolve(epicDetail())): Calls {
  const calls: Calls = { opened: [], created: [], flush: 0, reconcile: 0 }
  render(
    <ToastProvider scheduler={new ManualScheduler()}>
      <FolderHome
        folder={folder}
        list={list}
        status={storageStatus()}
        busy={{ flush: false, reconcile: false }}
        onOpenEpic={(id) => calls.opened.push(id)}
        onCreateEpic={(input) => {
          calls.created.push(input)
          return create()
        }}
        onFlush={() => {
          calls.flush += 1
        }}
        onReconcile={() => {
          calls.reconcile += 1
        }}
      />
    </ToastProvider>
  )
  return calls
}

describe('FolderHome layout', () => {
  it('names the folder and shows where it lives', async () => {
    renderHome()
    expect(screen.getByRole('heading', { level: 1, name: 'alpha' })).toBeTruthy()
    expect(screen.getByText('~/code/alpha')).toBeTruthy()
    await settle()
  })

  it('offers every section of the folder home', async () => {
    renderHome()
    for (const name of ['Epics', 'Search history', 'Storage', 'MCP connection', 'Epics on other branches']) {
      expect(screen.getByRole('region', { name })).toBeTruthy()
    }
    await settle()
  })

  it('lists the epics by bucket and opens one', async () => {
    const calls = renderHome()
    fireEvent.click(within(screen.getByRole('region', { name: 'Backlog' })).getByRole('button', { name: /Planning slice/ }))
    expect(calls.opened).toEqual([EPIC_A])
    await settle()
  })
})

describe('FolderHome new epic', () => {
  const open = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'New epic' }))
  }
  const fill = (): void => {
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Ship it' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create epic' }))
  }

  it('opens the dialog from the header button', async () => {
    renderHome()
    expect(screen.queryByRole('dialog')).toBeNull()
    open()
    expect(screen.getByRole('dialog', { name: 'New epic' })).toBeTruthy()
    await settle()
  })

  it('creates the epic and closes the dialog', async () => {
    const calls = renderHome()
    open()
    fill()
    await settle()
    expect(calls.created).toEqual([{ title: 'Ship it' }])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the dialog open when creation fails', async () => {
    renderHome(() => Promise.resolve(null))
    open()
    fill()
    await settle()
    expect(screen.getByRole('dialog', { name: 'New epic' })).toBeTruthy()
  })

  it('closes the dialog without creating on cancel', async () => {
    const calls = renderHome()
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls.created).toEqual([])
    await settle()
  })
})

describe('FolderHome storage actions', () => {
  it('routes Flush and Reconcile to the shell', async () => {
    const calls = renderHome()
    const card = screen.getByRole('region', { name: 'Storage' })
    fireEvent.click(within(card).getByRole('button', { name: 'Flush' }))
    fireEvent.click(within(card).getByRole('button', { name: 'Reconcile' }))
    expect(calls.flush).toBe(1)
    expect(calls.reconcile).toBe(1)
    await settle()
  })
})
