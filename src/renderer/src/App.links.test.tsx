// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { FakeTerminals } from './__mocks__/fakeTerminals'
import { agentView, chatRecord, folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

let h: AppHarness
let terminals: FakeTerminals

const AT = '2026-03-01T10:00:00.000Z'
const EPIC = 'ep_01k8zq2a3b4c5d6e7f8g9h0j1k'

const CHAT = chatRecord({ id: 'chat_a', folder: '/a', title: 'Run the epic', agent: 'claude', role: 'orchestrator', updatedAt: AT })

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  terminals = new FakeTerminals()
  h.dm.terminals = terminals
  h.dm.folders = [folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })]
  h.dm.agents = [agentView({ kind: 'claude' })]
  h.dm.agentStatuses.claude = { state: 'signed_in', reason: 'ok' }
  h.dm.chats.chats = [CHAT]
})

afterEach(cleanup)

describe('opening a chat at a thread from another screen', () => {
  it('shows the chat’s terminal, which is all of the chat there is to show', async () => {
    // Any screen with the shell's navigation can ask: here the epic workspace's "open chat" link, given a thread.
    window.localStorage.setItem('dm.selection', JSON.stringify({ folderPath: '/a', epicId: EPIC }))
    h.mount()
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'stub open thread' }))
    await settle()

    const workspace = within(screen.getByRole('main', { name: 'Workspace' }))
    expect(workspace.getByRole('heading', { level: 1, name: 'Run the epic' })).toBeTruthy()
    expect(terminals.calls).toEqual([['/a', 'chat_a']])
    expect(h.terminalKit.latest().host).toBe(workspace.getByTestId('terminal-host'))
  })
})

it('takes the epic host source-file landing once, then does not repeat it on returning to Source control', async () => {
  window.localStorage.setItem('dm.selection', JSON.stringify({ folderPath: '/a', epicId: EPIC }))
  window.localStorage.setItem('dm.folderTabs', JSON.stringify({ '/a': 'epics' }))
  h.git.setState('/a', { kind: 'repository', status: {
    root: '/a', branch: { name: 'main', headOid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0 },
    files: [], inProgress: null, lastFetchedAt: null, remote: null
  } })
  h.mount()
  await settle()
  act(() => h.epicProps.at(-1)!.orchestration.onOpenSourceFile('/a/committed.ts'))
  await settle()
  expect(screen.getByText('This file has no uncommitted changes')).toBeTruthy()
  expect(JSON.parse(localStorage.getItem('dm.folderTabs') ?? '{}')).toEqual({ '/a': 'source' })
  fireEvent.click(screen.getByRole('tab', { name: 'Epics' }))
  await settle()
  fireEvent.click(screen.getByRole('tab', { name: 'Source control' }))
  await settle()
  expect(screen.queryByText('This file has no uncommitted changes')).toBeNull()
  expect(h.git.calls.filter(call => call.method === 'getWorkingDiff')).toEqual([])
})
