import type { ConversationTarget } from '../../shared/agents/chatApi'
import { maskClaimTokens } from './claimTokenMask'

const MAX_KICKOFF_LENGTH = 24_000
const MAX_HISTORY_ENTRIES = 20
const ANSWER_ONLY =
  'You were opened from the board to answer the person. Answer only: do not start or take over a run, claim work or save a plan unless the person asks.'

export type { ConversationTarget } from '../../shared/agents/chatApi'

export interface BoardMessageInput {
  target: ConversationTarget
  epicTitle?: string
  ticketKey?: string
  ticketTitle?: string
  cardKey?: string
  body: string
  attachmentIds: string[]
  relay: boolean
}

export interface ConversationHistoryEntry {
  author: string
  at: string
  body: string
}

export interface FreshKickoffInput extends BoardMessageInput {
  history: ConversationHistoryEntry[]
  runActive: boolean
}

/** Removes terminal-hostile controls before masking so a control cannot split a token around the masker. */
function clean(value: string): string {
  return maskClaimTokens(value.replace(/[^\P{Cc}\t\n\r]/gu, '').trim())
}

function isCard(target: ConversationTarget): target is { cardId: string } {
  return 'cardId' in target
}

function targetLabel(input: BoardMessageInput): string {
  if (isCard(input.target)) return `card ${clean(input.cardKey ?? input.target.cardId)}`
  if (input.target.ticketId !== undefined) {
    const key = clean(input.ticketKey ?? input.target.ticketId)
    return input.ticketTitle === undefined ? key : `${key} "${clean(input.ticketTitle)}"`
  }
  return `epic "${clean(input.epicTitle ?? input.target.epicId)}"`
}

function replyInstruction(target: ConversationTarget): string {
  if (isCard(target)) return `Reply on the record with add_kanban_message ${JSON.stringify({ cardId: clean(target.cardId) })}`
  const command =
    target.ticketId === undefined
      ? { epicId: clean(target.epicId) }
      : { epicId: clean(target.epicId), ticketId: clean(target.ticketId) }
  return `Reply on the record with add_comment ${JSON.stringify(command)}`
}

function relayInstruction(input: BoardMessageInput): string | null {
  if (!input.relay) return null
  const key = input.ticketKey ?? input.cardKey ?? (isCard(input.target) ? input.target.cardId : input.target.ticketId ?? input.target.epicId)
  return `A worker subagent of yours may be doing ${clean(key)}: pass this to it now and post its answer.`
}

function messageLines(input: BoardMessageInput): string[] {
  const lines = [`[Board message from the person] on ${targetLabel(input)}:`, clean(input.body)]
  if (input.attachmentIds.length > 0) lines.push(`Attached images: ${input.attachmentIds.map(clean).join(', ')} (get_attachment)`)
  lines.push(replyInstruction(input.target))
  const relay = relayInstruction(input)
  if (relay !== null) lines.push(relay)
  return lines
}

export function boardMessage(input: BoardMessageInput): string {
  return messageLines(input).join('\n')
}

function historyText(entry: ConversationHistoryEntry): string {
  return `[${clean(entry.author)} at ${clean(entry.at)}]\n${clean(entry.body)}`
}

function kickoffText(input: FreshKickoffInput, history: readonly string[]): string {
  const sections = [boardMessage(input)]
  if (history.length > 0) sections.push(`Conversation history:\n${history.join('\n\n')}`)
  if (input.runActive) sections.push('A run of this epic is active under another session.')
  sections.push(ANSWER_ONLY)
  return sections.join('\n\n')
}

export function freshKickoff(input: FreshKickoffInput): string {
  const history = input.history.slice(-MAX_HISTORY_ENTRIES).map(historyText)
  let kickoff = kickoffText(input, history)
  while (kickoff.length > MAX_KICKOFF_LENGTH && history.length > 0) {
    history.shift()
    kickoff = kickoffText(input, history)
  }
  return kickoff
}
