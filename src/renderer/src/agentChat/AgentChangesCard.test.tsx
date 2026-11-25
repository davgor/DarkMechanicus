// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { FakeAgentChat } from '../__mocks__/fakeAgentChat'
import { FakeDm } from '../__mocks__/fakeDm'
import { settle } from '../__mocks__/settle'
import { fakeOrchestration, type FakeOrchestration } from '../epic/__mocks__/fakeOrchestration'
import { AgentChangesCard } from './AgentChangesCard'
import { agentChatScenarios } from './__mocks__/agentChatScenario'

const FOLDER = 'C:/Repo'
let api: FakeAgentChat
let host: FakeOrchestration

beforeEach(() => {
  const dm = new FakeDm()
  api = dm.agentChat as FakeAgentChat
  api.snapshotResult = { ok: true, data: agentChatScenarios.changes.snapshot }
  window.dm = dm
  host = fakeOrchestration()
})
afterEach(() => { cleanup(); localStorage.clear() })

async function mount(props: Partial<Parameters<typeof AgentChangesCard>[0]> = {}) {
  const view = render(<AgentChangesCard folder={FOLDER} epicId="ep_1" chat={{ id: 'chat_orch', surface: 'gui' }}
    threadId="th-dm3" onOpenSourceFile={host.onOpenSourceFile} {...props} />)
  await settle()
  return view
}

const header = () => within(screen.getByRole('region', { name: 'Changes' })).getAllByRole('button')[0]

it('reads Changes · 2 files for the worker scope with path, badge, tool and count, without starting the stopped chat', async () => {
  await mount()
  expect(header().textContent).toBe('Changes · 2 files')
  expect(header().getAttribute('aria-expanded')).toBe('true')
  const rows = screen.getAllByRole('listitem')
  expect(rows.map((row) => row.textContent)).toEqual(['src/card/ChangesCard.tsxEEdit×2', 'src/card/changes.cssWWrite'])
  expect(within(rows[0]).getByText('src/card/').className).toBe('acc-dir')
  expect(within(rows[0]).getByLabelText('Edited').textContent).toBe('E')
  expect(within(rows[1]).getByLabelText('Written').textContent).toBe('W')
  expect(within(rows[0]).getByTitle('src/card/ChangesCard.tsx')).toBeTruthy()
  expect(within(rows[0]).getByTitle('Edit')).toBeTruthy()
  expect(screen.getByText('Edits made through shell commands are not listed.')).toBeTruthy()
  expect(api.callsOf('snapshot')).toEqual([[{ folder: FOLDER, chatId: 'chat_orch' }]])
  expect(api.callsOf('start')).toEqual([])
})

it('opens an in-folder row in Source control at its absolute path; an out-of-folder row has no button', async () => {
  await mount({ threadId: null })
  expect(header().textContent).toBe('Changes · 3 files')
  fireEvent.click(screen.getByRole('button', { name: /ChangesCard\.tsx/ }))
  expect(host.openedSourceFiles).toEqual(['C:/Repo/src/card/ChangesCard.tsx'])
  const outside = screen.getByText('outside this folder').closest('li')!
  expect(within(outside).queryByRole('button')).toBeNull()
  expect(within(outside).getByTitle('C:/Elsewhere/notes.md')).toBeTruthy()
  fireEvent.click(outside)
  expect(host.openedSourceFiles).toEqual(['C:/Repo/src/card/ChangesCard.tsx'])
})

it('remembers collapse per epic across remounts', async () => {
  const first = await mount()
  fireEvent.click(header())
  expect(header().getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  expect(localStorage.getItem('dm.changesCardCollapsed')).toContain(JSON.stringify(`${FOLDER}\nep_1`))
  first.unmount()
  const again = await mount()
  expect(header().getAttribute('aria-expanded')).toBe('false')
  again.unmount()
  await mount({ epicId: 'ep_2' })
  expect(header().getAttribute('aria-expanded')).toBe('true')
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
})

it('shows the not-available text for a terminal chat and never reads it', async () => {
  await mount({ chat: { id: 'chat_orch', surface: 'terminal' } })
  expect(screen.getByText('Not available for terminal chats')).toBeTruthy()
  expect(screen.queryByRole('listitem')).toBeNull()
  expect(api.calls).toEqual([])
})

it('treats a legacy chat with no surface as terminal and never reads it', async () => {
  await mount({ chat: { id: 'chat_orch' } })
  expect(screen.getByText('Not available for terminal chats')).toBeTruthy()
  expect(screen.queryByRole('listitem')).toBeNull()
  expect(api.calls).toEqual([])
})

it('shows the empty state for an agent that touched no files', async () => {
  api.snapshotResult = { ok: true, data: agentChatScenarios.empty.snapshot }
  await mount({ threadId: null })
  expect(header().textContent).toBe('No file changes yet')
  expect(screen.queryByRole('list')).toBeNull()
  expect(screen.getByText('Edits made through shell commands are not listed.')).toBeTruthy()
})
