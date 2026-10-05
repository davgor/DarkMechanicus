import { useCallback, useMemo } from 'react'
import type { ApprovalDecision } from '../../../shared/agents/chat'
import type { BoundThread } from '../../../shared/agents/chatApi'
import { unwrapChat } from './chatCalls'
import { streamRows, type StreamRow } from './threadStream'
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
 * Follows one thread of a chat for as long as the view that uses it is on screen: the chat is opened once
 * (`chats:open`), then its pushed events keep the rows current (the same reducer the chat view uses, so
 * nothing pushed while it opens is lost). Nothing is polled, and the subscription ends with the view.
 * Items are stored masked, and approvals are answered through the chat they were raised in.
 */
export function useThreadStream(thread: BoundThread): ThreadStream {
  const { folder, chatId, threadId } = thread
  const { state } = useOpenedChat({ folder, chatId })
  const rows = useMemo(() => streamRows(state.entries, threadId), [state.entries, threadId])
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
