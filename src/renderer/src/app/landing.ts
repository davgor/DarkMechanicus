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

/** Open a ticket in its epic's workspace on its Scorecard tab, reading `runId`'s grade (null: the newest attempt's run). */
export interface TicketScorecardLanding {
  kind: 'ticketScorecard'
  epicId: string
  ticketId: string
  runId: string | null
  /** The ticket's key as the link showed it, for the message when the plan shown no longer holds the ticket. */
  ticketKey: string | null
}

/** Open an epic's workspace on its Scorecard. */
interface EpicScorecardLanding {
  kind: 'epicScorecard'
  epicId: string
}

/** What an epic's workspace can be asked to open. */
export type EpicLanding = TicketLanding | TicketScorecardLanding | EpicScorecardLanding

/** Open a chat with one of its threads (a `thread` item's id) expanded and scrolled into view. */
interface ThreadLandingRequest {
  kind: 'thread'
  chatId: string
  threadId: string
}

export type Landing = EpicLanding | ThreadLandingRequest

/** The request for the epic that is shown: only an epic request that names that epic. The same object, so views tell requests apart by identity. */
export function epicLandingFor(landing: Landing | null, epicId: string): EpicLanding | null {
  return landing !== null && landing.kind !== 'thread' && landing.epicId === epicId ? landing : null
}

/** The request for the chat that is shown: only a thread request that names that chat. */
export function threadLandingFor(landing: Landing | null, chatId: string): ThreadLandingRequest | null {
  return landing?.kind === 'thread' && landing.chatId === chatId ? landing : null
}
