// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FakeChats } from '../__mocks__/fakeChats'
import { chatRecord } from '../__mocks__/fixtures'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import { fakeOrchestration, readyAgent, type FakeOrchestration } from './__mocks__/fakeOrchestration'
import { runView } from './__mocks__/fixtures'
import { renderWorkspace, type WorkspaceHarness } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
})

const FOLDER = '/home/u/code/darkmechanicus'
const EPIC_TITLE = 'Planning vertical slice'
const QUEUED_TOAST = 'Run queued. It starts when an orchestrator picks it up.'

/** An epic with a saved plan and no run, so Start run is on offer. */
function idleBackend(): { backend: FakeBackend; chats: FakeChats } {
  const backend = new FakeBackend(scenario({ run: null, checkpoint: null }))
  const chats = new FakeChats()
  chats.modelLists = {
    claude: [
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' }
    ],
    codex: [{ id: 'gpt-5', label: 'GPT-5' }]
  }
  chats.orchestration = { epicTitle: EPIC_TITLE, queueRun: (_folder, epicId) => backend.runner('queueRun', { epicId }) }
  backend.chats = chats
  return { backend, chats }
}

/** One signed-in Claude Code, as the shell would pass it. */
function withClaude(patch: Partial<FakeOrchestration> = {}): FakeOrchestration {
  const { agent, status } = readyAgent('claude')
  return fakeOrchestration({ agents: [agent], statuses: { claude: status }, ...patch })
}

async function openDialog(): Promise<ReturnType<typeof within>> {
  fireEvent.click(await screen.findByRole('button', { name: 'Start run' }))
  return within(await screen.findByRole('dialog', { name: 'Start run' }))
}

/** The workspace stays where it is: no chat or agent pane is opened, and the shell is told its chats changed. */
async function stays(harness: WorkspaceHarness, host: FakeOrchestration): Promise<void> {
  await waitFor(() => expect(host.chatsChanged.count).toBe(1))
  expect(host.openedChats).toEqual([])
  expect(host.added.count).toBe(0)
  expect(harness.opened).toEqual([])
}

describe('Start run: the dialog and Leave pending', () => {
  it('opens a dialog instead of queueing, and queues nothing until a choice is made', async () => {
    const { backend } = idleBackend()
    renderWorkspace(backend)

    const dialog = await openDialog()

    expect(dialog.getByRole('button', { name: 'Leave pending' })).toBeTruthy()
    expect(dialog.getByRole('button', { name: 'Run with agent' })).toBeTruthy()
    expect(backend.inputs('queueRun')).toEqual([])
  })

  it('queues the run exactly as the Start run button did, and closes the dialog', async () => {
    const { backend, chats } = idleBackend()
    const harness = renderWorkspace(backend, { orchestration: withClaude() })

    const dialog = await openDialog()
    fireEvent.click(dialog.getByRole('button', { name: 'Leave pending' }))

    expect(await screen.findByText(QUEUED_TOAST)).toBeTruthy()
    expect(backend.inputs('queueRun')).toEqual([{ epicId: 'ep_1' }])
    expect(harness.changes.count).toBe(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(chats.callsOf('startOrchestrator')).toEqual([])
    expect(chats.chats).toEqual([])
    expect((await screen.findByText('QUEUED')).textContent).toBe('QUEUED')
  })

  it('says in the run bar that the queued run is waiting for an orchestrator', async () => {
    const { backend } = idleBackend()
    renderWorkspace(backend)

    fireEvent.click((await openDialog()).getByRole('button', { name: 'Leave pending' }))

    const bar = await screen.findByLabelText('Run')
    expect(within(bar).getByText('Waiting for an orchestrator. An agent picks this run up with start_run.')).toBeTruthy()
  })

  it('shows the refusal in the banner, with the dialog closed, when the run cannot be queued', async () => {
    const { backend } = idleBackend()
    backend.fail('queueRun', 'conflict', 'Epic ep_1 already has an active run.')
    renderWorkspace(backend)

    fireEvent.click((await openDialog()).getByRole('button', { name: 'Leave pending' }))

    expect(await screen.findByText('Epic ep_1 already has an active run.')).toBeTruthy()
    expect(screen.queryByText(QUEUED_TOAST)).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Start run: run with an agent', () => {
  it('offers only connected, signed-in agents, with that agent’s models', async () => {
    const { agent: codex } = readyAgent('codex')
    const { agent: claude, status } = readyAgent('claude')
    const host = fakeOrchestration({ agents: [claude, codex], statuses: { claude: status, codex: { state: 'signed_out', reason: 'no' } } })
    renderWorkspace(idleBackend().backend, { orchestration: host })

    const dialog = await openDialog()

    expect(dialog.getAllByRole('radio')).toHaveLength(1)
    expect(dialog.getByRole('radio', { name: /Claude Code/ })).toBeTruthy()
    await waitFor(() => expect(Array.from((dialog.getByLabelText('Model') as HTMLSelectElement).options).map((option) => option.value)).toEqual(['opus', 'sonnet']))
  })

  it('queues the run, then creates the orchestrator chat in this folder with that agent and model, the run id recorded and Allow save off', async () => {
    const { backend, chats } = idleBackend()
    const host = withClaude()
    const harness = renderWorkspace(backend, { orchestration: host })

    const dialog = await openDialog()
    await waitFor(() => expect(dialog.getByLabelText('Model')).toBeTruthy())
    fireEvent.change(dialog.getByLabelText('Model'), { target: { value: 'sonnet' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Run with agent' }))

    expect(await screen.findByText('Run queued. Claude Code is orchestrating it.')).toBeTruthy()
    expect(backend.inputs('queueRun')).toEqual([{ epicId: 'ep_1' }])
    expect(chats.callsOf('startOrchestrator')).toEqual([[{ folder: FOLDER, epicId: 'ep_1', agent: 'claude', model: 'sonnet' }]])
    expect(chats.chats).toHaveLength(1)
    expect(chats.chats[0]).toMatchObject({
      folder: FOLDER,
      agent: 'claude',
      model: 'sonnet',
      role: 'orchestrator',
      allowSave: false,
      title: `Orchestrator · ${EPIC_TITLE}`,
      runId: 'rn_2'
    })
    expect(chats.callsOf('create')).toEqual([])
    await stays(harness, host)
  })

  it('shows the run it started as queued while the main pane stays on the epic', async () => {
    const { backend } = idleBackend()
    renderWorkspace(backend, { orchestration: withClaude() })

    const dialog = await openDialog()
    await waitFor(() => expect(dialog.getByLabelText('Model')).toBeTruthy())
    fireEvent.click(dialog.getByRole('button', { name: 'Run with agent' }))

    expect((await screen.findByText('QUEUED')).textContent).toBe('QUEUED')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(EPIC_TITLE)
  })
})

describe('Start run: when the chat cannot be started', () => {
  it('keeps the run queued and shows why no chat was started', async () => {
    const { backend, chats } = idleBackend()
    chats.orchestrationProblem = 'Run #2 is queued, but Claude Code could not be started: claude exited with code 1. It is waiting for an orchestrator.'
    renderWorkspace(backend, { orchestration: withClaude() })

    const dialog = await openDialog()
    await waitFor(() => expect(dialog.getByLabelText('Model')).toBeTruthy())
    fireEvent.click(dialog.getByRole('button', { name: 'Run with agent' }))

    expect(await screen.findByText(/Run #2 is queued, but Claude Code could not be started/)).toBeTruthy()
    expect(backend.inputs('queueRun')).toEqual([{ epicId: 'ep_1' }])
    expect(chats.chats).toEqual([])
    expect(screen.queryByText('Run queued. Claude Code is orchestrating it.')).toBeNull()
    expect((await screen.findByText('QUEUED')).textContent).toBe('QUEUED')
  })

  it('shows the error and queues nothing when the run cannot be queued at all', async () => {
    const { backend, chats } = idleBackend()
    chats.failures.startOrchestrator = { code: 'conflict', message: 'Epic ep_1 already has an active run.' }
    renderWorkspace(backend, { orchestration: withClaude() })

    const dialog = await openDialog()
    await waitFor(() => expect(dialog.getByLabelText('Model')).toBeTruthy())
    fireEvent.click(dialog.getByRole('button', { name: 'Run with agent' }))

    expect(await screen.findByText('Epic ep_1 already has an active run.')).toBeTruthy()
    expect(chats.chats).toEqual([])
  })
})

describe('Start run: no agent that is connected and signed in', () => {
  it('links the agent choice to the add-agent pane, and Leave pending still queues the run', async () => {
    const { backend, chats } = idleBackend()
    const host = fakeOrchestration()
    renderWorkspace(backend, { orchestration: host })

    const dialog = await openDialog()
    expect(dialog.getByText('No agent is connected and signed in.')).toBeTruthy()
    expect((dialog.getByRole('button', { name: 'Run with agent' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(dialog.getByRole('button', { name: 'Add Claude Code' }))

    expect(host.added.count).toBe(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(backend.inputs('queueRun')).toEqual([])

    fireEvent.click((await openDialog()).getByRole('button', { name: 'Leave pending' }))
    expect(await screen.findByText(QUEUED_TOAST)).toBeTruthy()
    expect(backend.inputs('queueRun')).toEqual([{ epicId: 'ep_1' }])
    expect(chats.callsOf('startOrchestrator')).toEqual([])
  })

  it('lists a connected agent that is signed out with Sign in, in the dialog, which stays open', async () => {
    const { agent } = readyAgent('claude')
    const host = fakeOrchestration({ agents: [agent], statuses: { claude: { state: 'signed_out', reason: 'no' } } })
    renderWorkspace(idleBackend().backend, { orchestration: host })

    const dialog = await openDialog()
    expect((dialog.getByRole('button', { name: 'Run with agent' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(dialog.getByRole('button', { name: 'Sign in' }))

    // The backend cannot open a terminal, so the prompt says so, in the dialog.
    expect(await dialog.findByText('Could not start sign-in')).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('Run bar: who orchestrates', () => {
  const orchestrator = chatRecord({ id: 'chat_9', agent: 'claude', title: 'Orchestrator · Planning vertical slice', runId: 'rn_2' })
  const bystander = chatRecord({ id: 'chat_3', title: 'Plan the next epic' })

  it('links the chat orchestrating the active run, found by the run id recorded on it', async () => {
    const host = fakeOrchestration({ chats: [bystander, orchestrator] })
    renderWorkspace(new FakeBackend(scenario({ run: runView({ state: 'queued', activeSprintOrdinal: null }) })), { orchestration: host })

    const bar = await screen.findByLabelText('Run')
    expect(within(bar).getByText('Orchestrated by Claude Code in')).toBeTruthy()
    fireEvent.click(within(bar).getByRole('button', { name: 'Orchestrator · Planning vertical slice' }))

    expect(host.openedChats).toEqual(['chat_9'])
    expect(within(bar).queryByText(/Waiting for an orchestrator/)).toBeNull()
  })

  it('keeps showing the chat while the run is running', async () => {
    renderWorkspace(new FakeBackend(), { orchestration: fakeOrchestration({ chats: [orchestrator] }) })

    const bar = await screen.findByLabelText('Run')

    expect(within(bar).getByRole('button', { name: 'Orchestrator · Planning vertical slice' })).toBeTruthy()
  })

  it('shows no chat for a run that other chats or an external orchestrator are running', async () => {
    renderWorkspace(new FakeBackend(), { orchestration: fakeOrchestration({ chats: [bystander] }) })

    const bar = await screen.findByLabelText('Run')

    expect(within(bar).queryByText(/Orchestrated by/)).toBeNull()
    expect(within(bar).queryByText(/Waiting for an orchestrator/)).toBeNull()
  })

  it('shows no chat once the run has ended', async () => {
    renderWorkspace(new FakeBackend(scenario({ run: runView({ state: 'completed' }) })), { orchestration: fakeOrchestration({ chats: [orchestrator] }) })

    const bar = await screen.findByLabelText('Run')

    expect(within(bar).queryByText(/Orchestrated by/)).toBeNull()
  })
})
