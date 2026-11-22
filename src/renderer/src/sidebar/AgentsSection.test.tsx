// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView, chatRecord, epicSummary, folderView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { SignInRecorder } from '../__mocks__/signInRecorder'
import type { AgentAuthStatus, AgentId, AgentView } from '../../../shared/desktop/api'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { EpicListState } from '../app/useEpicLists'
import type { AgentStatuses } from '../agents/useAgents'
import { AgentsSection } from './AgentsSection'

let dm: FakeDm
let recorder: SignInRecorder

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  recorder = new SignInRecorder()
})

afterEach(cleanup)

const claude = agentView({ kind: 'claude', version: '2.1.4' })
const codex = agentView({ kind: 'codex', version: null, executablePath: '/usr/local/bin/codex' })

interface Calls {
  added: number
  selected: AgentId[]
  statuses: [AgentId, AgentAuthStatus][]
}

function renderSection(
  agents: AgentView[],
  statuses: AgentStatuses = {},
  selected: AgentId | null = null,
  chatSetup: { chats: ChatRecord[]; folders: TrackedFolderView[]; epics: Record<string, EpicListState> } = { chats: [], folders: [], epics: {} }
): Calls {
  const calls: Calls = { added: 0, selected: [], statuses: [] }
  render(
    recorder.wrap(
      <AgentsSection
        agents={agents}
        statuses={statuses}
        selected={selected}
        chats={{ list: { status: 'ready', chats: chatSetup.chats }, folders: chatSetup.folders, epics: chatSetup.epics, selectedChatId: null, onOpen: () => undefined, onRename: () => Promise.resolve(true), onDelete: () => Promise.resolve(true), onSummon: () => undefined }}
        onAdd={() => {
          calls.added += 1
        }}
        onSelect={(kind) => calls.selected.push(kind)}
        onStatus={(kind, status) => calls.statuses.push([kind, status])}
      />
    )
  )
  return calls
}

describe('AgentsSection head', () => {
  it('has an AGENTS eyebrow and a ghost + button labelled Add an agent', () => {
    const calls = renderSection([])
    expect(screen.getByText('AGENTS')).toBeTruthy()
    const add = screen.getByRole('button', { name: 'Add an agent' })
    expect(add.className).toContain('btn-ghost')
    expect(add.querySelector('[data-icon="plus"]')).toBeTruthy()
    fireEvent.click(add)
    expect(calls.added).toBe(1)
  })
})

describe('AgentsSection sign-in', () => {
  const signedOut: AgentAuthStatus = { state: 'signed_out', reason: 'Not signed in.' }
  const unknown: AgentAuthStatus = { state: 'unknown', reason: 'The status command did not answer.' }

  it('warns about a signed-out agent and offers Sign in on its row, without opening its page, and passes on what the sign-in view found', () => {
    const calls = renderSection([claude, codex], { claude: { state: 'signed_in', reason: 'Signed in.' }, codex: signedOut })
    const [first, second] = within(screen.getByRole('list')).getAllByRole('listitem') as HTMLElement[]
    expect(within(first as HTMLElement).queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(within(second as HTMLElement).getByText('Signed out').closest('.agent-state')?.className).toContain('tone-warn')
    fireEvent.click(within(second as HTMLElement).getByRole('button', { name: 'Sign in' }))
    expect(recorder.agents()).toEqual(['codex'])
    expect(calls.selected).toEqual([])
    act(() => recorder.finish({ state: 'signed_in', reason: 'Signed in.' }))
    expect(calls.statuses).toEqual([['codex', { state: 'signed_in', reason: 'Signed in.' }]])
  })

  it('shows an unknown state with its reason and Check again, and passes on what the check finds', async () => {
    const calls = renderSection([claude], { claude: unknown })
    expect(screen.getByText('The status command did not answer.')).toBeTruthy()
    dm.agentStatuses.claude = { state: 'signed_in', reason: 'Signed in.' }
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await settle()
    expect(calls.statuses).toEqual([['claude', { state: 'signed_in', reason: 'Signed in.' }]])
  })

  it('offers nothing while the state is still being asked', () => {
    renderSection([claude])
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
  })
})

describe('AgentsSection list', () => {
  it('explains how to add an agent when there are none', () => {
    renderSection([])
    expect(screen.getByText('No agents yet. Use + to add one.')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('lists each connected agent with its name, version and sign-in state', () => {
    renderSection([claude, codex], {
      claude: { state: 'signed_in', reason: 'Signed in.' },
      codex: { state: 'signed_out', reason: 'Not signed in.' }
    })
    expect(screen.queryByText('No agents yet. Use + to add one.')).toBeNull()
    const [first, second] = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(within(first as HTMLElement).getByText('Claude Code')).toBeTruthy()
    expect(within(first as HTMLElement).getByText('v2.1.4')).toBeTruthy()
    expect(within(first as HTMLElement).getByText('Signed in')).toBeTruthy()
    expect(within(second as HTMLElement).getByText('Codex')).toBeTruthy()
    expect(within(second as HTMLElement).getByText('Version unknown')).toBeTruthy()
    expect(within(second as HTMLElement).getByText('Signed out')).toBeTruthy()
  })

  it('says the sign-in state is being checked until it arrives', () => {
    renderSection([claude])
    expect(screen.getByText('Checking sign-in…')).toBeTruthy()
  })

  it('opens the page of the agent whose row is chosen', () => {
    const calls = renderSection([claude, codex])
    fireEvent.click(screen.getByRole('button', { name: /^Codex/ }))
    expect(calls.selected).toEqual(['codex'])
  })

  it('marks the agent whose page is open', () => {
    renderSection([claude, codex], {}, 'codex')
    expect(screen.getByRole('button', { name: /^Codex/ }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: /^Claude Code/ }).getAttribute('aria-current')).toBeNull()
  })

  it('lists a custom agent by its name, with no Sign in, and opens its page by its id', () => {
    const custom = agentView({ kind: 'custom', displayName: 'My Claude', connectedVia: 'custom', version: '2.1.4' })
    const calls = renderSection([claude, custom], { [custom.id]: { state: 'unchecked', reason: 'Not checked.' } })
    const row = within(within(screen.getByRole('list')).getAllByRole('listitem')[1] as HTMLElement)
    expect(row.getByText('My Claude')).toBeTruthy()
    expect(row.getByText('Sign-in not checked')).toBeTruthy()
    expect(row.queryByRole('button', { name: 'Sign in' })).toBeNull()
    fireEvent.click(row.getByRole('button', { name: /^My Claude/ }))
    expect(calls.selected).toEqual([custom.id])
  })
})

describe('AgentsSection board conversations', () => {
  const folder = folderView({ path: '/a', name: 'alpha' })
  const epicLists = { '/a': { status: 'ready', epics: [epicSummary({ id: 'ep_alpha', title: 'Alpha migration' })], error: null } } satisfies Record<string, EpicListState>

  it('names an epic-bound chat, leaves an unbound chat unlabelled, and explains that deleting the bound chat only unbinds it', () => {
    const bound = chatRecord({ id: 'chat_bound', folder: '/a', agent: 'claude', title: 'Bound work', conversation: { epicId: 'ep_alpha' } })
    const unbound = chatRecord({ id: 'chat_free', folder: '/a', agent: 'claude', title: 'Free work' })
    renderSection([claude], {}, null, { chats: [bound, unbound], folders: [folder], epics: epicLists })
    fireEvent.click(screen.getByRole('button', { name: 'Chats of Claude Code' }))

    const boundRow = screen.getByRole('button', { name: /^Bound work/ })
    expect(within(boundRow).getByText('Board conversation · Alpha migration')).toBeTruthy()
    expect(within(screen.getByRole('button', { name: /^Free work/ })).queryByText(/Board conversation/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Bound work' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(screen.getByText('This unbinds it from the epic; the conversation history stays on the board.', { exact: false })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Free work' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(screen.queryByText(/This unbinds it from/)).toBeNull()
  })

  it('labels card and unknown-epic conversations without inventing names', () => {
    const card = chatRecord({
      id: 'chat_card',
      folder: '/workspace/project',
      agent: 'claude',
      title: 'Card answer',
      conversation: { cardId: 'kc_missing' }
    })
    const unknownEpic = chatRecord({
      id: 'chat_unknown',
      folder: '/workspace/project',
      agent: 'claude',
      title: 'Epic answer',
      conversation: { epicId: 'ep_missing' }
    })
    renderSection([claude], {}, null, { chats: [card, unknownEpic], folders: [], epics: {} })
    fireEvent.click(screen.getByRole('button', { name: 'Chats of Claude Code' }))

    const cardRow = screen.getByRole('button', { name: /^Card answer/ })
    const epicRow = screen.getByRole('button', { name: /^Epic answer/ })
    expect(within(cardRow).getByText('project')).toBeTruthy()
    expect(within(cardRow).getByText('Board conversation')).toBeTruthy()
    expect(within(epicRow).getByText('Board conversation')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Card answer' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(screen.getByText('This unbinds it from the card; the conversation history stays on the board.', { exact: false })).toBeTruthy()
  })
})

describe('AgentsSection versions', () => {
  it('labels a built-in’s version, and a custom CLI’s as unknown', () => {
    const builtIn = agentView({ kind: 'codex', version: '0.9.1' })
    const custom = agentView({ kind: 'custom', id: 'cu_3', displayName: 'Quiet', version: null })
    renderSection([builtIn, custom])
    const [first, second] = within(screen.getByRole('list')).getAllByRole('listitem') as HTMLElement[]
    expect(within(first as HTMLElement).getByText('v0.9.1')).toBeTruthy()
    expect(within(second as HTMLElement).getByText('Version unknown')).toBeTruthy()
  })
})

it('collapses the Agents section while keeping its add control available', () => {
  const calls = renderSection([claude])
  const toggle = screen.getByRole('button', { name: 'Agents' })
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(toggle.firstElementChild?.textContent).toBe('AGENTS')
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('button', { name: /^Claude Code/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Add an agent' }))
  expect(calls.added).toBe(1)
  fireEvent.click(toggle)
  expect(screen.getByRole('button', { name: /^Claude Code/ })).toBeTruthy()
})
