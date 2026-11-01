/**
 * Which chat's terminal an attempt or a run is bound to by grant: the session the command layer records for the
 * claim (or the run's start) presented a grant, and the chat whose record stores that grant's id is the one.
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ActivityEntry, ActivitySession, AttemptTimelineView, RunTimelineView } from '../../shared/domain/activity'
import { memoryChatFs, memoryChatStore, REPO } from './__mocks__/chatFixtures'
import { ATTEMPT_A, RUN_ID } from './__mocks__/orchestratorChat'
import type { ChatStore } from './chatStore'
import { findBoundTerminal, type GrantBindingReads } from './grantBindings'

const OTHER_REPO = resolve('/work/other')
const AT = '2026-01-01T00:00:00.000Z'

function session(id: string, grantId: string | null): ActivitySession {
  return { id, role: 'orchestrator', label: id, grantId }
}

function claimed(sessionId: string, seq = 1): ActivityEntry {
  return {
    kind: 'claim',
    id: `event:${seq}`,
    at: AT,
    sessionId,
    attemptId: ATTEMPT_A,
    ticketId: 'tk_1',
    number: 1,
    worker: { label: 'impl', modelId: null, hostId: null, effort: null, rationale: null }
  }
}

function noted(sessionId: string, seq: number): ActivityEntry {
  return { kind: 'note', id: `event:${seq}`, at: AT, sessionId, attemptId: ATTEMPT_A, ticketId: 'tk_1', text: 'busy', step: null }
}

function runChange(sessionId: string, seq: number, change: 'started' | 'taken_over' | 'paused', at = AT): ActivityEntry {
  return { kind: 'run', id: `event:${seq}`, at, sessionId, change, reason: null }
}

function attemptView(entries: ActivityEntry[], sessions: ActivitySession[]): AttemptTimelineView {
  return { attemptId: ATTEMPT_A, runId: RUN_ID, ticketId: 'tk_1', state: 'running', isLive: true, cursor: entries.length, entries, sessions }
}

/** A run's log as pages of `pageSize` entries, read after a cursor the way `getRunTimeline` pages it. */
function runPages(entries: { entry: ActivityEntry; session: ActivitySession }[], pageSize = 500): GrantBindingReads['runTimeline'] {
  return async (_folder, runId, sinceSeq) => {
    const fresh = entries.filter((_, index) => index + 1 > sinceSeq).slice(0, pageSize)
    const groups = new Map<string | null, RunTimelineView['groups'][number]>()
    for (const { entry, session: who } of fresh) {
      const group = groups.get(who.id) ?? { session: who, entries: [] }
      group.entries.push(entry)
      groups.set(who.id, group)
    }
    const cursor = fresh.length === pageSize ? sinceSeq + pageSize : entries.length
    return { runId, epicId: 'ep_1', state: 'running', isLive: true, cursor, groups: [...groups.values()] }
  }
}

interface Rig {
  store: ChatStore
  reopened: () => ChatStore
  reads: GrantBindingReads
  asked: string[]
}

function rig(reads: Partial<GrantBindingReads> = {}): Rig {
  const fs = memoryChatFs([REPO, OTHER_REPO])
  const asked: string[] = []
  return {
    store: memoryChatStore(fs),
    reopened: () => memoryChatStore(fs),
    asked,
    reads: {
      attemptTimeline: async (folder, attemptId) => {
        asked.push(`attempt:${folder}:${attemptId}`)
        return reads.attemptTimeline === undefined ? attemptView([], []) : reads.attemptTimeline(folder, attemptId)
      },
      runTimeline: async (folder, runId, sinceSeq) => {
        asked.push(`run:${folder}:${runId}:${sinceSeq}`)
        return reads.runTimeline === undefined ? runPages([])(folder, runId, sinceSeq) : reads.runTimeline(folder, runId, sinceSeq)
      }
    }
  }
}

/** A chat in `folder` whose terminal was issued `grantIds` (none: a chat stored before terminals, with no grants). */
function chatWith(store: ChatStore, grantIds: string[] | null, folder = REPO): string {
  const chat = store.createChat({ folder, agent: 'claude', model: null, role: 'orchestrator', allowSave: false })
  if (grantIds !== null) {
    store.updateChat(chat, { grantIds })
  }
  return chat.id
}

describe('findBoundTerminal: an attempt', () => {
  it('finds the chat whose stored grants include the grant of the session that claimed the attempt', async () => {
    const claimer = session('ss_orch', 'gr_2')
    const worker = session('ss_worker', 'gr_9')
    const r = rig({ attemptTimeline: async () => attemptView([claimed('ss_orch'), noted('ss_worker', 2)], [claimer, worker]) })
    const bound = chatWith(r.store, ['gr_1', 'gr_2'])
    // Newer chats of the same folder on other grants: listed first, and not the one bound.
    chatWith(r.store, ['gr_9'])
    chatWith(r.store, ['gr_3', 'gr_4'])

    expect(await findBoundTerminal({ reads: r.reads, store: r.store }, REPO, { attemptId: ATTEMPT_A })).toBe(bound)
    expect(r.asked).toEqual([`attempt:${REPO}:${ATTEMPT_A}`])
  })

  it('finds it again after a restart, from the grant ids stored on the chat record', async () => {
    const r = rig({ attemptTimeline: async () => attemptView([claimed('ss_orch')], [session('ss_orch', 'gr_2')]) })
    const bound = chatWith(r.store, ['gr_1', 'gr_2'])
    chatWith(r.store, ['gr_3'])

    expect(await findBoundTerminal({ reads: r.reads, store: r.reopened() }, REPO, { attemptId: ATTEMPT_A })).toBe(bound)
  })

  it('finds none when the claim presented no grant, or a grant no chat of the folder was issued', async () => {
    const ungranted = rig({ attemptTimeline: async () => attemptView([claimed('ss_mcp')], [session('ss_mcp', null)]) })
    chatWith(ungranted.store, ['gr_1'])
    const elsewhere = rig({ attemptTimeline: async () => attemptView([claimed('ss_orch')], [session('ss_orch', 'gr_7')]) })
    chatWith(elsewhere.store, ['gr_7'], OTHER_REPO)

    expect(await findBoundTerminal({ reads: ungranted.reads, store: ungranted.store }, REPO, { attemptId: ATTEMPT_A })).toBeNull()
    expect(await findBoundTerminal({ reads: elsewhere.reads, store: elsewhere.store }, REPO, { attemptId: ATTEMPT_A })).toBeNull()
  })

  it('binds by the claim alone: a later session on another chat’s grant does not move the attempt', async () => {
    const r = rig({
      attemptTimeline: async () => attemptView([claimed('ss_orch'), noted('ss_other', 2)], [session('ss_orch', null), session('ss_other', 'gr_5')])
    })
    chatWith(r.store, ['gr_5'])

    expect(await findBoundTerminal({ reads: r.reads, store: r.store }, REPO, { attemptId: ATTEMPT_A })).toBeNull()
  })

  it('passes over chats stored before terminals, which have no grant ids', async () => {
    const r = rig({ attemptTimeline: async () => attemptView([claimed('ss_orch')], [session('ss_orch', 'gr_2')]) })
    const bound = chatWith(r.store, ['gr_2'])
    chatWith(r.store, null)
    chatWith(r.store, ['gr_8'])

    expect(await findBoundTerminal({ reads: r.reads, store: r.store }, REPO, { attemptId: ATTEMPT_A })).toBe(bound)
  })
})

describe('findBoundTerminal: a run', () => {
  const starter = session('ss_start', 'gr_1')
  const taker = session('ss_take', 'gr_2')
  const outsider = session('ss_out', null)

  it('finds the chat on whose grant the run was started', async () => {
    const r = rig({ runTimeline: runPages([{ entry: runChange('ss_start', 1, 'started'), session: starter }]) })
    const bound = chatWith(r.store, ['gr_1'])
    chatWith(r.store, ['gr_6'])

    expect(await findBoundTerminal({ reads: r.reads, store: r.store }, REPO, { runId: RUN_ID })).toBe(bound)
  })

  it('follows a takeover to the chat that took the run over, also when it is on a later page', async () => {
    const log = [
      { entry: runChange('ss_start', 1, 'started', '2026-01-01T00:00:00.000Z'), session: starter },
      { entry: runChange('ss_start', 2, 'paused', '2026-01-01T00:01:00.000Z'), session: starter },
      { entry: runChange('ss_take', 3, 'taken_over', '2026-01-01T00:02:00.000Z'), session: taker }
    ]
    const r = rig({ runTimeline: runPages(log, 2) })
    const taken = chatWith(r.store, ['gr_2'])
    // The starter's chat is newer than the taker's: the takeover, not recency, decides.
    chatWith(r.store, ['gr_1'])

    expect(await findBoundTerminal({ reads: r.reads, store: r.store }, REPO, { runId: RUN_ID })).toBe(taken)
    expect(r.asked).toEqual([`run:${REPO}:${RUN_ID}:0`, `run:${REPO}:${RUN_ID}:2`, `run:${REPO}:${RUN_ID}:3`])
  })

  it('keeps the chat that started the run when the session that took it over ran in no chat', async () => {
    const log = [
      { entry: runChange('ss_start', 1, 'started', '2026-01-01T00:00:00.000Z'), session: starter },
      { entry: runChange('ss_out', 2, 'taken_over', '2026-01-01T00:02:00.000Z'), session: outsider }
    ]
    const r = rig({ runTimeline: runPages(log) })
    const bound = chatWith(r.store, ['gr_1'])
    chatWith(r.store, ['gr_6'])

    expect(await findBoundTerminal({ reads: r.reads, store: r.store }, REPO, { runId: RUN_ID })).toBe(bound)
  })

  it('finds none for a run no chat started, whatever else chats did in it', async () => {
    const log = [
      { entry: runChange('ss_out', 1, 'started'), session: outsider },
      { entry: runChange('ss_take', 2, 'paused'), session: taker }
    ]
    const r = rig({ runTimeline: runPages(log) })
    chatWith(r.store, ['gr_2'])

    expect(await findBoundTerminal({ reads: r.reads, store: r.store }, REPO, { runId: RUN_ID })).toBeNull()
  })
})
