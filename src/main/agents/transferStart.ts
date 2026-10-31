/**
 * Starts an agent on the Linear transfer of an epic the person authorized: create an orchestrator chat
 * for it, send the transfer kickoff. It mirrors `startOrchestratorRun`, so a failure part way leaves a
 * state the person can read:
 *
 *   - The epic or its transfer cannot be read, or the transfer is not queued or in progress: nothing
 *     was created, and the error is the answer.
 *   - The chat cannot be created: no chat exists, and the answer says so. The transfer stays authorized.
 *   - The chat exists but its agent cannot start (not connected, signed out, crashed): the chat is
 *     removed again, so none is left claiming to carry out a transfer nobody is running, and the answer
 *     says why. If the chat cannot be removed it is kept and returned, with the reason.
 *
 * The chat records the epic's id (`transferEpicId`), so it is found again after an idle stop or an app
 * restart, and its role is `orchestrator`, so every session it resumes holds the same grant. Dark
 * Mechanicus attaches no Linear server: the agent uses the one configured in its own CLI.
 */
import { DomainError } from '../../core/errors'
import type { ChatRecord } from '../../shared/agents/chat'
import type { ChatSummary, StartTransferChatRequest, StartTransferChatResult } from '../../shared/agents/chatApi'
import type { TransferView } from '../../shared/domain/transfer'
import type { EpicDetailView } from '../../shared/domain/views'
import { transferKickoff, transferTitle } from '../../mcp/transferKickoff'
import type { SessionManager } from './sessionManager'

/** The transfer side of the desktop for one tracked folder: the same commands the Transfer to Linear button reads. */
export interface TransferReads {
  getEpic(folder: string, epicId: string): Promise<EpicDetailView>
  getTransfer(folder: string, epicId: string): Promise<TransferView>
}

interface TransferStartDeps {
  transfers: TransferReads
  sessions: Pick<SessionManager, 'createChat' | 'send' | 'deleteChat' | 'agentName'>
  /** Told about failures that are not DomainErrors and about a chat that could not be removed, so main can log them. */
  onError?: (error: unknown) => void
}

/** Only an authorized transfer, or one an agent already started, may get a chat. */
const STARTABLE: Record<TransferView['status'], boolean> = { not_started: false, queued: true, in_progress: true, verified: false, canceled: false }

const START_AGAIN = 'Start the transfer chat again, or copy the prompt for an agent of your own.'

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[.s]+$/, '')
}

function logUnexpected(deps: TransferStartDeps, error: unknown): void {
  if (!(error instanceof DomainError)) {
    deps.onError?.(error)
  }
}

/** Removes the chat of an agent that could not start; false (after reporting) when it could not be removed. */
async function removeChat(deps: TransferStartDeps, chat: { folder: string; id: string }): Promise<boolean> {
  try {
    await deps.sessions.deleteChat(chat)
    return true
  } catch (error) {
    deps.onError?.(error)
    return false
  }
}

/** `request.folder` is the canonical path of a tracked folder. */
export async function startTransferChat(deps: TransferStartDeps, request: StartTransferChatRequest): Promise<StartTransferChatResult> {
  const { folder, epicId, agent } = request
  const epic = await deps.transfers.getEpic(folder, epicId)
  const transfer = await deps.transfers.getTransfer(folder, epic.id)
  if (!STARTABLE[transfer.status]) {
    throw transfer.status === 'verified'
      ? new DomainError('conflict', 'This transfer is already verified; there is nothing left to move.')
      : new DomainError('unmet_prerequisite', 'The transfer is not authorized. Press Transfer to Linear before starting a transfer chat.')
  }
  const agentName = deps.sessions.agentName(agent)

  let chat: ChatRecord
  try {
    chat = deps.sessions.createChat({
      folder,
      agent,
      role: 'orchestrator',
      model: request.model ?? null,
      allowSave: false,
      title: transferTitle(epic.title),
      transferEpicId: epic.id
    })
  } catch (error) {
    logUnexpected(deps, error)
    return { chat: null, problem: `The transfer is authorized, but the transfer chat could not be created: ${reasonOf(error)}. ${START_AGAIN}` }
  }

  try {
    await deps.sessions.send(chat, transferKickoff({ epicId: epic.id, epicTitle: epic.title }))
  } catch (error) {
    logUnexpected(deps, error)
    const removed = await removeChat(deps, chat)
    return { chat: removed ? null : chat, problem: `The transfer is authorized, but ${agentName} could not be started: ${reasonOf(error)}. ${START_AGAIN}` }
  }
  return { chat, problem: null }
}

/** The most recently updated chat of the (canonical) folder started for the epic's transfer, or null. */
export function findTransferChat(sessions: Pick<SessionManager, 'listChats'>, folder: string, epicId: string): ChatSummary | null {
  return sessions.listChats(folder).find((chat) => chat.transferEpicId === epicId) ?? null
}

/** The transfer kickoff for an agent started elsewhere: the same text a transfer chat is sent first. */
export async function transferPrompt(transfers: Pick<TransferReads, 'getEpic'>, folder: string, epicId: string): Promise<string> {
  const epic = await transfers.getEpic(folder, epicId)
  return transferKickoff({ epicId: epic.id, epicTitle: epic.title })
}
