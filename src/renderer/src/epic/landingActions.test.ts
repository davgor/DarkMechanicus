import { describe, expect, it } from 'vitest'
import type { TicketLanding } from '../app/landing'
import { checkpointView, draftPlan, epicDetail, runView, savedPlan, validation } from './__mocks__/fixtures'
import { landingActions } from './landingActions'
import { initialWorkspaceState, workspaceReducer, type WorkspaceData } from './workspaceState'

function data(patch: Partial<WorkspaceData> = {}): WorkspaceData {
  return {
    epic: epicDetail(),
    saved: savedPlan(),
    draft: null,
    run: runView(),
    checkpoint: checkpointView(),
    overview: null,
    savedTickets: [],
    draftTickets: [],
    validation: validation(),
    ...patch
  }
}

const LANDING: TicketLanding = { kind: 'ticket', epicId: 'ep_1', ticketId: 'tk_202', attemptId: 'at_202_2' }

describe('landingActions', () => {
  it('opens the ticket on the Activity tab of the attempt when one is named', () => {
    expect(landingActions(LANDING, data(), 'saved')).toEqual([{ type: 'open_activity', ticketId: 'tk_202', attemptId: 'at_202_2' }])
  })

  it('opens just the ticket when no attempt is named', () => {
    expect(landingActions({ ...LANDING, attemptId: null }, data(), 'saved')).toEqual([{ type: 'select_ticket', ticketId: 'tk_202' }])
  })

  it('shows the saved plan first, without remembering the choice, when an attempt is asked for while a draft is shown', () => {
    const withDraft = data({ draft: draftPlan() })

    expect(landingActions(LANDING, withDraft, 'draft')).toEqual([
      { type: 'show_view', view: 'saved', remember: false },
      { type: 'open_activity', ticketId: 'tk_202', attemptId: 'at_202_2' }
    ])
    expect(landingActions({ ...LANDING, attemptId: null }, withDraft, 'draft')).toEqual([{ type: 'select_ticket', ticketId: 'tk_202' }])
  })

  it('opens nothing for a ticket the plan does not have, or an epic without a saved plan to follow an attempt in', () => {
    expect(landingActions({ ...LANDING, ticketId: 'tk_gone' }, data(), 'saved')).toEqual([])
    expect(landingActions(LANDING, data({ saved: null, draft: draftPlan() }), 'draft')).toEqual([])
  })
})

describe('the show_view action', () => {
  const loaded = (): ReturnType<typeof initialWorkspaceState> =>
    workspaceReducer(initialWorkspaceState(), { type: 'load_succeeded', data: data({ draft: draftPlan() }), at: 1 })

  it('remembers the view the person picked, unless told not to', () => {
    expect(workspaceReducer(loaded(), { type: 'show_view', view: 'draft' })).toMatchObject({ view: 'draft', chosenView: 'draft' })
    expect(workspaceReducer(loaded(), { type: 'show_view', view: 'draft', remember: false })).toMatchObject({ view: 'draft', chosenView: null })
  })
})
