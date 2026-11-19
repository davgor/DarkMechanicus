import { describe, expect, it } from 'vitest'
import type { MetricObservation } from '../../shared/domain/space'
import { sid, tid } from '../../test/bundles'
import { seedAttempt, seedEpic, seedRun, type SeededRun } from '../../test/checkpointSeed'
import { domainErrorOf } from '../../test/repoFixtures'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { encodeBase32, ID_PREFIXES, type IdGenerator } from '../ids'
import { resolveDefects } from '../space/defects'
import { listObservations, type ObservationInput, recordObservations } from './observations'

const RECORDED_AT = '2026-11-15T10:00:00.000Z'

interface World {
  ctx: TestCtx
  run: SeededRun
  attempts: Record<'accepted' | 'rejected' | 'failed' | 'canceled' | 'lease_expired' | 'superseded' | 'carry_forward', string>
}

/** An epic with a saved plan (sprint 1 = {1, 2}, sprint 2 = {3}), a run on it and attempts of ticket 1 in every end state. */
function ledgerWorld(ids?: IdGenerator): World {
  const ctx = createTestCtx(ids === undefined ? {} : { ids })
  ctx.clock.set(RECORDED_AT)
  const run = seedRun(ctx)
  const ticket = 1
  const attempts = {
    rejected: seedAttempt(ctx, run, { ticket, state: 'rejected' }),
    failed: seedAttempt(ctx, run, { ticket, state: 'failed' }),
    canceled: seedAttempt(ctx, run, { ticket, state: 'canceled' }),
    lease_expired: seedAttempt(ctx, run, { ticket, state: 'lease_expired', reconciled: true }),
    superseded: seedAttempt(ctx, run, { ticket, state: 'accepted', superseded: true }),
    accepted: seedAttempt(ctx, run, { ticket, state: 'accepted' }),
    carry_forward: seedAttempt(ctx, run, { ticket: 2, state: 'accepted', kind: 'carry_forward' })
  }
  return { ctx, run, attempts }
}

/** A valid attempt-level token observation of ticket 1, with `patch` applied on top. */
function tokens(world: World, attemptId: string, patch: Partial<ObservationInput> = {}): ObservationInput {
  return {
    metric: 'tokens_input',
    unit: 'tokens',
    scope: { level: 'attempt', epicId: world.run.epicId, sprintId: sid(1), runId: world.run.runId, ticketId: tid(1), attemptId },
    source: { kind: 'host', actor: 'claude-code-adapter' },
    measurement: { state: 'observed', value: 1200 },
    accumulation: 'delta',
    sequence: null,
    observedAt: '2026-11-15T09:59:00.000Z',
    attributes: {},
    evidence: [],
    ...patch
  }
}

function withScope(world: World, patch: object): ObservationInput {
  const base = tokens(world, world.attempts.accepted)
  return { ...base, scope: { ...base.scope, ...patch } }
}

function idNo(n: number): string {
  return `mo_01m7gg${String(n).padStart(20, '0')}`
}

function rowCount(world: World): number {
  return world.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM metric_observations')?.n ?? -1
}

function outboxCount(world: World): number {
  return world.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'metric_observation'")?.n ?? -1
}

function stored(world: World, id: string): MetricObservation | undefined {
  return listObservations(world.ctx.db).find((observation) => observation.observationId === id)
}

/** Ids that count down, so ids of later calls sort before earlier ones unless the allocator orders them. */
function descendingIds(): IdGenerator {
  let counter = 1_000_000
  return {
    next(kind) {
      counter -= 1
      return `${ID_PREFIXES[kind]}_${encodeBase32(BigInt(counter), 26)}`
    },
    secret: () => 'secret'
  }
}

describe('DM-170 c2: repeated observation ids are idempotent', () => {
  it('a repeated delivery of a stored id writes nothing and returns the original recordedAt', () => {
    const world = ledgerWorld()
    const first = recordObservations(world.ctx, [tokens(world, world.attempts.accepted, { observationId: idNo(1) })])
    world.ctx.clock.advanceSeconds(60)
    const again = recordObservations(world.ctx, [tokens(world, world.attempts.accepted, { observationId: idNo(1) })])
    expect(first.created).toEqual([idNo(1)])
    expect(first.observations[0]?.recordedAt).toBe(RECORDED_AT)
    expect(again.created).toEqual([])
    expect(again.unchanged).toEqual([idNo(1)])
    expect(again.observations[0]?.recordedAt).toBe(RECORDED_AT)
    expect(rowCount(world)).toBe(1)
    expect(outboxCount(world)).toBe(1)
  })

  it('the same id twice in one call is stored once and reported once as created', () => {
    const world = ledgerWorld()
    const twice = recordObservations(world.ctx, [
      tokens(world, world.attempts.accepted, { observationId: idNo(2) }),
      tokens(world, world.attempts.accepted, { observationId: idNo(2) })
    ])
    expect(twice.created).toEqual([idNo(2)])
    expect(twice.unchanged).toEqual([])
    expect(twice.observations.map((o) => o.observationId)).toEqual([idNo(2), idNo(2)])
    expect(rowCount(world)).toBe(1)
  })

  it('the same instant in another UTC offset is the same delivery, stored in UTC', () => {
    const world = ledgerWorld()
    const utc = recordObservations(world.ctx, [tokens(world, world.attempts.accepted, { observationId: idNo(30), observedAt: '2026-11-15T11:59:00+02:00' })])
    const offset = recordObservations(world.ctx, [tokens(world, world.attempts.accepted, { observationId: idNo(30), observedAt: '2026-11-15T04:59:00-05:00' })])
    expect(utc.observations[0]?.observedAt).toBe('2026-11-15T09:59:00.000Z')
    expect(offset.unchanged).toEqual([idNo(30)])
  })

  it('a repeated evidence reference is stored once', () => {
    const world = ledgerWorld()
    const ref = { kind: 'attempt' as const, id: world.attempts.rejected, detail: null }
    const result = recordObservations(world.ctx, [tokens(world, world.attempts.accepted, { evidence: [ref, ref] })])
    expect(result.observations[0]?.evidence).toEqual([ref])
  })
})

describe('DM-170 c2: a changed payload under the same id conflicts', () => {
  it.each([
    ['a different value', (world: World) => tokens(world, world.attempts.accepted, { observationId: idNo(1), measurement: { state: 'observed', value: 1201 } })],
    ['a different attribution', (world: World) => tokens(world, world.attempts.rejected, { observationId: idNo(1) })]
  ])('%s under a stored id is a conflict and the stored record stays', (_label, changed) => {
    const world = ledgerWorld()
    recordObservations(world.ctx, [tokens(world, world.attempts.accepted, { observationId: idNo(1) })])
    const error = domainErrorOf(() => recordObservations(world.ctx, [changed(world)]))
    expect(error.code).toBe('conflict')
    expect(error.details).toEqual({ observationId: idNo(1) })
    expect(stored(world, idNo(1))?.measurement).toEqual({ state: 'observed', value: 1200 })
    expect(stored(world, idNo(1))?.scope.attemptId).toBe(world.attempts.accepted)
  })

  it('two payloads under one id in a single call conflict and store nothing', () => {
    const world = ledgerWorld()
    const error = domainErrorOf(() =>
      recordObservations(world.ctx, [
        tokens(world, world.attempts.accepted, { observationId: idNo(3) }),
        tokens(world, world.attempts.accepted, { observationId: idNo(3), measurement: { state: 'observed', value: 1 } })
      ])
    )
    expect(error.code).toBe('conflict')
    expect(rowCount(world)).toBe(0)
  })
})

describe('DM-170 c2: invalid usage is refused', () => {
  it.each([
    ['negative usage', { state: 'observed', value: -1 }],
    ['NaN usage', { state: 'observed', value: Number.NaN }],
    ['infinite usage', { state: 'observed', value: Number.POSITIVE_INFINITY }],
    ['fractional tokens', { state: 'observed', value: 1.5 }],
    ['a negative estimate', { state: 'estimated', value: -5, method: 'chars / 4' }]
  ] as const)('%s is invalid_input and nothing is stored', (_label, measurement) => {
    const world = ledgerWorld()
    expect(domainErrorOf(() => recordObservations(world.ctx, [tokens(world, world.attempts.accepted, { measurement })])).code).toBe('invalid_input')
    expect(rowCount(world)).toBe(0)
  })

  it('a caller-supplied recordedAt is refused: recordedAt is the server clock', () => {
    const world = ledgerWorld()
    const input = { ...tokens(world, world.attempts.accepted), recordedAt: '2020-01-01T00:00:00.000Z' }
    expect(domainErrorOf(() => recordObservations(world.ctx, [input])).code).toBe('invalid_input')
  })

  it('a unit other than the metric’s is refused', () => {
    const world = ledgerWorld()
    expect(domainErrorOf(() => recordObservations(world.ctx, [tokens(world, world.attempts.accepted, { unit: 'count' })])).code).toBe('invalid_input')
  })

  it.each([
    ['a number', 42],
    ['null', null],
    ['a list', []]
  ] as const)('an entry that is %s, not an object, is invalid_input and nothing is stored', (_label, value) => {
    const world = ledgerWorld()
    const error = domainErrorOf(() => recordObservations(world.ctx, [tokens(world, world.attempts.accepted), value]))
    expect([error.code, error.message]).toEqual(['invalid_input', 'Observation 1 is not an object.'])
    expect(rowCount(world)).toBe(0)
  })

  it('an unknown top-level field is refused naming the issue without a path', () => {
    const world = ledgerWorld()
    const error = domainErrorOf(() => recordObservations(world.ctx, [{ ...tokens(world, world.attempts.accepted), extra: 1 }]))
    expect(error.code).toBe('invalid_input')
    expect(error.message).toMatch(/^Invalid metric observation 0: .*extra/)
  })

  it('more observations than one call may carry are refused before any is read', () => {
    const world = ledgerWorld()
    const error = domainErrorOf(() => recordObservations(world.ctx, Array.from({ length: 501 }, () => tokens(world, world.attempts.accepted))))
    expect([error.code, error.message]).toEqual(['invalid_input', 'At most 500 observations are recorded in one call; 501 were sent.'])
    expect(rowCount(world)).toBe(0)
  })
})

describe('DM-170 c2: unknown ownership and references are refused', () => {
  const UNKNOWN = { epic: 'ep_01m7gg00000000000000000099', run: 'rn_01m7gg00000000000000000099', attempt: 'at_01m7gg00000000000000000099', sprint: 'sp_01m7gg00000000000000000099' }

  it.each([
    ['an unknown epic', { epicId: UNKNOWN.epic }, 'not_found'],
    ['an unknown run', { runId: UNKNOWN.run }, 'not_found'],
    ['an unknown attempt', { attemptId: UNKNOWN.attempt }, 'not_found'],
    ['a ticket not in the run’s plan', { ticketId: tid(77) }, 'not_found'],
    ['a sprint not in the run’s plan', { sprintId: UNKNOWN.sprint }, 'not_found'],
    ['a ticket of another sprint', { sprintId: sid(2) }, 'invalid_input'],
    ['an attempt of another ticket', { ticketId: tid(2) }, 'invalid_input']
  ])('%s is %s', (_label, patch, code) => {
    const world = ledgerWorld()
    expect(domainErrorOf(() => recordObservations(world.ctx, [withScope(world, patch)])).code).toBe(code)
    expect(rowCount(world)).toBe(0)
  })

  it('an epic with no saved plan is not_found', () => {
    const world = ledgerWorld()
    const epicId = seedEpic(world.ctx, 'Unsaved epic')
    const input = tokens(world, world.attempts.accepted, { scope: { level: 'epic', epicId, sprintId: null, runId: null, ticketId: null, attemptId: null } })
    expect(domainErrorOf(() => recordObservations(world.ctx, [input])).code).toBe('not_found')
  })

  it('a run of another epic and evidence owned by another epic are invalid_input', () => {
    const world = ledgerWorld()
    const other = seedRun(world.ctx)
    expect(domainErrorOf(() => recordObservations(world.ctx, [withScope(world, { epicId: other.epicId })])).code).toBe('invalid_input')
    const cross = tokens(world, world.attempts.accepted, { evidence: [{ kind: 'run', id: other.runId, detail: null }] })
    const error = domainErrorOf(() => recordObservations(world.ctx, [cross]))
    expect(error.code).toBe('invalid_input')
    expect(error.details).toEqual({ kind: 'run', id: other.runId })
  })
})

describe('DM-170 c2: a full ledger refuses more', () => {
  it('the project level, once it holds the most observations kept, refuses another as capacity_exceeded', () => {
    const world = ledgerWorld()
    const project = { level: 'project', epicId: null, sprintId: null, runId: null, ticketId: null, attemptId: null } as const
    recordObservations(world.ctx, [tokens(world, world.attempts.accepted, { observationId: idNo(1), scope: project })])
    world.ctx.db.run(
      `INSERT INTO metric_observations (id, metric, scope_level, epic_id, sprint_id, run_id, ticket_id, attempt_id, source_kind, measurement_state, recorded_at, payload_hash, observation_json)
       WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < 50000)
       SELECT printf('mo_01m7gg%020d', i), metric, scope_level, epic_id, sprint_id, run_id, ticket_id, attempt_id, source_kind, measurement_state, recorded_at, payload_hash, observation_json
       FROM n, metric_observations WHERE id = ?`,
      idNo(1)
    )
    const error = domainErrorOf(() => recordObservations(world.ctx, [tokens(world, world.attempts.accepted, { scope: project })]))
    expect([error.code, error.message]).toEqual(['capacity_exceeded', 'The project level already holds 50000 metric observations; at most 50000 are kept.'])
    expect(rowCount(world)).toBe(50_000)
  })
})

describe('DM-170 c2: unknown evidence references are refused, and a refused batch stores nothing', () => {
  it.each([
    ['an unknown attempt', { kind: 'attempt', id: 'at_01m7gg00000000000000000099', detail: null }],
    ['an unknown criterion', { kind: 'criterion', id: tid(1), detail: 'c9' }],
    ['an unknown ticket', { kind: 'ticket', id: tid(77), detail: null }],
    ['an unknown sprint', { kind: 'sprint', id: 'sp_01m7gg00000000000000000099', detail: null }],
    ['an unknown observation', { kind: 'observation', id: idNo(99), detail: null }],
    ['an unknown baseline', { kind: 'baseline', id: 'bl_01m7gg00000000000000000001', detail: null }]
  ] as const)('evidence naming %s is not_found', (_label, ref) => {
    const world = ledgerWorld()
    const error = domainErrorOf(() => recordObservations(world.ctx, [tokens(world, world.attempts.accepted, { evidence: [ref] })]))
    expect(error.code).toBe('not_found')
    expect(error.details).toEqual({ kind: ref.kind, id: ref.id })
  })

  it('known references (a criterion, a sprint, another attempt, a stored observation) are accepted', () => {
    const world = ledgerWorld()
    recordObservations(world.ctx, [tokens(world, world.attempts.accepted, { observationId: idNo(11) })])
    const ok = recordObservations(world.ctx, [
      tokens(world, world.attempts.accepted, {
        observationId: idNo(10),
        evidence: [
          { kind: 'criterion', id: tid(1), detail: 'c1' },
          { kind: 'sprint', id: sid(2), detail: null },
          { kind: 'attempt', id: world.attempts.rejected, detail: null },
          { kind: 'observation', id: idNo(11), detail: null }
        ]
      })
    ])
    expect(ok.created).toEqual([idNo(10)])
  })

  it('an observation citing itself is refused', () => {
    const world = ledgerWorld()
    const self = tokens(world, world.attempts.accepted, { observationId: idNo(32), evidence: [{ kind: 'observation', id: idNo(32), detail: null }] })
    expect(domainErrorOf(() => recordObservations(world.ctx, [self])).code).toBe('invalid_input')
    expect(rowCount(world)).toBe(0)
  })

  it('a batch with one bad observation is refused whole: nothing stored, nothing queued', () => {
    const world = ledgerWorld()
    const bad = tokens(world, world.attempts.accepted, { measurement: { state: 'observed', value: -1 } })
    expect(domainErrorOf(() => recordObservations(world.ctx, [tokens(world, world.attempts.accepted, { observationId: idNo(20) }), bad])).code).toBe('invalid_input')
    expect(rowCount(world)).toBe(0)
    expect(outboxCount(world)).toBe(0)
  })
})

/** `id` citing each of `cites` (observations of the same call or stored ones). */
function citing(world: World, id: number, ...cites: number[]): ObservationInput {
  return tokens(world, world.attempts.accepted, { observationId: idNo(id), evidence: cites.map((n) => ({ kind: 'observation' as const, id: idNo(n), detail: null })) })
}

describe('DM-170 c2: observations of one call cite each other in any order, never in a cycle', () => {
  it('citing an earlier or a later entry of the same call is accepted', () => {
    const world = ledgerWorld()
    const ok = recordObservations(world.ctx, [citing(world, 10, 11), citing(world, 11), citing(world, 12, 11)])
    expect(ok.created).toEqual([idNo(10), idNo(11), idNo(12)])
    expect(stored(world, idNo(10))?.evidence).toEqual([{ kind: 'observation', id: idNo(11), detail: null }])
  })

  it('a mutual citation in one call is refused with the cycle and stores nothing', () => {
    const world = ledgerWorld()
    const error = domainErrorOf(() => recordObservations(world.ctx, [citing(world, 1, 2), citing(world, 2, 1)]))
    expect(error.code).toBe('invalid_input')
    expect(error.details).toEqual({ cycle: [idNo(1), idNo(2), idNo(1)] })
    expect(rowCount(world)).toBe(0)
    expect(outboxCount(world)).toBe(0)
  })

  it('a three-observation cycle in one call is refused and stores nothing, even behind an acyclic entry', () => {
    const world = ledgerWorld()
    const error = domainErrorOf(() => recordObservations(world.ctx, [citing(world, 9, 1), citing(world, 1, 2), citing(world, 2, 3), citing(world, 3, 1)]))
    expect(error.code).toBe('invalid_input')
    expect(error.details).toEqual({ cycle: [idNo(1), idNo(2), idNo(3), idNo(1)] })
    expect(rowCount(world)).toBe(0)
  })

  it('a diamond (two entries citing one, cited by a fourth) is not a cycle', () => {
    const world = ledgerWorld()
    const ok = recordObservations(world.ctx, [citing(world, 1, 2, 3), citing(world, 2, 4), citing(world, 3, 4), citing(world, 4)])
    expect(ok.created).toEqual([idNo(1), idNo(2), idNo(3), idNo(4)])
  })

  it('a chain of 500 observations, each citing the next, is accepted whole', () => {
    const world = ledgerWorld()
    const chain = Array.from({ length: 500 }, (_, i) => (i === 499 ? citing(world, 500) : citing(world, i + 1, i + 2)))
    const ok = recordObservations(world.ctx, chain)
    expect(ok.created).toHaveLength(500)
    expect(rowCount(world)).toBe(500)
  })

  it('a loop of 500 observations, the last citing the first, is refused with the whole loop and stores nothing', () => {
    const world = ledgerWorld()
    const loop = Array.from({ length: 500 }, (_, i) => citing(world, i + 1, i === 499 ? 1 : i + 2))
    const error = domainErrorOf(() => recordObservations(world.ctx, loop))
    const cycle = [...Array.from({ length: 500 }, (_, i) => idNo(i + 1)), idNo(1)]
    expect(error.code).toBe('invalid_input')
    expect(error.message).toBe(`Metric observations ${cycle.join(' -> ')} cite each other in a cycle; citations in one call must not loop.`)
    expect(error.details).toEqual({ cycle })
    expect(rowCount(world)).toBe(0)
  })
})

describe('DM-170 c2 with DM-175: a defect withdrawal may precede its report in one call', () => {
  it('a withdrawal sent before the report it withdraws, in one call, is accepted and reads withdrawn', () => {
    const world = ledgerWorld()
    const epicScope = { level: 'epic' as const, epicId: world.run.epicId, sprintId: null, runId: null, ticketId: null, attemptId: null }
    const defect = { metric: 'escaped_defect', unit: 'count', scope: epicScope, source: { kind: 'human', actor: 'desktop' }, accumulation: 'event', sequence: null, observedAt: RECORDED_AT } as const
    const withdrawal: ObservationInput = {
      ...defect,
      observationId: idNo(2),
      measurement: { state: 'observed', value: 0 },
      attributes: { defectEvent: 'withdrawal' },
      evidence: [{ kind: 'observation', id: idNo(1), detail: 'defect' }]
    }
    const report: ObservationInput = {
      ...defect,
      observationId: idNo(1),
      measurement: { state: 'observed', value: 1 },
      attributes: { defectEvent: 'report', severity: 'low', attribution: 'unassigned', discoveryPhase: 'sprint_review' },
      evidence: [{ kind: 'commit', id: 'a'.repeat(40), detail: 'source build' }]
    }
    expect(recordObservations(world.ctx, [withdrawal, report]).created).toEqual([idNo(2), idNo(1)])
    const resolved = resolveDefects(listObservations(world.ctx.db), RECORDED_AT).defects.find((d) => d.defectId === idNo(1))
    expect(resolved?.status).toBe('withdrawn')
    expect(resolved?.counted).toBe(false)
  })
})

describe('DM-170 c2: server ids of one call read back in call order', () => {
  it('ids generated in one instant by a counting-down generator still read back in call order, across calls', () => {
    const world = ledgerWorld(descendingIds())
    const step = (action: string, round: number): ObservationInput =>
      tokens(world, world.attempts.accepted, { metric: 'activity_volume', unit: 'count', accumulation: 'event', measurement: { state: 'observed', value: 1 }, attributes: { action, round } })
    const first = recordObservations(world.ctx, [step('reported', 0), step('withdrawn', 0), step('reopened', 0)])
    const second = recordObservations(world.ctx, [step('reported', 1), step('withdrawn', 1)])
    const read = listObservations(world.ctx.db).map((o) => `${o.attributes.round}:${o.attributes.action}`)
    expect(read).toEqual(['0:reported', '0:withdrawn', '0:reopened', '1:reported', '1:withdrawn'])
    expect(listObservations(world.ctx.db).map((o) => o.observationId)).toEqual([...first.created, ...second.created])
    expect(new Set([...first.created, ...second.created]).size).toBe(5)
  })

  it('a server id follows a caller id already recorded at the same instant', () => {
    const world = ledgerWorld(descendingIds())
    const high = 'mo_zzzzzzzzzzzzzzzzzzzzzzzzzy'
    recordObservations(world.ctx, [tokens(world, world.attempts.accepted, { observationId: high })])
    const next = recordObservations(world.ctx, [tokens(world, world.attempts.accepted)])
    expect(next.created).toEqual(['mo_zzzzzzzzzzzzzzzzzzzzzzzzzz'])
  })

  it('no id sorts after the highest caller id at this instant: conflict, nothing stored', () => {
    const world = ledgerWorld(descendingIds())
    recordObservations(world.ctx, [tokens(world, world.attempts.accepted, { observationId: 'mo_zzzzzzzzzzzzzzzzzzzzzzzzzz' })])
    expect(domainErrorOf(() => recordObservations(world.ctx, [tokens(world, world.attempts.accepted)])).code).toBe('conflict')
    expect(rowCount(world)).toBe(1)
  })

  it('the allocator’s per-instant lookup uses an index on (recorded_at, id)', () => {
    const world = ledgerWorld()
    const plan = world.ctx.db
      .all<{ detail: string }>('EXPLAIN QUERY PLAN SELECT MAX(id) AS id FROM metric_observations WHERE recorded_at = ?', RECORDED_AT)
      .map((row) => row.detail)
    expect(plan).toEqual(['SEARCH metric_observations USING COVERING INDEX metric_observations_recorded (recorded_at=?)'])
  })
})

describe('DM-170 c4: unknown is distinct from zero and estimates', () => {
  it('missing, observed zero and an estimate are stored as three distinct states', () => {
    const world = ledgerWorld()
    recordObservations(world.ctx, [
      tokens(world, world.attempts.accepted, { observationId: idNo(1), measurement: { state: 'missing', reason: 'not_reported' } }),
      tokens(world, world.attempts.accepted, { observationId: idNo(2), metric: 'tokens_output', measurement: { state: 'observed', value: 0 } }),
      tokens(world, world.attempts.accepted, { observationId: idNo(3), metric: 'tokens_reasoning', measurement: { state: 'estimated', value: 0, method: 'no reasoning model' } })
    ])
    expect(stored(world, idNo(1))?.measurement).toEqual({ state: 'missing', reason: 'not_reported' })
    expect(stored(world, idNo(2))?.measurement).toEqual({ state: 'observed', value: 0 })
    expect(stored(world, idNo(3))?.measurement).toEqual({ state: 'estimated', value: 0, method: 'no reasoning model' })
    const states = world.ctx.db.all<{ measurement_state: string }>('SELECT measurement_state FROM metric_observations ORDER BY id').map((row) => row.measurement_state)
    expect(states).toEqual(['missing', 'observed', 'estimated'])
  })

  it('turning an unknown into zero, or an estimate into an observation, under the same id is a conflict', () => {
    const world = ledgerWorld()
    recordObservations(world.ctx, [
      tokens(world, world.attempts.accepted, { observationId: idNo(1), measurement: { state: 'missing', reason: 'not_reported' } }),
      tokens(world, world.attempts.accepted, { observationId: idNo(3), metric: 'tokens_reasoning', measurement: { state: 'estimated', value: 0, method: 'm' } })
    ])
    const zero = tokens(world, world.attempts.accepted, { observationId: idNo(1), measurement: { state: 'observed', value: 0 } })
    const observed = tokens(world, world.attempts.accepted, { observationId: idNo(3), metric: 'tokens_reasoning', measurement: { state: 'observed', value: 0 } })
    expect(domainErrorOf(() => recordObservations(world.ctx, [zero])).code).toBe('conflict')
    expect(domainErrorOf(() => recordObservations(world.ctx, [observed])).code).toBe('conflict')
    expect(stored(world, idNo(1))?.measurement).toEqual({ state: 'missing', reason: 'not_reported' })
  })

  it('a missing value carrying a number is refused', () => {
    const world = ledgerWorld()
    const input = tokens(world, world.attempts.accepted, { measurement: { state: 'missing', reason: 'not_reported', value: 0 } as never })
    expect(domainErrorOf(() => recordObservations(world.ctx, [input])).code).toBe('invalid_input')
  })
})

describe('DM-170 c4: work in every end state stays attributable', () => {
  it.each(['rejected', 'failed', 'canceled', 'lease_expired', 'superseded'] as const)('usage on a %s attempt is recorded against that attempt', (state) => {
    const world = ledgerWorld()
    const attemptId = world.attempts[state]
    const result = recordObservations(world.ctx, [tokens(world, attemptId, { measurement: { state: 'observed', value: 500 } })])
    expect(result.created).toHaveLength(1)
    const list = listObservations(world.ctx.db, { attemptId })
    expect(list.map((o) => [o.scope.attemptId, o.measurement])).toEqual([[attemptId, { state: 'observed', value: 500 }]])
  })
})

describe('DM-170 c4: carry-forward references never duplicate execution', () => {
  function carried(world: World): ObservationInput {
    const base = tokens(world, world.attempts.carry_forward)
    return { ...base, scope: { ...base.scope, ticketId: tid(2) } }
  }

  it.each([
    ['tokens_input', 'tokens'],
    ['active_ms', 'milliseconds']
  ] as const)('%s on a carry-forward attempt is refused', (metric, unit) => {
    const world = ledgerWorld()
    const error = domainErrorOf(() => recordObservations(world.ctx, [{ ...carried(world), metric, unit }]))
    expect(error.code).toBe('invalid_input')
    expect(error.details).toEqual({ attemptId: world.attempts.carry_forward, metric })
  })

  it('a delivery citing the carry-forward attempt as a reference is accepted, with no usage on that attempt', () => {
    const world = ledgerWorld()
    const cited = recordObservations(world.ctx, [
      {
        ...carried(world),
        metric: 'scope_delivered',
        unit: 'count',
        accumulation: 'event',
        source: { kind: 'server', actor: null },
        measurement: { state: 'observed', value: 1 },
        scope: { level: 'ticket', epicId: world.run.epicId, sprintId: sid(1), runId: world.run.runId, ticketId: tid(2), attemptId: null },
        evidence: [{ kind: 'attempt', id: world.attempts.carry_forward, detail: 'carried forward' }]
      }
    ])
    expect(cited.created).toHaveLength(1)
    expect(listObservations(world.ctx.db, { attemptId: world.attempts.carry_forward })).toEqual([])
  })
})
