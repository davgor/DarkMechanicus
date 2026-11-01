/**
 * Starting an agent on an authorized Linear transfer: the transfer is read, an `orchestrator` chat that records
 * the epic is created, and its terminal is started with the transfer kickoff before the answer. On the terminal
 * sessions' fakes (fake PTY host, fake clock), with the real chat records over the same store.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { transferGuidance, transferKickoff } from '../../mcp/transferKickoff'
import type { ChatRecord } from '../../shared/agents/chat'
import type { TransferStatus, TransferView } from '../../shared/domain/transfer'
import type { EpicDetailView } from '../../shared/domain/views'
import { builtInAgent, connectedAgents } from './__mocks__/chatFixtures'
import { createChatRecords, type ChatRecords } from './chatRecords'
import { findTransferChat, startTransferChat, transferPrompt, type TransferReads } from './transferStart'
import { CUSTOM_AGENT, settle, terminalRig, type TerminalRig } from '../terminals/__mocks__/terminalSessionsRig'
import { endingTerminals } from '../terminals/terminalSessions'

const EPIC_ID = 'ep_01m6772ffwkwr2a91fsqzfz1he'
const EPIC = { id: EPIC_ID, title: 'Linear handoff', branch: null } as EpicDetailView
const KICKOFF = transferKickoff({ epicId: EPIC_ID, epicTitle: 'Linear handoff' })

interface Rig {
  records: ChatRecords
  transfers: TransferReads
  /** What the transfer side was asked for, as "<call> <epic id>". */
  calls: string[]
  errors: unknown[]
}

let terminals: TerminalRig

beforeEach(() => {
  terminals = terminalRig()
})

afterEach(() => {
  terminals.cleanup()
})

/** The chat records over the terminals' store, with deleting a chat ending its terminal first, as main wires them. */
function rig(status: TransferStatus = 'queued'): Rig {
  const calls: string[] = []
  const records = createChatRecords({ store: terminals.store, agentFor: connectedAgents([builtInAgent('claude'), builtInAgent('autonomous'), CUSTOM_AGENT]) })
  const transfers: TransferReads = {
    getEpic: (_folder, epicId) => (calls.push(`getEpic ${epicId}`), Promise.resolve(EPIC)),
    getTransfer: (_folder, epicId) =>
      (calls.push(`getTransfer ${epicId}`), Promise.resolve({ epicId, status, packet: null, recorded: [], lastMismatches: [], next: [] } as TransferView))
  }
  return { records: endingTerminals(records, terminals.sessions), transfers, calls, errors: [] }
}

function request(agent = 'claude', model: string | null = 'haiku'): { folder: string; epicId: string; agent: string; model?: string } {
  return { folder: terminals.repo, epicId: EPIC_ID, agent, ...(model === null ? {} : { model }) }
}

function chats(): ChatRecord[] {
  return terminals.store.listChats(terminals.repo)
}

function argsOf(index = 0): string[] {
  return (terminals.host.spawns[index]?.spec.args ?? []) as string[]
}

describe('start a transfer chat', () => {
  it('opens an orchestrator chat titled after the epic, recording it, and starts its terminal with the transfer kickoff', async () => {
    const { records, transfers, calls } = rig()

    const result = await startTransferChat({ transfers, chats: records, terminals: terminals.sessions }, request())

    expect(calls).toEqual([`getEpic ${EPIC_ID}`, `getTransfer ${EPIC_ID}`])
    expect(result.problem).toBeNull()
    expect(result.chat).toMatchObject({
      folder: terminals.repo,
      agent: 'claude',
      model: 'haiku',
      role: 'orchestrator',
      allowSave: false,
      title: 'Linear transfer · Linear handoff',
      transferEpicId: EPIC_ID
    })
    expect(result.chat).not.toHaveProperty('runId')
    expect(chats().map((chat) => chat.id)).toEqual([result.chat?.id])
    expect(terminals.steps).toEqual(['auth', 'grant:gr_1', 'spawn'])
    expect(argsOf().at(-1)).toBe(KICKOFF)
    expect(chats()[0]?.kickoffSent).toBe(true)
  })

  it('starts the agent with an orchestrator grant that may not save, the transfer guidance and no run guidance in its instructions', async () => {
    const { records, transfers } = rig('in_progress')

    const result = await startTransferChat({ transfers, chats: records, terminals: terminals.sessions }, request())

    const instructions = readFileSync(argsOf()[argsOf().indexOf('--append-system-prompt-file') + 1] ?? '', 'utf8')
    expect(result.problem).toBeNull()
    expect(instructions).toContain('**orchestrator** grant')
    expect(instructions).toContain('This chat may not save plans')
    expect(instructions).not.toContain('Orchestrating a Dark Mechanicus run')
    expect(instructions.endsWith(transferGuidance(EPIC_ID))).toBe(true)
  })

  it('pastes the transfer kickoff into Autonomous once its first screen has settled, with its default model', async () => {
    const { records, transfers } = rig()

    const result = await startTransferChat({ transfers, chats: records, terminals: terminals.sessions }, request('autonomous', null))
    const pty = terminals.host.last()
    pty.emitData('\x1b[?2004hAutonomous')
    await settle()
    terminals.clock.advance(1_500)

    const [paste = '', enter] = pty.written
    expect(paste.startsWith('\x1b[200~Move this saved Dark Mechanicus epic to a Linear project')).toBe(true)
    expect(paste).toContain('=== Linear transfer guidance ===')
    expect(enter).toBe('\r')
    expect(result.chat?.model).toBeNull()
    expect(chats()[0]).toMatchObject({ kickoffSent: true })
  })
})

describe('start a transfer chat: refusals before anything starts', () => {
  it.each([
    ['not_started', 'unmet_prerequisite'],
    ['canceled', 'unmet_prerequisite'],
    ['verified', 'conflict']
  ] as const)('refuses a transfer that is %s, creating no chat and starting no terminal', async (status, code) => {
    const { records, transfers } = rig(status)

    await expect(startTransferChat({ transfers, chats: records, terminals: terminals.sessions }, request())).rejects.toMatchObject({ code })

    expect(chats()).toEqual([])
    expect(terminals.host.spawns).toEqual([])
    expect(terminals.grantsAsked).toBe(0)
  })

  it('reads no transfer and creates nothing when the epic cannot be read', async () => {
    const { records, transfers, calls } = rig()
    const refusal = new DomainError('not_found', `Epic ${EPIC_ID} was not found.`)

    await expect(
      startTransferChat({ transfers: { ...transfers, getEpic: () => Promise.reject(refusal) }, chats: records, terminals: terminals.sessions }, request())
    ).rejects.toBe(refusal)

    expect(calls).toEqual([])
    expect(chats()).toEqual([])
  })
})

describe('start a transfer chat: failures once the chat is asked for', () => {
  it('says the transfer is still authorized when the chat cannot be created', async () => {
    const { records, transfers } = rig()
    const failing: ChatRecords = {
      ...records,
      createChat: () => {
        throw new DomainError('invalid_input', 'The chat store is full.')
      }
    }

    const result = await startTransferChat({ transfers, chats: failing, terminals: terminals.sessions }, request())

    expect(result.chat).toBeNull()
    expect(result.problem).toContain('The transfer is authorized')
    expect(result.problem).toContain('The chat store is full')
    expect(chats()).toEqual([])
    expect(terminals.host.spawns).toEqual([])
  })

  it.each([
    ['a spawn that fails', (): void => terminals.host.failNextSpawn(new Error('posix_spawnp failed.')), 'posix_spawnp failed'],
    ['a signed-out agent', (): void => void (terminals.auth.status = { state: 'signed_out', reason: 'Claude Code is signed out.' }), 'Claude Code is signed out'],
    ['a folder no longer tracked', (): void => void terminals.tracked.delete(terminals.repo), 'no longer tracked']
  ] as const)('removes the chat again when the terminal cannot start, naming the agent and why, for %s', async (_name, arrange, reason) => {
    const { records, transfers } = rig()
    arrange()

    const result = await startTransferChat({ transfers, chats: records, terminals: terminals.sessions }, request())

    expect(result.chat).toBeNull()
    expect(result.problem).toContain('The transfer is authorized, but Claude Code could not be started')
    expect(result.problem).toContain(reason)
    expect(chats()).toEqual([])
    expect(terminals.revoked).toEqual(terminals.steps.filter((step) => step.startsWith('grant:')).map((step) => step.slice('grant:'.length)))
  })

  it('keeps the chat, and says why, when the terminal cannot start and the chat cannot be removed either', async () => {
    const { records, transfers, errors } = rig()
    terminals.host.failNextSpawn(new Error('posix_spawnp failed.'))
    const stuck: ChatRecords = { ...records, deleteChat: () => Promise.reject(new Error('disk is read-only')) }

    const result = await startTransferChat({ transfers, chats: stuck, terminals: terminals.sessions, onError: (error) => errors.push(error) }, request())

    expect(result.chat).toMatchObject({ transferEpicId: EPIC_ID })
    expect(result.problem).toContain('posix_spawnp failed')
    expect(chats()).toHaveLength(1)
    expect(errors.map((error) => (error as Error).message)).toEqual(['disk is read-only'])
  })
})

describe('start a transfer chat: a custom agent', () => {
  it("names a custom agent that cannot start by the registry's display name", async () => {
    const { records, transfers } = rig()
    terminals.host.failNextSpawn(new Error('mine exited with code 1.'))

    const result = await startTransferChat({ transfers, chats: records, terminals: terminals.sessions }, request(CUSTOM_AGENT.id, null))

    expect(result.chat).toBeNull()
    expect(result.problem).toMatch(/^The transfer is authorized, but My CLI could not be started: .*mine exited with code 1/)
    expect(result.problem?.endsWith('Start the transfer chat again, or copy the prompt for an agent of your own.')).toBe(true)
    expect(chats()).toEqual([])
  })
})

describe('find a transfer chat', () => {
  it('finds the chat again after an app restart, an orchestrator that may not save, and its kickoff is not given again', async () => {
    const { records, transfers } = rig()
    const started = await startTransferChat({ transfers, chats: records, terminals: terminals.sessions }, request())
    terminals.host.last().exit({ exitCode: 0, signal: null })
    await settle()

    // The chat records over a store opened again on the same files stand for the app starting again.
    const reopened = createChatRecords({ store: terminals.reopenedStore(), agentFor: connectedAgents([builtInAgent('claude')]) })
    const found = findTransferChat(reopened, terminals.repo, EPIC_ID)

    expect(found).toMatchObject({ id: started.chat?.id, role: 'orchestrator', allowSave: false, transferEpicId: EPIC_ID, title: 'Linear transfer · Linear handoff', kickoffSent: true })
    expect(await terminals.sessions.start(found as ChatRecord, { kickoff: KICKOFF })).toMatchObject({ state: 'running' })
    expect(terminals.host.spawns).toHaveLength(2)
    expect(argsOf(1)).not.toContain(KICKOFF)
    // The task stays in the instructions file the restarted CLI is given.
    const instructions = readFileSync(argsOf(1)[argsOf(1).indexOf('--append-system-prompt-file') + 1] ?? '', 'utf8')
    expect(instructions).toContain(`Call start_transfer for epic ${EPIC_ID}`)
  })

  it('finds none for another epic or a chat that was not started for a transfer', async () => {
    const { records, transfers } = rig()
    records.createChat({ folder: terminals.repo, agent: 'claude', role: 'orchestrator', allowSave: false, runId: 'rn_1' })
    expect(findTransferChat(records, terminals.repo, EPIC_ID)).toBeNull()

    await startTransferChat({ transfers, chats: records, terminals: terminals.sessions }, request())

    expect(findTransferChat(records, terminals.repo, 'ep_01m6772ffwkwr2a91fsqzfz1hf')).toBeNull()
  })
})

describe('transfer prompt', () => {
  it("equals the kickoff a transfer chat's terminal is started with", async () => {
    const { transfers } = rig()

    expect(await transferPrompt(transfers, terminals.repo, EPIC_ID)).toBe(KICKOFF)
  })
})
