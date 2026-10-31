// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { TransferView } from '../../../shared/domain/transfer'
import { chatRecord } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { installDomShims } from './__mocks__/domShims'
import { epicDetail, transferOutcome, transferPacket, transferView } from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'
import { TRANSFER_PROMPT, transferSetup } from './__mocks__/transferBackend'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
})

const FOLDER = '/home/u/code/darkmechanicus'

/** The item at `index`, which the sample packet has. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`The sample packet has no item ${index}.`)
  return item
}

/** A transfer in progress with its first three items recorded, whose last read-back found three mismatches. */
function midTransfer(): TransferView {
  const packet = transferPacket()
  const [first, second, milestone] = [nth(packet.issues, 0), nth(packet.issues, 1), nth(packet.milestones, 1)]
  return transferView('in_progress', 3, {
    lastMismatches: [
      { ref: first.ref, key: first.key, field: 'title', expected: first.title, actual: 'Renamed in Linear' },
      { ref: second.ref, key: second.key, field: 'priority', expected: 2, actual: 4 },
      { ref: milestone.ref, field: 'position', expected: 2, actual: 1 }
    ]
  })
}

const strip = async (): Promise<ReturnType<typeof within>> => within(await screen.findByLabelText('Linear transfer'))

describe('the transfer strip while a transfer is open', () => {
  it('shows the status, how many items are created, and the last mismatches by DM key and field', async () => {
    const { backend, host } = transferSetup({ transfer: midTransfer() })
    renderWorkspace(backend, { orchestration: host })

    const shown = await strip()
    const total = midTransfer().recorded.length + midTransfer().next.length
    expect(shown.getByText('IN PROGRESS')).toBeTruthy()
    expect(shown.getByText(`3 of ${total} created`)).toBeTruthy()
    const [first, second] = transferPacket().issues
    const rows = within(shown.getByRole('list', { name: 'Last read-back mismatches' })).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([`${first?.key}title`, `${second?.key}priority`, 'Sprint 2position'])
    expect(shown.getByText('The last read-back differs from the plan in 3 places:')).toBeTruthy()
  })

  it('shows a queued transfer with nothing created and no mismatch list, and hides Start run and Transfer to Linear', async () => {
    const { backend, host } = transferSetup({ transfer: transferView('queued') })
    renderWorkspace(backend, { orchestration: host })

    const shown = await strip()
    expect(shown.getByText('QUEUED')).toBeTruthy()
    expect(shown.getByText(new RegExp(`^0 of ${transferView('queued').next.length} created$`))).toBeTruthy()
    expect(shown.queryByRole('list', { name: 'Last read-back mismatches' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start run' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Transfer to Linear' })).toBeNull()
  })

  it('shows no strip without an open transfer, and offers Transfer to Linear beside Start run', async () => {
    const { backend, host } = transferSetup({ transfer: transferView('canceled') })
    renderWorkspace(backend, { orchestration: host })

    expect(await screen.findByRole('button', { name: 'Transfer to Linear' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start run' })).toBeTruthy()
    expect(screen.queryByLabelText('Linear transfer')).toBeNull()
  })
})

describe('the transfer strip: Resume', () => {
  it('opens the chat already carrying out the transfer, and starts none', async () => {
    const { backend, chats, host } = transferSetup({ transfer: midTransfer() })
    chats.chats = [chatRecord({ id: 'chat_transfer', folder: FOLDER, role: 'orchestrator', transferEpicId: 'ep_1' })]
    renderWorkspace(backend, { orchestration: host })

    fireEvent.click((await strip()).getByRole('button', { name: 'Resume' }))

    await waitFor(() => expect(host.openedChats).toEqual(['chat_transfer']))
    expect(chats.callsOf('findTransferChat')).toEqual([[{ folder: FOLDER, epicId: 'ep_1' }]])
    expect(chats.callsOf('startTransferChat')).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('without a transfer chat, asks for an agent and starts a new transfer chat without queueing again', async () => {
    const { backend, chats, host } = transferSetup({ transfer: midTransfer() })
    renderWorkspace(backend, { orchestration: host })

    fireEvent.click((await strip()).getByRole('button', { name: 'Resume' }))
    const shown = within(await screen.findByRole('dialog', { name: 'Resume transfer' }))
    await waitFor(() => expect(shown.getByLabelText('Model')).toBeTruthy())
    fireEvent.click(shown.getByRole('button', { name: 'Resume with agent' }))

    await waitFor(() => expect(host.openedChats).toEqual(['chat_new_1']))
    expect(chats.callsOf('startTransferChat')).toEqual([[{ folder: FOLDER, epicId: 'ep_1', agent: 'claude', model: 'opus' }]])
    expect(backend.inputs('queueTransfer')).toEqual([])
  })

  it('copies the prompt of the open transfer without queueing again', async () => {
    const { backend, host } = transferSetup({ transfer: midTransfer() })
    renderWorkspace(backend, { orchestration: host })

    fireEvent.click((await strip()).getByRole('button', { name: 'Copy prompt' }))

    expect(await screen.findByText('Transfer prompt copied: paste it into an agent connected to this folder.')).toBeTruthy()
    expect(backend.copied).toEqual([TRANSFER_PROMPT])
    expect(backend.inputs('queueTransfer')).toEqual([])
  })
})

describe('the transfer strip: Cancel transfer', () => {
  it('cancels only after the confirmation, then unlocks Start run and Transfer to Linear', async () => {
    const { backend, host } = transferSetup({ transfer: midTransfer() })
    renderWorkspace(backend, { orchestration: host })

    fireEvent.click((await strip()).getByRole('button', { name: 'Cancel transfer' }))
    const confirm = within(await screen.findByRole('alertdialog', { name: 'Cancel transfer' }))
    expect(backend.inputs('cancelTransfer')).toEqual([])
    fireEvent.click(confirm.getByRole('button', { name: 'Cancel transfer' }))

    expect(await screen.findByText('Transfer canceled. Runs and Save are unlocked; what was created in Linear stays there.')).toBeTruthy()
    expect(backend.inputs('cancelTransfer')).toEqual([{ epicId: 'ep_1' }])
    await waitFor(() => expect(screen.queryByLabelText('Linear transfer')).toBeNull())
    expect(screen.getByRole('button', { name: 'Start run' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Transfer to Linear' })).toBeTruthy()
  })

  it('keeps the transfer when the person keeps transferring', async () => {
    const { backend, host } = transferSetup({ transfer: midTransfer() })
    renderWorkspace(backend, { orchestration: host })

    fireEvent.click((await strip()).getByRole('button', { name: 'Cancel transfer' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep transferring' }))
    await settle()

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(backend.inputs('cancelTransfer')).toEqual([])
    expect(screen.getByLabelText('Linear transfer')).toBeTruthy()
  })
})

describe('a transferred epic', () => {
  it('shows Transferred to Linear with its project link from the epic alone, with no run and no transfer read', async () => {
    const outcome = transferOutcome()
    const epic = epicDetail({
      status: 'completed',
      completedAt: '2026-09-30T11:00:00.000Z',
      outcome: { summary: 'Transferred to Linear.', successCriteria: [], recordedAt: '2026-09-30T11:00:00.000Z', runId: null, transfer: outcome }
    })
    const { backend, host } = transferSetup({ epic })
    renderWorkspace(backend, { orchestration: host })

    const panel = within(await screen.findByRole('region', { name: 'Transferred to Linear' }))
    expect(panel.getByRole('heading', { name: 'Transferred to Linear' })).toBeTruthy()
    expect(panel.getByText(new RegExp(`${outcome.items.length} issues in execution order`))).toBeTruthy()
    expect(panel.getByText(outcome.projectUrl)).toBeTruthy()
    fireEvent.click(panel.getByRole('button', { name: 'Open the project in Linear' }))

    await waitFor(() => expect(backend.opened).toEqual([outcome.projectUrl]))
    expect(backend.names().includes('getTransfer')).toBe(false)
    expect(screen.queryByLabelText('Run')).toBeNull()
    expect(screen.queryByLabelText('Linear transfer')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Transfer to Linear' })).toBeNull()
    expect(screen.getByText('Completed epics are read-only. Create a new epic to extend this work.')).toBeTruthy()
  })

  it('says so when the project link cannot be opened', async () => {
    const outcome = transferOutcome({ projectUrl: 'https://linear.app/acme/project/x' })
    const epic = epicDetail({ status: 'completed', outcome: { summary: '', successCriteria: [], recordedAt: '', runId: null, transfer: outcome } })
    const { backend, host } = transferSetup({ epic })
    backend.openExternal = (url: string) => {
      backend.opened.push(url)
      return Promise.resolve(false)
    }
    renderWorkspace(backend, { orchestration: host })

    fireEvent.click(await screen.findByRole('button', { name: 'Open the project in Linear' }))

    expect(await screen.findByText('The Linear project link could not be opened: https://linear.app/acme/project/x')).toBeTruthy()
  })

  it('shows no transferred panel for an epic a run completed', async () => {
    const epic = epicDetail({ status: 'completed', outcome: { summary: 'Done', successCriteria: [], recordedAt: '', runId: 'rn_2' } })
    const { backend, host } = transferSetup({ epic })
    renderWorkspace(backend, { orchestration: host })

    await screen.findByText('Completed epics are read-only. Create a new epic to extend this work.')
    expect(screen.queryByRole('region', { name: 'Transferred to Linear' })).toBeNull()
  })
})
