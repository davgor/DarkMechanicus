// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentAuthStatus, AgentView } from '../../../shared/desktop/api'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { installDomShims } from './__mocks__/domShims'
import type { FakeBackend } from './__mocks__/fakeBackend'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'
import { TRANSFER_PROMPT, transferSetup } from './__mocks__/transferBackend'
import type { StartRunChoice } from './orchestration'
import { TransferDialog } from './TransferDialog'
import type { TransferDialogMode } from './workspaceState'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
})

const FOLDER = '/home/u/code/darkmechanicus'
const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'ok' }
const SIGNED_OUT: AgentAuthStatus = { state: 'signed_out', reason: 'no' }
const claude = agentView({ kind: 'claude' })
const codex = agentView({ kind: 'codex', executablePath: '/bin/codex', version: '0.9.1' })

interface Calls {
  agent: StartRunChoice[]
  copied: number
}

interface Setup {
  mode?: TransferDialogMode
  agents?: AgentView[]
  statuses?: Partial<Record<'claude' | 'codex', AgentAuthStatus>>
  busy?: boolean
}

const dialog = (): ReturnType<typeof within> => within(screen.getByRole('dialog'))
const button = (name: string): HTMLButtonElement => dialog().getByRole('button', { name }) as HTMLButtonElement

/** The dialog alone, over a bridge that lists each agent's models; the calls record what its actions asked for. */
async function open(setup: Setup = {}): Promise<Calls> {
  const dm = new FakeDm()
  dm.chats.modelLists = { claude: [{ id: 'opus', label: 'Opus' }], codex: [{ id: 'gpt-5', label: 'GPT-5' }] }
  window.dm = dm
  const calls: Calls = { agent: [], copied: 0 }
  render(
    <TransferDialog
      epicTitle="Planning vertical slice"
      mode={setup.mode ?? 'queue'}
      agents={setup.agents ?? [claude, codex]}
      statuses={setup.statuses ?? { claude: SIGNED_IN, codex: SIGNED_IN }}
      busy={setup.busy ?? false}
      onTransferWithAgent={(choice) => calls.agent.push(choice)}
      onCopyPrompt={() => {
        calls.copied += 1
      }}
      onAddAgent={() => undefined}
      onAgentStatus={() => undefined}
      onClose={() => undefined}
    />
  )
  await settle()
  return calls
}

describe('TransferDialog: the agent choice', () => {
  it('offers only connected, signed-in agents with their models, and transfers with the one picked', async () => {
    const calls = await open({ statuses: { claude: SIGNED_OUT, codex: SIGNED_IN } })

    expect(dialog().getAllByRole('radio')).toHaveLength(1)
    expect((dialog().getByRole('radio', { name: /Codex/ }) as HTMLInputElement).checked).toBe(true)
    expect(Array.from((dialog().getByLabelText('Model') as HTMLSelectElement).options).map((option) => option.value)).toEqual(['gpt-5'])
    fireEvent.click(button('Transfer with agent'))

    expect(calls.agent).toEqual([{ agent: 'codex', model: 'gpt-5' }])
    expect(calls.copied).toBe(0)
  })

  it('still copies the prompt with no agent connected, and cannot transfer with one', async () => {
    const calls = await open({ agents: [], statuses: {} })

    expect(dialog().getByText('No agent is connected and signed in.')).toBeTruthy()
    expect(button('Transfer with agent').disabled).toBe(true)
    fireEvent.click(button('Copy prompt'))

    expect(calls.copied).toBe(1)
  })
})

describe('TransferDialog: the explanations and one action per opening', () => {
  it('explains the one-way handoff, completion after verification, the locks, the Linear MCP setup, the sign-in and the team', async () => {
    await open()

    expect(screen.getByRole('dialog', { name: 'Transfer to Linear' })).toBeTruthy()
    expect(dialog().getByText(/one-way handoff/)).toBeTruthy()
    expect(dialog().getByText(/epic completes here once the agent's read-back of the Linear project matches the plan/)).toBeTruthy()
    expect(dialog().getByText('Runs and Save are locked until the transfer is verified or canceled.')).toBeTruthy()
    expect(dialog().getByText(/its own Linear MCP server/)).toBeTruthy()
    const setup = within(dialog().getByRole('list', { name: 'Linear MCP setup' }))
    expect(setup.getByText('claude mcp add --transport http linear-server https://mcp.linear.app/mcp, then /mcp to sign in')).toBeTruthy()
    expect(setup.getByText('codex mcp add linear --url https://mcp.linear.app/mcp')).toBeTruthy()
    expect(setup.getByText("add https://mcp.linear.app/mcp in Cursor's MCP settings")).toBeTruthy()
    expect(dialog().getByText(/sign-in may open in your browser, and the agent asks in the chat which Linear team to use/)).toBeTruthy()
  })

  it('takes one action per opening, so a double click neither queues twice nor starts two chats', async () => {
    const calls = await open()

    fireEvent.click(button('Transfer with agent'))
    fireEvent.click(button('Transfer with agent'))
    fireEvent.click(button('Copy prompt'))

    expect(calls.agent).toHaveLength(1)
    expect(calls.copied).toBe(0)
    expect([button('Transfer with agent').disabled, button('Copy prompt').disabled]).toEqual([true, true])
  })

  it('disables both actions while busy, and in resume mode offers Resume with agent without the handoff points', async () => {
    await open({ busy: true })
    expect([button('Transfer with agent').disabled, button('Copy prompt').disabled]).toEqual([true, true])
    cleanup()

    await open({ mode: 'resume' })
    expect(screen.getByRole('dialog', { name: 'Resume transfer' })).toBeTruthy()
    expect(button('Resume with agent').disabled).toBe(false)
    expect(dialog().queryByText(/one-way handoff/)).toBeNull()
    expect(dialog().getByRole('list', { name: 'Linear MCP setup' })).toBeTruthy()
  })
})

async function openFromHeader(): Promise<ReturnType<typeof within>> {
  fireEvent.click(await screen.findByRole('button', { name: 'Transfer to Linear' }))
  const shown = within(await screen.findByRole('dialog', { name: 'Transfer to Linear' }))
  await waitFor(() => expect(shown.getByLabelText('Model')).toBeTruthy())
  return shown
}

/** Makes queueTransfer wait until the returned function is called. */
function holdQueue(backend: FakeBackend): () => void {
  let release = (): void => undefined
  backend.gates.queueTransfer = new Promise<void>((resolve) => {
    release = resolve
  })
  return () => release()
}

describe('TransferDialog in the workspace: each action queues the transfer first', () => {
  it('Transfer with agent queues, only then starts the transfer chat with that agent and model, and opens it', async () => {
    const { backend, chats, host } = transferSetup()
    const release = holdQueue(backend)
    renderWorkspace(backend, { orchestration: host })

    const shown = await openFromHeader()
    fireEvent.change(shown.getByLabelText('Model'), { target: { value: 'sonnet' } })
    fireEvent.click(shown.getByRole('button', { name: 'Transfer with agent' }))

    await waitFor(() => expect(backend.inputs('queueTransfer')).toEqual([{ epicId: 'ep_1' }]))
    await settle()
    expect(chats.callsOf('startTransferChat')).toEqual([])
    release()

    await waitFor(() => expect(host.openedChats).toEqual(['chat_new_1']))
    expect(chats.callsOf('startTransferChat')).toEqual([[{ folder: FOLDER, epicId: 'ep_1', agent: 'claude', model: 'sonnet' }]])
    expect(chats.chats[0]).toMatchObject({ folder: FOLDER, role: 'orchestrator', allowSave: false, transferEpicId: 'ep_1' })
    expect(host.chatsChanged.count).toBe(1)
    expect(chats.callsOf('transferPrompt')).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Copy prompt queues, only then copies the transfer prompt, and starts no chat', async () => {
    const { backend, chats, host } = transferSetup()
    const release = holdQueue(backend)
    renderWorkspace(backend, { orchestration: host })

    fireEvent.click((await openFromHeader()).getByRole('button', { name: 'Copy prompt' }))

    await waitFor(() => expect(backend.inputs('queueTransfer')).toEqual([{ epicId: 'ep_1' }]))
    await settle()
    expect([chats.callsOf('transferPrompt'), backend.copied]).toEqual([[], []])
    release()

    expect(await screen.findByText('Transfer authorized. Its prompt is copied: paste it into an agent connected to this folder.')).toBeTruthy()
    expect(chats.callsOf('transferPrompt')).toEqual([[{ folder: FOLDER, epicId: 'ep_1' }]])
    expect(backend.copied).toEqual([TRANSFER_PROMPT])
    expect(chats.callsOf('startTransferChat')).toEqual([])
    expect(host.openedChats).toEqual([])
  })
})

describe('TransferDialog in the workspace: when the queue or the chat fails', () => {
  it('reaches no agent and copies nothing when the transfer cannot be queued', async () => {
    const { backend, chats, host } = transferSetup()
    backend.fail('queueTransfer', 'conflict', 'The draft has unsaved changes. Save or discard them before transferring the plan.')
    backend.fail('queueTransfer', 'conflict', 'The draft has unsaved changes. Save or discard them before transferring the plan.')
    renderWorkspace(backend, { orchestration: host })

    fireEvent.click((await openFromHeader()).getByRole('button', { name: 'Transfer with agent' }))
    expect(await screen.findByText(/Save or discard them before transferring the plan/)).toBeTruthy()
    fireEvent.click((await openFromHeader()).getByRole('button', { name: 'Copy prompt' }))
    await waitFor(() => expect(backend.inputs('queueTransfer')).toHaveLength(2))
    await settle()

    expect([chats.callsOf('startTransferChat'), chats.callsOf('transferPrompt'), backend.copied, host.openedChats]).toEqual([[], [], [], []])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the transfer authorized when the chat cannot be started, and says Resume recovers', async () => {
    const { backend, chats, host } = transferSetup()
    chats.failures.startTransferChat = { code: 'unsupported_capability', message: 'Claude Code is not connected.' }
    renderWorkspace(backend, { orchestration: host })

    fireEvent.click((await openFromHeader()).getByRole('button', { name: 'Transfer with agent' }))

    expect(await screen.findByText(/Press Resume on the transfer to try again/)).toBeTruthy()
    expect(backend.state.transfer.status).toBe('queued')
    const strip = within(await screen.findByLabelText('Linear transfer'))
    expect(strip.getByRole('button', { name: 'Resume' })).toBeTruthy()
    expect(host.openedChats).toEqual([])
  })

  it('keeps the transfer authorized when the prompt cannot be read, and the strip copies it again', async () => {
    const { backend, chats, host } = transferSetup()
    chats.failures.transferPrompt = { code: 'internal', message: 'The prompt could not be built.' }
    renderWorkspace(backend, { orchestration: host })

    fireEvent.click((await openFromHeader()).getByRole('button', { name: 'Copy prompt' }))

    expect(await screen.findByText(/Press Copy prompt on the transfer to try again/)).toBeTruthy()
    expect([backend.state.transfer.status, backend.copied]).toEqual(['queued', []])
    delete chats.failures.transferPrompt
    fireEvent.click(within(await screen.findByLabelText('Linear transfer')).getByRole('button', { name: 'Copy prompt' }))
    await waitFor(() => expect(backend.copied).toEqual([TRANSFER_PROMPT]))
    expect(backend.inputs('queueTransfer')).toHaveLength(1)
  })
})
