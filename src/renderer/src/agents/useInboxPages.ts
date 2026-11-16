import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReadChatMailRequest } from '../../../shared/agents/chatApi'
import type { CommandResult } from '../../../shared/desktop/api'
import type { AgentMailMessageView } from '../../../shared/domain/agentMail'

/** Messages read per page (main allows 1 to 50). */
const INBOX_PAGE_SIZE = 50

export interface InboxPages {
  status: 'loading' | 'ready' | 'error'
  messages: AgentMailMessageView[]
  error: string | null
  hasMore: boolean
  /** A further page is being read. */
  busy: boolean
  /** Reads the inbox again from its first page. */
  reload(): void
  /** Reads the next page, up to the first page's horizon so no arrival is skipped. */
  more(): void
}

interface PagesState {
  status: InboxPages['status']
  messages: AgentMailMessageView[]
  error: string | null
  busy: boolean
  /** The first page's `snapshotHighWater` and the last page's `nextCursor`. */
  horizon: number
  cursor: number
  hasMore: boolean
}

const LOADING: PagesState = { status: 'loading', messages: [], error: null, busy: false, horizon: 0, cursor: 0, hasMore: false }

/**
 * The chat's inbox, read a page at a time with bodies, for this dialog only. An answer that a newer read overtook,
 * or that comes after the dialog closed, is dropped, so a late answer never shows in another chat's inbox.
 */
export function useInboxPages(folder: string, chatId: string): InboxPages {
  const [pages, setPages] = useState(LOADING)
  const ticket = useRef<object | null>(null)
  const read = useCallback(async (request: ReadChatMailRequest, append: boolean): Promise<void> => {
    const mine = {}
    ticket.current = mine
    setPages((previous) => (append ? { ...previous, busy: true } : LOADING))
    const result = await window.dm.chats.mail.read(request).catch(() => null)
    if (ticket.current !== mine) return
    if (result?.ok !== true) {
      const error = result?.error.message ?? 'The app did not answer.'
      setPages((previous) => (append ? { ...previous, busy: false, error } : { ...LOADING, status: 'error', error }))
      return
    }
    const page = result.data
    setPages((previous) => ({
      status: 'ready',
      messages: append ? [...previous.messages, ...page.messages] : page.messages,
      error: null,
      busy: false,
      horizon: append ? previous.horizon : page.snapshotHighWater,
      cursor: page.nextCursor,
      hasMore: page.hasMore
    }))
  }, [])
  const first = useCallback(() => void read({ folder, chatId, limit: INBOX_PAGE_SIZE }, false), [read, folder, chatId])
  useEffect(() => {
    first()
    return () => {
      ticket.current = null
    }
  }, [first])
  return {
    status: pages.status,
    messages: pages.messages,
    error: pages.error,
    hasMore: pages.hasMore,
    busy: pages.busy,
    reload: first,
    more: () => void read({ folder, chatId, afterSeq: pages.cursor, throughSeq: pages.horizon, limit: INBOX_PAGE_SIZE }, true)
  }
}

interface MailAction {
  busy: boolean
  error: string | null
  /** Runs one request at a time: a click while one is out does nothing. `onOk` gets the answer while the dialog is open. */
  run<T>(call: () => Promise<CommandResult<T>>, onOk: (data: T) => void, onError?: (code: string) => void): void
}

/** One person-initiated request (mark seen, allow a wake), never two at once, and its outcome while the dialog is open. */
export function useMailAction(): MailAction {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run: MailAction['run'] = (call, onOk, onError) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    void call()
      .catch(() => null)
      .then((result) => {
        inFlight.current = false
        if (!alive.current) return
        setBusy(false)
        if (result?.ok === true) onOk(result.data)
        else {
          setError(result?.error.message ?? 'The app did not answer.')
          onError?.(result?.error.code ?? 'unavailable')
        }
      })
  }
  return { busy, error, run }
}
