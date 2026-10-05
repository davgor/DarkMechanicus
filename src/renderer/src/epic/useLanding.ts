import { useEffect, useRef, type Dispatch } from 'react'
import type { TicketLanding } from '../app/landing'
import { landingActions } from './landingActions'
import type { WorkspaceAction, WorkspaceState } from './workspaceState'

interface LandingInput {
  landing: TicketLanding | null | undefined
  state: WorkspaceState
  dispatch: Dispatch<WorkspaceAction>
  /** Tells the shell the request was taken, so it forgets it. */
  onLanded: (() => void) | undefined
}

/**
 * Takes a request to open a ticket (a link from a chat) once the epic has loaded: opens the ticket, or its
 * Activity tab for the attempt, then tells the shell. Each request is taken once, however often the epic
 * reloads, so closing the panel afterwards is not undone; a ticket the epic does not have opens nothing.
 */
export function useLanding({ landing, state, dispatch, onLanded }: LandingInput): void {
  const taken = useRef<TicketLanding | null>(null)
  const landedRef = useRef(onLanded)
  landedRef.current = onLanded
  const { data, view } = state
  useEffect(() => {
    if (landing == null || data === null || taken.current === landing) {
      return
    }
    taken.current = landing
    landingActions(landing, data, view).forEach(dispatch)
    landedRef.current?.()
  }, [landing, data, view, dispatch])
}
