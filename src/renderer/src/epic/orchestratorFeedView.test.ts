import { describe, expect, it } from 'vitest'
import type { ActivityEntry, RunActivityGroup, RunTimelineView } from '../../../shared/domain/activity'
import { streamMeta, feedRows, ORCHESTRATOR_FALLBACK, orchestratorLabel } from './orchestratorFeedView'

const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const KEYS = new Map([
  ['tk_202', 'DM-202'],
  ['tk_203', 'DM-203']
])

function at(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString()
}

function claim(seq: number, secondsAgo: number, patch: Partial<Extract<ActivityEntry, { kind: 'claim' }>> = {}): ActivityEntry {
  return {
    kind: 'claim',
    id: `event:${seq}`,
    at: at(secondsAgo),
    sessionId: 'ss_orch',
    attemptId: 'at_202_1',
    ticketId: 'tk_202',
    number: 1,
    worker: { label: 'Claude Code subagent', modelId: 'claude-sonnet-5-5', hostId: 'host_1', effort: 'low', rationale: 'Top fit for a small ticket' },
    ...patch
  }
}

function run(seq: number, secondsAgo: number, change: 'started' | 'paused', reason: string | null = null): ActivityEntry {
  return { kind: 'run', id: `event:${seq}`, at: at(secondsAgo), sessionId: 'ss_orch', change, reason }
}

function group(label: string, role: RunActivityGroup['session']['role'], entries: ActivityEntry[], id = 'ss_orch'): RunActivityGroup {
  return { session: { id, role, label }, entries }
}

function view(groups: RunActivityGroup[]): RunTimelineView {
  return { runId: 'rn_2', epicId: 'ep_1', state: 'running', isLive: true, cursor: 9, groups }
}

describe('orchestratorLabel', () => {
  it('names the session whose role is orchestrator', () => {
    const named = view([group('Claude Code subagent', 'worker', [], 'ss_w'), group('Claude Code in chat', 'orchestrator', [])])
    expect(orchestratorLabel(named)).toBe('Claude Code in chat')
  })

  it('falls back until an orchestrator session has acted', () => {
    expect(orchestratorLabel(null)).toBe(ORCHESTRATOR_FALLBACK)
    expect(orchestratorLabel(view([]))).toBe(ORCHESTRATOR_FALLBACK)
    expect(orchestratorLabel(view([group('Someone', 'worker', [])]))).toBe(ORCHESTRATOR_FALLBACK)
    expect(orchestratorLabel(view([group('  ', 'orchestrator', [])]))).toBe(ORCHESTRATOR_FALLBACK)
  })
})

describe('feedRows', () => {
  it('merges the sessions into one list, newest first', () => {
    const merged = view([
      group('Orchestrator A', 'orchestrator', [run(1, 300, 'started'), run(4, 10, 'paused', 'sign-in lost')]),
      group('Worker B', 'worker', [claim(2, 200, { sessionId: 'ss_w' })], 'ss_w')
    ])
    const rows = feedRows(merged, KEYS, NOW)
    expect(rows.map((row) => row.id)).toEqual(['event:4', 'event:2', 'event:1'])
    expect(rows.map((row) => row.who)).toEqual(['Orchestrator A', 'Worker B', 'Orchestrator A'])
    expect(rows[0]).toMatchObject({ label: 'Run paused', text: 'sign-in lost', when: '10s ago', ticket: null })
  })

  it('shows a claim with its ticket, model and rationale', () => {
    const [row] = feedRows(view([group('Orchestrator', 'orchestrator', [claim(2, 60)])]), KEYS, NOW)
    expect(row).toMatchObject({ label: 'Claimed', text: 'attempt #1 by Claude Code subagent', ticket: { id: 'tk_202', key: 'DM-202' } })
    expect(row?.details).toEqual([
      { name: 'Model', value: 'claude-sonnet-5-5' },
      { name: 'Effort', value: 'low' },
      { name: 'Why', value: 'Top fit for a small ticket' }
    ])
  })

  it('leaves out what a claim does not record', () => {
    const bare = claim(2, 60, { worker: { label: 'W', modelId: null, hostId: null, effort: null, rationale: null } })
    expect(feedRows(view([group('O', 'orchestrator', [bare])]), KEYS, NOW)[0]?.details).toEqual([])
  })

  it('falls back to the ticket id when its key is unknown, and keeps text as plain text', () => {
    const odd = claim(3, 5, { ticketId: 'tk_999', worker: { label: '<b>w</b>', modelId: null, hostId: null, effort: null, rationale: '<img src=x>' } })
    const [row] = feedRows(view([group('O', 'orchestrator', [odd])]), KEYS, NOW)
    expect(row?.ticket).toEqual({ id: 'tk_999', key: 'tk_999' })
    expect(row?.text).toBe('attempt #1 by <b>w</b>')
    expect(row?.details).toEqual([{ name: 'Why', value: '<img src=x>' }])
  })
})

describe('feedRows entries', () => {
  it('describes the review and failure entries', () => {
    const entries: ActivityEntry[] = [
      { kind: 'submitted', id: 'event:5', at: at(50), sessionId: 's', attemptId: 'a', ticketId: 'tk_202', summary: 'Added the drawer' },
      { kind: 'decision', id: 'event:6', at: at(40), sessionId: 's', attemptId: 'a', ticketId: 'tk_202', outcome: 'rejected', reasons: ['c2 unmet'], notes: '', decidedBy: 'r' },
      { kind: 'failed', id: 'event:7', at: at(30), sessionId: 's', attemptId: 'a', ticketId: 'tk_203', reason: 'tests failed', retryable: true },
      { kind: 'lease_expired', id: 'event:8', at: at(20), sessionId: 's', attemptId: 'a', ticketId: 'tk_203', cause: 'timeout', leaseExpiresAt: null }
    ]
    const rows = feedRows(view([group('O', 'orchestrator', entries)]), KEYS, NOW)
    expect(rows.map((row) => [row.label, row.text, row.tone])).toEqual([
      ['Lease expired', 'the lease ran out', 'blocked'],
      ['Failed', 'tests failed (can retry)', 'failed'],
      ['Rejected', 'c2 unmet', 'failed'],
      ['Submitted', 'Added the drawer', 'review']
    ])
  })

  it('is empty before anything happened', () => {
    expect(feedRows(null, KEYS, NOW)).toEqual([])
    expect(feedRows(view([]), KEYS, NOW)).toEqual([])
  })
})

type Of<K extends ActivityEntry['kind']> = Extract<ActivityEntry, { kind: K }>

function rowsOf(entries: ActivityEntry[]) {
  return feedRows(view([group('O', 'orchestrator', entries)]), KEYS, NOW)
}

const ATTEMPT = { sessionId: 's', attemptId: 'a', ticketId: 'tk_202' }
const TICKET_202 = { id: 'tk_202', key: 'DM-202' }

describe('feedRows run changes', () => {
  it.each([
    ['queued', 'Run queued', 'waiting'],
    ['started', 'Run started', 'running'],
    ['paused', 'Run paused', 'attention'],
    ['resumed', 'Run resumed', 'running'],
    ['leases_extended', 'Leases extended', 'neutral'],
    ['completed', 'Run completed', 'accepted'],
    ['canceled', 'Run canceled', 'failed'],
    ['failed', 'Run failed', 'failed'],
    ['taken_over', 'Run taken over', 'attention']
  ] as const)('says a run %s with the label %s and tone %s, with the reason when there is one', (change, label, tone) => {
    const entry: Of<'run'> = { kind: 'run', id: 'event:1', at: at(5), sessionId: 's', change, reason: null }
    expect(rowsOf([entry])[0]).toMatchObject({ label, tone, text: '', ticket: null })
    expect(rowsOf([{ ...entry, reason: 'because' }])[0]).toMatchObject({ label, tone, text: 'because' })
  })
})

describe('feedRows attempt entries', () => {
  it('says whether a lease is still held', () => {
    const span = (active: boolean): Of<'alive'> => ({ ...ATTEMPT, kind: 'alive', id: 'alive:a', at: at(9), until: at(1), leaseExpiresAt: null, active })
    expect(rowsOf([span(true)])[0]).toMatchObject({ label: 'Alive', tone: 'running', text: 'holding its lease', ticket: TICKET_202 })
    expect(rowsOf([span(false)])[0]).toMatchObject({ label: 'Alive', text: 'lease released' })
  })

  it('shows progress notes, comments and carried-forward tickets as their own text', () => {
    const entries: ActivityEntry[] = [
      { ...ATTEMPT, kind: 'carried_forward', id: 'event:1', at: at(30), note: 'Unchanged since run 1' },
      { ...ATTEMPT, kind: 'note', id: 'event:2', at: at(20), text: 'schema is in', step: 'coding' },
      { kind: 'comment', id: 'event:3', at: at(10), sessionId: 's', ticketId: null, commentId: 'cm_1', body: 'Keep it reversible', author: { role: 'desktop', label: 'Desktop app' } }
    ]
    expect(rowsOf(entries).map((row) => [row.label, row.tone, row.text, row.ticket])).toEqual([
      ['Comment', 'neutral', 'Desktop app: Keep it reversible', null],
      ['Progress', 'neutral', 'schema is in', TICKET_202],
      ['Carried forward', 'accepted', 'Unchanged since run 1', TICKET_202]
    ])
  })

})

describe('feedRows how an attempt ended', () => {
  it('says an acceptance in good tone, and gives the reasons of a rejection, or its notes when it has none', () => {
    const decision = (seq: number, patch: Partial<Of<'decision'>>): ActivityEntry => ({
      ...ATTEMPT,
      kind: 'decision',
      id: `event:${seq}`,
      at: at(100 - seq),
      outcome: 'accepted',
      reasons: [],
      notes: 'Looks right',
      decidedBy: 'r',
      ...patch
    })
    const rows = rowsOf([
      decision(1, {}),
      decision(2, { outcome: 'rejected', reasons: ['no tests', 'no lint'], notes: 'ignored' }),
      decision(3, { outcome: 'rejected', notes: 'Try again' })
    ])
    expect(rows.map((row) => [row.label, row.tone, row.text])).toEqual([
      ['Rejected', 'failed', 'Try again'],
      ['Rejected', 'failed', 'no tests; no lint'],
      ['Accepted', 'accepted', 'Looks right']
    ])
  })

  it('offers a retry only for a failure that can be retried', () => {
    const failed = (retryable: boolean): Of<'failed'> => ({ ...ATTEMPT, kind: 'failed', id: 'event:1', at: at(5), reason: 'registry down', retryable })
    expect(rowsOf([failed(true)])[0]?.text).toBe('registry down (can retry)')
    expect(rowsOf([failed(false)])[0]?.text).toBe('registry down')
  })

  it('tells a timeout from a takeover, and an abandoned attempt from a resubmitted one', () => {
    const entries: ActivityEntry[] = [
      { ...ATTEMPT, kind: 'lease_expired', id: 'event:1', at: at(40), cause: 'timeout', leaseExpiresAt: null },
      { ...ATTEMPT, kind: 'lease_expired', id: 'event:2', at: at(30), cause: 'takeover', leaseExpiresAt: null },
      { ...ATTEMPT, kind: 'reconciled', id: 'event:3', at: at(20), resolution: 'abandon' },
      { ...ATTEMPT, kind: 'reconciled', id: 'event:4', at: at(10), resolution: 'resubmit' }
    ]
    expect(rowsOf(entries).map((row) => [row.label, row.tone, row.text])).toEqual([
      ['Reconciled', 'attention', 'resubmitted'],
      ['Reconciled', 'attention', 'abandoned'],
      ['Lease expired', 'blocked', 'the run moved to another machine'],
      ['Lease expired', 'blocked', 'the lease ran out']
    ])
  })

  it('says why a run ended under an attempt, or that it did', () => {
    const canceled = (reason: string | null): Of<'canceled'> => ({ ...ATTEMPT, kind: 'canceled', id: 'event:1', at: at(5), reason })
    expect(rowsOf([canceled('wrong plan')])[0]).toMatchObject({ label: 'Canceled', tone: 'failed', text: 'wrong plan' })
    expect(rowsOf([canceled(null)])[0]).toMatchObject({ label: 'Canceled', text: 'the run ended' })
  })
})

describe('feedRows sprint entries', () => {
  it('names the sprint report revision', () => {
    const report: Of<'report'> = { kind: 'report', id: 'event:1', at: at(5), sessionId: 's', sprintId: 'sp_1', reportRevision: 3 }
    expect(rowsOf([report])[0]).toMatchObject({ label: 'Sprint report', tone: 'review', text: 'revision 3', ticket: null })
  })

  it.each([
    ['approved', 'auto', 'Checkpoint approved', 'automatically'],
    ['approved', 'human', 'Checkpoint approved', 'by a person'],
    ['approved', null, 'Checkpoint approved', ''],
    ['advanced', 'auto', 'Sprint advanced', 'automatically'],
    ['advanced', 'human', 'Sprint advanced', 'by a person'],
    ['advanced', null, 'Sprint advanced', '']
  ] as const)('shows a checkpoint %s under policy %s as "%s" %s', (step, policy, label, text) => {
    const entry: Of<'checkpoint'> = {
      kind: 'checkpoint',
      id: 'event:1',
      at: at(5),
      sessionId: 's',
      step,
      sprintId: 'sp_1',
      toSprintId: step === 'advanced' ? 'sp_2' : null,
      policy
    }
    expect(rowsOf([entry])[0]).toMatchObject({ label, text, tone: 'attention' })
  })
})

describe('feedRows order', () => {
  it('puts the later of entries from the same moment first, comparing their numbers as numbers', () => {
    const rows = rowsOf([run(9, 5, 'started'), run(10, 5, 'paused'), run(100, 5, 'started')])
    expect(rows.map((row) => row.id)).toEqual(['event:100', 'event:10', 'event:9'])
  })

  it('still orders by time before it looks at the ids', () => {
    const rows = rowsOf([run(10, 50, 'started'), run(2, 5, 'paused')])
    expect(rows.map((row) => row.id)).toEqual(['event:2', 'event:10'])
  })
})

describe('feedRows time', () => {
  it('carries when each entry happened, so the rows of the orchestrator\'s chat can be placed among them', () => {
    const rows = rowsOf([run(1, 300, 'started'), run(2, 10, 'paused')])
    expect(rows.map((row) => row.at)).toEqual([at(10), at(300)])
  })
})

describe('streamMeta', () => {
  it('says the row is chat and how long ago it was stored', () => {
    expect(streamMeta(at(90), NOW)).toBe('Chat · 1m ago')
    expect(streamMeta(at(5), NOW)).toBe('Chat · 5s ago')
  })

  it('says a text that is still being written is happening now', () => {
    expect(streamMeta(null, NOW)).toBe('Chat · just now')
  })
})
