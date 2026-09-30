import type { EventView } from '../../../shared/domain/views'

type TokenMap = Record<string, number>

/**
 * Refresh tokens: a number per folder (refetch its epic list and storage status) and per epic
 * (reload the open epic view). Tokens only ever increase; consumers compare them for change.
 */
export interface Tokens {
  folders: TokenMap
  epics: Record<string, TokenMap>
}

export interface EventRoute {
  /** Epics named by the events, each once, in first-seen order. */
  epicIds: string[]
  /** True when there was at least one event, whatever it concerned. */
  touched: boolean
}

export const EMPTY_TOKENS: Tokens = { folders: {}, epics: {} }

export function routeEvents(events: readonly EventView[]): EventRoute {
  const epicIds: string[] = []
  for (const event of events) {
    if (event.epicId !== null && !epicIds.includes(event.epicId)) {
      epicIds.push(event.epicId)
    }
  }
  return { epicIds, touched: events.length > 0 }
}

export function folderToken(tokens: Tokens, folderPath: string): number {
  return tokens.folders[folderPath] ?? 0
}

export function epicToken(tokens: Tokens, folderPath: string, epicId: string): number {
  return tokens.epics[folderPath]?.[epicId] ?? 0
}

export function bumpFolderToken(tokens: Tokens, folderPath: string): Tokens {
  return { ...tokens, folders: { ...tokens.folders, [folderPath]: folderToken(tokens, folderPath) + 1 } }
}

/** Applies a routed batch: the folder token always moves, plus one token per affected epic. */
export function applyRoute(tokens: Tokens, folderPath: string, route: EventRoute): Tokens {
  if (!route.touched) {
    return tokens
  }
  const epics: TokenMap = { ...tokens.epics[folderPath] }
  for (const epicId of route.epicIds) {
    epics[epicId] = (epics[epicId] ?? 0) + 1
  }
  const bumped = bumpFolderToken(tokens, folderPath)
  return { ...bumped, epics: { ...tokens.epics, [folderPath]: epics } }
}

export type TokenAction =
  | { type: 'events'; path: string; route: EventRoute }
  | { type: 'bump'; path: string }

export function tokenReducer(tokens: Tokens, action: TokenAction): Tokens {
  return action.type === 'bump'
    ? bumpFolderToken(tokens, action.path)
    : applyRoute(tokens, action.path, action.route)
}
