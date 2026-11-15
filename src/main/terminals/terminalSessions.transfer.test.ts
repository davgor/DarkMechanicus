/**
 * A Linear transfer chat, or the chat Play opened for a Kanban card, started again (an exit, an app restart): its
 * kickoff went with the first start only, so a CLI that starts on a new session (Codex and Cursor with
 * no stored session, a custom CLI) must still find its task in the chat's instructions: for a transfer the epic id,
 * the start_transfer step and the guide; for a card the card id, the claim step and the guides. On the fake PTY host
 * and the fake clock.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { transferKickoff } from '../../mcp/transferKickoff'
import { kanbanKickoff } from '../agents/kanbanKickoff'
import type { ChatRecord } from '../../shared/agents/chat'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import type { FakePty } from './__mocks__/fakePtyHost'
import { CUSTOM_AGENT, settle, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'

const SECOND = 1_000
const ENTER_DELAY = 500
const EPIC_ID = 'ep_01m6772ffwkwr2a91fsqzfz1he'
const KICKOFF = transferKickoff({ epicId: EPIC_ID, epicTitle: 'Linear handoff' })
const STEP = `Call start_transfer for epic ${EPIC_ID}`
/** A custom CLI that is given the instructions file, as `{instructions}` lets one be. */
const CUSTOM = { ...CUSTOM_AGENT, args: ['--prompt-file', '{instructions}'] }

let rig: TerminalRig

beforeEach(() => {
  rig = terminalRig({ agents: [builtInAgent('codex'), builtInAgent('claude'), CUSTOM] })
})

afterEach(() => {
  rig.cleanup()
})

function transferChat(agent: string): ChatRecord {
  return rig.store.createChat({ folder: rig.repo, agent, model: null, role: 'orchestrator', allowSave: false, title: 'Linear transfer · Linear handoff', transferEpicId: EPIC_ID })
}

function instructionsOf(chat: ChatRecord): string {
  return readFileSync(join(rig.userData, 'agents', 'instructions', `${chat.id}.md`), 'utf8')
}

/** The CLI draws its first screen with bracketed paste on; the first paste and its Enter then go. */
async function settleFirstPaste(pty: FakePty): Promise<void> {
  pty.emitData('\x1b[?2004hready')
  await settle()
  rig.clock.advance(SECOND + ENTER_DELAY)
}

async function exit(pty: FakePty): Promise<void> {
  pty.exit({ exitCode: 0, signal: null })
  await settle()
}

describe('terminal sessions: a Linear transfer chat started again', () => {
  it('gives a Codex transfer chat on a new session its task again: the epic id, the start_transfer step and the guide, without the kickoff', async () => {
    const chat = transferChat('codex')
    expect(await rig.sessions.start(chat, { kickoff: KICKOFF })).toMatchObject({ state: 'running' })
    const first = rig.host.last()
    await settleFirstPaste(first)
    expect(first.written[0]).toContain('Move this saved Dark Mechanicus epic to a Linear project')
    await exit(first)

    const again = await startTerminal(rig, chat)
    await settleFirstPaste(again.pty)

    expect(rig.host.spawns).toHaveLength(2)
    expect(again.pty.spec.args).not.toContain('resume')
    const [paste = ''] = again.pty.written
    expect(paste).toContain(EPIC_ID)
    expect(paste).toContain(STEP)
    expect(paste).toContain('=== Linear transfer guidance ===')
    expect(paste).not.toContain('Move this saved Dark Mechanicus epic to a Linear project')
    expect(instructionsOf(chat)).toContain(STEP)
  })

  it('writes the task into the instructions file a custom transfer CLI is started with, on every start', async () => {
    const chat = transferChat(CUSTOM.id)
    expect(await rig.sessions.start(chat, { kickoff: KICKOFF })).toMatchObject({ state: 'running' })
    await exit(rig.host.last())

    const again = await startTerminal(rig, chat)

    expect(rig.host.spawns).toHaveLength(2)
    const file = (again.pty.spec.args as string[])[1] ?? ''
    expect(file).toBe(join(rig.userData, 'agents', 'instructions', `${chat.id}.md`))
    expect(readFileSync(file, 'utf8')).toContain(EPIC_ID)
    expect(readFileSync(file, 'utf8')).toContain(STEP)
  })

  it('gives a chat that is not a transfer chat no transfer guidance', async () => {
    const chat = rig.newChat('codex')

    const { pty } = await startTerminal(rig, chat)
    await settleFirstPaste(pty)

    expect(instructionsOf(chat)).not.toContain('start_transfer')
    expect(pty.written[0]).not.toContain('Linear transfer guidance')
  })
})

describe('terminal sessions: a Kanban card chat started again', () => {
  const CARD_ID = 'kc_01m6a1p7qaxttbw9f5927qk2dx'
  const CARD_KICKOFF = kanbanKickoff({ cardId: CARD_ID, key: 'DM-42', title: 'Fix the flaky upload test', branch: 'main' })

  it('gives a Codex card chat on a new session its card again: the claim step and the guides, without the kickoff', async () => {
    const chat = rig.store.createChat({ folder: rig.repo, agent: 'codex', model: null, role: 'orchestrator', allowSave: false, title: 'Kanban · DM-42 Fix the flaky upload test', cardId: CARD_ID })
    expect(await rig.sessions.start(chat, { kickoff: CARD_KICKOFF })).toMatchObject({ state: 'running' })
    const first = rig.host.last()
    await settleFirstPaste(first)
    expect(first.written[0]).toContain('Carry this Dark Mechanicus Kanban card')
    await exit(first)

    const again = await startTerminal(rig, chat)
    await settleFirstPaste(again.pty)

    expect(rig.host.spawns).toHaveLength(2)
    const [paste = ''] = again.pty.written
    expect(paste).toContain(`claim_kanban_card with cardId ${CARD_ID}`)
    expect(paste).toContain('=== Worker guidance')
    expect(paste).not.toContain('Carry this Dark Mechanicus Kanban card')
    expect(instructionsOf(chat)).toContain('## Carrying a Dark Mechanicus Kanban card')
  })
})

describe('terminal sessions: original first popup message', () => {
  const firstPrompt = '  Could you investigate why sign-in fails after expiry?\nPreserve café and 👋 exactly.  '

  it('waits for ready input, submits the whole original once, and never replays on attach or restart', async () => {
    const chat = rig.store.createChat({ folder: rig.repo, agent: CUSTOM.id, model: null, role: 'orchestrator', allowSave: true, firstPrompt, titleStatus: 'pending', firstPromptDelivery: 'pending' })
    const first = await startTerminal(rig, chat)
    rig.clock.advance(20_000)
    expect(first.pty.written).toEqual([])
    expect(instructionsOf(chat)).toContain('call name_chat')
    expect(instructionsOf(chat)).not.toContain(firstPrompt)
    await settleFirstPaste(first.pty)
    expect(first.pty.written).toEqual([`\x1b[200~${firstPrompt.replace(/\n/g, '\r')}\x1b[201~`, '\r'])
    expect(rig.store.getChat(chat)).toMatchObject({ firstPrompt, kickoffSent: true, firstPromptDelivery: 'submitted' })
    await startTerminal(rig, chat)
    expect(first.pty.written).toHaveLength(2)
    await exit(first.pty)
    const again = await startTerminal(rig, chat)
    await settleFirstPaste(again.pty)
    expect(again.pty.written).toEqual([])
  })

  it('does not automatically replay after exit between insertion and submission, and retains recoverable text', async () => {
    const chat = rig.store.createChat({ folder: rig.repo, agent: CUSTOM.id, model: null, role: 'orchestrator', allowSave: true, firstPrompt, titleStatus: 'pending', firstPromptDelivery: 'pending' })
    const first = await startTerminal(rig, chat)
    first.pty.emitData('\x1b[?2004hready')
    await settle()
    rig.clock.advance(SECOND)
    expect(first.pty.written).toHaveLength(1)
    await exit(first.pty)
    expect(rig.store.getChat(chat)).toMatchObject({ firstPrompt, firstPromptDelivery: 'uncertain' })
    const again = await startTerminal(rig, chat)
    await settleFirstPaste(again.pty)
    expect(again.pty.written).toEqual([])
  })

  it('reports a real PTY write failure and keeps the complete first prompt without automatic retry', async () => {
    const chat = rig.store.createChat({ folder: rig.repo, agent: CUSTOM.id, model: null, role: 'orchestrator', allowSave: true, firstPrompt, firstPromptDelivery: 'pending' })
    const first = await startTerminal(rig, chat)
    const error = new Error('The owned PTY rejected input.')
    first.pty.write = () => { throw error }
    first.pty.emitData('\x1b[?2004hready')
    await settle()
    expect(() => rig.clock.advance(SECOND)).not.toThrow()
    expect(rig.errors).toContain(error)
    expect(rig.store.getChat(chat)).toMatchObject({ firstPrompt, firstPromptDelivery: 'uncertain' })
    expect(first.pty.written).toEqual([])
    expect(rig.killed).toHaveLength(1)
  })
})

it.each(['help', '- explain this'])('delivers literal popup prompt %s unchanged once through a ready custom terminal', async (firstPrompt) => {
  const chat = rig.store.createChat({ folder: rig.repo, agent: CUSTOM.id, model: null, role: 'orchestrator', allowSave: true, firstPrompt, firstPromptDelivery: 'pending' })
  const started = await startTerminal(rig, chat)
  expect(started.pty.written).toEqual([])
  await settleFirstPaste(started.pty)
  expect(started.pty.written).toEqual([`\x1b[200~${firstPrompt}\x1b[201~`, '\r'])
  expect(rig.store.getChat(chat)).toMatchObject({ firstPrompt, kickoffSent: true, firstPromptDelivery: 'submitted' })
})

it('hands a full ordinary first popup message to the native startup contract once, without typing into a screen', async () => {
  const firstPrompt = '  Please explain session refresh.\nKeep the original request intact.  '
  const chat = rig.store.createChat({ folder: rig.repo, agent: 'claude', model: null, role: 'orchestrator', allowSave: true, firstPrompt, firstPromptDelivery: 'pending' })
  const started = await startTerminal(rig, chat)
  expect(started.pty.spec.args).toContain(firstPrompt)
  expect(started.pty.written).toEqual([])
  expect(rig.store.getChat(chat)).toMatchObject({ firstPrompt, kickoffSent: true, firstPromptDelivery: 'submitted' })
  await exit(started.pty)
  const again = await startTerminal(rig, chat)
  expect(again.pty.spec.args).not.toContain(firstPrompt)
  expect(again.pty.written).toEqual([])
})

it('retains ambiguous first input after a real Enter write failure and never resubmits automatically', async () => {
  const firstPrompt = 'Please repair the session refresh flow'
  const chat = rig.store.createChat({ folder: rig.repo, agent: CUSTOM.id, model: null, role: 'orchestrator', allowSave: true, firstPrompt, firstPromptDelivery: 'pending' })
  const first = await startTerminal(rig, chat)
  first.pty.emitData('\x1b[?2004hready')
  await settle()
  rig.clock.advance(SECOND)
  const error = new Error('The owned PTY rejected Enter.')
  first.pty.write = () => { throw error }
  expect(() => rig.clock.advance(ENTER_DELAY)).not.toThrow()
  expect(rig.errors).toContain(error)
  expect(rig.store.getChat(chat)).toMatchObject({ firstPrompt, firstPromptDelivery: 'uncertain' })
  expect(first.pty.written).toEqual([`\x1b[200~${firstPrompt}\x1b[201~`])
  expect(rig.killed).toHaveLength(1)
})
