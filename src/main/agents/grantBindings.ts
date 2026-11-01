/**
 * Which chat's terminal an attempt or a run is bound to, found by grant (`docs/design/chat-shells.md`, "Panels that
 * follow a chat"): a terminal chat produces no transcript items to bind by, but each start stores the id of the
 * grant it was issued on the chat record (`grantIds`, before the spawn), and the command layer records, for every
 * session, the grant it presented (`sessions.grant_id`, read through the timelines' sessions). So:
 *
 * - an attempt binds to the chat on one of whose grants the session that **claimed** it ran;
 * - a run binds to the chat on one of whose grants the session that **started** it (or, later, took it over) ran:
 *   the latest such session that ran in a chat of the folder.
 *
 * Worker subagents run in the orchestrator's process on its grant, so an attempt binds to the orchestrator's chat.
 * Only the chats of the folder asked about are searched, and the chat store is read from disk after a restart, so
 * a binding survives one. Old chats keep their item-based bindings (`activityBindings.ts`); a chat stored before
 * terminals has no grant ids and binds nothing here.
 */
import type { ActivityEntry, AttemptTimelineView, RunTimelineView } from '../../shared/domain/activity'
import type { BoundTarget } from './boundThreads'
import type { ChatStore } from './chatStore'

/** What the folder's desktop workspace can read: the command layer's own timelines. */
export interface GrantBindingReads {
  attemptTimeline(folder: string, attemptId: string): Promise<AttemptTimelineView>
  /** One page of the run's timeline after `sinceSeq`. */
  runTimeline(folder: string, runId: string, sinceSeq: number): Promise<RunTimelineView>
}

interface GrantBindingDeps {
  reads: GrantBindingReads
  store: Pick<ChatStore, 'listChats'>
}

/** The run changes that make a session the run's orchestrator. */
const RUN_STARTS: ReadonlySet<string> = new Set(['started', 'taken_over'])

/** The grants of the sessions that claimed the attempt, in the order they did. */
async function claimGrants(reads: GrantBindingReads, folder: string, attemptId: string): Promise<(string | null)[]> {
  const view = await reads.attemptTimeline(folder, attemptId)
  const grantOf = new Map(view.sessions.map((session) => [session.id, session.grantId]))
  return view.entries.filter((entry) => entry.kind === 'claim').map((entry) => grantOf.get(entry.sessionId) ?? null)
}

interface Start {
  at: string
  seq: number
  grantId: string | null
}

/** An entry's place in the log: `event:<seq>`. */
function seqOf(entry: ActivityEntry): number {
  const seq = Number(entry.id.slice(entry.id.indexOf(':') + 1))
  return Number.isFinite(seq) ? seq : 0
}

/** The grants of the sessions that started or took over the run, oldest first, read page by page to the end of its log. */
async function startGrants(reads: GrantBindingReads, folder: string, runId: string): Promise<(string | null)[]> {
  const starts: Start[] = []
  let since = 0
  for (;;) {
    const page = await reads.runTimeline(folder, runId, since)
    for (const { session, entries } of page.groups) {
      const changes = entries.filter((entry) => entry.kind === 'run' && RUN_STARTS.has(entry.change))
      starts.push(...changes.map((entry) => ({ at: entry.at, seq: seqOf(entry), grantId: session.grantId })))
    }
    if (page.cursor <= since) {
      break
    }
    since = page.cursor
  }
  return starts.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq).map((start) => start.grantId)
}

/**
 * The id of the chat in `folder` the attempt or run is bound to by grant (see the module comment); null when no
 * chat of the folder was issued the grant of a session that claimed (or started) it.
 */
export async function findBoundTerminal(deps: GrantBindingDeps, folder: string, target: BoundTarget): Promise<string | null> {
  const grants = 'attemptId' in target ? await claimGrants(deps.reads, folder, target.attemptId) : await startGrants(deps.reads, folder, target.runId)
  const chats = deps.store.listChats(folder)
  // Latest first: a run taken over binds to the chat that took it, unless that session ran in no chat of the folder.
  for (const grantId of [...grants].reverse()) {
    const chat = grantId === null ? undefined : chats.find((candidate) => candidate.grantIds?.includes(grantId) === true)
    if (chat !== undefined) {
      return chat.id
    }
  }
  return null
}
