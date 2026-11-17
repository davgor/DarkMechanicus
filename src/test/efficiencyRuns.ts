/**
 * Builders for the pure efficiency read (`runEfficiency`): a run's lifecycle events and ledger observations written
 * compactly (times in minutes after 09:00 on 2026-11-01), read through the real `runEfficiency` with the run usage
 * read's `usageCell` for tokens, and graded inside the complete rubric example with the real `gradeSpace`. Not shipped.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { usageCell } from '../core/services/metricReports'
import { type BudgetCandidates, type CohortRunInput, type PlannedTicket, runEfficiency, type RunEfficiencyInput } from '../core/space/efficiency'
import { gradeSpace, SPACE_POLICY_V1 } from '../core/space/rubric'
import type { TimingEvent, TimingInput } from '../core/space/timing'
import type { RunEfficiencyView, TicketEfficiencyView } from '../shared/domain/efficiency'
import type { BudgetBaseline, CohortKey, Measurement, MetricObservation, ObservationMissingReason, SpaceComponentResult, SpaceGradeInput, WorkflowCause } from '../shared/domain/space'

const T0 = Date.parse('2026-11-01T09:00:00.000Z')
/** The ISO time `m` minutes after 09:00 on 2026-11-01. */
export const at = (m: number): string => new Date(T0 + Math.round(m * 60_000)).toISOString()
export const MIN = 60_000

const EPIC = 'ep_01m452vt110000000000000001'
const RUN = 'rn_01m7gdve7p0000000000000001'
const pad = (n: number): string => String(n).padStart(2, '0')
export const tk = (n: number): string => `tk_01m453gpad00000000000000${pad(n)}`
export const sp = (n: number): string => `sp_01m452vt1200000000000000${pad(n)}`
export const atm = (n: number): string => `at_01m7ge55kx00000000000000${pad(n)}`
const mo = (n: number): string => `mo_01m7gf${String(n).padStart(20, '0')}`

export const KEY: CohortKey = { workType: 'implementation', size: 'medium', risk: 'multi_step' }

interface SpanOptions {
  actor?: string | null
  source?: 'host' | 'agent'
  role?: 'worker' | 'orchestrator' | 'reviewer' | 'other'
  handle?: string
  /** Minutes after 09:00 the server stored it (default: at its end). */
  recorded?: number
  usage?: { coverage: 'self' | 'inclusive'; parentActor: string | null }
  /** The host's delta form (`spanStart` attribute) instead of an event. */
  delta?: boolean
  missing?: ObservationMissingReason
  /** The value reported, when it is not the span's length (minutes). */
  reported?: number
  /** Leaves out `spanStart` (an amount with no place in time). */
  unplaced?: boolean
}

interface TokenOptions {
  actor?: string
  source?: 'host' | 'agent'
  sequence?: number
  missing?: ObservationMissingReason
  recorded?: number
  overhead?: string
  usage?: { coverage: 'self' | 'inclusive'; parentActor: string | null }
  estimated?: boolean
}

/** Where an observation is scoped: an attempt of a ticket, a ticket, a sprint's run bucket or the run. */
interface Where {
  attempt?: number
  ticket?: number
  sprint?: number
}

/** The stated actor, else the worker of the attempt, else the orchestrating host. */
function actorFor(where: Where, actor: string | null | undefined): string | null {
  if (actor !== undefined) return actor
  return where.attempt === undefined ? 'orchestrator-host' : `worker-${where.attempt}`
}

function measurementOf(value: number, missing: ObservationMissingReason | undefined): Measurement {
  return missing === undefined ? { state: 'observed', value } : { state: 'missing', reason: missing }
}

function tokenMeasurement(value: number, estimated: boolean): Measurement {
  return estimated ? { state: 'estimated', value, method: 'chars/4' } : { state: 'observed', value }
}

export class RunBuilder {
  events: TimingEvent[] = []
  observations: MetricObservation[] = []
  tickets: { ticketId: string; sprintId: string | null }[] = []
  plan: Record<string, PlannedTicket> = {}
  budgets: Record<string, { active_ms: BudgetCandidates; tokens: BudgetCandidates }> = {}
  private next = 1
  private sprintOf = new Map<number, number>()

  constructor(readonly asOf: number) {}

  start(m: number, sprint = 1): this {
    this.events.push({ kind: 'run_started', at: at(m) }, { kind: 'sprint_activated', at: at(m), sprintId: sp(sprint) })
    return this
  }

  activate(sprint: number, m: number): this {
    this.events.push({ kind: 'sprint_activated', at: at(m), sprintId: sp(sprint) })
    return this
  }

  /** A ticket of `sprint`, planned with a cohort key (null: no size), ready at `ready` minutes. */
  ticket(n: number, sprint: number, key: CohortKey | null, ready?: number): this {
    this.tickets.push({ ticketId: tk(n), sprintId: sp(sprint) })
    this.sprintOf.set(n, sprint)
    this.plan[tk(n)] = { cohortKey: key, acceptance: false }
    if (ready !== undefined) this.events.push({ kind: 'ticket_ready', at: at(ready), ticketId: tk(n) })
    return this
  }

  claim(attempt: number, ticket: number, number: number, m: number): this {
    this.events.push({ kind: 'attempt_claimed', at: at(m), attemptId: atm(attempt), ticketId: tk(ticket), sprintId: sp(this.sprintOf.get(ticket) ?? 1), number, carriedForward: false })
    return this
  }

  carry(attempt: number, ticket: number, m: number): this {
    this.events.push({ kind: 'attempt_claimed', at: at(m), attemptId: atm(attempt), ticketId: tk(ticket), sprintId: sp(this.sprintOf.get(ticket) ?? 1), number: 1, carriedForward: true })
    return this
  }

  attemptEvent(kind: 'attempt_submitted' | 'attempt_accepted' | 'attempt_rejected' | 'attempt_failed' | 'attempt_superseded', attempt: number, m: number): this {
    this.events.push({ kind, at: at(m), attemptId: atm(attempt) })
    return this
  }

  /** Claim at `claim`, submit at `submit`, then `decision` (default accepted) at `decided`. */
  attempt(attempt: number, ticket: number, number: number, times: { claim: number; submit?: number; decided?: number; decision?: 'accepted' | 'rejected' }): this {
    this.claim(attempt, ticket, number, times.claim)
    if (times.submit !== undefined) this.attemptEvent('attempt_submitted', attempt, times.submit)
    if (times.decided !== undefined) this.attemptEvent(times.decision === 'rejected' ? 'attempt_rejected' : 'attempt_accepted', attempt, times.decided)
    return this
  }

  checkpoint(sprint: number, reported: number, approved: number): this {
    this.events.push({ kind: 'sprint_report_submitted', at: at(reported), sprintId: sp(sprint) }, { kind: 'checkpoint_approved', at: at(approved), sprintId: sp(sprint) })
    return this
  }

  private scope(where: Where): MetricObservation['scope'] {
    const ticket = where.ticket
    const sprint = where.sprint ?? (ticket === undefined ? undefined : this.sprintOf.get(ticket))
    const level = where.attempt !== undefined ? 'attempt' : ticket !== undefined ? 'ticket' : 'run'
    return {
      level,
      epicId: EPIC,
      sprintId: sprint === undefined ? null : sp(sprint),
      runId: RUN,
      ticketId: ticket === undefined ? null : tk(ticket),
      attemptId: where.attempt === undefined ? null : atm(where.attempt)
    }
  }

  private add(observation: Omit<MetricObservation, 'observationId'>): string {
    const observationId = mo(this.next++)
    this.observations.push({ ...observation, observationId })
    return observationId
  }

  /** An `active_ms` span from `start` to `end` minutes. */
  span(where: Where, start: number, end: number, options: SpanOptions = {}): string {
    const { role, handle } = options
    return this.add({
      metric: 'active_ms',
      unit: 'milliseconds',
      scope: this.scope(where),
      source: { kind: options.source ?? 'host', actor: actorFor(where, options.actor) },
      measurement: measurementOf(Math.round((options.reported ?? end - start) * MIN), options.missing),
      accumulation: options.delta === true ? 'delta' : 'event',
      sequence: null,
      observedAt: at(end),
      recordedAt: at(options.recorded ?? end),
      attributes: { ...(options.unplaced === true ? {} : { spanStart: at(start) }), ...(role === undefined ? {} : { role }), ...(handle === undefined ? {} : { handle }) },
      evidence: [],
      ...(options.usage === undefined ? {} : { usage: options.usage })
    })
  }

  /** A host wait span (`waitKind`), never activity. */
  wait(where: Where, start: number, end: number, waitKind: string): string {
    return this.add({
      metric: 'wait_ms',
      unit: 'milliseconds',
      scope: this.scope(where),
      source: { kind: 'host', actor: actorFor(where, undefined) },
      measurement: { state: 'observed', value: Math.round((end - start) * MIN) },
      accumulation: 'event',
      sequence: null,
      observedAt: at(end),
      recordedAt: at(end),
      attributes: { spanStart: at(start), waitKind },
      evidence: []
    })
  }

  /** A `tokens_total` report: cumulative at `sequence` (default 2), or missing with a reason. */
  tokens(where: Where, value: number | null, m: number, options: TokenOptions = {}): string {
    const measured: Measurement = value === null || options.missing !== undefined ? measurementOf(0, options.missing ?? 'not_reported') : tokenMeasurement(value, options.estimated === true)
    return this.add({
      metric: 'tokens_total',
      unit: 'tokens',
      scope: this.scope(where),
      source: { kind: options.source ?? 'host', actor: actorFor(where, options.actor) },
      measurement: measured,
      accumulation: 'cumulative',
      sequence: options.sequence ?? 2,
      observedAt: at(m),
      recordedAt: at(options.recorded ?? m),
      attributes: options.overhead === undefined ? {} : { overhead: options.overhead },
      evidence: [],
      ...(options.usage === undefined ? {} : { usage: options.usage })
    })
  }

  /** A `corrective_effort_ms` classification of `minutes` of effort (null: its value is missing). */
  classify(where: Where, minutes: number | null, entry: { as: string; at: number; cause?: WorkflowCause; work?: string; missing?: ObservationMissingReason }): string {
    return this.add({
      metric: 'corrective_effort_ms',
      unit: 'milliseconds',
      scope: this.scope(where),
      source: { kind: 'agent', actor: `worker-${where.attempt ?? 0}` },
      measurement: minutes === null ? measurementOf(0, entry.missing ?? 'not_reported') : measurementOf(Math.round(minutes * MIN), undefined),
      accumulation: 'event',
      sequence: null,
      observedAt: at(entry.at),
      recordedAt: at(entry.at),
      attributes: { classification: entry.as, ...(entry.work === undefined ? {} : { work: entry.work }) },
      evidence: [],
      ...(entry.cause === undefined ? {} : { cause: entry.cause })
    })
  }

  /** A budget version for `ticket` frozen at `frozen` minutes; `pinned` when it is the version of the dispatch revision. */
  budget(ticket: number, metric: 'active_ms' | 'tokens', saved: { value: number; frozen: number; version: number; pinned: boolean }): string {
    const { value, version } = saved
    const baselineId = `bl_01m7gb${String(ticket * 100 + version * 10 + (metric === 'tokens' ? 1 : 0)).padStart(20, '0')}`
    const unit = metric === 'tokens' ? 'tokens' : 'milliseconds'
    const baseline: BudgetBaseline = { baselineId, kind: 'budget', metric, unit, ticketId: tk(ticket), revisionId: `rv_01m65yene3p1dwngx9apev${pad(version)}pn`, version, value, frozenAt: at(saved.frozen) }
    const entry = (this.budgets[tk(ticket)] ??= { active_ms: { pinned: null, others: [] }, tokens: { pinned: null, others: [] } })
    entry[metric] = saved.pinned ? { ...entry[metric], pinned: baseline } : { ...entry[metric], others: [...entry[metric].others, baseline] }
    return baselineId
  }

  /** The stored observation with id `id`, to edit it in place. */
  observation(id: string): MetricObservation {
    const found = this.observations.find((o) => o.observationId === id)
    if (found === undefined) throw new Error(`no observation ${id}`)
    return found
  }

  /** The run as a `runEfficiency` input, read at `cutoff` minutes (default: the builder's). */
  input(otherRuns: CohortRunInput[] = [], cutoff = this.asOf): RunEfficiencyInput {
    return { ...this.cohortRun(cutoff), budgets: this.budgets, otherRuns }
  }

  /** The run's records as another run's cohort source sees them at `cutoff` minutes. */
  cohortRun(cutoff = this.asOf, runId = RUN): CohortRunInput {
    const timing: TimingInput = { runId, asOf: at(cutoff), events: this.events, activity: this.observations.filter((o) => o.metric === 'active_ms' || o.metric === 'wait_ms'), tickets: this.tickets }
    return { timing, observations: this.observations, plan: this.plan }
  }
}

export const tokenCell = (observations: readonly MetricObservation[]) => usageCell(observations, 'tokens_total')

export function efficiency(input: RunEfficiencyInput): RunEfficiencyView {
  return runEfficiency(input, tokenCell, SPACE_POLICY_V1)
}

export function ticketOf(view: RunEfficiencyView, n: number): TicketEfficiencyView {
  const ticket = view.tickets.find((t) => t.scope.level === 'ticket' && t.scope.ticketId === tk(n))
  if (ticket === undefined) throw new Error(`no ticket ${n}`)
  return ticket
}

const fixturesDir = new URL('../core/space/fixtures/', import.meta.url)
const COMPLETE = JSON.parse(readFileSync(new URL('rubric/complete.json', fixturesDir), 'utf8')) as { input: SpaceGradeInput }

/** E, T and K of the ticket graded by `gradeSpace` inside the complete rubric example (its subject and dispatch replaced). */
export function grade(view: TicketEfficiencyView): Record<'E' | 'T' | 'K', SpaceComponentResult> {
  if (view.scope.level !== 'ticket') throw new Error('ticket views only')
  const input: SpaceGradeInput = {
    ...COMPLETE.input,
    subject: { level: 'ticket', id: view.scope.ticketId },
    dispatchedAt: view.dispatchedAt,
    components: { ...COMPLETE.input.components, E: view.E, T: view.T, K: view.K }
  }
  const result = gradeSpace(input)
  const pick = (c: 'E' | 'T' | 'K'): SpaceComponentResult => {
    const found = result.components.find((component) => component.component === c)
    if (found === undefined) throw new Error(c)
    return found
  }
  return { E: pick('E'), T: pick('T'), K: pick('K') }
}

/** A checked-in efficiency fixture (`src/core/space/fixtures/efficiency`). */
export interface EfficiencyFixture {
  name: string
  description: string
  input: RunEfficiencyInput
  /** Read cutoffs every expectation must hold at (default: the input's own). */
  cutoffs?: string[]
  expect: { path: string; equals: unknown; note?: string }[]
}

export function loadEfficiencyFixtures(): EfficiencyFixture[] {
  const dir = new URL('efficiency/', fixturesDir)
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ name: file.replace(/\.json$/, ''), ...(JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Omit<EfficiencyFixture, 'name'>) }))
}
