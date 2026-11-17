/**
 * DM-174 c1 and DM-175: what the desktop records for a person is placed where the person said and kept as given: a
 * sprint rating names a run of its own epic holding the sprint, only the desktop session speaks for a person, and an
 * escaped defect follow-up carries only the attributes its event has.
 */
import { describe, expect, it } from 'vitest'
import type { RecordHumanFeedbackInput } from '../../shared/domain/spaceSignals'
import { makeBundle, makeSprint, sid } from '../../test/bundles'
import { startedRun } from '../../test/execution'
import { domainErrorOf } from '../../test/repoFixtures'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { recordEscapedDefects, recordHumanFeedback } from './humanFeedback'
import { listObservations } from './observations'

interface World {
  ctx: TestCtx
  desktop: TestCtx
  epicId: string
  runId: string
  /** A run of another epic, whose only sprint is sprint 5. */
  otherRunId: string
}

function feedbackWorld(): World {
  const ctx = createTestCtx()
  ctx.clock.set('2026-11-15T09:00:00.000Z')
  const own = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
  const other = startedRun(ctx, { bundle: makeBundle([[3]], [], { sprints: [makeSprint(5, [3])] }) })
  return { ctx, desktop: withRole(ctx, 'desktop'), epicId: own.epicId, runId: own.runId, otherRunId: other.runId }
}

const sprintRating = (w: World, sprintId: string, runId: string): RecordHumanFeedbackInput => ({
  target: { epicId: w.epicId, sprintId, runId },
  feedback: { kind: 'rating', value: 4, sharedWithTickets: true }
})

function ratingCount(w: World): number {
  return listObservations(w.ctx.db, { epicId: w.epicId, metric: 'human_rating' }).length
}

describe('recordHumanFeedback: a sprint rating given while viewing a run', () => {
  it('refuses a run of another epic as invalid_input, naming the run, and stores nothing', () => {
    const w = feedbackWorld()
    const error = domainErrorOf(() => recordHumanFeedback(w.desktop, sprintRating(w, sid(1), w.otherRunId)))
    expect(error.code).toBe('invalid_input')
    expect(error.details).toEqual({ runId: w.otherRunId })
    expect(error.message).toContain(`not ${w.epicId}`)
    expect(ratingCount(w)).toBe(0)
  })

  it('refuses a sprint the run’s plan does not hold as invalid_input, naming the sprint', () => {
    const w = feedbackWorld()
    const error = domainErrorOf(() => recordHumanFeedback(w.desktop, sprintRating(w, sid(9), w.runId)))
    expect(error.code).toBe('invalid_input')
    expect(error.details).toEqual({ runId: w.runId, sprintId: sid(9) })
    expect(ratingCount(w)).toBe(0)
  })
})

describe('recordHumanFeedback: only the desktop speaks for a person', () => {
  it('refuses an agent session even when it was granted the feedback capability, naming its role', () => {
    const w = feedbackWorld()
    const granted = withRole(w.ctx, 'orchestrator', { capabilities: ['feedback.record'] })
    const error = domainErrorOf(() => recordHumanFeedback(granted, sprintRating(w, sid(1), w.runId)))
    expect(error.code).toBe('unauthorized')
    expect(error.details).toEqual({ role: 'orchestrator' })
    expect(ratingCount(w)).toBe(0)
  })
})

describe('recordEscapedDefects: a follow-up keeps only its own attributes', () => {
  it('stores a withdrawal as a 0-count record with no severity, attribution or discovery phase', () => {
    const w = feedbackWorld()
    const [report] = recordEscapedDefects(w.desktop, {
      target: { epicId: w.epicId },
      records: [{ defectEvent: 'report', severity: 'high', attribution: 'unassigned', discoveryPhase: 'after_epic', evidence: [{ kind: 'commit', id: 'abcdef1', detail: 'source build' }] }]
    }).observations
    const [withdrawal] = recordEscapedDefects(w.desktop, {
      target: { epicId: w.epicId },
      records: [{ defectEvent: 'withdrawal', evidence: [{ kind: 'observation', id: report?.observationId ?? '', detail: 'defect' }] }]
    }).observations
    expect(report?.measurement).toEqual({ state: 'observed', value: 1 })
    expect(withdrawal?.measurement).toEqual({ state: 'observed', value: 0 })
    expect(withdrawal?.attributes).toEqual({ defectEvent: 'withdrawal', desktopSession: w.desktop.session.id, machine: w.ctx.machineId })
  })
})
