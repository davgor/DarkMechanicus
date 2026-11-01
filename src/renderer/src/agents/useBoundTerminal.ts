import { useEffect, useState } from 'react'
import type { BoundThreadsRequest } from '../../../shared/agents/chatApi'

interface Found {
  /** The request it was found for, as JSON: a new object with the same ids is the same question. */
  asked: string
  chatId: string
}

/**
 * The id of the chat whose terminal an attempt (its claim) or a run (its start) is bound to by grant, as the main
 * process finds it (`chats:boundTerminal`); null while none is, and when the lookup fails.
 *
 * The session that binds may act after the view opened, so the lookup is asked again whenever `again` changes (the
 * view's own timeline moving), until a chat is found. It is never polled on its own, and a chat once found is kept.
 */
export function useBoundTerminal(request: BoundThreadsRequest, again: unknown): string | null {
  const asked = JSON.stringify(request)
  const [found, setFound] = useState<Found | null>(null)
  const known = found?.asked === asked
  useEffect(() => {
    if (known) {
      return undefined
    }
    let current = true
    window.dm.chats.boundTerminal(request).then(
      (result) => {
        if (current && result.ok && result.data !== null) setFound({ asked, chatId: result.data })
      },
      () => undefined
    )
    return () => {
      current = false
    }
    // `request` is covered by `asked`, which changes whenever it does.
  }, [asked, again, known])
  return known ? found.chatId : null
}
