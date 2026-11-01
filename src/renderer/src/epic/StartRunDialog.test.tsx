// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentAuthStatus, AgentId, AgentView } from '../../../shared/desktop/api'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { SignInRecorder } from '../__mocks__/signInRecorder'
import type { StartRunChoice } from './orchestration'
import { StartRunDialog } from './StartRunDialog'

let dm: FakeDm
let recorder: SignInRecorder

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  recorder = new SignInRecorder()
})

afterEach(() => {
  cleanup()
})

const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'ok' }
const SIGNED_OUT: AgentAuthStatus = { state: 'signed_out', reason: 'no' }

const claude = agentView({ kind: 'claude' })
const codex = agentView({ kind: 'codex', executablePath: '/bin/codex', version: '0.9.1' })
const autonomous = agentView({ kind: 'autonomous', executablePath: '/bin/a8s' })

interface Setup {
  agents?: AgentView[]
  statuses?: Partial<Record<AgentId, AgentAuthStatus>>
  busy?: boolean
  multiRepo?: boolean
  branchName?: string | null
  /** What recording the branch comes to; true when unset. */
  branchAccepted?: boolean
}

interface Calls {
  agent: StartRunChoice[]
  pending: number
  closed: number
  addAgent: number
  /** The order of branch recordings and run starts. */
  order: string[]
}

/** The dialog over statuses it is told about, as the shell tells it: a status a sign-in prompt finds is kept. */
function Harness({ setup, calls }: { setup: Setup; calls: Calls }): JSX.Element {
  const [statuses, setStatuses] = useState(setup.statuses ?? { claude: SIGNED_IN, codex: SIGNED_IN })
  return (
    <StartRunDialog
      epicTitle="Agent chats"
      folderPath="/a"
      agents={setup.agents ?? [claude, codex]}
      statuses={statuses}
      busy={setup.busy ?? false}
      multiRepo={setup.multiRepo ?? false}
      branchName={setup.branchName ?? null}
      onSetBranch={async (name) => {
        await Promise.resolve()
        calls.order.push(`setEpicBranch:${name}`)
        return setup.branchAccepted ?? true
      }}
      onRunWithAgent={(choice) => {
        calls.agent.push(choice)
        calls.order.push('queueRun')
      }}
      onLeavePending={() => {
        calls.pending += 1
        calls.order.push('queueRun')
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
  const calls: Calls = { agent: [], pending: 0, closed: 0, addAgent: 0, order: [] }
  render(recorder.wrap(<Harness setup={setup} calls={calls} />))
  await settle()
  return calls
}

const dialog = (): ReturnType<typeof within> => within(screen.getByRole('dialog', { name: 'Start run' }))
const agentRadio = (name: string): HTMLInputElement => dialog().getByRole('radio', { name: new RegExp(name) })
const modelOptions = (): string[] =>
  Array.from((dialog().getByLabelText('Model') as HTMLSelectElement).options).map((option) => option.value)
const runWithAgent = (): HTMLButtonElement => dialog().getByRole('button', { name: 'Run with agent' }) as HTMLButtonElement
const leavePending = (): HTMLButtonElement => dialog().getByRole('button', { name: 'Leave pending' }) as HTMLButtonElement

describe('StartRunDialog: the folder default agent', () => {
  it('opens with the folder’s default agent chosen when it can chat, and runs it', async () => {
    dm.folderDefaults['/a'] = 'codex'
    const calls = await open()
    expect(dm.agentCalls.filter((call) => call.method === 'folderDefaultAgent')).toEqual([
      { method: 'folderDefaultAgent', args: ['/a'] }
    ])
    expect(agentRadio('Codex').checked).toBe(true)
    fireEvent.click(runWithAgent())
    expect(calls.agent).toEqual([{ agent: 'codex', model: null }])
  })

  it('waits for the default before it can run with an agent', async () => {
    dm.folderDefaults['/a'] = 'codex'
    const hold = dm.holdAgent('folderDefaultAgent')
    await open()
    expect(runWithAgent().disabled).toBe(true)
    hold.resolve()
    await settle()
    expect(agentRadio('Codex').checked).toBe(true)
    expect(runWithAgent().disabled).toBe(false)
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
    expect(runWithAgent().disabled).toBe(false)
  })
})

describe('StartRunDialog: a custom agent', () => {
  it('preselects a custom agent default by its id', async () => {
    const custom = agentView({ kind: 'custom' })
    dm.folderDefaults['/a'] = custom.id
    const calls = await open({ agents: [claude, custom], statuses: { claude: SIGNED_IN, [custom.id]: SIGNED_IN } })
    expect(agentRadio('Custom agent').checked).toBe(true)
    fireEvent.click(runWithAgent())
    expect(calls.agent[0]?.agent).toBe(custom.id)
  })

  it('uses a custom agent’s id when it is the first that can chat', async () => {
    const custom = agentView({ kind: 'custom' })
    const calls = await open({ agents: [custom, claude], statuses: { claude: SIGNED_IN, [custom.id]: SIGNED_IN } })
    expect(agentRadio('Custom agent').checked).toBe(true)
    fireEvent.click(runWithAgent())
    expect(calls.agent[0]?.agent).toBe(custom.id)
  })
})

describe('StartRunDialog: run with an agent', () => {
  it('offers only connected agents that are signed in, the first one chosen, with that agent’s models', async () => {
    await open({ agents: [claude, codex], statuses: { claude: SIGNED_OUT, codex: SIGNED_IN } })

    expect(dialog().getAllByRole('radio')).toHaveLength(1)
    expect(agentRadio('Codex').checked).toBe(true)
    expect(modelOptions()).toEqual([''])
  })

  it('shows the models of the agent that is picked', async () => {
    await open()
    expect(agentRadio('Claude Code').checked).toBe(true)
    expect(modelOptions()).toEqual(['default', 'opus', 'sonnet', 'haiku'])

    fireEvent.click(agentRadio('Codex'))
    await settle()

    expect(modelOptions()).toEqual([''])
  })

  it('starts the chosen agent on the chosen model', async () => {
    const calls = await open()
    fireEvent.change(dialog().getByLabelText('Model'), { target: { value: 'sonnet' } })

    fireEvent.click(runWithAgent())

    expect(calls.agent).toEqual([{ agent: 'claude', model: 'sonnet' }])
    expect(calls.pending).toBe(0)
  })

  it('offers a custom agent by its name and runs it on CLI default', async () => {
    const custom = agentView({ kind: 'custom', displayName: 'My ACP' })
    const calls = await open({ agents: [custom], statuses: { [custom.id]: { state: 'unchecked', reason: 'Not checked.' } } })
    expect(agentRadio('My ACP').checked).toBe(true)
    expect(Array.from((dialog().getByLabelText('Model') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual(['CLI default'])

    fireEvent.click(runWithAgent())

    expect(calls.agent).toEqual([{ agent: custom.id, model: null }])
  })

  it('says the orchestrator cannot save plans, and offers no role or Allow save choice', async () => {
    await open()

    expect(dialog().getByText(/cannot save plans/)).toBeTruthy()
    expect(dialog().queryByLabelText('Role')).toBeNull()
    expect(dialog().queryByRole('checkbox')).toBeNull()
  })
})

describe('StartRunDialog: the model choice', () => {
  it('lists Claude Code’s curated models, and starts Default (recommended) with model null so the CLI picks', async () => {
    const calls = await open()
    const select = dialog().getByLabelText('Model') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['Default (recommended)', 'Opus', 'Sonnet', 'Haiku'])
    expect(select.value).toBe('default')

    fireEvent.click(runWithAgent())

    expect(calls.agent).toEqual([{ agent: 'claude', model: null }])
  })

  it('offers CLI default for an agent the app lists no models for, and starts it with model null', async () => {
    const calls = await open({ agents: [codex], statuses: { codex: SIGNED_IN } })
    const select = dialog().getByLabelText('Model') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['CLI default'])

    fireEvent.click(runWithAgent())

    expect(calls.agent).toEqual([{ agent: 'codex', model: null }])
  })

  it('forgets a model picked for one agent when another is picked', async () => {
    const calls = await open()
    fireEvent.change(dialog().getByLabelText('Model'), { target: { value: 'haiku' } })
    fireEvent.click(agentRadio('Codex'))
    fireEvent.click(agentRadio('Claude Code'))

    fireEvent.click(runWithAgent())

    expect(calls.agent).toEqual([{ agent: 'claude', model: null }])
  })
})

describe('StartRunDialog: Autonomous takes a typed model', () => {
  const openAutonomous = (): Promise<Calls> => open({ agents: [autonomous], statuses: { autonomous: SIGNED_IN } })
  const modelBox = (): HTMLInputElement => dialog().getByRole('textbox', { name: 'Model' }) as HTMLInputElement

  it('starts on its default model while the box is empty', async () => {
    const calls = await openAutonomous()
    expect(modelBox().value).toBe('')

    fireEvent.click(runWithAgent())

    expect(calls.agent).toEqual([{ agent: 'autonomous', model: null }])
  })

  it('starts on the model typed, trimmed', async () => {
    const calls = await openAutonomous()
    fireEvent.change(modelBox(), { target: { value: '  anthropic/claude-opus-4.5 ' } })

    fireEvent.click(runWithAgent())

    expect(calls.agent).toEqual([{ agent: 'autonomous', model: 'anthropic/claude-opus-4.5' }])
  })

  it.each(['--yolo', 'opus; rm -rf', 'a"b', 'x'.repeat(201)])('refuses %s: says why and cannot run with the agent', async (typed) => {
    const calls = await openAutonomous()
    fireEvent.change(modelBox(), { target: { value: typed } })

    expect(dialog().getByRole('alert').textContent).toMatch(/model id holds only/)
    expect(modelBox().getAttribute('aria-invalid')).toBe('true')
    expect(runWithAgent().disabled).toBe(true)
    fireEvent.click(runWithAgent())
    expect(calls.agent).toEqual([])
    expect(leavePending().disabled).toBe(false)
  })

  it('can run again once the typed model is fixed', async () => {
    const calls = await openAutonomous()
    fireEvent.change(modelBox(), { target: { value: '-bad' } })
    fireEvent.change(modelBox(), { target: { value: 'good-model' } })

    expect(dialog().queryByRole('alert')).toBeNull()
    fireEvent.click(runWithAgent())
    expect(calls.agent).toEqual([{ agent: 'autonomous', model: 'good-model' }])
  })
})

describe('StartRunDialog: leave pending', () => {
  it('leaves the run pending without choosing an agent', async () => {
    const calls = await open()

    fireEvent.click(leavePending())

    expect(calls.pending).toBe(1)
    expect(calls.agent).toEqual([])
  })

  it('says what pending means: an orchestrator you start yourself picks the run up', async () => {
    await open()

    expect(dialog().getByText(/external orchestrator/)).toBeTruthy()
  })
})

describe('StartRunDialog: no agent that is connected and signed in', () => {
  it('links to the add-agent pane, cannot run with an agent, and still leaves the run pending', async () => {
    const calls = await open({ agents: [], statuses: {} })

    expect(dialog().getByText('No agent is connected and signed in.')).toBeTruthy()
    expect(dialog().queryByLabelText('Model')).toBeNull()
    expect(runWithAgent().disabled).toBe(true)
    fireEvent.click(dialog().getByRole('button', { name: 'Add Claude Code' }))
    expect(calls.addAgent).toBe(1)

    expect(leavePending().disabled).toBe(false)
    fireEvent.click(leavePending())
    expect(calls.pending).toBe(1)
  })

  it('lists a connected agent that is signed out with Sign in, and cannot run with it', async () => {
    const calls = await open({ agents: [claude, codex], statuses: { claude: SIGNED_OUT, codex: SIGNED_IN } })

    const unavailable = within(dialog().getByRole('list', { name: 'Not available' }))
    expect(unavailable.getByText('Signed out')).toBeTruthy()
    expect(dialog().queryByRole('radio', { name: /Claude Code/ })).toBeNull()
    fireEvent.click(unavailable.getByRole('button', { name: 'Sign in' }))

    expect(recorder.agents()).toEqual(['claude'])
    expect(calls.closed).toBe(0)
  })

  it('makes the signed-out agent selectable once the status says signed in, without leaving the dialog', async () => {
    const calls = await open({ agents: [claude], statuses: { claude: SIGNED_OUT } })
    expect(runWithAgent().disabled).toBe(true)
    fireEvent.click(dialog().getByRole('button', { name: 'Sign in' }))
    act(() => recorder.finish(SIGNED_IN))
    await settle()

    expect(agentRadio('Claude Code').checked).toBe(true)
    expect(dialog().queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(modelOptions()).toEqual(['default', 'opus', 'sonnet', 'haiku'])
    expect(runWithAgent().disabled).toBe(false)
    fireEvent.click(runWithAgent())
    expect(calls.agent).toEqual([{ agent: 'claude', model: null }])
    expect(calls.closed).toBe(0)
  })
})

describe('StartRunDialog: busy and closing', () => {
  it('disables both choices while the run is being started', async () => {
    await open({ busy: true })

    expect([runWithAgent().disabled, leavePending().disabled]).toEqual([true, true])
  })

  it('closes from Cancel and from Escape', async () => {
    const calls = await open()

    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(calls.closed).toBe(2)
  })
})

describe('StartRunDialog: the epic branch in a folder of repositories', () => {
  const branchField = (): HTMLInputElement | null => dialog().queryByRole('textbox', { name: 'Epic branch' }) as HTMLInputElement | null

  it('asks for the branch only in a folder of repositories without one, prefilled with a slug of the title', async () => {
    await open({ multiRepo: true })
    expect(branchField()?.value).toBe('agent-chats')
    expect(branchField()?.required).toBe(true)
  })

  it('shows a set branch read-only', async () => {
    await open({ multiRepo: true, branchName: 'feature/chats' })
    expect(branchField()).toBeNull()
    expect(dialog().getByRole('region', { name: 'Epic branch' }).textContent).toContain('feature/chats')
  })

  it('has no branch field in a single repository', async () => {
    const calls = await open({ branchName: null })
    expect(dialog().queryByRole('region', { name: 'Epic branch' })).toBeNull()
    fireEvent.click(leavePending())
    expect(calls.order).toEqual(['queueRun'])
  })

  it('refuses an invalid name', async () => {
    const calls = await open({ multiRepo: true })
    fireEvent.change(branchField() as HTMLInputElement, { target: { value: 'bad..name' } })
    expect(dialog().getByRole('alert').textContent).toBe('Not a valid branch name')
    expect([leavePending().disabled, runWithAgent().disabled]).toEqual([true, true])
    fireEvent.change(branchField() as HTMLInputElement, { target: { value: '' } })
    expect(leavePending().disabled).toBe(true)
    fireEvent.click(leavePending())
    await settle()
    expect(calls.order).toEqual([])
  })

  it('records the branch before the run is queued, both ways', async () => {
    const calls = await open({ multiRepo: true })
    fireEvent.change(branchField() as HTMLInputElement, { target: { value: 'feature/chats' } })
    fireEvent.click(leavePending())
    await settle()
    fireEvent.click(runWithAgent())
    await settle()
    expect(calls.order).toEqual(['setEpicBranch:feature/chats', 'queueRun', 'setEpicBranch:feature/chats', 'queueRun'])
  })

  it('does not queue the run when recording the branch is refused', async () => {
    const calls = await open({ multiRepo: true, branchAccepted: false })
    fireEvent.click(leavePending())
    await settle()
    expect(calls.order).toEqual(['setEpicBranch:agent-chats'])
  })
})
