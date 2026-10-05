/**
 * What the thread blocks and action markers of an open chat need besides their own item: where a link
 * goes, which threads of the chat are bound to a run or an attempt, which thread to open and scroll to,
 * and how to find the ticket behind an id. `ChatView` provides it; rendered without a provider (a
 * transcript on its own) the context is inert: nothing links, nothing is bound, nothing resolves.
 */
import { createContext, useContext, useEffect, useState } from 'react'
import type { ThreadBinding } from '../../../shared/agents/chatApi'
import { needsLookup } from './chatLookup'
import type { MarkerTarget } from './actionMarkers'

/** A ticket to open: in its epic, and with an attempt on the ticket's Activity tab for that attempt. */
export interface TicketLink {
  epicId: string
  ticketId: string
  attemptId: string | null
}

/** Where a chat's links lead; the shell opens the epic workspace. */
export interface ChatNavigation {
  openTicket(link: TicketLink): void
  openEpic(epicId: string): void
}

/**
 * A request to open a chat at one of its threads: the thread (a `thread` item's id) is shown open and scrolled
 * into view. A new object per request, so the same thread can be asked for again.
 */
export interface ThreadLanding {
  threadId: string
}

/** The thread to show: it and every thread above it open, and it is scrolled into view when it appears. */
export interface ThreadFocus {
  threadId: string
  /** The thread and the threads it is inside, which have to be open for it to be seen. */
  open: ReadonlySet<string>
  /** A new object for each request, so asking for the same thread again shows it again. */
  request: object
}

export interface ChatContextValue {
  navigation: ChatNavigation | null
  /** The chat's threads bound to a run or an attempt, as main resolved them. */
  bindings: readonly ThreadBinding[]
  focus: ThreadFocus | null
  /** The target with the key and epic the desktop's reads can add; the target itself when it cannot. */
  resolve(target: MarkerTarget): Promise<MarkerTarget>
}

const INERT: ChatContextValue = { navigation: null, bindings: [], focus: null, resolve: (target) => Promise.resolve(target) }

export const ChatContext = createContext<ChatContextValue>(INERT)

export function useChatContext(): ChatContextValue {
  return useContext(ChatContext)
}

interface Resolved {
  /** The target it was resolved for, as JSON: a new object with the same ids is the same question. */
  asked: string
  value: MarkerTarget
}

/**
 * The target with what the lookup finds, once it has: the target itself until then, and when nothing
 * can be found. It asks again when the chat's bindings change, which may know more.
 */
export function useResolvedTarget(target: MarkerTarget): MarkerTarget {
  const { resolve, bindings } = useChatContext()
  const [resolved, setResolved] = useState<Resolved | null>(null)
  const asked = JSON.stringify(target)
  useEffect(() => {
    if (!needsLookup(target)) {
      return undefined
    }
    let current = true
    resolve(target).then(
      (value) => {
        if (current) setResolved({ asked, value })
      },
      () => undefined
    )
    return () => {
      current = false
    }
    // `target` is covered by `asked`, which changes whenever it does.
  }, [asked, resolve, bindings])
  return resolved?.asked === asked ? resolved.value : target
}
