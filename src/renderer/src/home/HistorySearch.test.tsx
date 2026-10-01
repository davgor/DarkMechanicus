// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { EPIC_A, EPIC_B, folderView } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import type { SearchResultView } from '../../../shared/domain/views'
import { ToastProvider } from '../app/toasts'
import { HistorySearch } from './HistorySearch'

let dm: FakeDm
let opened: string[]

beforeEach(() => {
  dm = new FakeDm()
  opened = []
  window.dm = dm
})

afterEach(cleanup)

const hit = (patch: Partial<SearchResultView>): SearchResultView => ({
  docType: 'ticket',
  docId: 'tk_1',
  epicId: EPIC_A,
  epicTitle: 'Packaging spike',
  runId: null,
  ticketId: 'tk_1',
  title: 'Driver shortlist',
  snippet: 'native module packaging probe',
  ...patch
})

function renderSearch(): void {
  render(
    <ToastProvider scheduler={new ManualScheduler()}>
      <HistorySearch folder={folderView({ path: '/a' })} onOpenEpic={(id) => opened.push(id)} />
    </ToastProvider>
  )
}

const box = (): HTMLInputElement => screen.getByRole('searchbox', { name: 'Search plans and run history' }) as HTMLInputElement
const submit = (): HTMLElement => screen.getByRole('button', { name: 'Search' })

async function search(text: string): Promise<void> {
  fireEvent.change(box(), { target: { value: text } })
  fireEvent.click(submit())
  await settle()
}

describe('HistorySearch input', () => {
  it('cannot search until something is typed', () => {
    renderSearch()
    expect((submit() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(box(), { target: { value: '   ' } })
    expect((submit() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(box(), { target: { value: 'driver' } })
    expect((submit() as HTMLButtonElement).disabled).toBe(false)
  })

  it('searches the folder history with a trimmed query and a result limit', async () => {
    renderSearch()
    await search('  driver  ')
    expect(dm.callsOf('searchHistory').map((call) => [call.folder, call.input])).toEqual([
      ['/a', { query: 'driver', limit: 25 }]
    ])
  })

  it('does not search when the form is submitted empty', async () => {
    renderSearch()
    fireEvent.submit(screen.getByRole('search'))
    await settle()
    expect(dm.callsOf('searchHistory')).toEqual([])
  })
})

describe('HistorySearch results', () => {
  it('lists results with their kind, title, epic and snippet', async () => {
    dm.responses.searchHistory = [
      hit({}),
      hit({ docType: 'report', docId: 'rp_1', epicId: EPIC_B, epicTitle: 'Other epic', title: 'Sprint 1 report', snippet: 'all green' })
    ]
    renderSearch()
    await search('driver')
    expect(screen.getByRole('status').textContent).toBe('2 results for “driver”')
    const first = screen.getByRole('button', { name: /Driver shortlist/ })
    expect(within(first).getByText('Ticket')).toBeTruthy()
    expect(within(first).getByText('in Packaging spike')).toBeTruthy()
    expect(within(first).getByText('native module packaging probe')).toBeTruthy()
    expect(within(screen.getByRole('button', { name: /Sprint 1 report/ })).getByText('Report')).toBeTruthy()
  })

})

describe('HistorySearch result details', () => {
  it('highlights the matched terms in a snippet', async () => {
    dm.responses.searchHistory = [hit({ snippet: 'Build the [telemetry] dashboard' })]
    renderSearch()
    await search('telemetry')
    const snippet = document.querySelector('.result-snippet') as HTMLElement
    expect(snippet.textContent).toBe('Build the telemetry dashboard')
    expect(Array.from(snippet.querySelectorAll('mark')).map((mark) => mark.textContent)).toEqual(['telemetry'])
  })

  it('labels every kind of document', async () => {
    dm.responses.searchHistory = [
      hit({ docType: 'epic', docId: 'e', title: 'E' }),
      hit({ docType: 'attempt', docId: 'a', title: 'A' }),
      hit({ docType: 'comment', docId: 'cm_1', title: 'Comment by worker-3', snippet: 'blocked on the [keychain]' })
    ]
    renderSearch()
    await search('x')
    expect(within(screen.getByRole('button', { name: /^Epic/ })).getByText('Epic')).toBeTruthy()
    expect(within(screen.getByRole('button', { name: /^Attempt/ })).getByText('Attempt')).toBeTruthy()
    const comment = screen.getByRole('button', { name: /Comment by worker-3/ })
    expect(comment.querySelector('.result-type')?.textContent).toBe('Comment')
  })

  it('opens the epic of the clicked result', async () => {
    dm.responses.searchHistory = [hit({ epicId: EPIC_B, title: 'Second' })]
    renderSearch()
    await search('second')
    fireEvent.click(screen.getByRole('button', { name: /Second/ }))
    expect(opened).toEqual([EPIC_B])
  })

  it('says when nothing matches', async () => {
    dm.responses.searchHistory = []
    renderSearch()
    await search('zzz')
    expect(screen.getByRole('status').textContent).toBe('No matches for “zzz”.')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('uses the singular for a single result', async () => {
    dm.responses.searchHistory = [hit({})]
    renderSearch()
    await search('driver')
    expect(screen.getByRole('status').textContent).toBe('1 result for “driver”')
  })
})

describe('HistorySearch progress and failure', () => {
  it('shows progress while a search runs', async () => {
    const hold = dm.holdNext('searchHistory')
    renderSearch()
    fireEvent.change(box(), { target: { value: 'driver' } })
    fireEvent.click(submit())
    await settle()
    expect(screen.getByRole('status').textContent).toBe('Searching…')
    hold.resolve()
    await settle()
    expect(screen.getByRole('status').textContent).toBe('No matches for “driver”.')
  })

  it('reports a failed search and shows no results', async () => {
    dm.failures.searchHistory = { code: 'internal', message: 'index unavailable' }
    renderSearch()
    await search('driver')
    expect(screen.getByRole('alert').textContent).toContain('index unavailable')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the newest search when an older one answers late', async () => {
    const slow = dm.holdNext('searchHistory')
    dm.handlers.searchHistory = (input) => [hit({ title: `for ${(input as { query: string }).query}`, docId: 'x' })]
    renderSearch()
    fireEvent.change(box(), { target: { value: 'old' } })
    fireEvent.click(submit())
    await settle()
    fireEvent.change(box(), { target: { value: 'new' } })
    fireEvent.click(submit())
    await settle()
    slow.resolve()
    await settle()
    expect(screen.getByRole('status').textContent).toBe('1 result for “new”')
    expect(screen.queryByText('for old')).toBeNull()
  })
})
