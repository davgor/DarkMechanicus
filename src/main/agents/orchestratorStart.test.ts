/**
 * Start run with an agent (`docs/design/chat-shells.md`, "The orchestrator chat Start run opens"): the run is
 * queued, the `orchestrator` chat is created for it, and its terminal is started with the kickoff before Start run
 * answers. A start that fails leaves no chat and the run queued, with the reason. On the terminal session manager's
 * fakes (fake PTY host, fake clock), with the real chat records over the same store.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import type { ChatRecord } from '../../shared/agents/chat'
import type { EpicDetailView, RunView } from '../../shared/domain/views'
import { builtInAgent, connectedAgents } from './__mocks__/chatFixtures'
import { createChatRecords, type ChatRecords } from './chatRecords'
import { CLAIM_TOKEN_MASK, maskClaimTokens } from './claimTokenMask'
import { orchestratorGuidance } from './orchestratorKickoff'
import { startOrchestratorRun, type OrchestratorRuns } from './orchestratorStart'
import { settle, terminalRig, type TerminalRig } from '../terminals/__mocks__/terminalSessionsRig'
import { endingTerminals } from '../terminals/terminalSessions'

const EPIC = {
  id: 'ep_1',
  title: 'Agent chats',
  branch: { repository: null, name: 'epic/agent-chats', startCommit: null }
} as EpicDetailView

const RUN = { id: 'rn_2', number: 2, epicId: 'ep_1', state: 'queued' } as RunView

interface Rig {
  terminals: TerminalRig
  records: ChatRecords
  runs: OrchestratorRuns
  /** What the runs side was asked for, as "<call> <epic id>". */
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
function rig(runs: Partial<OrchestratorRuns> = {}): Rig {
  const errors: unknown[] = []
  const calls: string[] = []
  const records = createChatRecords({ store: terminals.store, agentFor: connectedAgents([builtInAgent('claude'), builtInAgent('autonomous')]) })
  const wired: OrchestratorRuns = {
    getEpic: (_folder, epicId) => (calls.push(`getEpic ${epicId}`), Promise.resolve(EPIC)),
    queueRun: (_folder, epicId) => (calls.push(`queueRun ${epicId}`), Promise.resolve(RUN)),
    ...runs
  }
  return { terminals, records: endingTerminals(records, terminals.sessions), calls, errors, runs: wired }
}

function request(agent = 'claude', model: string | null = 'haiku'): { folder: string; epicId: string; agent: string; model?: string } {
  return { folder: terminals.repo, epicId: 'ep_1', agent, ...(model === null ? {} : { model }) }
}

function chats(): ChatRecord[] {
  return terminals.store.listChats(terminals.repo)
}

function argsOf(index = 0): string[] {
  return (terminals.host.spawns[index]?.spec.args ?? []) as string[]
}

describe('Start run with an agent', () => {
  it('queues the run, creates the orchestrator chat with its run id, and starts its terminal before answering', async () => {
    const { records, runs, calls } = rig()

    const result = await startOrchestratorRun({ runs, chats: records, terminals: terminals.sessions }, request())

    expect(calls).toEqual(['getEpic ep_1', 'queueRun ep_1'])
    expect(result.run).toBe(RUN)
    expect(result.problem).toBeNull()
    expect(result.chat).toMatchObject({
      folder: terminals.repo,
      agent: 'claude',
      model: 'haiku',
      role: 'orchestrator',
      allowSave: false,
      title: 'Orchestrator · Agent chats',
      runId: 'rn_2'
    })
    expect(chats().map((chat) => chat.id)).toEqual([result.chat?.id])
    expect(terminals.host.spawns).toHaveLength(1)
    expect(terminals.steps).toEqual(['auth', 'grant:gr_1', 'spawn'])
    expect(terminals.store.readTranscript(result.chat as ChatRecord)?.items ?? []).toEqual([])
  })

  it('keeps the chat of a CLI that starts and then exits: the person can read it and start it again', async () => {
    const { records, runs } = rig()
    terminals.host.onSpawn = (pty) => {
      queueMicrotask(() => {
        pty.exit({ exitCode: 1, signal: null })
      })
    }

    const result = await startOrchestratorRun({ runs, chats: records, terminals: terminals.sessions }, request())
    await settle()

    expect(result.problem).toBeNull()
    expect(result.chat).not.toBeNull()
    expect(chats()).toHaveLength(1)
    expect(terminals.revoked).toEqual(['gr_1'])
  })
})

describe('Start run with an agent: the guidance and the kickoff', () => {
  it('gives Claude Code the kickoff as its prompt: fixed text and the run lines, no guidance and no claim token', async () => {
    const { records, runs } = rig()

    await startOrchestratorRun({ runs, chats: records, terminals: terminals.sessions }, request())

    const kickoff = argsOf().at(-1) ?? ''
    for (const wanted of ['Epic: Agent chats (ep_1)', 'Branch: epic/agent-chats', 'Run: rn_2', 'First step: ']) {
      expect(kickoff).toContain(wanted)
    }
    expect(kickoff).not.toContain('=== ')
    expect(maskClaimTokens(kickoff)).toBe(kickoff)
    expect(kickoff).not.toContain(CLAIM_TOKEN_MASK)
    expect(chats()[0]?.kickoffSent).toBe(true)
  })

  it('puts the orchestrator and worker guidance in the chat\'s instructions file, with an orchestrator grant that may not save', async () => {
    const { records, runs } = rig()

    const result = await startOrchestratorRun({ runs, chats: records, terminals: terminals.sessions }, request())

    const file = argsOf()[argsOf().indexOf('--append-system-prompt-file') + 1] ?? ''
    expect(file).toBe(join(terminals.userData, 'agents', 'instructions', `${result.chat?.id ?? ''}.md`))
    const instructions = readFileSync(file, 'utf8')
    expect(instructions.endsWith(orchestratorGuidance())).toBe(true)
    expect(instructions).toContain('**orchestrator** grant')
    expect(instructions).toContain('This chat may not save plans')
  })

  it('pastes the kickoff into Autonomous once its first screen has settled', async () => {
    const { records, runs } = rig()

    await startOrchestratorRun({ runs, chats: records, terminals: terminals.sessions }, request('autonomous', null))
    const pty = terminals.host.last()
    pty.emitData('\x1b[?2004hAutonomous')
    await settle()
    // The screen settles for a second, then the paste goes, and its Enter half a second later.
    terminals.clock.advance(1_500)

    const [paste = '', enter] = pty.written
    expect(paste.startsWith('\x1b[200~Run this Dark Mechanicus epic')).toBe(true)
    expect(paste.endsWith('\x1b[201~')).toBe(true)
    expect(paste).toContain('Run: rn_2')
    expect(enter).toBe('\r')
    expect(chats()[0]).toMatchObject({ model: null, kickoffSent: true })
  })
})

describe('Start run with an agent: failures before the chat', () => {
  it('creates nothing when the run cannot be queued', async () => {
    const refusal = new DomainError('conflict', 'Epic ep_1 already has an active run.')
    const { records, runs } = rig({ queueRun: () => Promise.reject(refusal) })

    await expect(startOrchestratorRun({ runs, chats: records, terminals: terminals.sessions }, request())).rejects.toBe(refusal)

    expect(chats()).toEqual([])
    expect(terminals.host.spawns).toEqual([])
  })

  it('queues nothing when the epic cannot be read', async () => {
    const refusal = new DomainError('not_found', 'Epic ep_1 was not found.')
    const { calls, records, runs } = rig({ getEpic: () => Promise.reject(refusal) })

    await expect(startOrchestratorRun({ runs, chats: records, terminals: terminals.sessions }, request())).rejects.toBe(refusal)

    expect(calls).toEqual([])
  })

  it('keeps the queued run and says so when the chat cannot be created', async () => {
    const { records, runs } = rig()
    const failing: ChatRecords = {
      ...records,
      createChat: () => {
        throw new DomainError('invalid_input', 'The chat store is full.')
      }
    }

    const result = await startOrchestratorRun({ runs, chats: failing, terminals: terminals.sessions }, request())

    expect([result.run, result.chat]).toEqual([RUN, null])
    expect(result.problem).toContain('Run #2 is queued')
    expect(result.problem).toContain('The chat store is full.')
    expect(result.problem).toContain('waiting for an orchestrator')
    expect(terminals.host.spawns).toEqual([])
  })
})

describe('Start run with an agent: a terminal that cannot start', () => {
  const NOT_STARTED = [
    ['a spawn that fails', (): void => terminals.host.failNextSpawn(new Error('posix_spawnp failed.')), 'posix_spawnp failed'],
    ['a signed-out agent', (): void => void (terminals.auth.status = { state: 'signed_out', reason: 'Claude Code is signed out.' }), 'Claude Code is signed out'],
    ['a folder no longer tracked', (): void => void terminals.tracked.delete(terminals.repo), 'no longer tracked']
  ] as const

  it.each(NOT_STARTED)('removes the chat again and leaves the run queued with the reason, for %s', async (_name, arrange, reason) => {
    const { records, runs } = rig()
    arrange()

    const result = await startOrchestratorRun({ runs, chats: records, terminals: terminals.sessions }, request())

    expect([result.run, result.chat]).toEqual([RUN, null])
    expect(result.problem).toContain('Run #2 is queued, but Claude Code could not be started')
    expect(result.problem).toContain(reason)
    expect(result.problem).toContain('waiting for an orchestrator')
    expect(chats()).toEqual([])
    expect(terminals.revoked).toEqual(terminals.steps.filter((step) => step.startsWith('grant:')).map((step) => step.slice('grant:'.length)))
  })

  it('names an agent that is not connected, and leaves no chat behind', async () => {
    terminals.cleanup()
    terminals = terminalRig({ agents: [builtInAgent('autonomous')] })
    const { records, runs } = rig()

    const result = await startOrchestratorRun({ runs, chats: records, terminals: terminals.sessions }, request())

    expect(result.chat).toBeNull()
    expect(result.problem).toContain('No connected agent has the id claude')
    expect(chats()).toEqual([])
  })

  it('keeps the chat, and says why, when the terminal cannot start and the chat cannot be removed either', async () => {
    const { records, runs, errors } = rig()
    terminals.host.failNextSpawn(new Error('posix_spawnp failed.'))
    const stuck: ChatRecords = { ...records, deleteChat: () => Promise.reject(new Error('disk is read-only')) }

    const result = await startOrchestratorRun({ runs, chats: stuck, terminals: terminals.sessions, onError: (error) => errors.push(error) }, request())

    expect(result.chat).toMatchObject({ runId: 'rn_2' })
    expect(result.problem).toContain('posix_spawnp failed')
    expect(chats()).toHaveLength(1)
    expect(errors.map((error) => (error as Error).message)).toEqual(['disk is read-only'])
  })
})
