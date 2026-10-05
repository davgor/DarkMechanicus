import { useEffect, useMemo, useState } from 'react'
import type { ThreadBinding } from '../../../shared/agents/chatApi'
import { isActionTool } from './actionMarkers'
import type { TranscriptEntry } from './chatViewModel'

const NO_BINDINGS: readonly ThreadBinding[] = []

/**
 * What decides when the chat's bindings are read again: how many threads it has and how many Dark Mechanicus
 * calls the server has answered, since those are what bind a thread (the main process binds as it stores).
 * Streaming text, other calls and a thread changing state do not change it.
 */
function bindingsSignature(entries: readonly TranscriptEntry[]): string {
  let threads = 0
  let answered = 0
  for (const entry of entries) {
    if (entry.kind === 'thread') {
      threads += 1
    } else if (entry.kind === 'tool_call' && entry.status === 'completed' && isActionTool(entry.name)) {
      answered += 1
    }
  }
  return `${threads}:${answered}`
}

/**
 * The chat's threads bound to a run or an attempt, as the main process resolved them (`chats:threadBindings`):
 * read once the transcript is shown, and again whenever its signature changes. A read that fails keeps what
 * was known; none known means no thread is bound as far as this view can tell.
 */
export function useThreadBindings(ref: { folder: string; chatId: string }, entries: readonly TranscriptEntry[], enabled: boolean): readonly ThreadBinding[] {
  const { folder, chatId } = ref
  const signature = useMemo(() => bindingsSignature(entries), [entries])
  const [bindings, setBindings] = useState<readonly ThreadBinding[]>(NO_BINDINGS)
  useEffect(() => {
    if (!enabled) {
      return undefined
    }
    let current = true
    window.dm.chats.threadBindings({ folder, chatId }).then(
      (result) => {
        if (current && result.ok) setBindings(result.data)
      },
      () => undefined
    )
    return () => {
      current = false
    }
  }, [folder, chatId, signature, enabled])
  return bindings
}
