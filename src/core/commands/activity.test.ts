import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import type { Workspace } from '../workspace'

interface Started {
  runId: string
  attemptId: string
  claimToken: string
}

async function startedAttempt(orchestrator: Workspace): Promise<Started> {
  await orchestrator.initializeRepository({ name: 'activity-repo' })
  const epic = await orchestrator.createEpic({ title: 'Activity epic' })
  const draft = await orchestrator.updatePlanDraft({
    epicId: epic.id,
    ops: [{ op: 'add_ticket', ref: 'one', sprint: '1', ticket: { title: 'Only ticket' } }]
  })
  await orchestrator.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  const run = await orchestrator.startRun({ epicId: epic.id })
  const claimed = await orchestrator.claimTicket({
    runId: run.id,
    ticketId: draft.refMap['one'] ?? '',
    worker: { label: 'impl-1' }
  })
  return { runId: run.id, attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken }
}

async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error: unknown) {
    return (error as { code: string }).code
  }
  return 'ok'
}

let harness: Harness

beforeEach(() => {
  harness = createHarness()
})

afterEach(() => {
  harness.cleanup()
})

describe('activity timeline commands', () => {
  it('lets the desktop read an attempt timeline and a run timeline of work an agent did', async () => {
    const orchestrator = harness.open('orchestrator')
    const started = await startedAttempt(orchestrator)
    harness.clock.advanceSeconds(5)
    await harness.open('worker').heartbeatAttempt({
      attemptId: started.attemptId,
      claimToken: started.claimToken,
      progress: { note: 'schema is in', step: 'coding' }
    })
    const desktop = harness.open('desktop')

    const attempt = await desktop.getAttemptTimeline({ attemptId: started.attemptId })
    expect(attempt.isLive).toBe(true)
    expect(attempt.entries.map((entry) => entry.kind)).toEqual(['claim', 'alive', 'note'])
    expect(attempt.sessions.map((session) => [session.role, session.label])).toEqual([
      ['orchestrator', 'orchestrator session'],
      ['worker', 'worker session']
    ])

    const run = await desktop.getRunTimeline({ runId: started.runId })
    expect(run.isLive).toBe(true)
    expect(run.groups.map((group) => [group.session.role, group.entries.map((entry) => entry.kind)])).toEqual([
      ['orchestrator', ['run', 'claim']]
    ])
  })

  it('polls with the cursor each timeline returned', async () => {
    const orchestrator = harness.open('orchestrator')
    const started = await startedAttempt(orchestrator)
    const desktop = harness.open('desktop')
    const attempt = await desktop.getAttemptTimeline({ attemptId: started.attemptId })
    const run = await desktop.getRunTimeline({ runId: started.runId })
    await desktop.addComment({ epicId: (await desktop.getRun({ runId: started.runId }))?.epicId ?? '', body: 'epic note' })
    await orchestrator.pauseRun({ runId: started.runId, reason: 'break' })

    expect(await desktop.getAttemptTimeline({ attemptId: started.attemptId, sinceSeq: attempt.cursor })).toMatchObject({
      entries: [],
      isLive: true
    })
    const next = await desktop.getRunTimeline({ runId: started.runId, sinceSeq: run.cursor })
    expect(next.groups.map((group) => group.entries.map((entry) => entry.kind))).toEqual([['run']])
    expect(next.cursor).toBeGreaterThan(run.cursor)
  })

})

describe('activity timeline commands — who may read and what is refused', () => {
  it('lets every role read, and answers not_found for an id it does not know', async () => {
    const orchestrator = harness.open('orchestrator')
    const started = await startedAttempt(orchestrator)
    for (const role of ['planner', 'worker', 'reviewer'] as const) {
      const reader = harness.open(role)
      expect((await reader.getAttemptTimeline({ attemptId: started.attemptId })).attemptId).toBe(started.attemptId)
      expect((await reader.getRunTimeline({ runId: started.runId })).runId).toBe(started.runId)
    }
    const missing = 'at_00000000000000000000000099'
    expect(await failureCode(orchestrator.getAttemptTimeline({ attemptId: missing }))).toBe('not_found')
    expect(await failureCode(orchestrator.getRunTimeline({ runId: 'rn_00000000000000000000000099' }))).toBe('not_found')
  })

  it('rejects malformed input before reading anything', async () => {
    const desktop = harness.open('desktop')
    await desktop.initializeRepository({ name: 'activity-repo' })
    const attemptId = 'at_00000000000000000000000001'
    const runId = 'rn_00000000000000000000000001'
    const bad = [
      desktop.getAttemptTimeline({ attemptId: 'nope' }),
      desktop.getAttemptTimeline({ attemptId, sinceSeq: -1 }),
      desktop.getAttemptTimeline({ attemptId, limit: 501 }),
      desktop.getAttemptTimeline({ attemptId, claimToken: 'x' } as never),
      desktop.getRunTimeline({ runId, sinceSeq: 1.5 }),
      desktop.getRunTimeline({ runId, limit: 0 }),
      desktop.getRunTimeline({} as never)
    ]
    expect(await Promise.all(bad.map(failureCode))).toEqual(bad.map(() => 'invalid_input'))
  })
})
