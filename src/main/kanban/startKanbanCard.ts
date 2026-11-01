/**
 * Play and Kick back for a Kanban card, in main (`docs/design/chat-shells.md`, "The card chat Play opens"), mirroring
 * `startTransferChat`, so a failure part way leaves a state the person can read:
 *
 *   - Play marks a pending play on the card (core `playKanbanCard`), creates an orchestrator chat for it (Allow save
 *     off, the card's id recorded on the chat) and starts its terminal with the kickoff before answering, so the app
 *     can show the terminal. A card that cannot be played is an error and nothing is created. When the chat cannot
 *     be created, or its terminal does not start (a folder refused, the agent not connected or signed out, a spawn
 *     that fails), the chat is removed again and the answer says why; if it cannot be removed it is kept and
 *     returned, with the reason. The pending play is harmless: pressing Play again starts a new chat. A CLI that
 *     starts and then exits leaves its chat, which the person can read and start again.
 *   - Kick back records the person's comment (core `kickBackKanbanCard`, which returns the card to In progress with a
 *     pending play), then pastes the kick-back message into the terminal of the card's newest chat
 *     (`TerminalSessions.paste`): into its running PTY, or into the PTY it starts again (a resume when the CLI has a
 *     session, never with the kickoff), once the CLI's input is live, so its agent claims the card again. A card with
 *     no chat answers `chatId: null`.
 *
 * The kickoff is short (the card lines and the first step, `kanbanKickoff`) and goes with the chat's first start
 * only (`terminalSessions.ts`): Claude Code's positional prompt, every other CLI's first paste. The steps and the
 * orchestrator and worker guidance are in the chat's instructions (`terminalFiles.ts`, for a chat with a `cardId`),
 * written at every start. Neither the kickoff, the instructions nor the kick-back message carries a claim token: the
 * agent gets one only when it claims, and a token pasted into a comment is masked before it reaches the terminal.
 */
import { DomainError } from '../../core/errors'
import type { ChatRecord } from '../../shared/agents/chat'
import type { KickBackKanbanCardRequest, KickBackKanbanCardResult, StartKanbanCardRequest, StartKanbanCardResult } from '../../shared/agents/chatApi'
import type { KickBackKanbanCardInput } from '../../shared/domain/api'
import type { KanbanCardView } from '../../shared/domain/kanban'
import type { ChatRecords } from '../agents/chatRecords'
import { maskClaimTokens } from '../agents/claimTokenMask'
import { kanbanKickoff, kanbanTitle } from '../agents/kanbanKickoff'
import type { TerminalSessions, TerminalStart } from '../terminals/terminalSessions'

/** The Kanban side of the desktop for one tracked folder: the same commands the board's buttons run. */
export interface KanbanCards {
  play(folder: string, cardId: string): Promise<KanbanCardView>
  kickBack(folder: string, input: KickBackKanbanCardInput): Promise<KanbanCardView>
  /** The checkout's current branch, which cards work on; null when there is none (a detached HEAD, no Git). */
  branch(folder: string): Promise<string | null>
}

interface KanbanStartDeps {
  cards: KanbanCards
  chats: Pick<ChatRecords, 'createChat' | 'deleteChat' | 'agentName' | 'listChats'>
  terminals: Pick<TerminalSessions, 'start' | 'paste'>
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
    await deps.chats.deleteChat(chat)
    return true
  } catch (error) {
    deps.onError?.(error)
    return false
  }
}

/** Runs a terminal step (a start, or a paste); resolves with why it did not get a running PTY, or null once it did. */
async function terminalStep(deps: KanbanStartDeps, step: () => Promise<TerminalStart>): Promise<string | null> {
  try {
    const answer = await step()
    return answer.state === 'running' ? null : answer.message
  } catch (error) {
    logUnexpected(deps, error)
    return error instanceof Error ? error.message : String(error)
  }
}

/** `request.folder` is the canonical path of a tracked folder and `request.cardId` a card id. */
export async function startKanbanCard(deps: KanbanStartDeps, request: StartKanbanCardRequest): Promise<StartKanbanCardResult> {
  const { folder, agent } = request
  const card = await deps.cards.play(folder, request.cardId)
  const agentName = deps.chats.agentName(agent)
  // Only the kickoff names the branch, and the claim packet carries it again, so a failed read is reported and does not stop Play.
  const branch = await deps.cards.branch(folder).catch((error: unknown) => {
    deps.onError?.(error)
    return null
  })

  let chat: ChatRecord
  try {
    chat = deps.chats.createChat({
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

  const kickoff = kanbanKickoff({ cardId: card.id, key: card.key, title: card.title, branch })
  const failure = await terminalStep(deps, () => deps.terminals.start(chat, { kickoff }))
  if (failure !== null) {
    const removed = await removeChat(deps, chat)
    return { card, chat: removed ? null : chat, problem: `${card.key} is played, but ${agentName} could not be started: ${reasonOf(failure)}. ${PLAY_AGAIN}` }
  }
  return { card, chat, problem: null }
}

/**
 * The message a kicked-back card's chat receives: the comment, masked, and what to do about it. One closing period of
 * the comment is the sentence's own. The control characters the paste would drop (all but tab and line breaks) are
 * taken out first, so a token split by one is whole when it is masked, not joined again after.
 */
function kickBackMessage(card: KanbanCardView, comment: string): string {
  const text = comment.replace(/[^\P{Cc}\t\n\r]/gu, '').trim()
  return `${card.key} was kicked back by a person: ${maskClaimTokens(text).replace(/\.$/, '')}. Claim it again with claim_kanban_card (cardId ${card.id}) and address the comment.`
}

/** `request.folder` is the canonical path of a tracked folder and `request.cardId` a card id. */
export async function kickBackKanbanCard(deps: KanbanStartDeps, request: KickBackKanbanCardRequest): Promise<KickBackKanbanCardResult> {
  const { folder, cardId, comment } = request
  const card = await deps.cards.kickBack(folder, { cardId, comment })
  // The newest chat Play started for the card, whatever was active since: an older one an earlier Play left behind no longer carries it.
  const chat = deps.chats
    .listChats(folder)
    .filter((candidate) => candidate.cardId === card.id)
    .reduce<ChatRecord | undefined>((newest, candidate) => (newest === undefined || candidate.createdAt > newest.createdAt ? candidate : newest), undefined)
  if (chat === undefined) {
    return { card, chatId: null, problem: null }
  }
  const message = kickBackMessage(card, comment)
  const failure = await terminalStep(deps, () => deps.terminals.paste(chat, message))
  if (failure !== null) {
    const problem = `${card.key} is back In progress with a pending play, but the comment could not reach its chat: ${reasonOf(failure)}. Open the chat and ask its agent to claim the card again once it can answer, or press Play to start a new chat.`
    return { card, chatId: chat.id, problem }
  }
  return { card, chatId: chat.id, problem: null }
}
