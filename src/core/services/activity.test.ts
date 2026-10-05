import { describe, expect, it } from 'vitest'
import type { ActivityEntry, AttemptTimelineView, RunTimelineView } from '../../shared/domain/activity'
import type { ClaimResultView } from '../../shared/domain/views'
import { makeBundle, sid, tid } from '../../test/bundles'
import { claim, completeTicket, errorCode, seedEpic, startedRun } from '../../test/execution'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { getAttemptTimeline, getRunTimeline } from './activity'
import {
  acceptAttempt,
  carryForwardTicket,
  failAttempt,
  heartbeatAttempt,
  reconcileAttempt,
  rejectAttempt,
  submitAttempt
} from './attempts'
import { advanceSprint, approveCheckpoint } from './checkpoints'
import { addComment } from './comments'
import { submitSprintReport } from './reports'
import { cancelRun, pauseRun, queueRun, resumeRun, startRun, takeoverRun } from './runs'

const TOKEN_LOOKALIKE = 'at_01j8z3k5m7n9p2q4r6s8t0v1w2.Zk9_aB3dEf7-Hj2LmN5pQr8TuVw0XyZa'

interface Rig {
  ctx: TestCtx
  worker: TestCtx
  desktop: TestCtx
  runId: string
  epicId: string
}

function registerSessions(ctx: TestCtx, labels: Record<string, string>): void {
  for (const [role, label] of Object.entries(labels)) {
    const id = role === 'orchestrator' ? ctx.session.id : withRole(ctx, role as 'worker' | 'desktop').session.id
    ctx.db.run(
      `INSERT INTO sessions (id, role, label, capabilities_json, transport, started_at, last_seen_at)
       VALUES (?, ?, ?, '[]', 'in_process', ?, ?)`,
      id,
      role,
      label,
      ctx.clock.nowIso(),
      ctx.clock.nowIso()
    )
  }
}

function rig(): Rig {
  const ctx = createTestCtx()
  registerSessions(ctx, { orchestrator: 'Orchestrator chat', worker: 'impl-1 worker', desktop: 'Desktop app' })
  const { runId, epicId } = startedRun(ctx)
  return { ctx, worker: withRole(ctx, 'worker'), desktop: withRole(ctx, 'desktop'), runId, epicId }
}

function tick(ctx: TestCtx, seconds = 10): void {
  ctx.clock.advanceSeconds(seconds)
}

function beat(rigged: Rig, claimed: ClaimResultView, progress?: { note: string; step?: string }): void {
  heartbeatAttempt(rigged.worker, {
    attemptId: claimed.attempt.id,
    claimToken: claimed.packet.claimToken,
    ...(progress === undefined ? {} : { progress })
  })
}

function submit(rigged: Rig, claimed: ClaimResultView, summary = 'Added the schema'): void {
  submitAttempt(rigged.worker, {
    attemptId: claimed.attempt.id,
    claimToken: claimed.packet.claimToken,
    outputs: { summary }
  })
}

function comment(who: TestCtx, rigged: Rig, ticket: number, body: string): void {
  addComment(who, { epicId: rigged.epicId, ticketId: tid(ticket), body })
}

function kinds(entries: ActivityEntry[]): string[] {
  return entries.map((entry) => entry.kind)
}

function timeline(rigged: Rig, claimed: ClaimResultView, window: { sinceSeq?: number; limit?: number } = {}): AttemptTimelineView {
  return getAttemptTimeline(rigged.ctx, { attemptId: claimed.attempt.id, ...window })
}

/** Claim, three heartbeats (two with notes), two comments around a submission, then acceptance: the c1 story. */
function fullStory(rigged: Rig): ClaimResultView {
  const { ctx, desktop } = rigged
  comment(desktop, rigged, 1, 'Before the claim: not part of the attempt.')
  tick(ctx)
  const claimed = claim(ctx, rigged.runId, 1, {
    worker: { label: 'impl-1', modelId: 'model-a', hostId: 'host-a', effort: 'medium', rationale: 'small change' }
  })
  tick(ctx)
  beat(rigged, claimed)
  tick(ctx)
  beat(rigged, claimed, { note: 'schema is in', step: 'coding' })
  tick(ctx)
  beat(rigged, claimed)
  tick(ctx)
  comment(desktop, rigged, 1, 'Keep the migration reversible.')
  comment(desktop, rigged, 2, 'Another ticket: not part of the attempt.')
  tick(ctx)
  beat(rigged, claimed, { note: 'tests are green', step: 'testing' })
  tick(ctx)
  beat(rigged, claimed)
  tick(ctx)
  submit(rigged, claimed)
  tick(ctx)
  comment(ctx, rigged, 1, 'Reviewing now.')
  tick(ctx)
  acceptAttempt(ctx, { attemptId: claimed.attempt.id, notes: 'Looks right' })
  tick(ctx)
  comment(desktop, rigged, 1, 'After the decision: not part of the attempt.')
  return claimed
}

describe('getAttemptTimeline — what an attempt timeline lists', () => {
  it('lists the claim, notes, comments, submission and decision in time order with the heartbeats collapsed', () => {
    const rigged = rig()
    const claimed = fullStory(rigged)
    const view = timeline(rigged, claimed)
    expect(kinds(view.entries)).toEqual(['claim', 'alive', 'note', 'comment', 'note', 'submitted', 'comment', 'decision'])
    const times = view.entries.map((entry) => Date.parse(entry.at))
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('collapses five heartbeats into one alive span from the first beat to the latest', () => {
    const rigged = rig()
    const claimed = fullStory(rigged)
    const alive = timeline(rigged, claimed).entries.filter((entry) => entry.kind === 'alive')
    expect(alive).toEqual([
      {
        kind: 'alive',
        id: `alive:${claimed.attempt.id}`,
        attemptId: claimed.attempt.id,
        ticketId: tid(1),
        at: '2026-01-01T00:00:20.000Z',
        sessionId: rigged.worker.session.id,
        until: '2026-01-01T00:01:10.000Z',
        leaseExpiresAt: null,
        active: false
      }
    ])
  })

  it('says who took the ticket, with the model, host, effort and rationale', () => {
    const rigged = rig()
    const claimed = fullStory(rigged)
    const [first] = timeline(rigged, claimed).entries
    expect(first).toMatchObject({
      kind: 'claim',
      attemptId: claimed.attempt.id,
      ticketId: tid(1),
      number: 1,
      sessionId: rigged.ctx.session.id,
      worker: { label: 'impl-1', modelId: 'model-a', hostId: 'host-a', effort: 'medium', rationale: 'small change' }
    })
  })

})

describe('getAttemptTimeline — notes, comments, submission, decision and sessions', () => {
  it('carries each note with its step and the session that sent it', () => {
    const rigged = rig()
    const claimed = fullStory(rigged)
    const notes = timeline(rigged, claimed).entries.filter((entry) => entry.kind === 'note')
    expect(notes.map((entry) => entry.kind === 'note' && [entry.text, entry.step, entry.sessionId])).toEqual([
      ['schema is in', 'coding', rigged.worker.session.id],
      ['tests are green', 'testing', rigged.worker.session.id]
    ])
  })

  it('lists only comments on the attempt ticket made while the attempt was open', () => {
    const rigged = rig()
    const claimed = fullStory(rigged)
    const comments = timeline(rigged, claimed).entries.filter((entry) => entry.kind === 'comment')
    expect(comments.map((entry) => entry.kind === 'comment' && [entry.body, entry.author])).toEqual([
      ['Keep the migration reversible.', { role: 'desktop', label: 'test desktop' }],
      ['Reviewing now.', { role: 'orchestrator', label: 'test orchestrator' }]
    ])
  })

  it('shows the submission summary and the review decision', () => {
    const rigged = rig()
    const claimed = fullStory(rigged)
    const entries = timeline(rigged, claimed).entries
    expect(entries.find((entry) => entry.kind === 'submitted')).toMatchObject({ summary: 'Added the schema' })
    expect(entries.find((entry) => entry.kind === 'decision')).toMatchObject({
      outcome: 'accepted',
      notes: 'Looks right',
      reasons: [],
      decidedBy: 'test orchestrator',
      sessionId: rigged.ctx.session.id
    })
  })

  it('names each session once, with its role and label, and falls back for one it does not know', () => {
    const rigged = rig()
    rigged.ctx.db.run("DELETE FROM sessions WHERE role = 'desktop'")
    const claimed = fullStory(rigged)
    const { sessions } = timeline(rigged, claimed)
    expect(sessions).toEqual([
      { id: rigged.ctx.session.id, role: 'orchestrator', label: 'Orchestrator chat' },
      { id: rigged.worker.session.id, role: 'worker', label: 'impl-1 worker' },
      { id: rigged.desktop.session.id, role: null, label: 'Unknown session' }
    ])
  })

})

describe('getAttemptTimeline — retries, failures and expired leases', () => {
  it('keeps a retry separate: the second attempt lists only its own entries and comments', () => {
    const rigged = rig()
    const { ctx, desktop } = rigged
    const first = claim(ctx, rigged.runId, 1)
    beat(rigged, first, { note: 'first try' })
    submit(rigged, first)
    rejectAttempt(ctx, { attemptId: first.attempt.id, reasons: ['tests missing'] })
    comment(desktop, rigged, 1, 'Between the attempts.')
    const second = claim(ctx, rigged.runId, 1)
    beat(rigged, second, { note: 'second try' })
    comment(desktop, rigged, 1, 'During the second.')
    expect(kinds(timeline(rigged, first).entries)).toEqual(['claim', 'alive', 'note', 'submitted', 'decision'])
    expect(timeline(rigged, first).entries.at(-1)).toMatchObject({ kind: 'decision', outcome: 'rejected', reasons: ['tests missing'] })
    expect(kinds(timeline(rigged, second).entries)).toEqual(['claim', 'alive', 'note', 'comment'])
  })

  it('records a failure with its reason and whether it can be retried', () => {
    const rigged = rig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    beat(rigged, claimed)
    failAttempt(rigged.worker, {
      attemptId: claimed.attempt.id,
      claimToken: claimed.packet.claimToken,
      failure: { reason: 'cannot reach the registry', retryable: false }
    })
    const view = timeline(rigged, claimed)
    expect(view.entries.at(-1)).toMatchObject({ kind: 'failed', reason: 'cannot reach the registry', retryable: false })
    expect(view.isLive).toBe(false)
  })

  it('records an expired lease and its reconciliation', () => {
    const rigged = rig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    beat(rigged, claimed)
    tick(rigged.ctx, 3600)
    const expired = timeline(rigged, claimed)
    expect(expired.entries.at(-1)).toMatchObject({ kind: 'lease_expired', cause: 'timeout', leaseExpiresAt: '2026-01-01T00:15:00.000Z' })
    expect([expired.state, expired.isLive]).toEqual(['lease_expired', false])
    reconcileAttempt(rigged.ctx, { attemptId: claimed.attempt.id, resolution: 'abandon' })
    expect(kinds(timeline(rigged, claimed).entries)).toEqual(['claim', 'alive', 'lease_expired', 'reconciled'])
    expect(timeline(rigged, claimed).entries.at(-1)).toMatchObject({ kind: 'reconciled', resolution: 'abandon' })
  })

})

describe('getAttemptTimeline — the end of the run, takeover and unknown attempts', () => {
  it('records that the run ended under an open attempt', () => {
    const rigged = rig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    cancelRun(rigged.desktop, { runId: rigged.runId, reason: 'wrong plan' })
    const view = timeline(rigged, claimed)
    expect(view.entries.at(-1)).toMatchObject({ kind: 'canceled', reason: 'wrong plan', sessionId: rigged.desktop.session.id })
    expect(view.isLive).toBe(false)
  })

  it('records that a takeover expired the lease', () => {
    const rigged = rig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    beat(rigged, claimed)
    takeoverRun({ ...rigged.ctx, machineId: 'mc_other' }, { runId: rigged.runId })
    expect(timeline(rigged, claimed).entries.at(-1)).toMatchObject({ kind: 'lease_expired', cause: 'takeover', leaseExpiresAt: null })
  })

  it('is not widened by a takeover or a cancel that did not touch the attempt', () => {
    const rigged = rig()
    const other = { ...rigged.ctx, machineId: 'mc_other' }
    takeoverRun(other, { runId: rigged.runId })
    resumeRun(other, { runId: rigged.runId })
    comment(rigged.desktop, rigged, 1, 'After the takeover, before the claim.')
    tick(rigged.ctx)
    const claimed = claim(other, rigged.runId, 1)
    tick(rigged.ctx)
    comment(rigged.desktop, rigged, 1, 'During the attempt.')
    const bodies = timeline(rigged, claimed).entries.map((entry) => entry.kind === 'comment' && entry.body)
    expect(bodies.filter(Boolean)).toEqual(['During the attempt.'])
    expect(kinds(timeline(rigged, claimed).entries)).toEqual(['claim', 'comment'])
  })

  it('refuses an attempt it does not know', () => {
    const rigged = rig()
    expect(errorCode(() => getAttemptTimeline(rigged.ctx, { attemptId: 'at_00000000000000000000000099' }))).toBe('not_found')
  })
})

describe('getAttemptTimeline — isLive', () => {
  it('is true from the claim through the review and false once the decision is made', () => {
    const rigged = rig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    const states: Array<[string, boolean]> = []
    const note = (): void => {
      const view = timeline(rigged, claimed)
      states.push([view.state, view.isLive])
    }
    note()
    beat(rigged, claimed)
    note()
    submit(rigged, claimed)
    note()
    acceptAttempt(rigged.ctx, { attemptId: claimed.attempt.id })
    note()
    expect(states).toEqual([
      ['claimed', true],
      ['running', true],
      ['submitted', true],
      ['accepted', false]
    ])
  })
})

describe('getAttemptTimeline — claim tokens', () => {
  it('never carries the stored claim secret, and masks a token pasted into any text it shows', () => {
    const rigged = rig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    const own = claimed.packet.claimToken
    beat(rigged, claimed, { note: `holding ${own}` })
    comment(rigged.desktop, rigged, 1, `pasted ${TOKEN_LOOKALIKE} by mistake`)
    submit(rigged, claimed, `done, token was ${TOKEN_LOOKALIKE}`)
    const text = JSON.stringify(timeline(rigged, claimed))
    expect(text).not.toContain('secret-')
    expect(text).not.toContain(TOKEN_LOOKALIKE)
    expect(text).not.toContain(TOKEN_LOOKALIKE.split('.')[1])
    expect(text).toContain('pasted [claim token masked] by mistake')
    expect(text).toContain('done, token was [claim token masked]')
  })
})

describe('getAttemptTimeline — polling with the cursor', () => {
  it('returns the whole history for a first poll and the log head as the cursor', () => {
    const rigged = rig()
    const claimed = fullStory(rigged)
    const head = rigged.ctx.db.get<{ seq: number }>('SELECT MAX(seq) AS seq FROM events')?.seq
    const view = timeline(rigged, claimed)
    expect([view.entries.length, view.cursor]).toEqual([8, head])
  })

  it('returns nothing new when nothing happened and the attempt holds no lease', () => {
    const rigged = rig()
    const claimed = fullStory(rigged)
    const first = timeline(rigged, claimed)
    const again = timeline(rigged, claimed, { sinceSeq: first.cursor })
    expect(again).toMatchObject({ entries: [], cursor: first.cursor, isLive: false })
  })

  it('returns only the entries that arrived after the cursor', () => {
    const rigged = rig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    beat(rigged, claimed, { note: 'one' })
    const first = timeline(rigged, claimed)
    tick(rigged.ctx)
    comment(rigged.desktop, rigged, 1, 'a question')
    beat(rigged, claimed, { note: 'two' })
    const next = timeline(rigged, claimed, { sinceSeq: first.cursor })
    expect(next.entries.filter((entry) => entry.kind !== 'alive').map((entry) => entry.kind)).toEqual(['comment', 'note'])
    expect(next.entries.filter((entry) => entry.kind === 'note').map((entry) => entry.kind === 'note' && entry.text)).toEqual(['two'])
    expect(next.cursor).toBeGreaterThan(first.cursor)
    expect(timeline(rigged, claimed, { sinceSeq: next.cursor }).entries.map((entry) => entry.kind)).toEqual(['alive'])
  })

})

describe('getAttemptTimeline — the growing alive span and paging', () => {
  it('re-sends the growing alive span by id while the attempt holds a lease, even with nothing else new', () => {
    const rigged = rig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    tick(rigged.ctx)
    beat(rigged, claimed)
    const first = timeline(rigged, claimed)
    const span = first.entries.find((entry) => entry.kind === 'alive')
    tick(rigged.ctx, 120)
    beat(rigged, claimed)
    const next = timeline(rigged, claimed, { sinceSeq: first.cursor })
    expect(next.cursor).toBe(first.cursor)
    expect(next.entries).toHaveLength(1)
    expect(next.entries[0]).toMatchObject({ kind: 'alive', id: span?.id, at: span?.at, until: '2026-01-01T00:02:10.000Z', active: true })
    expect(span).toMatchObject({ until: '2026-01-01T00:00:10.000Z' })
  })

  it('sends the final span again when the attempt closed between two polls', () => {
    const rigged = rig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    tick(rigged.ctx)
    beat(rigged, claimed)
    const first = timeline(rigged, claimed)
    tick(rigged.ctx, 90)
    beat(rigged, claimed)
    tick(rigged.ctx)
    submit(rigged, claimed)
    acceptAttempt(rigged.ctx, { attemptId: claimed.attempt.id })
    const next = timeline(rigged, claimed, { sinceSeq: first.cursor })
    expect(kinds(next.entries)).toEqual(['alive', 'submitted', 'decision'])
    expect(next.entries[0]).toMatchObject({ kind: 'alive', until: '2026-01-01T00:01:40.000Z', active: false })
    expect(next.isLive).toBe(false)
  })

})

describe('getAttemptTimeline — paging', () => {
  it('pages with a limit and a cursor without repeating or skipping an entry', () => {
    const rigged = rig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    for (const note of ['n1', 'n2', 'n3', 'n4', 'n5']) {
      tick(rigged.ctx)
      beat(rigged, claimed, { note })
    }
    const seen: string[] = []
    let cursor = 0
    for (let page = 0; page < 10; page += 1) {
      const view = timeline(rigged, claimed, { sinceSeq: cursor, limit: 2 })
      const fresh = view.entries.filter((entry) => entry.kind !== 'alive')
      if (fresh.length === 0) {
        break
      }
      seen.push(...fresh.map((entry) => entry.id))
      cursor = view.cursor
    }
    const whole = timeline(rigged, claimed).entries.filter((entry) => entry.kind !== 'alive').map((entry) => entry.id)
    expect(seen).toEqual(whole)
    expect(new Set(seen).size).toBe(seen.length)
    expect(whole).toHaveLength(6)
  })

  it('never moves the cursor back when the client is ahead of the log', () => {
    const rigged = rig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    expect(timeline(rigged, claimed, { sinceSeq: 9999 })).toMatchObject({ entries: [], cursor: 9999 })
  })
})

function runRig(): { rigged: Rig; sprints: ReturnType<typeof makeBundle> } {
  const ctx = createTestCtx()
  registerSessions(ctx, { orchestrator: 'Orchestrator chat', worker: 'impl-1 worker', desktop: 'Desktop app' })
  const bundle = makeBundle([[1, 2], [3]])
  const { epicId } = seedEpic(ctx, { bundle })
  const desktop = withRole(ctx, 'desktop')
  const run = queueRun(desktop, { epicId })
  tick(ctx)
  startRun(ctx, { epicId })
  return { rigged: { ctx, worker: withRole(ctx, 'worker'), desktop, runId: run.id, epicId }, sprints: bundle }
}

/** The orchestrator's afternoon: two tickets (one rejected once), a pause, the sprint report and the checkpoint. */
function runStory(rigged: Rig): void {
  const { ctx, desktop } = rigged
  tick(ctx)
  const first = claim(ctx, rigged.runId, 1)
  tick(ctx)
  submit(rigged, first, 'one')
  acceptAttempt(ctx, { attemptId: first.attempt.id })
  const second = claim(ctx, rigged.runId, 2)
  submit(rigged, second, 'two')
  rejectAttempt(ctx, { attemptId: second.attempt.id, reasons: ['no tests'] })
  tick(ctx)
  pauseRun(desktop, { runId: rigged.runId, reason: 'lunch' })
  tick(ctx)
  resumeRun(desktop, { runId: rigged.runId })
  const retry = claim(ctx, rigged.runId, 2)
  submit(rigged, retry, 'two again')
  acceptAttempt(ctx, { attemptId: retry.attempt.id })
  tick(ctx)
  const report = submitSprintReport(ctx, { runId: rigged.runId, sprintId: sid(1), report: { summary: 'Sprint one done.' } })
  tick(ctx)
  approveCheckpoint(desktop, { runId: rigged.runId, reportId: report.id })
  tick(ctx)
  advanceSprint(ctx, { runId: rigged.runId })
}

function groupKinds(view: RunTimelineView): Array<[string, string[]]> {
  return view.groups.map((group) => [group.session.label, kinds(group.entries)])
}

describe('getRunTimeline — what a run timeline lists', () => {
  it('groups the actions by the session that did them, in the order the sessions first acted', () => {
    const { rigged } = runRig()
    runStory(rigged)
    const view = getRunTimeline(rigged.ctx, { runId: rigged.runId })
    expect(groupKinds(view)).toEqual([
      ['Desktop app', ['run', 'run', 'run', 'checkpoint']],
      ['Orchestrator chat', ['run', 'claim', 'decision', 'claim', 'decision', 'claim', 'decision', 'report', 'checkpoint']],
      ['impl-1 worker', ['submitted', 'submitted', 'submitted']]
    ])
    expect(view.groups.map((group) => group.session)).toEqual([
      { id: rigged.desktop.session.id, role: 'desktop', label: 'Desktop app' },
      { id: rigged.ctx.session.id, role: 'orchestrator', label: 'Orchestrator chat' },
      { id: rigged.worker.session.id, role: 'worker', label: 'impl-1 worker' }
    ])
  })

  it('shows what each run, review, report and checkpoint entry was about', () => {
    const { rigged } = runRig()
    runStory(rigged)
    const groups = getRunTimeline(rigged.ctx, { runId: rigged.runId }).groups
    const [desktop, orchestrator] = groups
    expect(desktop?.entries.map((entry) => entry.kind === 'run' && entry.change)).toEqual(['queued', 'paused', 'resumed', false])
    expect(desktop?.entries[1]).toMatchObject({ kind: 'run', change: 'paused', reason: 'lunch' })
    expect(desktop?.entries[3]).toMatchObject({ kind: 'checkpoint', step: 'approved', sprintId: sid(1), toSprintId: null })
    expect(orchestrator?.entries[0]).toMatchObject({ kind: 'run', change: 'started', reason: null })
    expect(orchestrator?.entries[1]).toMatchObject({ kind: 'claim', ticketId: tid(1), number: 1, worker: { label: 'worker-1' } })
    expect(orchestrator?.entries[4]).toMatchObject({ kind: 'decision', ticketId: tid(2), outcome: 'rejected', reasons: ['no tests'] })
    expect(orchestrator?.entries[7]).toMatchObject({ kind: 'report', sprintId: sid(1), reportRevision: 1 })
    expect(orchestrator?.entries[8]).toMatchObject({ kind: 'checkpoint', step: 'advanced', sprintId: sid(1), toSprintId: sid(2), policy: 'human' })
  })

  it('keeps each group time-ordered and leaves heartbeats and notes to the attempt timeline', () => {
    const { rigged } = runRig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    beat(rigged, claimed, { note: 'busy' })
    const view = getRunTimeline(rigged.ctx, { runId: rigged.runId })
    const entries = view.groups.flatMap((group) => group.entries)
    expect(kinds(entries)).not.toContain('note')
    expect(kinds(entries)).not.toContain('alive')
    for (const group of view.groups) {
      const times = group.entries.map((entry) => Date.parse(entry.at))
      expect([...times].sort((a, b) => a - b)).toEqual(times)
    }
  })

})

describe('getRunTimeline — lease trouble and the end of the run', () => {
  it('records lease trouble, takeover and the end of the run', () => {
    const { rigged } = runRig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    beat(rigged, claimed)
    tick(rigged.ctx, 3600)
    reconcileAttempt(rigged.ctx, { attemptId: claimed.attempt.id, resolution: 'abandon' })
    cancelRun(rigged.desktop, { runId: rigged.runId, reason: 'enough' })
    const view = getRunTimeline(rigged.ctx, { runId: rigged.runId })
    const all = view.groups.flatMap((group) => group.entries)
    expect(kinds(all).filter((kind) => kind !== 'run' && kind !== 'claim')).toEqual(['lease_expired', 'reconciled'])
    expect(all.find((entry) => entry.kind === 'run' && entry.change === 'canceled')).toMatchObject({ reason: 'enough' })
    expect(view).toMatchObject({ state: 'canceled', isLive: false })
  })

  it('refuses a run it does not know', () => {
    const { rigged } = runRig()
    expect(errorCode(() => getRunTimeline(rigged.ctx, { runId: 'rn_00000000000000000000000099' }))).toBe('not_found')
  })
})

/** A ticket finished in an earlier run, then carried into a new one by the orchestrator. */
function carriedForward(): { ctx: TestCtx; runId: string; attemptId: string } {
  const ctx = createTestCtx()
  registerSessions(ctx, { orchestrator: 'Orchestrator chat' })
  const { epicId, runId: earlier } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
  completeTicket(ctx, earlier, 1, { summary: 'from run 1' })
  ctx.db.run("UPDATE ticket_status SET status = 'in_progress' WHERE ticket_id = ?", tid(1))
  cancelRun(ctx, { runId: earlier })
  const runId = startRun(ctx, { epicId }).id
  const attemptId = carryForwardTicket(ctx, { runId, ticketId: tid(1), note: 'Unchanged since run 1' }).id
  return { ctx, runId, attemptId }
}

describe('carried-forward tickets', () => {
  it('is the whole story of a carried-forward attempt: one entry with the note, and nothing live', () => {
    const { ctx, attemptId } = carriedForward()
    const view = getAttemptTimeline(ctx, { attemptId })
    expect(view).toMatchObject({ state: 'accepted', isLive: false, sessions: [{ id: ctx.session.id, role: 'orchestrator', label: 'Orchestrator chat' }] })
    expect(view.entries).toEqual([
      {
        kind: 'carried_forward',
        id: expect.stringMatching(/^event:\d+$/),
        at: '2026-01-01T00:00:00.000Z',
        sessionId: ctx.session.id,
        attemptId,
        ticketId: tid(1),
        note: 'Unchanged since run 1'
      }
    ])
  })

  it('lists the carry-forward in the run timeline under the session that did it', () => {
    const { ctx, runId, attemptId } = carriedForward()
    const entries = getRunTimeline(ctx, { runId }).groups.flatMap((group) => group.entries)
    expect(kinds(entries)).toEqual(['run', 'carried_forward'])
    expect(entries[1]).toMatchObject({ kind: 'carried_forward', attemptId, note: 'Unchanged since run 1' })
  })
})

describe('timelines over a log that has lost or never had some of its records', () => {
  it('attributes an event no session wrote to an unknown session, in both timelines', () => {
    const rigged = rig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    beat(rigged, claimed, { note: 'busy' })
    rigged.ctx.db.run("UPDATE events SET session_id = NULL WHERE kind IN ('attempt.progress', 'run.started')")
    const attempt = timeline(rigged, claimed)
    expect(attempt.entries.find((entry) => entry.kind === 'note')).toMatchObject({ sessionId: null })
    expect(attempt.sessions).toContainEqual({ id: null, role: null, label: 'Unknown session' })
    const group = getRunTimeline(rigged.ctx, { runId: rigged.runId }).groups.find((item) => item.session.id === null)
    expect(group?.session).toEqual({ id: null, role: null, label: 'Unknown session' })
    expect(kinds(group?.entries ?? [])).toEqual(['run'])
  })

  it('ends the alive span where it began when the attempt no longer records a heartbeat', () => {
    const rigged = rig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    tick(rigged.ctx)
    beat(rigged, claimed)
    tick(rigged.ctx, 60)
    beat(rigged, claimed)
    expect(timeline(rigged, claimed).entries.find((entry) => entry.kind === 'alive')).toMatchObject({ until: '2026-01-01T00:01:10.000Z' })
    rigged.ctx.db.run('UPDATE attempts SET heartbeat_at = NULL WHERE id = ?', claimed.attempt.id)
    expect(timeline(rigged, claimed).entries.find((entry) => entry.kind === 'alive')).toMatchObject({
      at: '2026-01-01T00:00:10.000Z',
      until: '2026-01-01T00:00:10.000Z'
    })
  })

})

describe('timelines over a log with a comment or an attempt record missing', () => {
  it('skips a comment event whose comment is gone and keeps the others', () => {
    const rigged = rig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    comment(rigged.desktop, rigged, 1, 'Now removed.')
    comment(rigged.desktop, rigged, 1, 'Still here.')
    rigged.ctx.db.run("DELETE FROM comments WHERE body = 'Now removed.'")
    const bodies = timeline(rigged, claimed).entries.map((entry) => entry.kind === 'comment' && entry.body)
    expect(bodies.filter(Boolean)).toEqual(['Still here.'])
  })

  it('shows an attempt with no events of its own as an empty timeline in its current state, open or closed', () => {
    const rigged = rig()
    const open = claim(rigged.ctx, rigged.runId, 1)
    const closed = claim(rigged.ctx, rigged.runId, 2)
    submit(rigged, closed)
    acceptAttempt(rigged.ctx, { attemptId: closed.attempt.id })
    rigged.ctx.db.run("DELETE FROM events WHERE json_extract(payload_json, '$.attemptId') IN (?, ?)", open.attempt.id, closed.attempt.id)
    expect(timeline(rigged, open)).toMatchObject({ attemptId: open.attempt.id, state: 'claimed', isLive: true, entries: [], sessions: [] })
    expect(timeline(rigged, closed)).toMatchObject({ attemptId: closed.attempt.id, state: 'accepted', isLive: false, entries: [], sessions: [] })
  })

  it('leaves an attempt event out of the run timeline when the run no longer has that attempt', () => {
    const rigged = rig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    expect(kinds(getRunTimeline(rigged.ctx, { runId: rigged.runId }).groups.flatMap((group) => group.entries))).toEqual(['run', 'claim'])
    rigged.ctx.db.run('DELETE FROM attempts WHERE id = ?', claimed.attempt.id)
    expect(kinds(getRunTimeline(rigged.ctx, { runId: rigged.runId }).groups.flatMap((group) => group.entries))).toEqual(['run'])
  })
})

describe('getRunTimeline — isLive', () => {
  it('is true while the run is active, paused included, and false once it ended', () => {
    const { rigged } = runRig()
    const read = (): [string, boolean] => {
      const view = getRunTimeline(rigged.ctx, { runId: rigged.runId })
      return [view.state, view.isLive]
    }
    const seen = [read()]
    pauseRun(rigged.desktop, { runId: rigged.runId })
    seen.push(read())
    resumeRun(rigged.ctx, { runId: rigged.runId })
    cancelRun(rigged.desktop, { runId: rigged.runId })
    seen.push(read())
    expect(seen).toEqual([
      ['running', true],
      ['paused', true],
      ['canceled', false]
    ])
  })
})

describe('getRunTimeline — polling with the cursor', () => {
  it('returns only what happened after the cursor, still grouped by session', () => {
    const { rigged } = runRig()
    const claimed = claim(rigged.ctx, rigged.runId, 1)
    const first = getRunTimeline(rigged.ctx, { runId: rigged.runId })
    expect(groupKinds(first)).toEqual([
      ['Desktop app', ['run']],
      ['Orchestrator chat', ['run', 'claim']]
    ])
    tick(rigged.ctx)
    pauseRun(rigged.desktop, { runId: rigged.runId, reason: 'break' })
    submit(rigged, claimed)
    const next = getRunTimeline(rigged.ctx, { runId: rigged.runId, sinceSeq: first.cursor })
    expect(groupKinds(next)).toEqual([
      ['Desktop app', ['run']],
      ['impl-1 worker', ['submitted']]
    ])
    expect(next.cursor).toBeGreaterThan(first.cursor)
    const idle = getRunTimeline(rigged.ctx, { runId: rigged.runId, sinceSeq: next.cursor })
    expect(idle).toMatchObject({ groups: [], cursor: next.cursor, isLive: true })
  })

  it('does not return another run or another epic events', () => {
    const { rigged } = runRig()
    const other = startedRun(rigged.ctx, { bundle: makeBundle([[11, 12]]) })
    expect(other.runId).not.toBe(rigged.runId)
    const view = getRunTimeline(rigged.ctx, { runId: rigged.runId })
    expect(view.groups.flatMap((group) => group.entries).every((entry) => entry.id.startsWith('event:'))).toBe(true)
    expect(kinds(view.groups.flatMap((group) => group.entries))).toEqual(['run', 'run'])
  })

  it('pages with a limit without repeating or skipping an entry', () => {
    const { rigged } = runRig()
    runStory(rigged)
    const whole = getRunTimeline(rigged.ctx, { runId: rigged.runId }).groups.flatMap((group) => group.entries.map((entry) => entry.id))
    const seen: string[] = []
    let cursor = 0
    for (let page = 0; page < 40; page += 1) {
      const view = getRunTimeline(rigged.ctx, { runId: rigged.runId, sinceSeq: cursor, limit: 3 })
      const ids = view.groups.flatMap((group) => group.entries.map((entry) => entry.id))
      seen.push(...ids)
      cursor = view.cursor
      if (ids.length < 3) {
        break
      }
    }
    expect([...seen].sort()).toEqual([...whole].sort())
    expect(new Set(seen).size).toBe(whole.length)
  })
})
