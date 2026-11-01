/**
 * Play and Kick back for a Kanban card: Play marks the play, creates an `orchestrator` chat that records the card
 * and starts its terminal with the card kickoff before the answer; Kick back records the comment and pastes it into
 * the terminal of the card's newest chat, starting that terminal again (a resume, never the kickoff) when it is
 * stopped. The real Kanban core over a test database, and the terminal sessions on their fakes (fake PTY host, fake
 * clock) with the real chat records over the same store.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { kickBackKanbanCard as coreKickBack, claimKanbanCard, playKanbanCard, submitKanbanCard } from '../../core/services/kanban/attempts'
import { createKanbanCard, getKanbanCard } from '../../core/services/kanban/cards'
import type { ChatRecord } from '../../shared/agents/chat'
import type { KanbanPacket } from '../../shared/domain/kanban'
import { createTestCtx, withRole, type TestCtx } from '../../test/testContext'
import { builtInAgent, connectedAgents } from '../agents/__mocks__/chatFixtures'
import { createChatRecords, type ChatRecords } from '../agents/chatRecords'
import { CLAIM_TOKEN_MASK, maskClaimTokens } from '../agents/claimTokenMask'
import { kanbanGuidance, kanbanKickoff } from '../agents/kanbanKickoff'
import type { FakePty } from '../terminals/__mocks__/fakePtyHost'
import { claudeSessionFile, CUSTOM_AGENT, settle, terminalRig, type TerminalRig } from '../terminals/__mocks__/terminalSessionsRig'
import { endingTerminals } from '../terminals/terminalSessions'
import { kickBackKanbanCard, startKanbanCard, type KanbanCards } from './startKanbanCard'

const SECOND = 1_000
/** How long after a paste its Enter goes. */
const ENTER_DELAY = 500
/** What a TUI writes to turn bracketed paste on, once its input is live. */
const PASTE_ON = '\x1b[?2004h'
const TITLE = 'Fix the flaky upload test'
/** A Kanban claim token as the server issues it: the card attempt id, a dot and a 32-character secret. */
const CLAIM_TOKEN = 'ka_01m6aspj4vxjq38vcbgxpg73jn.gUJvQxJEDk0emfDt1HQ9H3tYGOmsf4IX'

interface Rig {
  desktop: TestCtx
  records: ChatRecords
  cards: KanbanCards
  /** What the cards side was asked for, as "<call> <card id>". */
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

/** The real Kanban core over one test database, and the chat records over the terminals' store, with deleting a chat ending its terminal first, as main wires them. */
function rig(): Rig {
  const desktop = createTestCtx({ role: 'desktop', checkout: { branch: 'feature/cards', commit: null } })
  const calls: string[] = []
  const records = createChatRecords({ store: terminals.store, agentFor: connectedAgents([builtInAgent('claude'), builtInAgent('autonomous'), CUSTOM_AGENT]) })
  const cards: KanbanCards = {
    play: async (_folder, cardId) => (calls.push(`play ${cardId}`), playKanbanCard(desktop, { cardId })),
    kickBack: async (_folder, input) => (calls.push(`kickBack ${input.cardId}`), coreKickBack(desktop, input)),
    branch: async () => desktop.checkout().branch
  }
  return { desktop, records: endingTerminals(records, terminals.sessions), cards, calls, errors: [] }
}

function deps(state: Rig, records: ChatRecords = state.records): Parameters<typeof startKanbanCard>[0] {
  return { cards: state.cards, chats: records, terminals: terminals.sessions, onError: (error) => state.errors.push(error) }
}

function newCard(state: Rig, title = TITLE): { id: string; key: string } {
  return createKanbanCard(state.desktop, { title, acceptanceCriteria: ['It passes 50 runs in a row'] })
}

/** The card's agent claims and submits it: it waits in Ready for review. */
function submit(state: Rig, cardId: string): void {
  const packet: KanbanPacket = claimKanbanCard(withRole(state.desktop, 'orchestrator'), { cardId })
  submitKanbanCard(withRole(state.desktop, 'worker'), { attemptId: packet.attemptId, claimToken: packet.claimToken ?? '', outputs: { summary: 'Fixed' } })
}

function chats(): ChatRecord[] {
  return terminals.store.listChats(terminals.repo)
}

function argsOf(pty: FakePty): string[] {
  return pty.spec.args as string[]
}

function instructionsOf(pty: FakePty): string {
  const args = argsOf(pty)
  return readFileSync(args[args.indexOf('--append-system-prompt-file') + 1] ?? '', 'utf8')
}

/** What a person pasting `text` sends, as xterm.js sends it: newlines as CR, between the paste marks; then Enter. */
function pasteOf(text: string): string[] {
  return [`\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`, '\r']
}

/** The CLI draws its screen with its input live, and the screen has then been quiet for a second. */
async function drawSettled(pty: FakePty, data = 'ready'): Promise<void> {
  pty.emitData(`${PASTE_ON}${data}`)
  await settle()
  terminals.clock.advance(SECOND)
}

function kickBackMessage(key: string, cardId: string, comment: string): string {
  return `${key} was kicked back by a person: ${comment}. Claim it again with claim_kanban_card (cardId ${cardId}) and address the comment.`
}

describe('play a Kanban card', () => {
  it('marks the play, then creates an orchestrator chat that records the card and gives Claude Code the kickoff as its positional prompt', async () => {
    const state = rig()
    const card = newCard(state)

    const result = await startKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, agent: 'claude', model: 'sonnet' })

    expect(state.calls).toEqual([`play ${card.id}`])
    expect(result.problem).toBeNull()
    expect(result.card).toMatchObject({ id: card.id, playPending: true })
    expect(result.chat).toMatchObject({ role: 'orchestrator', allowSave: false, model: 'sonnet', cardId: card.id, title: `Kanban · ${card.key} ${TITLE}` })
    expect(chats().map((chat) => chat.id)).toEqual([result.chat?.id])
    expect(terminals.steps).toEqual(['auth', 'grant:gr_1', 'spawn'])
    expect(argsOf(terminals.host.last()).at(-1)).toBe(kanbanKickoff({ cardId: card.id, key: card.key, title: TITLE, branch: 'feature/cards' }))
    expect(terminals.host.kickoffSentAtSpawn).toEqual([true])
  })

  it('keeps the kickoff short, and puts the card guidance in the instructions of an orchestrator grant that may not save', async () => {
    const state = rig()
    const card = newCard(state)

    await startKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, agent: 'claude' })

    const pty = terminals.host.last()
    const kickoff = argsOf(pty).at(-1) ?? ''
    expect(kickoff).toContain(`claim_kanban_card with cardId ${card.id}`)
    expect(kickoff).not.toContain('=== ')
    expect(kickoff.length).toBeLessThan(1_500)
    const instructions = instructionsOf(pty)
    expect(instructions).toContain('**orchestrator** grant')
    expect(instructions).toContain('This chat may not save plans')
    expect(instructions).not.toContain('Orchestrating a Dark Mechanicus run')
    expect(instructions.endsWith(kanbanGuidance(card.id))).toBe(true)
    expect(instructions).toMatch(/do not call submit_kanban_card or fail_kanban_card, report back/)
    expect(maskClaimTokens(`${kickoff}\n${instructions}`)).toBe(`${kickoff}\n${instructions}`)
  })

  it('pastes the kickoff into Autonomous once its first screen has settled', async () => {
    const state = rig()
    const card = newCard(state)

    await startKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, agent: 'autonomous' })
    const pty = terminals.host.last()
    await drawSettled(pty, 'Autonomous')
    terminals.clock.advance(ENTER_DELAY)

    expect(argsOf(pty).join('\n')).not.toContain('Carry this Dark Mechanicus Kanban card')
    expect(pty.written).toEqual(pasteOf(kanbanKickoff({ cardId: card.id, key: card.key, title: TITLE, branch: 'feature/cards' })))
    expect(chats()[0]).toMatchObject({ kickoffSent: true })
  })

})

describe('play a Kanban card: a card that cannot be played, a branch that cannot be read', () => {
  it('creates nothing when the card cannot be played', async () => {
    const state = rig()
    const card = newCard(state)
    playKanbanCard(state.desktop, { cardId: card.id })
    submit(state, card.id)

    await expect(startKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, agent: 'claude' })).rejects.toMatchObject({ code: 'invalid_state' })

    expect(chats()).toEqual([])
    expect(terminals.host.spawns).toEqual([])
  })

  it('still starts the agent when the branch cannot be read, saying so in the kickoff and reporting the failure', async () => {
    const state = rig()
    const card = newCard(state)
    const cards: KanbanCards = { ...state.cards, branch: () => Promise.reject(new Error('git is gone')) }

    const result = await startKanbanCard({ ...deps(state), cards }, { folder: terminals.repo, cardId: card.id, agent: 'claude' })

    expect(result.problem).toBeNull()
    expect(argsOf(terminals.host.last()).at(-1)).toContain('Branch: the checked-out branch could not be read')
    expect(state.errors).toEqual([expect.objectContaining({ message: 'git is gone' })])
  })
})

describe('play a Kanban card: failures once the chat is asked for', () => {
  it.each([
    ['a spawn that fails', (): void => terminals.host.failNextSpawn(new Error('posix_spawnp failed.')), 'posix_spawnp failed'],
    ['a signed-out agent', (): void => void (terminals.auth.status = { state: 'signed_out', reason: 'Claude Code is signed out.' }), 'Claude Code is signed out'],
    ['a folder no longer tracked', (): void => void terminals.tracked.delete(terminals.repo), 'no longer tracked']
  ] as const)('removes the chat again and keeps the pending play, naming the agent and why, for %s', async (_name, arrange, reason) => {
    const state = rig()
    const card = newCard(state)
    arrange()

    const result = await startKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, agent: 'claude' })

    expect(result.chat).toBeNull()
    expect(result.problem).toContain(`${card.key} is played, but Claude Code could not be started`)
    expect(result.problem).toContain(reason)
    expect(result.problem?.endsWith('The card keeps its pending play: press Play again to start a new chat.')).toBe(true)
    expect(chats()).toEqual([])
    expect(getKanbanCard(state.desktop, { cardId: card.id })).toMatchObject({ lane: 'backlog', playPending: true })
    expect(terminals.revoked).toEqual(terminals.steps.filter((step) => step.startsWith('grant:')).map((step) => step.slice('grant:'.length)))
  })

  it('keeps the chat, and says why, when the terminal cannot start and the chat cannot be removed either', async () => {
    const state = rig()
    const card = newCard(state)
    terminals.host.failNextSpawn(new Error('posix_spawnp failed.'))
    const stuck: ChatRecords = { ...state.records, deleteChat: () => Promise.reject(new Error('disk is read-only')) }

    const result = await startKanbanCard(deps(state, stuck), { folder: terminals.repo, cardId: card.id, agent: 'claude' })

    expect(result.chat).toMatchObject({ cardId: card.id })
    expect(result.problem).toContain('posix_spawnp failed')
    expect(chats()).toHaveLength(1)
    expect(state.errors.map((error) => (error as Error).message)).toEqual(['disk is read-only'])
  })

  it('reports a chat that cannot be created by its reason, starting nothing', async () => {
    const state = rig()
    const card = newCard(state)
    const refusing: ChatRecords = {
      ...state.records,
      createChat: () => {
        throw new DomainError('invalid_input', 'The chat store is full.')
      }
    }

    const result = await startKanbanCard(deps(state, refusing), { folder: terminals.repo, cardId: card.id, agent: 'claude' })

    expect(result).toMatchObject({ chat: null, problem: `${card.key} is played, but its chat could not be created: The chat store is full. The card keeps its pending play: press Play again to start a new chat.` })
    expect(terminals.host.spawns).toEqual([])
    expect(state.errors).toEqual([])
  })
})

/** A card played with `agent` whose agent has carried it to Ready for review; answers the card, its chat and its PTY. */
async function playedToReview(state: Rig, agent = 'claude'): Promise<{ card: { id: string; key: string }; chat: ChatRecord; pty: FakePty }> {
  const card = newCard(state)
  const played = await startKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, agent })
  submit(state, card.id)
  return { card, chat: played.chat as ChatRecord, pty: terminals.host.last() }
}

describe("kick back a Kanban card: the card's terminal runs", () => {
  it('records the kick-back, then pastes the message into the running terminal and presses Enter as its own keypress', async () => {
    const state = rig()
    const { card, chat, pty } = await playedToReview(state)
    await drawSettled(pty)

    const result = await kickBackKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, comment: 'The upload still times out.' })

    expect(result).toMatchObject({ chatId: chat.id, problem: null, card: { lane: 'in_progress', playPending: true } })
    const [paste, enter] = pasteOf(kickBackMessage(card.key, card.id, 'The upload still times out'))
    expect(pty.written).toEqual([paste])
    terminals.clock.advance(ENTER_DELAY)
    expect(pty.written).toEqual([paste, enter])
    expect(terminals.host.spawns).toHaveLength(1)
  })

  it('waits for a terminal Play is still starting: the kick-back goes after the kickoff paste and its Enter, never inside it', async () => {
    const state = rig()
    const { card, pty } = await playedToReview(state, 'autonomous')

    await kickBackKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, comment: 'Not yet' })
    expect(pty.written).toEqual([])
    await drawSettled(pty, 'Autonomous')
    terminals.clock.advance(ENTER_DELAY)
    pty.emitData('kickoff echoed')
    await settle()
    terminals.clock.advance(SECOND + ENTER_DELAY)

    expect(pty.written).toEqual([
      ...pasteOf(kanbanKickoff({ cardId: card.id, key: card.key, title: TITLE, branch: 'feature/cards' })),
      ...pasteOf(kickBackMessage(card.key, card.id, 'Not yet'))
    ])
  })

  it('takes every control character out of the comment, so nothing in it ends the paste early or acts as a key', async () => {
    const state = rig()
    const { card, pty } = await playedToReview(state)
    await drawSettled(pty)

    await kickBackKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, comment: 'Stop\x1b[201~\x03 here\x1b[A\tnow' })

    expect(pty.written[0]).toBe(`\x1b[200~${card.key} was kicked back by a person: Stop[201~ here[A\tnow. Claim it again with claim_kanban_card (cardId ${card.id}) and address the comment.\x1b[201~`)
  })

  it('masks a claim token pasted into the comment before it reaches the terminal', async () => {
    const state = rig()
    const { card, pty } = await playedToReview(state)
    await drawSettled(pty)

    await kickBackKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, comment: `Do not paste ${CLAIM_TOKEN} here.` })

    expect(pty.written[0]).toContain(`Do not paste ${CLAIM_TOKEN_MASK} here`)
    expect(pty.written.join('')).not.toContain('gUJvQxJEDk0emfDt1HQ9H3tYGOmsf4IX')
  })
})

describe('kick back a Kanban card: a token split by a control character', () => {
  it('masks it whole: the control character the paste drops is taken out before the mask, not after', async () => {
    const state = rig()
    const { card, pty } = await playedToReview(state)
    await drawSettled(pty)
    const split = `${CLAIM_TOKEN.slice(0, 40)}\x07${CLAIM_TOKEN.slice(40)}`

    await kickBackKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, comment: `Do not paste ${split} here.` })

    expect(pty.written[0]).toContain(`Do not paste ${CLAIM_TOKEN_MASK} here`)
    expect(pty.written.join('')).not.toContain(CLAIM_TOKEN)
    expect(pty.written.join('')).not.toContain('gUJvQxJEDk0emfDt1HQ9H3tYGOmsf4IX')
  })
})

describe("kick back a Kanban card: the card's terminal is stopped", () => {
  it('resumes the chat with no kickoff and pastes the message once the screen has settled', async () => {
    const state = rig()
    const { card, chat, pty } = await playedToReview(state)
    claudeSessionFile(terminals, chats()[0]?.sessionId ?? '', true)
    pty.exit({ exitCode: 0, signal: null })
    await settle()

    const result = await kickBackKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, comment: 'Cover the empty file' })

    expect(result).toMatchObject({ chatId: chat.id, problem: null })
    const resumed = terminals.host.last()
    expect(terminals.host.spawns).toHaveLength(2)
    expect(argsOf(resumed)).toContain('--resume')
    expect(argsOf(resumed).join('\n')).not.toContain('Carry this Dark Mechanicus Kanban card')
    expect(resumed.written).toEqual([])
    await drawSettled(resumed, 'Claude Code')
    terminals.clock.advance(ENTER_DELAY)
    expect(resumed.written).toEqual(pasteOf(kickBackMessage(card.key, card.id, 'Cover the empty file')))
    expect(instructionsOf(resumed).endsWith(kanbanGuidance(card.id))).toBe(true)
  })

  it('never sends the kickoff with the restart, not even to a chat whose kickoff never went', async () => {
    const state = rig()
    const { card, pty } = await playedToReview(state, 'autonomous')
    // Autonomous exited before its first screen settled, so the kickoff was never pasted.
    pty.exit({ exitCode: 1, signal: null })
    await settle()
    expect(chats()[0]?.kickoffSent).toBeUndefined()

    await kickBackKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, comment: 'Again' })
    const restarted = terminals.host.last()
    await drawSettled(restarted, 'Autonomous')
    terminals.clock.advance(ENTER_DELAY + 10 * SECOND)

    expect(restarted.written).toEqual(pasteOf(kickBackMessage(card.key, card.id, 'Again')))
  })

  it("says the comment could not reach the chat when its terminal cannot start, and the card is back In progress", async () => {
    const state = rig()
    const { card, chat, pty } = await playedToReview(state)
    pty.exit({ exitCode: 0, signal: null })
    await settle()
    terminals.auth.status = { state: 'signed_out', reason: 'Claude Code is signed out.' }

    const result = await kickBackKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, comment: 'Not yet' })

    expect(result.chatId).toBe(chat.id)
    expect(result.problem).toBe(
      `${card.key} is back In progress with a pending play, but the comment could not reach its chat: Claude Code is signed out. Open the chat and ask its agent to claim the card again once it can answer, or press Play to start a new chat.`
    )
    expect(result.card).toMatchObject({ lane: 'in_progress', playPending: true })
  })
})

describe('kick back a Kanban card: which chat', () => {
  it('pastes into the newest chat Play started for the card, and none of an older one', async () => {
    const state = rig()
    const card = newCard(state)
    await startKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, agent: 'claude' })
    const older = terminals.host.last()
    older.exit({ exitCode: 1, signal: null })
    await settle()
    const again = await startKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, agent: 'claude' })
    const newer = terminals.host.last()
    submit(state, card.id)
    await drawSettled(newer)

    const result = await kickBackKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, comment: 'Not yet' })

    expect(result.chatId).toBe(again.chat?.id)
    expect(newer.written[0]).toContain('was kicked back by a person: Not yet.')
    expect(terminals.host.spawns).toHaveLength(2)
  })

  it('answers chatId null when the card has no chat, or its chat was deleted, and still records the kick-back', async () => {
    const state = rig()
    const card = newCard(state)
    playKanbanCard(state.desktop, { cardId: card.id })
    submit(state, card.id)

    const result = await kickBackKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, comment: 'Not yet' })

    expect(result).toMatchObject({ chatId: null, problem: null, card: { lane: 'in_progress' } })
    expect(terminals.host.spawns).toEqual([])

    const { card: other, chat, pty } = await playedToReview(state)
    const deleted = state.records.deleteChat(chat)
    pty.exit({ exitCode: 0, signal: 9 })
    await deleted
    expect(await kickBackKanbanCard(deps(state), { folder: terminals.repo, cardId: other.id, comment: 'Gone' })).toMatchObject({ chatId: null, problem: null })
    expect(terminals.host.spawns).toHaveLength(1)
  })

  it('pastes nothing when the core refuses the kick-back', async () => {
    const state = rig()
    const card = newCard(state)
    await startKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, agent: 'claude' })
    const pty = terminals.host.last()
    await drawSettled(pty)

    await expect(kickBackKanbanCard(deps(state), { folder: terminals.repo, cardId: card.id, comment: 'Not yet' })).rejects.toMatchObject({ code: 'invalid_state' })

    expect(pty.written).toEqual([])
  })
})
