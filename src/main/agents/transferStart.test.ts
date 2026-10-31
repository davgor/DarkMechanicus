import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { transferKickoff } from '../../mcp/transferKickoff'
import type { ChatRecord } from '../../shared/agents/chat'
import type { TransferStatus, TransferView } from '../../shared/domain/transfer'
import type { AgentView } from '../../shared/desktop/api'
import type { EpicDetailView } from '../../shared/domain/views'
import { AT, builtInAgent, connectedAgents, fakeAdapters, memoryChatFs, memoryChatStore, REPO, trackedFolders, type FakeAdapters } from './__mocks__/fakeChatAdapter'
import type { ChatStore, ChatStoreFs } from './chatStore'
import { createSessionManager, type SessionManager } from './sessionManager'
import { findTransferChat, startTransferChat, transferPrompt, type TransferReads } from './transferStart'

const EPIC_ID = 'ep_01m6772ffwkwr2a91fsqzfz1he'
const EPIC = { id: EPIC_ID, title: 'Linear handoff', branch: null } as EpicDetailView
const KICKOFF = transferKickoff({ epicId: EPIC_ID, epicTitle: 'Linear handoff' })
const DM_CLI = { command: 'node', args: ['/app/out/main/cli.js', '--repo', REPO], env: { DM_SESSION_TOKEN: 'dmg_test' } }
const REQUEST = { folder: REPO, epicId: EPIC_ID, agent: 'claude', model: 'big' } as const
/** A connected custom CLI, named only by the registry: the built-in table knows nothing of it. */
const CUSTOM: AgentView = builtInAgent('cursor', { id: 'cu_01m65kwqqeyajbj5bnq81gngrb', kind: 'custom', displayName: 'My ACP agent', executablePath: '/opt/my-acp' })

interface Rig {
  store: ChatStore
  fakes: FakeAdapters
  manager: SessionManager
  transfers: TransferReads
  /** What the transfer side was asked for, as "<call> <epic id>". */
  calls: string[]
  /** The grants the chats were issued, in order. */
  grants: { role: string; allowSave: boolean }[]
  errors: unknown[]
}

function managerOver(store: ChatStore, fakes: FakeAdapters, seen: Pick<Rig, 'grants' | 'errors'>, agents?: readonly AgentView[]): SessionManager {
  const { grants, errors } = seen
  return createSessionManager({
    store,
    adapters: fakes.definitions,
    agentFor: connectedAgents(agents),
    folders: trackedFolders(),
    issueChatCli: async (_folder, grant) => {
      grants.push({ role: grant.role, allowSave: grant.allowSave })
      return { cli: DM_CLI, grantId: 'gr_00000000000000000000000001' }
    },
    revokeChatGrant: async () => undefined,
    push: () => {},
    now: () => AT,
    onError: (error) => errors.push(error)
  })
}

function rig(status: TransferStatus = 'queued', fs: ChatStoreFs = memoryChatFs(), agents?: readonly AgentView[]): Rig {
  const store = memoryChatStore(fs)
  const fakes = fakeAdapters()
  const errors: unknown[] = []
  const grants: Rig['grants'] = []
  const calls: string[] = []
  const transfers: TransferReads = {
    getEpic: (_folder, epicId) => (calls.push(`getEpic ${epicId}`), Promise.resolve(EPIC)),
    getTransfer: (_folder, epicId) =>
      (calls.push(`getTransfer ${epicId}`), Promise.resolve({ epicId, status, packet: null, recorded: [], lastMismatches: [], next: [] } as TransferView))
  }
  return { store, fakes, manager: managerOver(store, fakes, { grants, errors }, agents), transfers, calls, grants, errors }
}

function chatsOf(store: ChatStore): ChatRecord[] {
  return store.listChats(REPO)
}

describe('start a transfer chat', () => {
  it('opens an orchestrator chat titled after the epic, recording it, and sends the transfer kickoff first', async () => {
    const { store, fakes, manager, transfers, calls } = rig()

    const result = await startTransferChat({ transfers, sessions: manager }, REQUEST)

    expect(calls).toEqual([`getEpic ${EPIC_ID}`, `getTransfer ${EPIC_ID}`])
    expect(result.problem).toBeNull()
    expect(result.chat).toMatchObject({
      folder: REPO,
      agent: 'claude',
      model: 'big',
      role: 'orchestrator',
      allowSave: false,
      title: 'Linear transfer · Linear handoff',
      transferEpicId: EPIC_ID
    })
    expect(result.chat).not.toHaveProperty('runId')
    expect(chatsOf(store).map((chat) => chat.id)).toEqual([result.chat?.id])

    const first = store.readTranscript({ folder: REPO, id: result.chat?.id ?? '' })?.items[0]
    expect(first).toMatchObject({ kind: 'user_message', text: KICKOFF })
    expect(fakes.of('claude')[0]?.sent).toEqual([KICKOFF])
  })

  it('starts the agent as an orchestrator holding the chat grant and DM_SESSION_TOKEN, with the same Dark Mechanicus options as any chat', async () => {
    const { fakes, manager, transfers, grants } = rig('in_progress')

    await startTransferChat({ transfers, sessions: manager }, REQUEST)

    expect(grants).toEqual([{ role: 'orchestrator', allowSave: false }])
    const started = fakes.of('claude')[0]?.started[0]
    expect(started).toMatchObject({ role: 'orchestrator', allowSave: false, model: 'big', darkMechanicus: DM_CLI })
    expect(started?.darkMechanicus.args).not.toContain('--allow-save')
  })

  it('lets the agent use its default model when none was chosen', async () => {
    const { manager, transfers } = rig()

    const result = await startTransferChat({ transfers, sessions: manager }, { folder: REPO, epicId: EPIC_ID, agent: 'claude' })

    expect(result.chat?.model).toBeNull()
  })
})

describe('start a transfer chat: refusals before anything starts', () => {
  it.each([
    ['not_started', 'unmet_prerequisite'],
    ['canceled', 'unmet_prerequisite'],
    ['verified', 'conflict']
  ] as const)('refuses a transfer that is %s, creating no chat and starting no agent', async (status, code) => {
    const { store, fakes, manager, transfers, grants } = rig(status)

    await expect(startTransferChat({ transfers, sessions: manager }, REQUEST)).rejects.toMatchObject({ code })

    expect(chatsOf(store)).toEqual([])
    expect(fakes.created).toEqual([])
    expect(grants).toEqual([])
  })

  it('reads no transfer and creates nothing when the epic cannot be read', async () => {
    const { store, manager, transfers, calls } = rig()
    const refusal = new DomainError('not_found', `Epic ${EPIC_ID} was not found.`)

    await expect(startTransferChat({ transfers: { ...transfers, getEpic: () => Promise.reject(refusal) }, sessions: manager }, REQUEST)).rejects.toBe(refusal)

    expect(calls).toEqual([])
    expect(chatsOf(store)).toEqual([])
  })
})

describe('start a transfer chat: failures once the chat is asked for', () => {
  it('says the transfer is still authorized when the chat cannot be created', async () => {
    const { store, fakes, manager, transfers } = rig()
    const failing: SessionManager = {
      ...manager,
      createChat: () => {
        throw new DomainError('invalid_input', 'The chat store is full.')
      }
    }

    const result = await startTransferChat({ transfers, sessions: failing }, REQUEST)

    expect(result.chat).toBeNull()
    expect(result.problem).toContain('The transfer is authorized')
    expect(result.problem).toContain('The chat store is full')
    expect(chatsOf(store)).toEqual([])
    expect(fakes.created).toEqual([])
  })

  it('removes the chat again when the agent cannot start, naming the agent and why', async () => {
    const { store, fakes, manager, transfers, errors } = rig()
    fakes.prepare = (adapter) => {
      adapter.startError = new Error('claude exited with code 1')
    }

    const result = await startTransferChat({ transfers, sessions: manager, onError: (error) => errors.push(error) }, REQUEST)

    expect(result.chat).toBeNull()
    expect(result.problem).toContain('Claude Code could not be started')
    expect(result.problem).toContain('claude exited with code 1')
    expect(chatsOf(store)).toEqual([])
  })

  it('keeps the chat, and says why, when the agent cannot start and the chat cannot be removed either', async () => {
    const { store, fakes, manager, transfers, errors } = rig()
    fakes.prepare = (adapter) => {
      adapter.startError = new Error('claude exited with code 1')
    }
    const stuck: SessionManager = { ...manager, deleteChat: () => Promise.reject(new Error('disk is read-only')) }

    const result = await startTransferChat({ transfers, sessions: stuck, onError: (error) => errors.push(error) }, REQUEST)

    expect(result.chat).toMatchObject({ transferEpicId: EPIC_ID })
    expect(result.problem).toContain('claude exited with code 1')
    expect(chatsOf(store)).toHaveLength(1)
    expect(errors.map((error) => (error as Error).message)).toEqual(['claude exited with code 1', 'disk is read-only'])
  })
})

describe('start a transfer chat: a custom agent', () => {
  it("names a custom agent that cannot start by the registry's display name", async () => {
    const { store, fakes, manager, transfers, errors } = rig('queued', memoryChatFs(), [CUSTOM])
    fakes.prepare = (adapter) => {
      adapter.startError = new Error('my-acp exited with code 1')
    }

    const result = await startTransferChat({ transfers, sessions: manager, onError: (error) => errors.push(error) }, { ...REQUEST, agent: CUSTOM.id })

    expect(result.chat).toBeNull()
    expect(result.problem).toBe(
      'The transfer is authorized, but My ACP agent could not be started: my-acp exited with code 1. Start the transfer chat again, or copy the prompt for an agent of your own.'
    )
    expect(chatsOf(store)).toEqual([])
  })
})

describe('find a transfer chat', () => {
  it('finds the chat again after an app restart, and it resumes as an orchestrator with the same grant', async () => {
    const fs = memoryChatFs()
    const before = rig('queued', fs)
    const started = await startTransferChat({ transfers: before.transfers, sessions: before.manager }, REQUEST)
    await before.manager.disposeAll()

    // A new store and session manager over the same files stand for the app starting again.
    const after = rig('in_progress', fs)
    const found = findTransferChat(after.manager, REPO, EPIC_ID)

    expect(found).toMatchObject({ id: started.chat?.id, role: 'orchestrator', allowSave: false, transferEpicId: EPIC_ID, title: 'Linear transfer · Linear handoff' })
    await after.manager.send({ folder: REPO, id: found?.id ?? '' }, 'Carry on with the transfer.')
    expect(after.grants).toEqual([{ role: 'orchestrator', allowSave: false }])
    expect(after.fakes.of('claude')[0]?.started[0]).toMatchObject({ role: 'orchestrator', allowSave: false, darkMechanicus: DM_CLI })
  })

  it('finds none for another epic or a chat that was not started for a transfer', async () => {
    const { manager, transfers } = rig()
    manager.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator', allowSave: false, runId: 'rn_1' })
    expect(findTransferChat(manager, REPO, EPIC_ID)).toBeNull()

    await startTransferChat({ transfers, sessions: manager }, REQUEST)

    expect(findTransferChat(manager, REPO, 'ep_01m6772ffwkwr2a91fsqzfz1hf')).toBeNull()
  })
})

describe('transfer prompt', () => {
  it('equals the kickoff a transfer chat is sent first', async () => {
    const { transfers } = rig()

    expect(await transferPrompt(transfers, REPO, EPIC_ID)).toBe(KICKOFF)
  })
})
