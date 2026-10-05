import { useCallback, useMemo } from 'react'
import type { ApprovalDecision } from '../../../shared/agents/chat'
import type { BoundThread } from '../../../shared/agents/chatApi'
import { unwrapChat } from './chatCalls'
import { clipRows, streamRows, type RowWindow, type StreamRow } from './threadStream'
import { useOpenedChat } from './useChatSession'

export interface ThreadStream {
  /** The thread's rows in the order stored, with the texts still being written last; empty until the chat is read. */
  rows: StreamRow[]
  /** Why the chat could not be read; null otherwise. */
  error: string | null
  /** The chat's folder: where the commands of its approval requests run. */
  folder: string
  /** Sends the person's decision for a waiting request; rejects with why it was not accepted, which the card shows. */
  answer(requestId: string, decision: ApprovalDecision): Promise<void>
}

/**
 * Follows one thread of a chat for as long as the view that uses it is on screen: the chat is read once
 * (`chats:read`, which starts no agent and writes nothing, unlike `chats:open`), then its pushed events
 * keep the rows current (the same reducer the chat view uses, so nothing pushed while it is read is lost).
 * Nothing is polled, and the subscription ends with the view. Items are stored masked, and approvals are
 * answered through the chat they were raised in, which reaches the agent while its session is live.
 *
 * A thread can have served several attempts: with a `span`, only the rows from that stretch of time are
 * kept (an attempt's claim to its end, or to now while it is open).
 */
export function useThreadStream(thread: BoundThread, span: RowWindow | null = null): ThreadStream {
  const { folder, chatId, threadId } = thread
  const { state } = useOpenedChat({ folder, chatId }, 'read')
  const from = span?.from ?? null
  const to = span?.to ?? null
  // Without a span both ends are open, which keeps every row.
  const rows = useMemo(() => clipRows(streamRows(state.entries, threadId), { from, to }), [state.entries, threadId, from, to])
  const answer = useCallback(
    async (requestId: string, decision: ApprovalDecision): Promise<void> => {
      await unwrapChat(window.dm.chats.answerApproval({ folder, chatId, requestId, decision }))
    },
    [folder, chatId]
  )
  const error = state.phase === 'failed' ? state.error : null
  return useMemo(() => ({ rows, error, folder, answer }), [rows, error, folder, answer])
}

/** A row with the stream it came from, so a request in it can be answered where it is shown. */
export interface StreamEntry {
  at: string | null
  row: StreamRow
  stream: ThreadStream
}

const NO_ENTRIES: StreamEntry[] = []

/** The stream's rows as entries, oldest first; none for a view with no chat to follow. */
export function streamEntries(stream: ThreadStream | null): StreamEntry[] {
  return stream === null ? NO_ENTRIES : stream.rows.map((row) => ({ at: row.at, row, stream }))
}
