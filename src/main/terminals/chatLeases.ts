/**
 * Whether the run or Kanban card a chat carries holds a lease, for the idle stop (`terminalSessions.ts`): an
 * orchestrator watching a worker's lease is not idle. A lease is held by an attempt that is `claimed` or `running`
 * (`LEASED_ATTEMPT_STATES`, the same two for cards) with a lease that ends after now. The expiry is compared here as
 * well, since a run paused for sign-in keeps its open attempts whatever their lease time.
 *
 * Only the newest chat of its folder that carries the run (or card) is kept by its lease, as Kick back picks the
 * card's chat: an older one an earlier Start run or Play left behind no longer carries it, so another chat's worker
 * cannot keep it running. A run or card that is gone (`not_found`) holds no lease; any other failed read rejects.
 */
import { DomainError } from '../../core/errors'
import type { ChatRecord } from '../../shared/agents/chat'

/** What an attempt is read as: its state and when its lease ends. */
export interface LeasedAttempt {
  state: string
  leaseExpiresAt: string | null
}

type LeaseChat = Pick<ChatRecord, 'id' | 'folder' | 'createdAt' | 'runId' | 'cardId'>

/** The reads a lease is found through: the folder's chats, and its desktop workspace's run and card reads. */
export interface LeaseReads {
  listChats(folder: string): readonly LeaseChat[]
  getRun(folder: string, runId: string): Promise<{ attempts: readonly LeasedAttempt[] } | null>
  getKanbanCard(folder: string, cardId: string): Promise<{ attempts: readonly LeasedAttempt[] }>
}

function holdsLease(attempt: LeasedAttempt, now: number): boolean {
  return (attempt.state === 'claimed' || attempt.state === 'running') && attempt.leaseExpiresAt !== null && Date.parse(attempt.leaseExpiresAt) > now
}

/** Whether a chat of the folder created after `chat` carries the same run or card. */
function superseded(reads: LeaseReads, chat: LeaseChat): boolean {
  return reads
    .listChats(chat.folder)
    .some(
      (other) =>
        other.id !== chat.id &&
        other.createdAt > chat.createdAt &&
        ((chat.runId !== undefined && other.runId === chat.runId) || (chat.cardId !== undefined && other.cardId === chat.cardId))
    )
}

/** The attempts `read` answers; none when what it reads is gone. */
async function attemptsOf(read: () => Promise<{ attempts: readonly LeasedAttempt[] } | null>): Promise<readonly LeasedAttempt[]> {
  try {
    return (await read())?.attempts ?? []
  } catch (error) {
    if (error instanceof DomainError && error.code === 'not_found') {
      return []
    }
    throw error
  }
}

/** The terminal sessions' `leaseHeld` over `reads`; a failed read rejects, for the caller to report. */
export function createLeaseHeld(reads: LeaseReads, now: () => number = Date.now): (chat: LeaseChat) => Promise<boolean> {
  return async (chat) => {
    const { folder, runId, cardId } = chat
    if ((runId === undefined && cardId === undefined) || superseded(reads, chat)) {
      return false
    }
    const run = runId === undefined ? [] : await attemptsOf(() => reads.getRun(folder, runId))
    const card = cardId === undefined ? [] : await attemptsOf(() => reads.getKanbanCard(folder, cardId))
    const at = now()
    return [...run, ...card].some((attempt) => holdsLease(attempt, at))
  }
}
