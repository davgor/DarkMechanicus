/**
 * What the Magos arbiter is told besides the prompt: the ticket a worker thread is bound to and the epic's Standards
 * section, read through the chat folder's own desktop workspace (the read pattern of `conversationReads` in
 * `bootstrap.ts`). A failed read rejects, so the arbiter never decides without its context: the person does.
 */
import type { ChatRecord } from '../../shared/agents/chat'
import type { CommandApi } from '../../shared/domain/api'
import type { ActivityBinding } from '../agents/activityBindings'
import { extractStandards, type buildArbiterRequest } from './arbiterPrompt'

/** The workspace reads the context needs; the desktop workspace of the chat's folder in the app. */
export type ArbiterReads = Pick<CommandApi, 'getAttemptTimeline' | 'getRun' | 'getTicket' | 'getEpic'>

type ArbiterTicket = Parameters<typeof buildArbiterRequest>[0]['ticket']

interface ArbiterContext {
  ticket: ArbiterTicket
  standards: string | null
}

const NO_CONTEXT: ArbiterContext = { ticket: null, standards: null }

/** The epic of the chat's run: its id and its Standards section. */
async function runEpic(workspace: ArbiterReads, runId: string): Promise<{ epicId: string; standards: string | null }> {
  const run = await workspace.getRun({ runId })
  if (run === null) throw new Error('The run of the chat was not found.')
  const epic = await workspace.getEpic({ epicId: run.epicId })
  return { epicId: run.epicId, standards: extractStandards(epic.intent) }
}

/** The saved ticket of a bound attempt in `epicId`; an attempt of another run is refused. */
async function attemptTicket(workspace: ArbiterReads, epicId: string, attemptId: string, runId: string | null): Promise<NonNullable<ArbiterTicket>> {
  const timeline = await workspace.getAttemptTimeline({ attemptId })
  if (runId !== null && timeline.runId !== runId) throw new Error('The bound attempt belongs to another run.')
  const { ticket } = await workspace.getTicket({ epicId, ticketId: timeline.ticketId, view: 'saved' })
  return { key: ticket.key, title: ticket.title, body: ticket.body, acceptance: ticket.acceptanceCriteria.map(criterion => criterion.text) }
}

/**
 * The context of one prompt of a run's Magos chat: the epic's Standards section, plus the bound ticket when the prompt
 * comes from a worker thread bound to an attempt (`binding`). A main-thread or unbound prompt has no ticket; a chat
 * with no run has neither. Any failed or refused read rejects.
 */
export async function readArbiterContext(
  workspace: ArbiterReads,
  input: { chat: Pick<ChatRecord, 'runId'>; threadId: string | null; binding: ActivityBinding | null }
): Promise<ArbiterContext> {
  const { chat, threadId, binding } = input
  if (chat.runId === undefined) return NO_CONTEXT
  const { epicId, standards } = await runEpic(workspace, chat.runId)
  const bound = threadId !== null && binding?.kind === 'attempt' && binding.threadId === threadId ? binding : null
  const ticket = bound === null ? null : await attemptTicket(workspace, epicId, bound.attemptId, chat.runId)
  return { ticket, standards }
}

/** The ticket key of a bound attempt, through the same reads; null on any error. */
export async function ticketKeyOfAttempt(workspace: ArbiterReads, attemptId: string): Promise<string | null> {
  try {
    const timeline = await workspace.getAttemptTimeline({ attemptId })
    const { epicId } = (await workspace.getRun({ runId: timeline.runId })) ?? {}
    if (epicId === undefined) return null
    const { ticket } = await workspace.getTicket({ epicId, ticketId: timeline.ticketId, view: 'saved' })
    return ticket.key
  } catch {
    return null
  }
}
