import { useEffect, useState } from 'react'
import type { BoundThread, BoundThreadsRequest } from '../../../shared/agents/chatApi'
import { chooseBoundThread } from './threadStream'

interface Found {
  /** The request it was found for, as JSON: a new object with the same ids is the same question. */
  asked: string
  thread: BoundThread
}

/**
 * The chat thread bound to an attempt (its worker's thread) or to a run (the main thread of the chat that
 * orchestrates it), as the main process knows it (`chats:boundThreads`); null while nothing is bound, and
 * for good when the attempt or run is worked outside a chat or the lookup fails.
 *
 * Threads bind as a chat stores the calls that name them, which may be after the view opened, so the
 * lookup is asked again whenever `again` changes (the view's own timeline moving), until a thread is found.
 * It is never polled on its own, and a thread once found is kept.
 */
export function useBoundThread(request: BoundThreadsRequest, again: unknown): BoundThread | null {
  const asked = JSON.stringify(request)
  const [found, setFound] = useState<Found | null>(null)
  const known = found?.asked === asked
  useEffect(() => {
    if (known) {
      return undefined
    }
    const role = 'attemptId' in request ? 'worker' : 'orchestrator'
    let current = true
    window.dm.chats.boundThreads(request).then(
      (result) => {
        const thread = result.ok ? chooseBoundThread(result.data, role) : null
        if (current && thread !== null) setFound({ asked, thread })
      },
      () => undefined
    )
    return () => {
      current = false
    }
    // `request` is covered by `asked`, which changes whenever it does.
  }, [asked, again, known])
  return known ? found.thread : null
}
