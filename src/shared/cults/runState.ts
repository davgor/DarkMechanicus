/**
 * The cult run lifecycle as a pure state machine: `starting → running ⇄ paused → shutting_down → ended`.
 * The timer counts only running time, so it is frozen while paused or shutting down; a run with no time limit
 * (`timeLimitMs` null) never expires. No database, process or timer code: the store persists what this returns.
 */

const RUN_STATES = ['starting', 'running', 'paused', 'shutting_down', 'ended'] as const
export type RunState = (typeof RUN_STATES)[number]

const END_REASONS = ['completed', 'expired', 'stopped', 'killed', 'interrupted', 'failed'] as const
export type EndReason = (typeof END_REASONS)[number]

/** Reasons that wind a run down gracefully through `shutting_down`. */
export type ShutdownReason = Extract<EndReason, 'completed' | 'expired' | 'stopped'>
/** Reasons that end a run at once, from any state but `ended`. */
export type AbortReason = Extract<EndReason, 'killed' | 'interrupted' | 'failed'>

export type RunEvent =
  | { type: 'started' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'shutdown'; reason: ShutdownReason }
  | { type: 'finish' }
  | { type: 'abort'; reason: AbortReason }

/** The lifecycle fields of a run; timestamps are ISO strings. */
export interface RunClock {
  state: RunState
  /** Set when shutdown starts (or the run aborts) and kept once ended. */
  endReason: EndReason | null
  /** Null: unlimited. */
  timeLimitMs: number | null
  /** Running time banked by earlier running spans. */
  accumulatedRunningMs: number
  /** Start of the current running span; null unless `running`. */
  runningSince: string | null
  endedAt: string | null
}

export const DEFAULT_CAP = 6
export const MAX_CAP = 24
export const MIN_CAP = 1

const SECOND = 1000
const MINUTE = 60 * SECOND

export const MIN_TIME_LIMIT_MS = MINUTE
export const DEFAULT_ACOLYTE_GRACE_MS = 3 * MINUTE
export const DEFAULT_MAGOS_WINDOW_MS = 2 * MINUTE
export const MIN_SHUTDOWN_TIMING_MS = 30 * SECOND
export const MAX_SHUTDOWN_TIMING_MS = 60 * MINUTE
/** What the backstop adds after the acolyte grace and the Magos window before a run is killed. */
const BACKSTOP_MARGIN_MS = MINUTE

/** A refused lifecycle move: the state it was attempted from and the event. */
export class RunTransitionError extends Error {
  readonly code = 'invalid_state'
  readonly from: RunState
  readonly event: RunEvent['type']

  constructor(from: RunState, event: RunEvent) {
    super(`A cult run cannot ${describe(event)} while ${from.replace('_', ' ')}.`)
    this.name = 'RunTransitionError'
    this.from = from
    this.event = event.type
  }
}

function describe(event: RunEvent): string {
  switch (event.type) {
    case 'started':
      return 'start running'
    case 'shutdown':
      return `shut down (${event.reason})`
    case 'abort':
      return `end (${event.reason})`
    default:
      return event.type
  }
}

/** Running time so far, including the current span. */
function runningMs(run: RunClock, now: string): number {
  const span = run.state === 'running' && run.runningSince ? Date.parse(now) - Date.parse(run.runningSince) : 0
  return run.accumulatedRunningMs + Math.max(0, span)
}

/** Time left on the limit, counting only running time; null for an unlimited run. Never negative. */
export function remainingMs(run: RunClock, now: string): number | null {
  if (run.timeLimitMs === null) return null
  return Math.max(0, run.timeLimitMs - runningMs(run, now))
}

/** Whether a running run has used up its time limit; an unlimited run never expires. */
export function isExpired(run: RunClock, now: string): boolean {
  return run.state === 'running' && remainingMs(run, now) === 0
}

/** Banks the current running span (if any) and closes it. */
function bank(run: RunClock, now: string): Pick<RunClock, 'accumulatedRunningMs' | 'runningSince'> {
  return { accumulatedRunningMs: runningMs(run, now), runningSince: null }
}

/** From which states each graceful reason may start shutdown; `expired` also needs the limit used up. */
const SHUTDOWN_FROM: Readonly<Record<ShutdownReason, readonly RunState[]>> = {
  completed: ['starting', 'running', 'paused'],
  stopped: ['starting', 'running', 'paused'],
  expired: ['running']
}

function canShutDown(run: RunClock, reason: ShutdownReason, now: string): boolean {
  return SHUTDOWN_FROM[reason].includes(run.state) && (reason !== 'expired' || isExpired(run, now))
}

type Step<E extends RunEvent> = (run: RunClock, event: E, now: string) => Partial<RunClock> | null

/** Each event's move, or null when it is illegal from the run's state. */
const STEPS: { [K in RunEvent['type']]: Step<Extract<RunEvent, { type: K }>> } = {
  started: (run, _event, now) => (run.state === 'starting' ? { state: 'running', runningSince: now } : null),
  pause: (run, _event, now) => (run.state === 'running' ? { state: 'paused', ...bank(run, now) } : null),
  resume: (run, _event, now) => (run.state === 'paused' ? { state: 'running', runningSince: now } : null),
  shutdown: (run, event, now) =>
    canShutDown(run, event.reason, now) ? { state: 'shutting_down', endReason: event.reason, ...bank(run, now) } : null,
  finish: (run, _event, now) => (run.state === 'shutting_down' ? { state: 'ended', endedAt: now } : null),
  abort: (run, event, now) =>
    run.state === 'ended' ? null : { state: 'ended', endReason: event.reason, endedAt: now, ...bank(run, now) }
}

function next(run: RunClock, event: RunEvent, now: string): Partial<RunClock> | null {
  return (STEPS[event.type] as Step<RunEvent>)(run, event, now)
}

/** Applies one lifecycle event, returning the moved run; throws `RunTransitionError` for an illegal move. */
export function transition<T extends RunClock>(run: T, event: RunEvent, now: string): T {
  const change = next(run, event, now)
  if (change === null) throw new RunTransitionError(run.state, event)
  return { ...run, ...change }
}

/** Null when the cap is a whole number from 1 to 24; otherwise why it is refused. */
export function capIssue(cap: number): string | null {
  if (!Number.isInteger(cap) || cap < MIN_CAP) return `The acolyte cap must be a whole number of at least ${MIN_CAP}.`
  if (cap > MAX_CAP) return `The acolyte cap cannot exceed ${MAX_CAP}.`
  return null
}

/** Null when the limit is unlimited or at least one minute (no upper bound); otherwise why it is refused. */
export function timeLimitIssue(timeLimitMs: number | null): string | null {
  if (timeLimitMs === null) return null
  if (!Number.isSafeInteger(timeLimitMs) || timeLimitMs < MIN_TIME_LIMIT_MS)
    return 'A time limit must be at least 1 minute, or unlimited.'
  return null
}

/** Null when a shutdown timing (acolyte grace or Magos window) is from 30 seconds to 60 minutes. */
export function shutdownTimingIssue(ms: number): string | null {
  if (!Number.isSafeInteger(ms) || ms < MIN_SHUTDOWN_TIMING_MS || ms > MAX_SHUTDOWN_TIMING_MS)
    return 'Shutdown timings must be from 30 seconds to 60 minutes.'
  return null
}

/** How long after shutdown starts a run is killed if it has not ended: derived, never stored. */
export function backstopMs(acolyteGraceMs: number, magosWindowMs: number): number {
  return acolyteGraceMs + magosWindowMs + BACKSTOP_MARGIN_MS
}

export type PetitionState = 'pending' | 'approved' | 'denied'

interface PetitionDecision {
  state: PetitionState
  decidedAt: string | null
}

/** When a run ends, every pending petition is denied at that moment; decided ones are kept as they are. */
export function denyPendingPetitions<T extends PetitionDecision>(petitions: readonly T[], now: string): T[] {
  return petitions.map((petition) =>
    petition.state === 'pending' ? { ...petition, state: 'denied', decidedAt: now } : petition
  )
}
