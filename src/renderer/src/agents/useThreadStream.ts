import { useEffect, useMemo, useState } from 'react'
import type { BoundThread, ChatRequestRef } from '../../../shared/agents/chatApi'
import { errorMessage } from '../api/dm'
import { unwrapChat } from './chatCalls'
import { applyItem, type TranscriptEntry } from './chatViewModel'
import { clipRows, streamRows, type RowWindow, type StreamRow } from './threadStream'

export interface ThreadStream {
  /** The thread's rows in the order stored; empty until the chat is read. */
  rows: StreamRow[]
  /** Why the chat could not be read; null otherwise. */
  error: string | null
  /** The chat's folder: where the commands of its approval requests ran. */
  folder: string
}

interface Stored {
  /** The chat it was read for (`folder`, `chatId`), so a chat shown next never shows this one's rows. */
  key: string
  entries: TranscriptEntry[]
  error: string | null
}

const NO_ENTRIES: TranscriptEntry[] = []

/** The chat's stored transcript, read once per chat (`chats:read`: nothing is started or written); empty until it is. */
function useStoredTranscript({ folder, chatId }: ChatRequestRef): Pick<Stored, 'entries' | 'error'> {
  const [stored, setStored] = useState<Stored | null>(null)
  const key = `${folder}\n${chatId}`
  useEffect(() => {
    let current = true
    unwrapChat(window.dm.chats.read({ folder, chatId })).then(
      (view) => {
        if (current) setStored({ key, entries: view.items.reduce<TranscriptEntry[]>(applyItem, []), error: null })
      },
      (error: unknown) => {
        if (current) setStored({ key, entries: [], error: errorMessage(error) })
      }
    )
    return () => {
      current = false
    }
  }, [folder, chatId, key])
  return stored?.key === key ? stored : { entries: NO_ENTRIES, error: null }
}

/**
 * One thread of an old chat, as the chat stored it before chats became terminals: the chat is read once
 * (`chats:read`), and nothing is polled or pushed, since nothing writes to that transcript any more. Items
 * are stored masked, and every approval in it is a record: main reports one no decision was stored for as
 * cancelled.
 *
 * A thread can have served several attempts: with a `span`, only the rows from that stretch of time are
 * kept (an attempt's claim to its end, or to now while it is open).
 */
export function useThreadStream(thread: BoundThread, span: RowWindow | null = null): ThreadStream {
  const { folder, chatId, threadId } = thread
  const { entries, error } = useStoredTranscript({ folder, chatId })
  const from = span?.from ?? null
  const to = span?.to ?? null
  // Without a span both ends are open, which keeps every row.
  const rows = useMemo(() => clipRows(streamRows(entries, threadId), { from, to }), [entries, threadId, from, to])
  return useMemo(() => ({ rows, error, folder }), [rows, error, folder])
}

/** A row with the stream it came from, so an approval in it names the folder its command ran in. */
export interface StreamEntry {
  at: string
  row: StreamRow
  stream: ThreadStream
}

const NO_STREAM_ENTRIES: StreamEntry[] = []

/** The stream's rows as entries, oldest first; none for a view with no chat to follow. */
export function streamEntries(stream: ThreadStream | null): StreamEntry[] {
  return stream === null ? NO_STREAM_ENTRIES : stream.rows.map((row) => ({ at: row.at, row, stream }))
}
