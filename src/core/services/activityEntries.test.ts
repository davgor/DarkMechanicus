import { describe, expect, it } from 'vitest'
import type { AttemptView, EventView } from '../../shared/domain/views'
import { ATTEMPT_ONLY_BODIES, entryOf, LIFECYCLE_BODIES, RUN_BODIES, text, texts } from './activityEntries'

function event(kind: string, payload: Record<string, unknown> = {}, patch: Partial<EventView> = {}): EventView {
  return {
    seq: 7,
    at: '2026-01-01T00:00:07.000Z',
    kind,
    epicId: 'ep_1',
    runId: 'rn_1',
    ticketId: 'tk_1',
    sessionId: 'ss_1',
    payload,
    ...patch
  }
}

function attempt(patch: Partial<AttemptView> = {}): AttemptView {
  return {
    id: 'at_1',
    runId: 'rn_1',
    ticketId: 'tk_1',
    number: 2,
    kind: 'work',
    state: 'claimed',
    fencingToken: 1,
    worker: { sessionId: 'ss_w', label: 'impl-1', modelId: 'model-a', hostId: 'host-a', catalogRevision: null, rationale: 'small change', effort: 'medium' },
    revisionId: 'rv_1',
    ticketContentHash: 'hash',
    leaseExpiresAt: null,
    heartbeatAt: null,
    outputs: null,
    evidence: null,
    failure: null,
    decision: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    submittedAt: null,
    decidedAt: null,
    reconciledAt: null,
    superseded: false,
    ...patch
  }
}

function lifecycle(kind: string, payload: Record<string, unknown>, held: AttemptView = attempt()) {
  const build = LIFECYCLE_BODIES[kind]
  if (build === undefined) {
    throw new Error(`no lifecycle body for ${kind}`)
  }
  return build(event(kind, payload), held)
}

function attemptOnly(kind: string, payload: Record<string, unknown>, held: AttemptView = attempt()) {
  const build = ATTEMPT_ONLY_BODIES[kind]
  if (build === undefined) {
    throw new Error(`no attempt body for ${kind}`)
  }
  return build(event(kind, payload), held)
}

function runBody(kind: string, payload: Record<string, unknown> = {}) {
  const build = RUN_BODIES[kind]
  if (build === undefined) {
    throw new Error(`no run body for ${kind}`)
  }
  return build(event(kind, payload))
}

describe('entryOf', () => {
  it('gives a body the id, time and session of the event it came from', () => {
    const entry = entryOf(event('run.started', {}, { seq: 41, at: '2026-02-03T04:05:06.000Z', sessionId: null }), {
      kind: 'run',
      change: 'started',
      reason: null
    })
    expect(entry).toEqual({ id: 'event:41', at: '2026-02-03T04:05:06.000Z', sessionId: null, kind: 'run', change: 'started', reason: null })
  })
})

describe('text and texts', () => {
  it('keep strings and drop everything else', () => {
    expect([text('a'), text(''), text(3), text(null), text(undefined), text(['a'])]).toEqual(['a', '', null, null, null, null])
    expect(texts(['a', 3, 'b', null, {}, ''])).toEqual(['a', 'b', ''])
    expect([texts('a'), texts(undefined), texts({ 0: 'a' })]).toEqual([[], [], []])
  })
})

describe('LIFECYCLE_BODIES — what each lifecycle event says', () => {
  it('lists exactly the lifecycle events of an attempt', () => {
    expect(Object.keys(LIFECYCLE_BODIES).sort()).toEqual([
      'attempt.accepted',
      'attempt.carried_forward',
      'attempt.claimed',
      'attempt.failed',
      'attempt.lease_expired',
      'attempt.reconciled',
      'attempt.rejected',
      'attempt.submitted'
    ])
  })

  it('names the worker of a claim, with the effort when one was dispatched', () => {
    expect(lifecycle('attempt.claimed', {})).toEqual({
      kind: 'claim',
      attemptId: 'at_1',
      ticketId: 'tk_1',
      number: 2,
      worker: { label: 'impl-1', modelId: 'model-a', hostId: 'host-a', effort: 'medium', rationale: 'small change' }
    })
  })

  it('records no effort for a worker stored before efforts existed', () => {
    const legacy = attempt({ worker: { sessionId: null, label: 'old', modelId: null, hostId: null, catalogRevision: null, rationale: null } })
    expect(lifecycle('attempt.claimed', {}, legacy)).toMatchObject({
      worker: { label: 'old', modelId: null, hostId: null, effort: null, rationale: null }
    })
  })

  it('carries the note of a carried-forward ticket, and an empty note when the event has none', () => {
    expect(lifecycle('attempt.carried_forward', { note: 'Unchanged since run 1' })).toEqual({
      kind: 'carried_forward',
      attemptId: 'at_1',
      ticketId: 'tk_1',
      note: 'Unchanged since run 1'
    })
    expect(lifecycle('attempt.carried_forward', {})).toMatchObject({ note: '' })
    expect(lifecycle('attempt.carried_forward', { note: 12 })).toMatchObject({ note: '' })
  })

})

describe('LIFECYCLE_BODIES — submissions, decisions and failures', () => {
  it('shows the summary of what was submitted, or an empty one when the attempt holds no outputs', () => {
    const outputs = { summary: 'Added the schema', artifacts: [], commits: [], changedFiles: [], branch: null }
    expect(lifecycle('attempt.submitted', {}, attempt({ outputs }))).toMatchObject({ kind: 'submitted', summary: 'Added the schema' })
    expect(lifecycle('attempt.submitted', {}, attempt({ outputs: null }))).toMatchObject({ kind: 'submitted', summary: '' })
  })

  it('takes a decision from the attempt, whichever way it went', () => {
    const decision = { outcome: 'rejected' as const, notes: 'Try again', reasons: ['no tests', 'no lint'], decidedBy: 'reviewer-1' }
    const held = attempt({ state: 'rejected', decision })
    expect(lifecycle('attempt.rejected', { reasons: ['ignored'] }, held)).toEqual({
      kind: 'decision',
      attemptId: 'at_1',
      ticketId: 'tk_1',
      outcome: 'rejected',
      reasons: ['no tests', 'no lint'],
      notes: 'Try again',
      decidedBy: 'reviewer-1'
    })
    expect(lifecycle('attempt.accepted', {}, attempt({ state: 'accepted', decision: { ...decision, outcome: 'accepted', reasons: [] } }))).toMatchObject({
      outcome: 'accepted',
      reasons: [],
      notes: 'Try again',
      decidedBy: 'reviewer-1'
    })
  })

  it('falls back to the reasons the event logged when the attempt holds no decision', () => {
    expect(lifecycle('attempt.rejected', { reasons: ['c2 unmet', 7, 'c3 unmet'] })).toMatchObject({
      outcome: 'rejected',
      reasons: ['c2 unmet', 'c3 unmet'],
      notes: '',
      decidedBy: ''
    })
    expect(lifecycle('attempt.accepted', {})).toMatchObject({ outcome: 'accepted', reasons: [], notes: '', decidedBy: '' })
  })

  it('records why an attempt failed: the event reason first, then the attempt failure, then nothing', () => {
    const failure = { reason: 'cannot reach the registry', details: '', retryable: false }
    expect(lifecycle('attempt.failed', { reason: 'from the event' }, attempt({ failure }))).toMatchObject({
      kind: 'failed',
      reason: 'from the event',
      retryable: false
    })
    expect(lifecycle('attempt.failed', {}, attempt({ failure }))).toMatchObject({ reason: 'cannot reach the registry', retryable: false })
    expect(lifecycle('attempt.failed', {})).toMatchObject({ reason: '', retryable: true })
  })

  it('treats a failure as retryable unless the attempt says it is not', () => {
    const retryable = { reason: 'flaky', details: '', retryable: true }
    expect(lifecycle('attempt.failed', {}, attempt({ failure: retryable }))).toMatchObject({ retryable: true })
  })

})

describe('LIFECYCLE_BODIES — lease trouble and reconciliation', () => {
  it('says a lease timed out, and when it was due, if the event knows', () => {
    expect(lifecycle('attempt.lease_expired', { leaseExpiresAt: '2026-01-01T00:15:00.000Z' })).toEqual({
      kind: 'lease_expired',
      attemptId: 'at_1',
      ticketId: 'tk_1',
      cause: 'timeout',
      leaseExpiresAt: '2026-01-01T00:15:00.000Z'
    })
    expect(lifecycle('attempt.lease_expired', {})).toMatchObject({ cause: 'timeout', leaseExpiresAt: null })
  })

  it('reads a reconciliation as resubmit only when the event says so', () => {
    expect(lifecycle('attempt.reconciled', { resolution: 'resubmit' })).toMatchObject({ kind: 'reconciled', resolution: 'resubmit' })
    expect(lifecycle('attempt.reconciled', { resolution: 'abandon' })).toMatchObject({ resolution: 'abandon' })
    expect(lifecycle('attempt.reconciled', {})).toMatchObject({ resolution: 'abandon' })
    expect(lifecycle('attempt.reconciled', { resolution: 'something else' })).toMatchObject({ resolution: 'abandon' })
  })
})

describe('ATTEMPT_ONLY_BODIES — notes and the run events that closed the attempt', () => {
  it('lists the progress note and the three run events that can end an attempt', () => {
    expect(Object.keys(ATTEMPT_ONLY_BODIES).sort()).toEqual(['attempt.progress', 'run.canceled', 'run.failed', 'run.taken_over'])
  })

  it('turns a progress note into a note with its step, leaving both empty when the event has none', () => {
    expect(attemptOnly('attempt.progress', { note: 'schema is in', step: 'coding' })).toEqual({
      kind: 'note',
      attemptId: 'at_1',
      ticketId: 'tk_1',
      text: 'schema is in',
      step: 'coding'
    })
    expect(attemptOnly('attempt.progress', { note: 'no step' })).toMatchObject({ text: 'no step', step: null })
    expect(attemptOnly('attempt.progress', { step: 'testing' })).toMatchObject({ text: '', step: 'testing' })
    expect(attemptOnly('attempt.progress', {})).toMatchObject({ text: '', step: null })
  })

  it.each(['run.canceled', 'run.failed'])('%s ends only the attempts it lists, with its reason when it gave one', (kind) => {
    expect(attemptOnly(kind, { canceledAttempts: ['at_9', 'at_1'], reason: 'wrong plan' })).toEqual({
      kind: 'canceled',
      attemptId: 'at_1',
      ticketId: 'tk_1',
      reason: 'wrong plan'
    })
    expect(attemptOnly(kind, { canceledAttempts: ['at_1'] })).toMatchObject({ kind: 'canceled', reason: null })
    expect(attemptOnly(kind, { canceledAttempts: ['at_9'], reason: 'wrong plan' })).toBeNull()
    expect(attemptOnly(kind, { reason: 'wrong plan' })).toBeNull()
  })

  it('has a takeover expire only the attempts it lists', () => {
    expect(attemptOnly('run.taken_over', { expiredAttempts: ['at_1'] })).toEqual({
      kind: 'lease_expired',
      attemptId: 'at_1',
      ticketId: 'tk_1',
      cause: 'takeover',
      leaseExpiresAt: null
    })
    expect(attemptOnly('run.taken_over', { expiredAttempts: ['at_9'] })).toBeNull()
    expect(attemptOnly('run.taken_over', {})).toBeNull()
  })
})

describe('RUN_BODIES — what the run itself did', () => {
  it('lists the run events, the report and the two checkpoint steps', () => {
    expect(Object.keys(RUN_BODIES).sort()).toEqual([
      'checkpoint.advanced',
      'checkpoint.approved',
      'report.submitted',
      'run.canceled',
      'run.completed',
      'run.failed',
      'run.leases_extended',
      'run.paused',
      'run.queued',
      'run.resumed',
      'run.started',
      'run.taken_over'
    ])
  })

  it.each([
    ['run.queued', 'queued'],
    ['run.started', 'started'],
    ['run.resumed', 'resumed'],
    ['run.leases_extended', 'leases_extended'],
    ['run.completed', 'completed'],
    ['run.taken_over', 'taken_over']
  ])('%s is a %s change that never shows a reason, even when the event carries one', (kind, change) => {
    expect(runBody(kind, { reason: 'ignored' })).toEqual({ kind: 'run', change, reason: null })
  })

  it.each([
    ['run.paused', 'paused'],
    ['run.canceled', 'canceled'],
    ['run.failed', 'failed']
  ])('%s is a %s change that shows the reason the event gave, or none', (kind, change) => {
    expect(runBody(kind, { reason: 'lunch' })).toEqual({ kind: 'run', change, reason: 'lunch' })
    expect(runBody(kind, {})).toEqual({ kind: 'run', change, reason: null })
    expect(runBody(kind, { reason: 4 })).toEqual({ kind: 'run', change, reason: null })
  })

})

describe('RUN_BODIES — reports and checkpoints', () => {
  it('says which sprint a report was filed for and its revision, with an empty sprint and revision 0 when the event omits them', () => {
    expect(runBody('report.submitted', { sprintId: 'sp_1', reportRevision: 3 })).toEqual({ kind: 'report', sprintId: 'sp_1', reportRevision: 3 })
    expect(runBody('report.submitted', {})).toEqual({ kind: 'report', sprintId: '', reportRevision: 0 })
    expect(runBody('report.submitted', { sprintId: 4, reportRevision: '3' })).toEqual({ kind: 'report', sprintId: '', reportRevision: 0 })
  })

  it('records an approval for its sprint, with no sprint to move to and no policy', () => {
    expect(runBody('checkpoint.approved', { sprintId: 'sp_1', policy: 'auto' })).toEqual({
      kind: 'checkpoint',
      step: 'approved',
      sprintId: 'sp_1',
      toSprintId: null,
      policy: null
    })
    expect(runBody('checkpoint.approved', {})).toMatchObject({ sprintId: '' })
  })

  it('records an advance from one sprint to the next under the policy that allowed it', () => {
    expect(runBody('checkpoint.advanced', { fromSprintId: 'sp_1', toSprintId: 'sp_2', policy: 'auto' })).toEqual({
      kind: 'checkpoint',
      step: 'advanced',
      sprintId: 'sp_1',
      toSprintId: 'sp_2',
      policy: 'auto'
    })
    expect(runBody('checkpoint.advanced', { fromSprintId: 'sp_1', toSprintId: 'sp_2', policy: 'human' })).toMatchObject({ policy: 'human' })
  })

  it('leaves out a policy it does not know and the sprints an advance does not name', () => {
    expect(runBody('checkpoint.advanced', { fromSprintId: 'sp_1', toSprintId: 'sp_2', policy: 'robot' })).toMatchObject({ policy: null })
    expect(runBody('checkpoint.advanced', {})).toEqual({ kind: 'checkpoint', step: 'advanced', sprintId: '', toSprintId: null, policy: null })
  })
})
