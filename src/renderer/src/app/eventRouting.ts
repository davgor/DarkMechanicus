import type { EventView } from '../../../shared/domain/views'

type TokenMap = Record<string, number>

export interface Tokens {
  folders: TokenMap
  epics: Record<string, TokenMap>
  allEpics: TokenMap
  kanban: TokenMap
  counts: TokenMap
  ready: Record<string, string>
}

interface EventRoute {
  epicIds: string[]
  allEpics: boolean
  folder: boolean
  kanban: boolean
  count: boolean
}

export const EMPTY_TOKENS: Tokens = { folders: {}, epics: {}, allEpics: {}, kanban: {}, counts: {}, ready: {} }

/** These transitions add, remove or complete a card. Other Kanban events only change board content. */
const COUNT_EVENTS = new Set(['kanban.created', 'kanban.deleted', 'kanban.approved'])

type Routing = Omit<EventRoute, 'epicIds'> & { epicIds: Set<string> }

function applyImport(route: Routing, payload: EventView['payload']): void {
  const { changedEpics, branchChanged, kanbanChanged, conflicts, rejected, refreshAll } = payload
  if (Array.isArray(changedEpics)) {
    for (const id of changedEpics) if (typeof id === 'string') route.epicIds.add(id)
  }
  // Older events have no affected entities. A branch switch can affect every epic.
  const allViews = refreshAll === true
  const boardChanged = allViews || kanbanChanged !== false
  route.allEpics ||= [allViews, !Array.isArray(changedEpics), branchChanged === true].some(Boolean)
  route.kanban ||= boardChanged
  route.count ||= boardChanged
  route.folder ||= [route.allEpics, route.epicIds.size, Number(conflicts), Number(rejected)].some(Boolean)
}

function applyEvent(route: Routing, { kind, epicId, payload }: EventView): void {
  if (kind.startsWith('kanban.')) {
    route.kanban = true
    route.count ||= COUNT_EVENTS.has(kind)
  } else if (kind === 'repository.reconciled') {
    applyImport(route, payload)
  } else if (kind !== 'attempt.progress') {
    // The ticket Activity view polls its own timeline.
    if (epicId !== null) route.epicIds.add(epicId)
    route.folder ||= epicId !== null || kind === 'epic.deleted' || kind.startsWith('project.')
  }
}

export function routeEvents(events: readonly EventView[]): EventRoute {
  const route: Routing = { epicIds: new Set(), allEpics: false, folder: false, kanban: false, count: false }
  for (const event of events) applyEvent(route, event)
  return { ...route, epicIds: [...route.epicIds] }
}

export function folderToken(tokens: Tokens, path: string): number { return tokens.folders[path] ?? 0 }
export function epicToken(tokens: Tokens, path: string, epicId: string): number {
  return (tokens.epics[path]?.[epicId] ?? 0) + (tokens.allEpics[path] ?? 0)
}
export function kanbanToken(tokens: Tokens, path: string): number { return tokens.kanban[path] ?? 0 }
export function kanbanCountToken(tokens: Tokens, path: string): number { return tokens.counts[path] ?? 0 }

function bump(map: TokenMap, key: string): TokenMap {
  return { ...map, [key]: (map[key] ?? 0) + 1 }
}

export function bumpFolderToken(tokens: Tokens, path: string): Tokens {
  return { ...tokens, folders: bump(tokens.folders, path) }
}

export function applyRoute(tokens: Tokens, path: string, route: EventRoute): Tokens {
  const { epicIds, allEpics, folder, kanban, count } = route
  if (![folder, kanban, allEpics, epicIds.length].some(Boolean)) return tokens
  let epics = tokens.epics
  if (epicIds.length > 0) {
    const affected = { ...epics[path] }
    for (const id of epicIds) affected[id] = (affected[id] ?? 0) + 1
    epics = { ...epics, [path]: affected }
  }
  return {
    ...tokens,
    epics,
    allEpics: allEpics ? bump(tokens.allEpics, path) : tokens.allEpics,
    folders: folder ? bump(tokens.folders, path) : tokens.folders,
    kanban: kanban ? bump(tokens.kanban, path) : tokens.kanban,
    counts: count ? bump(tokens.counts, path) : tokens.counts
  }
}

export type TokenAction =
  | { type: 'events'; path: string; route: EventRoute }
  | { type: 'baseline'; path: string; identity: string }
  | { type: 'bump' | 'remove'; path: string }

function without<T>(map: Record<string, T>, path: string): Record<string, T> {
  if (map[path] === undefined) return map
  const rest = { ...map }
  delete rest[path]
  return rest
}

export function tokenReducer(tokens: Tokens, action: TokenAction): Tokens {
  const { path } = action
  switch (action.type) {
    case 'events': return applyRoute(tokens, path, action.route)
    case 'bump': return bumpFolderToken(tokens, path)
    case 'baseline': return {
      ...bumpFolderToken(tokens, path),
      allEpics: bump(tokens.allEpics, path),
      kanban: bump(tokens.kanban, path),
      counts: bump(tokens.counts, path),
      ready: { ...tokens.ready, [path]: action.identity }
    }
    case 'remove': return {
      folders: without(tokens.folders, path),
      epics: without(tokens.epics, path),
      allEpics: without(tokens.allEpics, path),
      kanban: without(tokens.kanban, path),
      counts: without(tokens.counts, path),
      ready: without(tokens.ready, path)
    }
  }
}
