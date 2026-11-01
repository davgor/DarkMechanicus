/**
 * Play and Kick back for a Kanban card, in main, mirroring `startOrchestratorRun`:
 *
 *   - Play marks a pending play on the card (core `playKanbanCard`), creates an orchestrator chat for it
 *     (Allow save off, the card's id recorded on the chat) and sends the kickoff. A card that cannot be
 *     played is an error and nothing is created. When the chat cannot be created, or its agent cannot
 *     start, the chat is removed again and the answer says why; the pending play is harmless, and
 *     pressing Play again starts a new chat.
 *   - Kick back records the person's comment (core `kickBackKanbanCard`, which returns the card to In
 *     progress with a pending play), then sends the comment to the card's newest chat, which resumes as
 *     a send to any stopped chat does, so its agent claims the card again. A card with no chat answers
 *     `chatId: null`.
 *
 * Neither message carries a claim token: the agent gets one only when it claims, and a token pasted
 * into a comment is masked before it reaches the chat.
 */
import { DomainError } from '../../core/errors'
import type { ChatRecord } from '../../shared/agents/chat'
import type { KickBackKanbanCardRequest, KickBackKanbanCardResult, StartKanbanCardRequest, StartKanbanCardResult } from '../../shared/agents/chatApi'
import type { KickBackKanbanCardInput } from '../../shared/domain/api'
import type { KanbanCardView } from '../../shared/domain/kanban'
import { maskClaimTokens } from '../agents/claimTokenMask'
import { kanbanKickoff, kanbanTitle } from '../agents/kanbanKickoff'
import type { SessionManager } from '../agents/sessionManager'

/** The Kanban side of the desktop for one tracked folder: the same commands the board's buttons run. */
export interface KanbanCards {
  play(folder: string, cardId: string): Promise<KanbanCardView>
  kickBack(folder: string, input: KickBackKanbanCardInput): Promise<KanbanCardView>
  /** The checkout's current branch, which cards work on; null when there is none (a detached HEAD, no Git). */
  branch(folder: string): Promise<string | null>
}

interface KanbanStartDeps {
  cards: KanbanCards
  sessions: Pick<SessionManager, 'createChat' | 'send' | 'deleteChat' | 'agentName' | 'listChats'>
  /** Told about failures that are not DomainErrors and about a chat that could not be removed, so main can log them. */
  onError?: (error: unknown) => void
}

const PLAY_AGAIN = 'The card keeps its pending play: press Play again to start a new chat.'

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, '')
}

function logUnexpected(deps: KanbanStartDeps, error: unknown): void {
  if (!(error instanceof DomainError)) {
    deps.onError?.(error)
  }
}

/** Removes the chat of an agent that could not start; false (after reporting) when it could not be removed. */
async function removeChat(deps: KanbanStartDeps, chat: ChatRecord): Promise<boolean> {
  try {
    await deps.sessions.deleteChat(chat)
    return true
  } catch (error) {
    deps.onError?.(error)
    return false
  }
}

/** `request.folder` is the canonical path of a tracked folder and `request.cardId` a card id. */
export async function startKanbanCard(deps: KanbanStartDeps, request: StartKanbanCardRequest): Promise<StartKanbanCardResult> {
  const { folder, agent } = request
  const card = await deps.cards.play(folder, request.cardId)
  const agentName = deps.sessions.agentName(agent)
  // Only the kickoff names the branch, and the claim packet carries it again, so a failed read is reported and does not stop Play.
  const branch = await deps.cards.branch(folder).catch((error: unknown) => {
    deps.onError?.(error)
    return null
  })

  let chat: ChatRecord
  try {
    chat = deps.sessions.createChat({
      folder,
      agent,
      role: 'orchestrator',
      model: request.model ?? null,
      allowSave: false,
      title: kanbanTitle(card.key, card.title),
      cardId: card.id
    })
  } catch (error) {
    logUnexpected(deps, error)
    return { card, chat: null, problem: `${card.key} is played, but its chat could not be created: ${reasonOf(error)}. ${PLAY_AGAIN}` }
  }

  try {
    await deps.sessions.send(chat, kanbanKickoff({ cardId: card.id, key: card.key, title: card.title, branch }))
  } catch (error) {
    logUnexpected(deps, error)
    const removed = await removeChat(deps, chat)
    return { card, chat: removed ? null : chat, problem: `${card.key} is played, but ${agentName} could not be started: ${reasonOf(error)}. ${PLAY_AGAIN}` }
  }
  return { card, chat, problem: null }
}

/** The message a kicked-back card's chat receives: the comment, masked, and what to do about it. One closing period of the comment is the sentence's own. */
function kickBackMessage(key: string, comment: string): string {
  return `${key} was kicked back by a person: ${maskClaimTokens(comment.trim()).replace(/\.$/, '')}. Claim it again with claim_kanban_card and address the comment.`
}

/** `request.folder` is the canonical path of a tracked folder and `request.cardId` a card id. */
export async function kickBackKanbanCard(deps: KanbanStartDeps, request: KickBackKanbanCardRequest): Promise<KickBackKanbanCardResult> {
  const { folder, cardId, comment } = request
  const card = await deps.cards.kickBack(folder, { cardId, comment })
  // The newest chat Play started for the card, whatever was active since: an older one an earlier Play left behind no longer carries it.
  const chat = deps.sessions
    .listChats(folder)
    .filter((candidate) => candidate.cardId === card.id)
    .reduce<ChatRecord | undefined>((newest, candidate) => (newest === undefined || candidate.createdAt > newest.createdAt ? candidate : newest), undefined)
  if (chat === undefined) {
    return { card, chatId: null, problem: null }
  }
  try {
    await deps.sessions.send(chat, kickBackMessage(card.key, comment))
  } catch (error) {
    logUnexpected(deps, error)
    const problem = `${card.key} is back In progress with a pending play, but the comment could not reach its chat: ${reasonOf(error)}. Open the chat and ask its agent to claim the card again once it can answer, or press Play to start a new chat.`
    return { card, chatId: chat.id, problem }
  }
  return { card, chatId: chat.id, problem: null }
}
