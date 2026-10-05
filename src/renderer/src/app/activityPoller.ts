/**
 * The renderer's client for the activity timelines (`getAttemptTimeline`, `getRunTimeline`): a poller that
 * follows a page cursor like the event poller does, and pure merges that fold each page into what the UI
 * already shows. Unlike the event poller it replays history on its first request (a timeline is shown whole),
 * and it keeps delivering pages until one says the timeline is no longer live.
 */
import type {
  ActivityEntry,
  ActivitySession,
  AttemptTimelineView,
  RunActivityGroup,
  RunTimelineView
} from '../../../shared/domain/activity'
import { MAX_PAGES_PER_TICK, PAGE_LIMIT } from './eventPoller'

/** What every timeline page tells a poller. */
export interface TimelinePage {
  cursor: number
  isLive: boolean
}

interface PageRequest {
  sinceSeq: number
  limit: number
}

interface ActivityPollerOptions<P extends TimelinePage> {
  fetchPage(request: PageRequest): Promise<P>
  /** How many entries a page holds; a page of `PAGE_LIMIT` or more may have another behind it. */
  size(page: P): number
  /** Called with every page, empty ones included: they carry the cursor and whether the timeline is still live. */
  onPage(page: P): void
  /** Called on the first failure of a run of failures; recovery re-arms it. */
  onError(error: unknown): void
}

interface ActivityPoller {
  tick(): Promise<void>
  /** True once a page said the timeline is not live and nothing is left behind it: stop polling. */
  done(): boolean
}

/** One polling loop per timeline. Overlapping ticks are skipped so a slow reply never stacks requests. */
export function createActivityPoller<P extends TimelinePage>(options: ActivityPollerOptions<P>): ActivityPoller {
  let cursor = 0
  let busy = false
  let failing = false
  let finished = false

  async function drain(): Promise<void> {
    for (let pages = 0; pages < MAX_PAGES_PER_TICK; pages += 1) {
      const page = await options.fetchPage({ sinceSeq: cursor, limit: PAGE_LIMIT })
      cursor = page.cursor
      options.onPage(page)
      if (options.size(page) < PAGE_LIMIT) {
        finished = !page.isLive
        return
      }
    }
  }

  return {
    done: () => finished,
    async tick() {
      if (busy || finished) {
        return
      }
      busy = true
      try {
        await drain()
        failing = false
      } catch (error) {
        if (!failing) {
          failing = true
          options.onError(error)
        }
      } finally {
        busy = false
      }
    }
  }
}

function sameEntry(a: ActivityEntry | undefined, b: ActivityEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Folds a page's entries into the held ones: an entry whose id is already held replaces it in place (the
 * alive span grows that way), any other is appended in the order it arrived. Returns `held` itself when
 * nothing changed, so an idle poll does not re-render.
 */
export function mergeEntries(held: readonly ActivityEntry[], incoming: readonly ActivityEntry[]): readonly ActivityEntry[] {
  const positions = new Map(held.map((entry, position) => [entry.id, position]))
  const next = [...held]
  let changed = false
  for (const entry of incoming) {
    const position = positions.get(entry.id)
    if (position === undefined) {
      positions.set(entry.id, next.length)
      next.push(entry)
      changed = true
    } else if (!sameEntry(next[position], entry)) {
      next[position] = entry
      changed = true
    }
  }
  return changed ? next : (held as ActivityEntry[])
}

function mergeSessions(held: readonly ActivitySession[], incoming: readonly ActivitySession[]): readonly ActivitySession[] {
  const known = new Set(held.map((session) => session.id))
  const added = incoming.filter((session) => !known.has(session.id))
  return added.length === 0 ? held : [...held, ...added]
}

/** The held attempt timeline with the page folded in; the page's cursor, state and liveness win. */
export function mergeAttemptTimeline(held: AttemptTimelineView | null, page: AttemptTimelineView): AttemptTimelineView {
  if (held === null) {
    return page
  }
  const entries = mergeEntries(held.entries, page.entries) as ActivityEntry[]
  const sessions = mergeSessions(held.sessions, page.sessions) as ActivitySession[]
  const unchanged =
    entries === held.entries &&
    sessions === held.sessions &&
    held.cursor === page.cursor &&
    held.isLive === page.isLive &&
    held.state === page.state
  return unchanged ? held : { ...page, entries, sessions }
}

function mergeGroups(held: readonly RunActivityGroup[], incoming: readonly RunActivityGroup[]): readonly RunActivityGroup[] {
  const next = [...held]
  let changed = false
  for (const group of incoming) {
    const position = next.findIndex((item) => item.session.id === group.session.id)
    const existing = next[position]
    if (existing === undefined) {
      next.push(group)
      changed = true
      continue
    }
    const entries = mergeEntries(existing.entries, group.entries) as ActivityEntry[]
    if (entries !== existing.entries) {
      next[position] = { session: existing.session, entries }
      changed = true
    }
  }
  return changed ? next : held
}

/** The held run timeline with the page folded in, each entry under the group of its session. */
export function mergeRunTimeline(held: RunTimelineView | null, page: RunTimelineView): RunTimelineView {
  if (held === null) {
    return page
  }
  const groups = mergeGroups(held.groups, page.groups) as RunActivityGroup[]
  const unchanged =
    groups === held.groups && held.cursor === page.cursor && held.isLive === page.isLive && held.state === page.state
  return unchanged ? held : { ...page, groups }
}
