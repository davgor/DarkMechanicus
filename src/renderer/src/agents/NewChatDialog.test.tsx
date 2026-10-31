// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAuthStatus, AgentId, AgentView } from '../../../shared/desktop/api'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView, folderView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { NewChatDialog } from './NewChatDialog'
import type { NewChatChoice } from './NewChatDialog'
import { SIGN_IN_POLL_MS } from './SignInPrompt'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  dm.chats.modelLists = {
    claude: [
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' }
    ],
    codex: [{ id: 'gpt-5', label: 'GPT-5' }]
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'ok' }
const SIGNED_OUT: AgentAuthStatus = { state: 'signed_out', reason: 'no' }

const claude = agentView({ kind: 'claude' })
const codex = agentView({ kind: 'codex', executablePath: '/bin/codex', version: '0.9.1' })

interface Setup {
  agents?: AgentView[]
  statuses?: Partial<Record<AgentId, AgentAuthStatus>>
  create?: (choice: NewChatChoice) => Promise<boolean>
}

interface Calls {
  created: NewChatChoice[]
  closed: number
  addAgent: number
}

/** The dialog over statuses it is told about, as the shell tells it: a status a sign-in prompt finds is kept. */
function Harness({ setup, calls }: { setup: Setup; calls: Calls }): JSX.Element {
  const [statuses, setStatuses] = useState(setup.statuses ?? { claude: SIGNED_IN, codex: SIGNED_IN })
  return (
    <NewChatDialog
      folder={folderView({ path: '/a', name: 'alpha' })}
      agents={setup.agents ?? [claude, codex]}
      statuses={statuses}
      onCreate={(choice) => {
        calls.created.push(choice)
        return setup.create ? setup.create(choice) : Promise.resolve(true)
      }}
      onAddAgent={() => {
        calls.addAgent += 1
      }}
      onAgentStatus={(kind, status) => setStatuses((previous) => ({ ...previous, [kind]: status }))}
      onClose={() => {
        calls.closed += 1
      }}
    />
  )
}

async function open(setup: Setup = {}): Promise<Calls> {
  const calls: Calls = { created: [], closed: 0, addAgent: 0 }
  render(<Harness setup={setup} calls={calls} />)
  await settle()
  return calls
}

const dialog = (): ReturnType<typeof within> => within(screen.getByRole('dialog', { name: 'New chat in alpha' }))
const agentRadio = (name: string): HTMLInputElement => dialog().getByRole('radio', { name: new RegExp(name) })
const modelOptions = (): string[] =>
  Array.from((dialog().getByLabelText('Model') as HTMLSelectElement).options).map((option) => option.value)
const start = (): HTMLButtonElement => dialog().getByRole('button', { name: 'Start chat' }) as HTMLButtonElement

describe('NewChatDialog: the folder default agent', () => {
  it('opens with the folder’s default agent chosen when it can chat', async () => {
    dm.folderDefaults['/a'] = 'codex'
    await open()
    expect(dm.agentCalls.filter((call) => call.method === 'folderDefaultAgent')).toEqual([
      { method: 'folderDefaultAgent', args: ['/a'] }
    ])
    expect(agentRadio('Codex').checked).toBe(true)
    expect(modelOptions()).toEqual(['gpt-5'])
  })

  it('chooses the default once it arrives, and waits for it before a chat can start', async () => {
    dm.folderDefaults['/a'] = 'codex'
    const hold = dm.holdAgent('folderDefaultAgent')
    await open()
    expect(start().disabled).toBe(true)
    hold.resolve()
    await settle()
    expect(agentRadio('Codex').checked).toBe(true)
    expect(start().disabled).toBe(false)
  })

  it('keeps the first choice when the default is signed out', async () => {
    dm.folderDefaults['/a'] = 'codex'
    await open({ statuses: { claude: SIGNED_IN, codex: SIGNED_OUT } })
    expect(agentRadio('Claude Code').checked).toBe(true)
  })

  it('keeps the first choice when the default is no longer connected', async () => {
    dm.folderDefaults['/a'] = 'codex'
    await open({ agents: [claude], statuses: { claude: SIGNED_IN } })
    expect(agentRadio('Claude Code').checked).toBe(true)
  })

  it('keeps the first choice when the default cannot be read', async () => {
    dm.folderDefaultAgent = () => Promise.reject(new Error('unauthorized'))
    await open()
    expect(agentRadio('Claude Code').checked).toBe(true)
    expect(start().disabled).toBe(false)
  })

  it('lets the person pick another agent over the default', async () => {
    dm.folderDefaults['/a'] = 'codex'
    const calls = await open()
    fireEvent.click(agentRadio('Claude Code'))
    await settle()
    fireEvent.click(start())
    await settle()
    expect(calls.created[0]?.agent).toBe('claude')
  })
})

describe('NewChatDialog: a custom agent', () => {
  it('preselects a custom agent default by its id', async () => {
    const custom = agentView({ kind: 'custom' })
    dm.folderDefaults['/a'] = custom.id
    const calls = await open({ agents: [claude, custom], statuses: { claude: SIGNED_IN, [custom.id]: SIGNED_IN } })
    expect(agentRadio('Custom agent').checked).toBe(true)
    fireEvent.click(start())
    await settle()
    expect(calls.created[0]?.agent).toBe(custom.id)
  })

  it('uses a custom agent’s id when it is the first that can chat', async () => {
    const custom = agentView({ kind: 'custom' })
    const calls = await open({ agents: [custom, claude], statuses: { claude: SIGNED_IN, [custom.id]: SIGNED_IN } })
    expect(agentRadio('Custom agent').checked).toBe(true)
    fireEvent.click(start())
    await settle()
    expect(calls.created[0]?.agent).toBe(custom.id)
  })

  it('lists a custom agent by its name, and offers CLI default when it lists no models', async () => {
    const custom = agentView({ kind: 'custom', displayName: 'My ACP', protocol: 'acp' })
    dm.chats.modelLists = { ...dm.chats.modelLists, [custom.id]: [] }
    const calls = await open({ agents: [claude, custom], statuses: { claude: SIGNED_IN, [custom.id]: { state: 'unchecked', reason: 'Not checked.' } } })
    fireEvent.click(agentRadio('My ACP'))
    await settle()
    expect(Array.from((dialog().getByLabelText('Model') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual(['CLI default'])
    fireEvent.click(start())
    await settle()
    expect(calls.created).toEqual([{ agent: custom.id, model: null, role: 'orchestrator', allowSave: true }])
  })

  it('labels each agent’s version with the agent name its handshake reported, the version alone, or Version unknown', async () => {
    const named = agentView({ kind: 'custom', id: 'cu_1', displayName: 'a8s custom', version: '18.11.2', reportedName: 'omp' })
    const unknown = agentView({ kind: 'custom', id: 'cu_2', displayName: 'Quiet', version: null, reportedName: null })
    await open({ agents: [named, codex, unknown], statuses: { cu_1: SIGNED_IN, codex: SIGNED_IN, cu_2: SIGNED_IN } })
    const hint = (name: string): string | null | undefined => agentRadio(name).closest('label')?.querySelector('.field-hint')?.textContent
    expect(hint('a8s custom')).toBe('omp 18.11.2')
    expect(hint('Codex')).toBe('v0.9.1')
    expect(hint('Quiet')).toBe('Version unknown')
  })
})

describe('NewChatDialog: the agent', () => {
  it('offers only connected agents that are signed in, the first one chosen', async () => {
    await open({ agents: [claude, codex], statuses: { claude: SIGNED_OUT, codex: SIGNED_IN } })
    expect(dialog().getAllByRole('radio')).toHaveLength(1)
    expect(agentRadio('Codex').checked).toBe(true)
    expect(dialog().queryByRole('radio', { name: /Claude Code/ })).toBeNull()
  })

  it('says no agent is ready, points to the add-agent pane, and cannot start a chat', async () => {
    const calls = await open({ agents: [], statuses: {} })
    expect(dialog().getByText('No agent is ready to chat yet. Connect one and sign in to start a chat.')).toBeTruthy()
    expect(dialog().queryByLabelText('Model')).toBeNull()
    expect(start().disabled).toBe(true)
    fireEvent.click(dialog().getByRole('button', { name: 'Add Claude Code' }))
    expect(calls.addAgent).toBe(1)
  })
})

describe('NewChatDialog: signing in from the list', () => {
  it('lists an agent that is signed out with Sign in, and the ones that are not connected with Add, and cannot pick any', async () => {
    const calls = await open({ agents: [claude, codex], statuses: { claude: SIGNED_OUT, codex: SIGNED_IN } })
    const unavailable = within(dialog().getByRole('list', { name: 'Not available' }))
    expect(unavailable.getByText('Signed out')).toBeTruthy()
    expect(unavailable.getAllByText('Not connected')).toHaveLength(2)
    expect(unavailable.getByRole('button', { name: 'Add Autonomous' })).toBeTruthy()
    expect(dialog().queryByRole('radio', { name: /Claude Code/ })).toBeNull()
    fireEvent.click(unavailable.getByRole('button', { name: 'Sign in' }))
    await settle()
    expect(dm.agentCallsOf('signInAgent')).toEqual([['claude']])
    fireEvent.click(unavailable.getByRole('button', { name: 'Add Cursor' }))
    expect(calls.addAgent).toBe(1)
    expect(calls.closed).toBe(0)
  })

  it('shows an agent whose state is unknown with its reason and Check again, and one still being checked with neither', async () => {
    await open({ agents: [claude, codex], statuses: { codex: { state: 'unknown', reason: 'The status command did not answer.' } } })
    expect(dialog().queryAllByRole('radio')).toHaveLength(0)
    expect(dialog().getByText('Checking sign-in…')).toBeTruthy()
    expect(dialog().getByText('Sign-in unknown')).toBeTruthy()
    expect(dialog().getByText('The status command did not answer.')).toBeTruthy()
    expect(dialog().getAllByRole('button', { name: 'Check again' })).toHaveLength(1)
  })

  it('makes a signed-out agent selectable once the status says signed in, without leaving the dialog', async () => {
    const calls = await open({ agents: [claude], statuses: { claude: SIGNED_OUT } })
    expect(dialog().getByText('No agent is ready to chat yet. Connect one and sign in to start a chat.')).toBeTruthy()
    expect(start().disabled).toBe(true)
    vi.useFakeTimers()
    fireEvent.click(dialog().getByRole('button', { name: 'Sign in' }))
    await settle()
    dm.agentStatuses.claude = SIGNED_IN
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS)
    })
    await settle()
    expect(agentRadio('Claude Code').checked).toBe(true)
    expect(dialog().queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(modelOptions()).toEqual(['opus', 'sonnet'])
    expect(start().disabled).toBe(false)
    expect(calls.closed).toBe(0)
  })

})

describe('NewChatDialog: the model', () => {
  it('lists the models of the chosen agent, and the other agent\'s models when the choice changes', async () => {
    await open()
    expect(dm.chats.callsOf('models')).toEqual([['claude']])
    expect(modelOptions()).toEqual(['opus', 'sonnet'])
    fireEvent.click(agentRadio('Codex'))
    await settle()
    expect(modelOptions()).toEqual(['gpt-5'])
  })

  it('cannot start a chat while the models are still loading', async () => {
    const hold = dm.chats.hold('models')
    await open()
    expect(dialog().getByText('Loading models…')).toBeTruthy()
    expect(start().disabled).toBe(true)
    hold.resolve()
    await settle()
    expect(start().disabled).toBe(false)
  })

  it('offers one CLI default choice when the agent lists no models, and starts the chat with model null', async () => {
    dm.chats.modelLists = { claude: [] }
    const calls = await open()
    const select = dialog().getByLabelText('Model') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['CLI default'])
    expect(dialog().getByText('The CLI picks its own model.')).toBeTruthy()
    fireEvent.click(start())
    expect(calls.created).toEqual([{ agent: 'claude', model: null, role: 'orchestrator', allowSave: true }])
  })

  it('reports a model list that could not be read, and still allows the default model', async () => {
    dm.chats.modelFailures = { claude: { code: 'internal', message: 'The agent did not answer.' } }
    const calls = await open()
    expect(dialog().getByText(/Could not list this agent.s models: The agent did not answer\. The chat will use its default model\./)).toBeTruthy()
    fireEvent.click(start())
    expect(calls.created[0]).toMatchObject({ agent: 'claude', model: null })
  })

  it('blocks the chat for an agent whose chats this version does not support', async () => {
    dm.chats.modelFailures = { claude: { code: 'unsupported_capability', message: 'Claude Code chats are not available in this version.' } }
    const calls = await open()
    expect(dialog().getByText('Chats with Claude Code are not available in this version yet.')).toBeTruthy()
    expect(start().disabled).toBe(true)
    fireEvent.click(start())
    expect(calls.created).toEqual([])
  })
})

describe('NewChatDialog: the role and Allow save', () => {
  const allowSave = (): HTMLInputElement | null => dialog().queryByRole('checkbox', { name: /Allow save/ })
  const chooseRole = (role: string): void => {
    fireEvent.change(dialog().getByLabelText('Role'), { target: { value: role } })
  }

  it('offers the four Dark Mechanicus roles', async () => {
    await open()
    const roles = Array.from((dialog().getByLabelText('Role') as HTMLSelectElement).options).map((option) => option.value)
    expect(roles).toEqual(['planner', 'orchestrator', 'worker', 'reviewer'])
  })

  it('shows Allow save, on by default, for a planner and an orchestrator only', async () => {
    await open()
    for (const role of ['planner', 'orchestrator']) {
      chooseRole(role)
      expect(allowSave()?.checked).toBe(true)
    }
    for (const role of ['worker', 'reviewer']) {
      chooseRole(role)
      expect(allowSave()).toBeNull()
    }
  })

  it('keeps what was chosen for Allow save when the role changes and changes back', async () => {
    await open()
    chooseRole('planner')
    fireEvent.click(allowSave() as HTMLInputElement)
    expect(allowSave()?.checked).toBe(false)
    chooseRole('worker')
    chooseRole('orchestrator')
    expect(allowSave()?.checked).toBe(false)
  })
})

describe('NewChatDialog: creating the chat', () => {
  it('creates the chat with exactly the agent, model, role and Allow save that were chosen', async () => {
    const calls = await open()
    fireEvent.click(agentRadio('Claude Code'))
    await settle()
    fireEvent.change(dialog().getByLabelText('Model'), { target: { value: 'sonnet' } })
    fireEvent.change(dialog().getByLabelText('Role'), { target: { value: 'planner' } })
    fireEvent.click(dialog().getByRole('checkbox', { name: /Allow save/ }))
    fireEvent.click(start())
    await settle()
    expect(calls.created).toEqual([{ agent: 'claude', model: 'sonnet', role: 'planner', allowSave: false }])
  })

  it('starts the first model and an orchestrator that may save, when nothing else is touched', async () => {
    const calls = await open()
    fireEvent.click(start())
    expect(calls.created).toEqual([{ agent: 'claude', model: 'opus', role: 'orchestrator', allowSave: true }])
  })

  it('never lets a worker or reviewer save, whatever Allow save said before', async () => {
    const calls = await open()
    fireEvent.change(dialog().getByLabelText('Role'), { target: { value: 'worker' } })
    fireEvent.click(start())
    expect(calls.created).toEqual([{ agent: 'claude', model: 'opus', role: 'worker', allowSave: false }])
  })

  it('uses the models of the agent that was chosen second, not the first one\'s selection', async () => {
    const calls = await open()
    fireEvent.change(dialog().getByLabelText('Model'), { target: { value: 'sonnet' } })
    fireEvent.click(agentRadio('Codex'))
    await settle()
    fireEvent.click(start())
    expect(calls.created).toEqual([{ agent: 'codex', model: 'gpt-5', role: 'orchestrator', allowSave: true }])
  })

  it('stays open, ready to try again, when the chat could not be created', async () => {
    const calls = await open({ create: () => Promise.resolve(false) })
    fireEvent.click(start())
    await settle()
    expect(calls.closed).toBe(0)
    expect(start().disabled).toBe(false)
  })

  it('closes from Cancel and from Escape without creating anything', async () => {
    const calls = await open()
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(calls.closed).toBe(2)
    expect(calls.created).toEqual([])
  })
})
