import { describe, expect, it } from 'vitest'
import { EPIC_A, EPIC_B, eventView } from '../__mocks__/fixtures'
import { EMPTY_TOKENS, applyRoute, epicToken, folderToken, kanbanCountToken, kanbanToken, routeEvents, tokenReducer } from './eventRouting'

describe('event refresh domains', () => {
  it('coalesces epic events by id across a batch', () => {
    const events = [eventView({ epicId: EPIC_A }), eventView({ epicId: EPIC_B }), eventView({ epicId: EPIC_A })]
    const next = applyRoute(EMPTY_TOKENS, '/f', routeEvents(events))
    expect(epicToken(next, '/f', EPIC_A)).toBe(1)
    expect(epicToken(next, '/f', EPIC_B)).toBe(1)
    expect(folderToken(next, '/f')).toBe(1)
    expect(kanbanCountToken(next, '/f')).toBe(0)
    expect(kanbanToken(next, '/f')).toBe(0)
  })

  it('routes card activity to Kanban and refreshes the open count only for a changed total', () => {
    const active = applyRoute(EMPTY_TOKENS, '/f', routeEvents([eventView({ kind: 'kanban.submitted', epicId: null })]))
    const done = applyRoute(active, '/f', routeEvents([eventView({ kind: 'kanban.approved', epicId: null })]))
    expect(kanbanToken(done, '/f')).toBe(2)
    expect(kanbanCountToken(active, '/f')).toBe(0)
    expect(kanbanCountToken(done, '/f')).toBe(1)
    expect(folderToken(done, '/f')).toBe(0)
  })

  it('refreshes only affected epics and exact board counts after imported records', () => {
    const imported = eventView({ kind: 'repository.reconciled', epicId: null, payload: { changedEpics: [EPIC_B], kanbanChanged: true } })
    const next = applyRoute(EMPTY_TOKENS, '/f', routeEvents([imported, imported]))
    expect(epicToken(next, '/f', EPIC_A)).toBe(0)
    expect(epicToken(next, '/f', EPIC_B)).toBe(1)
    expect(folderToken(next, '/f')).toBe(1)
    expect(kanbanCountToken(next, '/f')).toBe(1)
    expect(kanbanCountToken(next, '/g')).toBe(0)
  })

  it('invalidates visible views after attachment-only or conflict-state reconciliation', () => {
    const repair = eventView({ kind: 'repository.reconciled', payload: { changedEpics: [], kanbanChanged: false, refreshAll: true } })
    const next = applyRoute(EMPTY_TOKENS, '/f', routeEvents([repair]))
    expect(epicToken(next, '/f', EPIC_A)).toBe(1)
    expect(kanbanToken(next, '/f')).toBe(1)
    expect(folderToken(next, '/f')).toBe(1)
    expect(epicToken(next, '/other', EPIC_A)).toBe(0)
  })

  it('ignores mail and empty batches', () => {
    expect(applyRoute(EMPTY_TOKENS, '/f', routeEvents([]))).toBe(EMPTY_TOKENS)
    expect(applyRoute(EMPTY_TOKENS, '/f', routeEvents([eventView({ kind: 'mail.sent', epicId: null })]))).toBe(EMPTY_TOKENS)
  })

  it('evicts every token for a removed identity', () => {
    const active = tokenReducer(EMPTY_TOKENS, { type: 'baseline', path: '/f', identity: 'before' })
    const changed = applyRoute(active, '/f', routeEvents([eventView({ epicId: EPIC_A })]))
    expect(changed.ready['/f']).toBe('before')
    expect(tokenReducer(changed, { type: 'remove', path: '/f' })).toEqual(EMPTY_TOKENS)
  })
})

describe('learning changes from another window (DM-983)', () => {
  it('refreshes the Learnings token for a learning retired or replaced, without a board count', () => {
    for (const kind of ['kanban.learning_retired', 'kanban.learning_replaced']) {
      const next = applyRoute(EMPTY_TOKENS, '/f', routeEvents([eventView({ kind, epicId: null })]))
      // The Learnings panel's refresh token is the folder's Kanban token plus its folder token (`useShell`).
      expect(kanbanToken(next, '/f') + folderToken(next, '/f')).toBe(1)
      expect(kanbanCountToken(next, '/f')).toBe(0)
    }
  })
})
