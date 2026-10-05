/**
 * What one screen asks of the screen it opens. The shell holds one request at a time (`ShellModel.landing`),
 * hands it to the view that was opened for it, and forgets it once that view took it (`landed`), so going back
 * to the same chat or epic later does not repeat it. Each request is a new object; the views tell one from the
 * next by identity.
 */

/** Open a ticket in its epic's workspace, on its Activity tab for the attempt when one is named. */
export interface TicketLanding {
  kind: 'ticket'
  epicId: string
  ticketId: string
  attemptId: string | null
}

/** Open a chat with one of its threads (a `thread` item's id) expanded and scrolled into view. */
interface ThreadLandingRequest {
  kind: 'thread'
  chatId: string
  threadId: string
}

export type Landing = TicketLanding | ThreadLandingRequest

/** The request for the epic that is shown: only a ticket request that names that epic. The same object, so views tell requests apart by identity. */
export function ticketLandingFor(landing: Landing | null, epicId: string): TicketLanding | null {
  return landing?.kind === 'ticket' && landing.epicId === epicId ? landing : null
}

/** The request for the chat that is shown: only a thread request that names that chat. */
export function threadLandingFor(landing: Landing | null, chatId: string): ThreadLandingRequest | null {
  return landing?.kind === 'thread' && landing.chatId === chatId ? landing : null
}
