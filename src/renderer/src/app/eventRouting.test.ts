import { describe, expect, it } from 'vitest'
import { EPIC_A, EPIC_B, eventView } from '../__mocks__/fixtures'
import {
  EMPTY_TOKENS,
  applyRoute,
  bumpFolderToken,
  epicToken,
  folderToken,
  routeEvents,
  tokenReducer
} from './eventRouting'

describe('routeEvents', () => {
  it('ignores an empty batch', () => {
    expect(routeEvents([])).toEqual({ epicIds: [], touched: false })
  })

  it('collects each affected epic once, in first-seen order', () => {
    const events = [
      eventView({ seq: 1, epicId: EPIC_B }),
      eventView({ seq: 2, epicId: EPIC_A }),
      eventView({ seq: 3, epicId: EPIC_B })
    ]
    expect(routeEvents(events)).toEqual({ epicIds: [EPIC_B, EPIC_A], touched: true })
  })

  it('marks epic-less events as touching the folder only', () => {
    expect(routeEvents([eventView({ seq: 1, epicId: null })])).toEqual({ epicIds: [], touched: true })
  })
})

describe('token lookups', () => {
  it('defaults every token to zero', () => {
    expect(folderToken(EMPTY_TOKENS, '/f')).toBe(0)
    expect(epicToken(EMPTY_TOKENS, '/f', EPIC_A)).toBe(0)
  })

  it('bumps only the requested folder', () => {
    const bumped = bumpFolderToken(bumpFolderToken(EMPTY_TOKENS, '/f'), '/f')
    expect(folderToken(bumped, '/f')).toBe(2)
    expect(folderToken(bumped, '/g')).toBe(0)
  })
})

describe('applyRoute', () => {
  it('returns the same tokens when nothing was touched', () => {
    const tokens = bumpFolderToken(EMPTY_TOKENS, '/f')
    expect(applyRoute(tokens, '/f', { epicIds: [], touched: false })).toBe(tokens)
  })

  it('bumps the folder and each affected epic by one', () => {
    const next = applyRoute(EMPTY_TOKENS, '/f', { epicIds: [EPIC_A, EPIC_B], touched: true })
    expect(folderToken(next, '/f')).toBe(1)
    expect(epicToken(next, '/f', EPIC_A)).toBe(1)
    expect(epicToken(next, '/f', EPIC_B)).toBe(1)
  })

  it('leaves unrelated epics and folders alone', () => {
    const first = applyRoute(EMPTY_TOKENS, '/f', { epicIds: [EPIC_A], touched: true })
    const second = applyRoute(first, '/f', { epicIds: [EPIC_B], touched: true })
    expect(epicToken(second, '/f', EPIC_A)).toBe(1)
    expect(epicToken(second, '/f', EPIC_B)).toBe(1)
    expect(folderToken(second, '/f')).toBe(2)
    expect(epicToken(second, '/g', EPIC_A)).toBe(0)
  })

  it('accumulates repeated bumps for the same epic', () => {
    const route = { epicIds: [EPIC_A], touched: true }
    const twice = applyRoute(applyRoute(EMPTY_TOKENS, '/f', route), '/f', route)
    expect(epicToken(twice, '/f', EPIC_A)).toBe(2)
  })

  it('does not mutate the previous tokens', () => {
    applyRoute(EMPTY_TOKENS, '/f', { epicIds: [EPIC_A], touched: true })
    expect(EMPTY_TOKENS).toEqual({ folders: {}, epics: {} })
  })
})

describe('tokenReducer', () => {
  it('applies routed events to the tokens', () => {
    const route = { epicIds: [EPIC_A], touched: true }
    const next = tokenReducer(EMPTY_TOKENS, { type: 'events', path: '/f', route })
    expect(epicToken(next, '/f', EPIC_A)).toBe(1)
    expect(folderToken(next, '/f')).toBe(1)
  })

  it('bumps only the folder token on request', () => {
    const next = tokenReducer(EMPTY_TOKENS, { type: 'bump', path: '/f' })
    expect(folderToken(next, '/f')).toBe(1)
    expect(next.epics).toEqual({})
  })
})
