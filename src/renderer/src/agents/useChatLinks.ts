import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { MarkerTarget } from './actionMarkers'
import type { ChatContextValue, ChatNavigation, ThreadFocus, ThreadLanding } from './ChatContext'
import { knownRunIds, lookupReads, resolveTarget } from './chatLookup'
import type { SessionState } from './chatViewModel'
import { threadPath } from './threadModel'
import { useThreadBindings } from './useThreadBindings'

/** The same members: a path that has not changed keeps its set, so what depends on it does not change for nothing. */
function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id))
}

interface Requested {
  threadId: string
  request: object
}

/**
 * The thread to show, from the shell's request: the view takes the request once (and tells the shell it did)
 * and keeps showing that thread. `open` names it and the threads it is inside, from the transcript as it is now.
 */
function useThreadFocus(landing: ThreadLanding | null, entries: SessionState['entries'], onLanded: () => void): ThreadFocus | null {
  const [requested, setRequested] = useState<Requested | null>(landing === null ? null : { threadId: landing.threadId, request: landing })
  const landedRef = useRef(onLanded)
  landedRef.current = onLanded
  useEffect(() => {
    if (landing !== null) {
      setRequested((current) => (current?.request === landing ? current : { threadId: landing.threadId, request: landing }))
      landedRef.current()
    }
  }, [landing])
  const previous = useRef<ReadonlySet<string>>(new Set())
  return useMemo(() => {
    if (requested === null) {
      return null
    }
    const path = threadPath(entries, requested.threadId)
    const open = sameMembers(previous.current, path) ? previous.current : path
    previous.current = open
    return { threadId: requested.threadId, open, request: requested.request }
  }, [requested, entries])
}

interface ChatLinksInput {
  chat: ChatRecord
  session: Pick<SessionState, 'phase' | 'entries'>
  navigation: ChatNavigation | null
  landing: ThreadLanding | null
  onLanded: () => void
}

/**
 * What the thread blocks and action markers of a chat need (`ChatContext`): where links lead, the chat's bound
 * threads, the thread the shell asked to show, and a way to find the ticket behind an id.
 */
export function useChatLinks({ chat, session, navigation, landing, onLanded }: ChatLinksInput): ChatContextValue {
  const { folder, id: chatId } = chat
  const bindings = useThreadBindings({ folder, chatId }, session.entries, session.phase === 'ready')
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings
  const reads = useMemo(() => lookupReads(folder, () => bindingsRef.current), [folder])
  const resolve = useCallback((target: MarkerTarget) => resolveTarget(target, reads, knownRunIds(bindings)), [reads, bindings])
  const focus = useThreadFocus(landing, session.entries, onLanded)
  return useMemo(() => ({ navigation, bindings, focus, resolve }), [navigation, bindings, focus, resolve])
}
