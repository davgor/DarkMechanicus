import { usePersistentState } from '../app/usePersistentState'

export const RAIL_TAB_ORDER = ['agents', 'browser', 'files'] as const
export type RailTabId = (typeof RAIL_TAB_ORDER)[number]

interface RailState {
  collapsed: boolean
  tab: RailTabId
  cards: Record<string, boolean>
}

export interface RailStateHandle {
  state: RailState
  setCollapsed: (collapsed: boolean) => void
  setTab: (tab: RailTabId) => void
  setCard: (id: string, open: boolean) => void
}

function isRailState(value: unknown): value is RailState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  if (Object.keys(state).length !== 3 || typeof state.collapsed !== 'boolean') return false
  if (!RAIL_TAB_ORDER.some((tab) => tab === state.tab)) return false
  return typeof state.cards === 'object' && state.cards !== null && !Array.isArray(state.cards)
    && Object.values(state.cards).every((open) => typeof open === 'boolean')
}

/** The caller owns the storage namespace; RightRail remounts this hook when that key changes. */
export function useRailState(storageKey: string): RailStateHandle {
  const [state, setState] = usePersistentState<RailState>(storageKey, {
    collapsed: window.matchMedia?.('(max-width: 1099px)').matches ?? false,
    tab: 'agents',
    cards: {}
  }, isRailState)
  return {
    state,
    setCollapsed: (collapsed) => setState((previous) => ({ ...previous, collapsed })),
    setTab: (tab) => setState((previous) => ({ ...previous, tab })),
    setCard: (id, open) => setState((previous) => ({ ...previous, cards: { ...previous.cards, [id]: open } }))
  }
}
