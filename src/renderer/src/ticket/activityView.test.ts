import { describe, expect, it } from 'vitest'
import type { ActivityEntry, AttemptTimelineView } from '../../../shared/domain/activity'
import { activityItems, clockTime, endedSummary, isNearBottom, latestAttemptId } from './activityView'

const BASE = { at: '2026-10-05T14:02:00.000Z', sessionId: 'ss_w', attemptId: 'at_1', ticketId: 'tk_1' }

type Of<K extends ActivityEntry['kind']> = Extract<ActivityEntry, { kind: K }>

function claim(patch: Partial<Of<'claim'>> = {}): ActivityEntry {
  const worker = { label: 'worker-a', modelId: 'model-large', hostId: 'claude-code', effort: 'medium' as const, rationale: 'Best fit' }
  return { ...BASE, kind: 'claim', id: 'claim:at_1', number: 2, worker, ...patch }
}

function alive(patch: Partial<Of<'alive'>> = {}): ActivityEntry {
  return { ...BASE, kind: 'alive', id: 'alive:at_1', until: '2026-10-05T14:20:00.000Z', leaseExpiresAt: null, active: true, ...patch }
}

function note(text: string, patch: Partial<Of<'note'>> = {}): ActivityEntry {
  return { ...BASE, kind: 'note', id: `event:${text}`, text, step: null, ...patch }
}

function describeOne(entry: ActivityEntry) {
  const [item] = activityItems([entry], 'UTC')
  if (item === undefined) {
    throw new Error('no item')
  }
  return item
}

describe('clockTime', () => {
  it('reads as a 24-hour clock in the given zone, and keeps what it cannot read', () => {
    expect(clockTime('2026-10-05T14:02:00.000Z', 'UTC')).toBe('14:02')
    expect(clockTime('2026-10-05T14:02:00.000Z', 'Asia/Tokyo')).toBe('23:02')
    expect(clockTime('2026-10-05T00:05:00.000Z', 'UTC')).toBe('00:05')
    expect(clockTime('soon', 'UTC')).toBe('soon')
  })
})

describe('activityItems', () => {
  it('reads the alive span as one line, from the first heartbeat to the last seen', () => {
    expect(describeOne(alive())).toMatchObject({ title: 'Working since 14:02, last seen 14:20', when: '', tone: 'running' })
    expect(describeOne(alive({ active: false })).title).toBe('Worked from 14:02 to 14:20')
  })

  it('names the claim with its worker, model, effort and reason', () => {
    expect(describeOne(claim())).toMatchObject({
      title: 'Claimed by worker-a',
      detail: 'Attempt #2 · model-large · medium effort\nBest fit',
      when: '14:02'
    })
    const bare = claim({ number: 1, worker: { label: 'w', modelId: null, hostId: null, effort: null, rationale: null } })
    expect(describeOne(bare).detail).toBe('Attempt #1')
  })

  it('keeps note and comment text as given, to be shown as plain text', () => {
    const text = '<img src=x onerror=alert(1)> **not bold**'
    expect(describeOne(note(text, { step: 'build' }))).toMatchObject({ kind: 'note', title: text, detail: 'Step: build' })
    const comment: ActivityEntry = {
      ...BASE,
      kind: 'comment',
      id: 'comment:cm_1',
      commentId: 'cm_1',
      body: text,
      author: { role: 'reviewer', label: 'Reviewer' }
    }
    expect(describeOne(comment)).toMatchObject({ title: 'Reviewer commented', detail: text })
  })

})

describe('activityItems on how an attempt moved on', () => {
  it('describes how the attempt moved on', () => {
    const entries: ActivityEntry[] = [
      { ...BASE, kind: 'submitted', id: 's', summary: 'Added the tab' },
      { ...BASE, kind: 'decision', id: 'd1', outcome: 'rejected', reasons: ['No test', 'No lint'], notes: 'Try again', decidedBy: 'orchestrator' },
      { ...BASE, kind: 'decision', id: 'd2', outcome: 'accepted', reasons: [], notes: '', decidedBy: 'orchestrator' },
      { ...BASE, kind: 'failed', id: 'f', reason: '2 tests failed', retryable: true },
      { ...BASE, kind: 'lease_expired', id: 'l1', cause: 'timeout', leaseExpiresAt: null },
      { ...BASE, kind: 'lease_expired', id: 'l2', cause: 'takeover', leaseExpiresAt: null },
      { ...BASE, kind: 'reconciled', id: 'r', resolution: 'abandon' },
      { ...BASE, kind: 'canceled', id: 'c', reason: 'Run canceled' }
    ]
    expect(activityItems(entries, 'UTC').map((item) => [item.title, item.detail, item.tone])).toEqual([
      ['Submitted for review', 'Added the tab', 'review'],
      ['Rejected by orchestrator', 'No test\nNo lint\nTry again', 'failed'],
      ['Accepted by orchestrator', '', 'accepted'],
      ['Failed, can retry', '2 tests failed', 'failed'],
      ['Lease expired', 'The worker stopped reporting. The attempt needs reconciling.', 'blocked'],
      ['Run moved to another machine', 'The attempt needs reconciling.', 'blocked'],
      ['Reconciled: abandoned', '', 'neutral'],
      ['Canceled with the run', 'Run canceled', 'neutral']
    ])
  })

  it('keeps the order it is given, one item per entry id', () => {
    const items = activityItems([claim(), alive(), note('a'), note('b')], 'UTC')
    expect(items.map((item) => item.id)).toEqual(['claim:at_1', 'alive:at_1', 'event:a', 'event:b'])
  })
})

describe('activityItems on the less common entries', () => {
  it('says a failure that cannot be retried without offering a retry', () => {
    const failed: ActivityEntry = { ...BASE, kind: 'failed', id: 'f', reason: 'registry unreachable', retryable: false }
    expect(describeOne(failed)).toMatchObject({ title: 'Failed', detail: 'registry unreachable', tone: 'failed' })
  })

  it('says whether a reconciled attempt was abandoned or resubmitted', () => {
    const reconciled = (resolution: Of<'reconciled'>['resolution']): ActivityEntry => ({ ...BASE, kind: 'reconciled', id: 'r', resolution })
    expect(describeOne(reconciled('abandon')).title).toBe('Reconciled: abandoned')
    expect(describeOne(reconciled('resubmit')).title).toBe('Reconciled: resubmitted')
  })

  it('keeps the reason a run ended under the attempt, or says nothing more when there is none', () => {
    const canceled = (reason: string | null): ActivityEntry => ({ ...BASE, kind: 'canceled', id: 'c', reason })
    expect(describeOne(canceled('wrong plan'))).toMatchObject({ title: 'Canceled with the run', detail: 'wrong plan' })
    expect(describeOne(canceled(null))).toMatchObject({ title: 'Canceled with the run', detail: '' })
  })

  it('reads a carried-forward ticket with its note', () => {
    const carried: ActivityEntry = { ...BASE, kind: 'carried_forward', id: 'cf', note: 'Unchanged since run 1' }
    expect(describeOne(carried)).toMatchObject({ title: 'Carried forward from an earlier run', detail: 'Unchanged since run 1', tone: 'accepted' })
  })

  it('reads a run change in words, with its reason when it has one', () => {
    const change = (value: Of<'run'>['change'], reason: string | null): ActivityEntry => ({ kind: 'run', id: 'ru', at: BASE.at, sessionId: 'ss_o', change: value, reason })
    expect(describeOne(change('taken_over', null))).toMatchObject({ title: 'Run taken over', detail: '' })
    expect(describeOne(change('leases_extended', null)).title).toBe('Run leases extended')
    expect(describeOne(change('paused', 'lunch'))).toMatchObject({ title: 'Run paused', detail: 'lunch', when: '14:02' })
  })

  it('reads the sprint report and each checkpoint step', () => {
    const base = { at: BASE.at, sessionId: 'ss_o', sprintId: 'sp_1' }
    const report: ActivityEntry = { ...base, kind: 'report', id: 'rp', reportRevision: 2 }
    const checkpoint = (step: Of<'checkpoint'>['step']): ActivityEntry => ({ ...base, kind: 'checkpoint', id: step, step, toSprintId: null, policy: null })
    expect(describeOne(report).title).toBe('Sprint report filed')
    expect(describeOne(checkpoint('approved')).title).toBe('Checkpoint approved')
    expect(describeOne(checkpoint('advanced')).title).toBe('Run advanced to the next sprint')
  })

  it('leaves out a blank rationale and a note without a step', () => {
    const blank = claim({ worker: { label: 'w', modelId: 'm', hostId: null, effort: 'high', rationale: '   ' } })
    expect(describeOne(blank).detail).toBe('Attempt #2 · m · high effort')
    expect(describeOne(note('plain')).detail).toBe('')
  })
})

function view(patch: Partial<AttemptTimelineView> = {}): AttemptTimelineView {
  return { attemptId: 'at_1', runId: 'rn_1', ticketId: 'tk_1', state: 'running', isLive: true, cursor: 3, entries: [], sessions: [], ...patch }
}

describe('endedSummary', () => {
  it('says nothing while the attempt is open', () => {
    expect(endedSummary(view())).toBe(null)
    expect(endedSummary(view({ state: 'submitted' }))).toBe(null)
  })

  it('says how a closed attempt ended, with the reason the record gives', () => {
    const rejected: ActivityEntry = { ...BASE, kind: 'decision', id: 'd', outcome: 'rejected', reasons: ['No test'], notes: '', decidedBy: 'orchestrator' }
    const failed: ActivityEntry = { ...BASE, kind: 'failed', id: 'f', reason: '2 tests failed', retryable: false }
    const canceled: ActivityEntry = { ...BASE, kind: 'canceled', id: 'c', reason: null }
    expect(endedSummary(view({ isLive: false, state: 'rejected', entries: [rejected] }))).toEqual({
      label: 'Rejected',
      tone: 'failed',
      detail: 'Rejected by orchestrator: No test'
    })
    expect(endedSummary(view({ isLive: false, state: 'failed', entries: [failed] }))).toEqual({
      label: 'Failed',
      tone: 'failed',
      detail: '2 tests failed'
    })
    expect(endedSummary(view({ isLive: false, state: 'canceled', entries: [canceled] }))).toEqual({
      label: 'Canceled',
      tone: 'neutral',
      detail: 'The run ended while the attempt was open.'
    })
  })

  it('names an accepted attempt and an expired lease, reconciled or not', () => {
    const accepted: ActivityEntry = { ...BASE, kind: 'decision', id: 'd', outcome: 'accepted', reasons: [], notes: '', decidedBy: 'orchestrator' }
    const expired: ActivityEntry = { ...BASE, kind: 'lease_expired', id: 'l', cause: 'takeover', leaseExpiresAt: null }
    const reconciled: ActivityEntry = { ...BASE, kind: 'reconciled', id: 'r', resolution: 'resubmit' }
    expect(endedSummary(view({ isLive: false, state: 'accepted', entries: [accepted] }))).toEqual({
      label: 'Accepted',
      tone: 'accepted',
      detail: 'Accepted by orchestrator'
    })
    expect(endedSummary(view({ isLive: false, state: 'lease_expired', entries: [expired] }))?.detail).toBe(
      'The run moved to another machine. The attempt needs reconciling.'
    )
    expect(endedSummary(view({ isLive: false, state: 'lease_expired', entries: [expired, reconciled] }))?.detail).toBe(
      'Reconciled: resubmitted'
    )
  })

  it('still names the state when the record has no reason', () => {
    expect(endedSummary(view({ isLive: false, state: 'failed' }))).toEqual({ label: 'Failed', tone: 'failed', detail: '' })
  })

})

describe('endedSummary on how each ending reads', () => {
  it('gives the reason a canceled attempt recorded', () => {
    const canceled: ActivityEntry = { ...BASE, kind: 'canceled', id: 'c', reason: 'wrong plan' }
    expect(endedSummary(view({ isLive: false, state: 'canceled', entries: [canceled] }))?.detail).toBe('wrong plan')
  })

  it('says an accepted or rejected attempt was decided by whom, and leaves the verdict out when it does not match the state', () => {
    const decision = (outcome: Of<'decision'>['outcome'], reasons: string[] = []): ActivityEntry => ({
      ...BASE,
      kind: 'decision',
      id: 'd',
      outcome,
      reasons,
      notes: '',
      decidedBy: 'reviewer'
    })
    expect(endedSummary(view({ isLive: false, state: 'rejected', entries: [decision('rejected', ['No test', 'No lint'])] }))?.detail).toBe(
      'Rejected by reviewer: No test; No lint'
    )
    expect(endedSummary(view({ isLive: false, state: 'rejected', entries: [decision('rejected')] }))?.detail).toBe('Rejected by reviewer')
    expect(endedSummary(view({ isLive: false, state: 'accepted', entries: [decision('rejected')] }))?.detail).toBe('')
    expect(endedSummary(view({ isLive: false, state: 'accepted', entries: [] }))?.detail).toBe('')
  })

  it('uses the latest decision when an attempt was decided more than once', () => {
    const decision = (id: string, decidedBy: string): ActivityEntry => ({ ...BASE, kind: 'decision', id, outcome: 'accepted', reasons: [], notes: '', decidedBy })
    expect(endedSummary(view({ isLive: false, state: 'accepted', entries: [decision('d1', 'first'), decision('d2', 'second')] }))?.detail).toBe(
      'Accepted by second'
    )
  })

  it('explains an expired lease by how it expired, and by its reconciliation when there is one', () => {
    const timeout: ActivityEntry = { ...BASE, kind: 'lease_expired', id: 'l', cause: 'timeout', leaseExpiresAt: null }
    const abandoned: ActivityEntry = { ...BASE, kind: 'reconciled', id: 'r', resolution: 'abandon' }
    const expiredView = (entries: ActivityEntry[]) => endedSummary(view({ isLive: false, state: 'lease_expired', entries }))
    expect(expiredView([timeout])).toEqual({ label: 'Lease expired', tone: 'blocked', detail: 'The worker stopped reporting. The attempt needs reconciling.' })
    expect(expiredView([timeout, abandoned])?.detail).toBe('Reconciled: abandoned')
    expect(expiredView([])?.detail).toBe('')
  })

  it('names the state of a closed view whose state has no recorded ending', () => {
    expect(endedSummary(view({ isLive: false, state: 'submitted' }))).toEqual({ label: 'Submitted', tone: 'review', detail: '' })
  })
})

describe('latestAttemptId', () => {
  const item = (id: string, number: number, superseded = false) => ({ id, number, superseded })

  it('picks the highest-numbered attempt that is still current', () => {
    expect(latestAttemptId([item('a1', 1), item('a3', 3, true), item('a2', 2)])).toBe('a2')
  })

  it('does not depend on the order the attempts are listed in', () => {
    expect(latestAttemptId([item('a3', 3), item('a1', 1), item('a2', 2)])).toBe('a3')
    expect(latestAttemptId([item('a1', 1), item('a2', 2), item('a3', 3)])).toBe('a3')
  })

  it('falls back to the latest of all when every attempt is superseded, and to nothing without attempts', () => {
    expect(latestAttemptId([item('a1', 1, true), item('a2', 2, true)])).toBe('a2')
    expect(latestAttemptId([])).toBe(null)
  })
})

describe('isNearBottom', () => {
  it('follows a log that sits at, or within a few pixels of, its end', () => {
    expect(isNearBottom({ scrollTop: 400, scrollHeight: 600, clientHeight: 200 })).toBe(true)
    expect(isNearBottom({ scrollTop: 380, scrollHeight: 600, clientHeight: 200 })).toBe(true)
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 150, clientHeight: 200 })).toBe(true)
  })

  it('lets go once the person has scrolled up', () => {
    expect(isNearBottom({ scrollTop: 300, scrollHeight: 600, clientHeight: 200 })).toBe(false)
  })
})
