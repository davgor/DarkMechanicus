/**
 * DM-174 c1: desktop-origin ratings and rescue minutes keep who, when and scope; no agent session (core capability or
 * MCP tool) can record them, and absent feedback stays missing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '../errors'
import type { RecordHumanFeedbackInput } from '../../shared/domain/spaceSignals'
import { type Claimed, graded, mcpSession, type SignalsWorld, signalsWorld } from '../../test/spaceSignalsWorld'
import { thrownBy } from '../../test/thrownBy'
import { recordHumanFeedback } from './humanFeedback'

let w: SignalsWorld
let rated: Claimed

beforeEach(async () => {
  w = await signalsWorld({
    rated: { title: 'Rated ticket', acceptanceCriteria: ['It works'] },
    inherits: { title: 'Inheriting ticket', acceptanceCriteria: ['It works'] },
    unrated: { title: 'Unrated ticket', acceptanceCriteria: ['It works'] }
  })
  // Claimed at 10:02:00.
  rated = await w.claim('rated')
  w.harness.clock.advanceSeconds(60)
})

afterEach(() => w.close())

function codeOf(action: () => unknown): string | undefined {
  const error = thrownBy(action)
  return error instanceof DomainError ? error.code : undefined
}

const AGENT_ROLES = ['orchestrator', 'worker', 'planner', 'reviewer', 'reader'] as const

describe('recordHumanFeedback: ratings keep who, when and scope (DM-174 c1)', () => {
  it('stores a sprint rating under the named person, the server time and the sprint, with its sharing choice', () => {
    const stored = recordHumanFeedback(w.desktop.ctx(), {
      target: { epicId: w.epicId, sprintId: w.sprintId },
      feedback: { kind: 'rating', value: 5, sharedWithTickets: true },
      person: 'Dana'
    })
    expect(stored.metric).toBe('human_rating')
    expect(stored.source).toEqual({ kind: 'human', actor: 'Dana' })
    expect(stored.observedAt).toBe('2026-03-01T10:03:00.000Z')
    expect(stored.recordedAt).toBe('2026-03-01T10:03:00.000Z')
    expect(stored.scope).toEqual({ level: 'sprint', epicId: w.epicId, sprintId: w.sprintId, runId: null, ticketId: null, attemptId: null })
    expect(stored.measurement).toEqual({ state: 'observed', value: 5 })
    expect(stored.attributes.sharedWithTickets).toBe(true)
  })

  it('stores a sprint rating given while viewing a run under the sprint, once per sprint', () => {
    const stored = recordHumanFeedback(w.desktop.ctx(), {
      target: { epicId: w.epicId, sprintId: w.sprintId, runId: w.runId },
      feedback: { kind: 'rating', value: 4, sharedWithTickets: false }
    })
    expect(stored.scope).toEqual({ level: 'sprint', epicId: w.epicId, sprintId: w.sprintId, runId: null, ticketId: null, attemptId: null })
    expect(stored.attributes.sharedWithTickets).toBe(false)
  })

  it('scopes a ticket rating to the ticket in its run', () => {
    const stored = recordHumanFeedback(w.desktop.ctx(), {
      target: { epicId: w.epicId, ticketId: w.ticket.rated ?? '', runId: w.runId },
      feedback: { kind: 'rating', value: 2 },
      person: 'Dana'
    })
    expect(stored.scope).toEqual({ level: 'ticket', epicId: w.epicId, sprintId: null, runId: w.runId, ticketId: w.ticket.rated, attemptId: null })
    expect(stored.attributes.sharedWithTickets).toBeUndefined()
  })
})

describe('recordHumanFeedback: rescue entries keep who, when and scope (DM-174 c1)', () => {
  it('fills a rescue entry’s run, ticket and sprint from its attempt and keeps the intervention and cause', () => {
    const stored = recordHumanFeedback(w.desktop.ctx(), {
      target: { epicId: w.epicId, attemptId: rated.id },
      feedback: { kind: 'rescue', minutes: 25, intervention: 'rescue', cause: 'context' }
    })
    expect(stored.metric).toBe('rescue_minutes')
    expect(stored.scope).toEqual({ level: 'attempt', epicId: w.epicId, sprintId: w.sprintId, runId: w.runId, ticketId: w.ticket.rated, attemptId: rated.id })
    expect(stored.measurement).toEqual({ state: 'observed', value: 25 })
    expect(stored.intervention).toBe('rescue')
    expect(stored.cause).toBe('context')
  })

  it('names the desktop session’s label when no person is given, and keeps the desktop session and machine', () => {
    const ctx = w.desktop.ctx()
    const stored = recordHumanFeedback(ctx, {
      target: { epicId: w.epicId, attemptId: rated.id },
      feedback: { kind: 'rescue', minutes: 5, intervention: 'override', cause: 'tooling' }
    })
    expect(stored.source).toEqual({ kind: 'human', actor: 'desktop session' })
    expect(stored.attributes.desktopSession).toBe(ctx.session.id)
    expect(stored.attributes.machine).toBe(ctx.machineId)
  })

  it('keeps rescue time that was not given as missing, never as 0', () => {
    const stored = recordHumanFeedback(w.desktop.ctx(), {
      target: { epicId: w.epicId, ticketId: w.ticket.rated ?? '' },
      feedback: { kind: 'rescue', intervention: 'redirect', cause: 'requirement' }
    })
    expect(stored.measurement).toEqual({ state: 'missing', reason: 'not_reported' })
    const view = w.signals({ level: 'ticket', id: w.ticket.rated ?? '' })
    expect(view.S.rescueMinutes).toBe(0)
    expect(view.S.entriesWithoutMinutes).toBe(1)
    expect(view.S.rescue.map((entry) => entry.value)).toEqual([null])
  })

  it('records a retried request with the same idempotency key once', () => {
    const input: RecordHumanFeedbackInput = {
      target: { epicId: w.epicId, sprintId: w.sprintId },
      feedback: { kind: 'rating', value: 3, sharedWithTickets: false },
      idempotencyKey: 'k-1'
    }
    const first = recordHumanFeedback(w.desktop.ctx(), input)
    w.harness.clock.advanceSeconds(60)
    const again = recordHumanFeedback(w.desktop.ctx(), input)
    expect(again.observationId).toBe(first.observationId)
    expect(w.signals({ level: 'sprint', id: w.sprintId }).S.ratings).toHaveLength(1)
  })
})

describe('recordHumanFeedback: refused input (DM-174 c1)', () => {
  const cases: [string, (world: SignalsWorld, attempt: Claimed) => RecordHumanFeedbackInput][] = [
    ['a rating of 6', (x) => ({ target: { epicId: x.epicId, sprintId: x.sprintId }, feedback: { kind: 'rating', value: 6, sharedWithTickets: true } })],
    ['a rating of 0', (x) => ({ target: { epicId: x.epicId, sprintId: x.sprintId }, feedback: { kind: 'rating', value: 0, sharedWithTickets: true } })],
    ['a fractional rating', (x) => ({ target: { epicId: x.epicId, ticketId: x.ticket.rated ?? '' }, feedback: { kind: 'rating', value: 3.5 } })],
    ['a sprint rating that does not say whether it is shared', (x) => ({ target: { epicId: x.epicId, sprintId: x.sprintId }, feedback: { kind: 'rating', value: 4 } })],
    [
      'a ticket rating claiming to be shared',
      (x) => ({ target: { epicId: x.epicId, ticketId: x.ticket.rated ?? '' }, feedback: { kind: 'rating', value: 4, sharedWithTickets: true } })
    ],
    ['a rating of a whole run', (x) => ({ target: { epicId: x.epicId, runId: x.runId }, feedback: { kind: 'rating', value: 4 } })],
    ['a rating of a whole epic', (x) => ({ target: { epicId: x.epicId }, feedback: { kind: 'rating', value: 4 } })],
    ['zero rescue minutes', (x) => ({ target: { epicId: x.epicId, runId: x.runId }, feedback: { kind: 'rescue', minutes: 0, intervention: 'rescue', cause: 'context' } })],
    [
      'more rescue minutes than a working week',
      (x) => ({ target: { epicId: x.epicId, runId: x.runId }, feedback: { kind: 'rescue', minutes: 2_401, intervention: 'rescue', cause: 'context' } })
    ],
    [
      'an attempt target whose named ticket disagrees',
      (x, attempt) => ({
        target: { epicId: x.epicId, attemptId: attempt.id, ticketId: x.ticket.unrated ?? '' },
        feedback: { kind: 'rescue', minutes: 5, intervention: 'clarification', cause: 'requirement' }
      })
    ],
    [
      'an attempt target whose named epic disagrees',
      (_x, attempt) => ({ target: { epicId: 'ep_00000000000000000000000099', attemptId: attempt.id }, feedback: { kind: 'rescue', minutes: 5, intervention: 'rescue', cause: 'context' } })
    ],
    ['a blank person', (x) => ({ target: { epicId: x.epicId, sprintId: x.sprintId }, feedback: { kind: 'rating', value: 4, sharedWithTickets: true }, person: '   ' })]
  ]
  it.each(cases)('refuses %s as invalid_input and stores nothing', (_label, build) => {
    expect(codeOf(() => recordHumanFeedback(w.desktop.ctx(), build(w, rated)))).toBe('invalid_input')
    const sprint = w.signals({ level: 'sprint', id: w.sprintId })
    expect(sprint.S.ratings).toEqual([])
    expect(sprint.S.rescue).toEqual([])
  })
})

describe('recordHumanFeedback: no agent session speaks for a person (DM-174 c1)', () => {
  it.each(AGENT_ROLES)('refuses the %s session as unauthorized, even naming a person', (role) => {
    const ctx = role === 'orchestrator' ? w.orchestrator.ctx() : w.harness.open(role).ctx()
    const input: RecordHumanFeedbackInput = { target: { epicId: w.epicId, sprintId: w.sprintId }, feedback: { kind: 'rating', value: 5, sharedWithTickets: true }, person: 'Dana' }
    expect(codeOf(() => recordHumanFeedback(ctx, input))).toBe('unauthorized')
    expect(w.signals({ level: 'sprint', id: w.sprintId }).S.input.sprintRating).toBeNull()
  })
})

/** One report as an agent would send it through a metric tool. */
function report(metric: string, unit: string, source: { kind: string; actor: string }, value: number): Record<string, unknown> {
  return { metric, unit, source, measurement: { state: 'observed', value }, accumulation: 'event', eventId: `fake-${metric}`, observedAt: '2026-03-01T10:00:00.000Z' }
}

describe('MCP metric tools: no agent speaks for a person (DM-174 c1)', () => {
  it('offers no feedback, rating or rescue tool to any agent role', async () => {
    for (const role of AGENT_ROLES) {
      const session = await mcpSession(role === 'orchestrator' ? w.orchestrator : w.harness.open(role), role)
      const offered = session.tools
      await session.close()
      expect(offered).toContain('get_capabilities')
      expect(offered.filter((name) => /feedback|rating|rescue/.test(name))).toEqual([])
    }
  })

  it('refuses a worker reporting a rating as a human source', async () => {
    const worker = await mcpSession(w.harness.open('worker'), 'worker')
    const answer = await worker.call('record_attempt_metrics', {
      attemptId: rated.id,
      claimToken: rated.token,
      reports: [report('human_rating', 'rating_1_5', { kind: 'human', actor: 'Dana' }, 5)]
    })
    await worker.close()
    expect(answer.ok).toBe(false)
    expect(answer.error?.code).toBe('unauthorized')
    expect(w.signals({ level: 'ticket', id: w.ticket.rated ?? '' }).S.input.ticketRating).toBeNull()
  })

  it('refuses an orchestrator reporting rescue minutes as itself', async () => {
    const orchestrator = await mcpSession(w.orchestrator, 'orchestrator')
    const answer = await orchestrator.call('record_run_metrics', {
      runId: w.runId,
      overhead: 'review',
      reports: [report('rescue_minutes', 'minutes', { kind: 'agent', actor: 'orchestrator' }, 30)]
    })
    await orchestrator.close()
    expect(answer.ok).toBe(false)
    expect(answer.error?.code).toBe('unauthorized')
    expect(w.signals({ level: 'run', id: w.runId }).S.rescueMinutes).toBe(0)
  })
})

describe('S read of human feedback (DM-174 c1)', () => {
  it('uses the ticket’s own rating over the sprint’s, and the latest sprint rating as the sprint’s', () => {
    const desktop = w.desktop.ctx()
    recordHumanFeedback(desktop, { target: { epicId: w.epicId, sprintId: w.sprintId }, feedback: { kind: 'rating', value: 5, sharedWithTickets: true }, person: 'Dana' })
    w.harness.clock.advanceSeconds(60)
    const own = recordHumanFeedback(desktop, { target: { epicId: w.epicId, ticketId: w.ticket.rated ?? '' }, feedback: { kind: 'rating', value: 2 }, person: 'Dana' })
    w.harness.clock.advanceSeconds(60)
    const latest = recordHumanFeedback(desktop, { target: { epicId: w.epicId, sprintId: w.sprintId }, feedback: { kind: 'rating', value: 3, sharedWithTickets: false }, person: 'Lee' })
    const view = w.signals({ level: 'ticket', id: w.ticket.rated ?? '' })
    expect(view.S.input.ticketRating).toEqual({ observationId: own.observationId, source: 'human', value: 2 })
    expect(view.S.input.sprintRating).toEqual({ observationId: latest.observationId, source: 'human', value: 3, sharedWithTickets: false })
    expect(view.S.ratings.map((entry) => [entry.person, entry.value, entry.recordedAt])).toEqual([
      ['Dana', 5, '2026-03-01T10:03:00.000Z'],
      ['Dana', 2, '2026-03-01T10:04:00.000Z'],
      ['Lee', 3, '2026-03-01T10:05:00.000Z']
    ])
    const s = graded(view, 'S')
    expect(s.score).toBe(25)
    expect(s.inherited).toBe(false)
  })

  it('lets a ticket without its own rating inherit the sprint rating only while it is shared, labeled inherited', () => {
    const desktop = w.desktop.ctx()
    const shared = recordHumanFeedback(desktop, { target: { epicId: w.epicId, sprintId: w.sprintId }, feedback: { kind: 'rating', value: 5, sharedWithTickets: true } })
    w.harness.clock.advanceSeconds(60)
    recordHumanFeedback(desktop, { target: { epicId: w.epicId, sprintId: w.sprintId }, feedback: { kind: 'rating', value: 5, sharedWithTickets: false } })

    const whileShared = w.signals({ level: 'ticket', id: w.ticket.inherits ?? '', cutoff: shared.recordedAt })
    expect(whileShared.S.sprintRatingUse).toBe('inherited')
    expect(graded(whileShared, 'S')).toMatchObject({ state: 'observed', score: 100, inherited: true })

    const now = w.signals({ level: 'ticket', id: w.ticket.inherits ?? '' })
    expect(now.S.sprintRatingUse).toBe('not_shared')
    expect(graded(now, 'S')).toMatchObject({ state: 'missing', score: null, missingReason: 'no_rating', inherited: false })
  })

  it('keeps S missing when no feedback exists by the cutoff, inventing nothing', () => {
    recordHumanFeedback(w.desktop.ctx(), { target: { epicId: w.epicId, sprintId: w.sprintId }, feedback: { kind: 'rating', value: 5, sharedWithTickets: true } })
    const before = w.signals({ level: 'ticket', id: w.ticket.unrated ?? '', cutoff: '2026-03-01T10:02:30.000Z' })
    expect(before.S.input).toEqual({ ticketRating: null, sprintRating: null })
    expect(before.S.sprintRatingUse).toBe('none')
    expect(graded(before, 'S')).toMatchObject({ state: 'missing', score: null, missingReason: 'no_rating' })
  })
})

describe('S read of rescue entries (DM-174 c1)', () => {
  it('counts each rescue entry once for its ticket, the sprint and run holding it, and the epic', () => {
    const desktop = w.desktop.ctx()
    const target = (ticketId: string | undefined): RecordHumanFeedbackInput['target'] => ({ epicId: w.epicId, ticketId: ticketId ?? '' })
    recordHumanFeedback(desktop, { target: { epicId: w.epicId, attemptId: rated.id }, feedback: { kind: 'rescue', minutes: 25, intervention: 'rescue', cause: 'context' } })
    recordHumanFeedback(desktop, { target: target(w.ticket.inherits), feedback: { kind: 'rescue', minutes: 35, intervention: 'redirect', cause: 'requirement' }, person: 'Dana' })
    recordHumanFeedback(desktop, { target: { epicId: w.epicId, sprintId: w.sprintId }, feedback: { kind: 'rescue', minutes: 5, intervention: 'override', cause: 'implementation' } })
    recordHumanFeedback(desktop, { target: target(w.ticket.unrated), feedback: { kind: 'planned_review', activity: 'playtest', minutes: 40 } })

    const ratedView = w.signals({ level: 'ticket', id: w.ticket.rated ?? '' })
    expect(ratedView.S.rescueMinutes).toBe(25)
    expect(ratedView.S.rescue.map((entry) => [entry.person, entry.scope.level, entry.intervention, entry.cause])).toEqual([['desktop session', 'attempt', 'rescue', 'context']])
    expect(w.signals({ level: 'ticket', id: w.ticket.inherits ?? '' }).S.rescueMinutes).toBe(35)
    expect(w.signals({ level: 'sprint', id: w.sprintId }).S.rescueMinutes).toBe(65)
    expect(w.signals({ level: 'run', id: w.runId }).S.rescueMinutes).toBe(65)
    const epic = w.signals({ level: 'epic', id: w.epicId })
    expect(epic.S.rescueMinutes).toBe(65)
    expect(epic.S.plannedReviewMinutes).toBe(40)
  })
})
