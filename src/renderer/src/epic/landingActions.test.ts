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
    savedTickets: [],
    draftTickets: [],
    validation: validation(),
    transfer: null,
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

  it('opens the Agent tab on the chat an Agent request names, never at a thread, whatever the plan holds', () => {
    const agent = { kind: 'epicAgent', epicId: 'ep_1', chatId: 'chat_magos' } as const
    expect(landingActions(agent, data(), 'saved')).toEqual([{ type: 'open_agent', chatId: 'chat_magos', threadId: null }])
    expect(landingActions(agent, data({ saved: null, draft: draftPlan() }), 'draft'))
      .toEqual([{ type: 'open_agent', chatId: 'chat_magos', threadId: null }])

    const loaded = workspaceReducer(initialWorkspaceState(), { type: 'load_succeeded', data: data(), at: 1 })
    expect(landingActions(agent, data(), 'saved').reduce(workspaceReducer, loaded))
      .toMatchObject({ layout: 'agent', agentChatId: 'chat_magos', agentThreadId: null, checkpointOpen: false })
  })

  it('opens the checkpoint panel for a checkpoint request', () => {
    const checkpoint = { kind: 'epicCheckpoint', epicId: 'ep_1' } as const
    expect(landingActions(checkpoint, data(), 'saved')).toEqual([{ type: 'open_checkpoint' }])

    const onAgent = workspaceReducer(
      workspaceReducer(initialWorkspaceState(), { type: 'load_succeeded', data: data(), at: 1 }),
      { type: 'show_layout', layout: 'agent' }
    )
    expect(landingActions(checkpoint, data(), 'saved').reduce(workspaceReducer, onAgent)).toMatchObject({ layout: 'graph', checkpointOpen: true })
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
