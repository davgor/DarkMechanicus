import { describe, expect, it } from 'vitest'
import {
  backstopMs,
  capIssue,
  DEFAULT_ACOLYTE_GRACE_MS,
  DEFAULT_CAP,
  DEFAULT_MAGOS_WINDOW_MS,
  denyPendingPetitions,
  isExpired,
  MAX_CAP,
  remainingMs,
  type RunClock,
  type RunEvent,
  type RunState,
  RunTransitionError,
  shutdownTimingIssue,
  timeLimitIssue,
  transition
} from './runState'

const T0 = '2026-01-01T00:00:00.000Z'
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()
const MIN = 60_000

const fresh = (timeLimitMs: number | null = 10 * MIN): RunClock => ({
  state: 'starting',
  endReason: null,
  timeLimitMs,
  accumulatedRunningMs: 0,
  runningSince: null,
  endedAt: null
})

/** A run moved into `state` at T0 by the shortest legal path. */
function inState(state: RunState): RunClock {
  const paths: Record<RunState, RunEvent[]> = {
    starting: [],
    running: [{ type: 'started' }],
    paused: [{ type: 'started' }, { type: 'pause' }],
    shutting_down: [{ type: 'shutdown', reason: 'stopped' }],
    ended: [{ type: 'abort', reason: 'killed' }]
  }
  return paths[state].reduce((run, event) => transition(run, event, T0), fresh())
}

const EVENTS: RunEvent[] = [
  { type: 'started' },
  { type: 'pause' },
  { type: 'resume' },
  { type: 'shutdown', reason: 'completed' },
  { type: 'shutdown', reason: 'stopped' },
  { type: 'shutdown', reason: 'expired' },
  { type: 'finish' },
  { type: 'abort', reason: 'killed' },
  { type: 'abort', reason: 'interrupted' },
  { type: 'abort', reason: 'failed' }
]

const key = (event: RunEvent): string => ('reason' in event ? `${event.type}:${event.reason}` : event.type)

/** Every legal move and where it lands; anything else must be refused. `expired` needs an expired run (below). */
const LEGAL: Record<RunState, Record<string, RunState>> = {
  starting: { started: 'running', 'shutdown:completed': 'shutting_down', 'shutdown:stopped': 'shutting_down', 'abort:killed': 'ended', 'abort:interrupted': 'ended', 'abort:failed': 'ended' },
  running: { pause: 'paused', 'shutdown:completed': 'shutting_down', 'shutdown:stopped': 'shutting_down', 'abort:killed': 'ended', 'abort:interrupted': 'ended', 'abort:failed': 'ended' },
  paused: { resume: 'running', 'shutdown:completed': 'shutting_down', 'shutdown:stopped': 'shutting_down', 'abort:killed': 'ended', 'abort:interrupted': 'ended', 'abort:failed': 'ended' },
  shutting_down: { finish: 'ended', 'abort:killed': 'ended', 'abort:interrupted': 'ended', 'abort:failed': 'ended' },
  ended: {}
}

describe('transition: every legal and illegal move', () => {
  for (const from of Object.keys(LEGAL) as RunState[]) {
    for (const event of EVENTS) {
      const to = LEGAL[from][key(event)]
      it(`${from} + ${key(event)} → ${to ?? 'refused'}`, () => {
        const run = inState(from)
        if (to === undefined) {
          const error = (() => {
            try {
              transition(run, event, at(MIN))
            } catch (thrown: unknown) {
              return thrown
            }
          })()
          expect(error).toBeInstanceOf(RunTransitionError)
          expect((error as RunTransitionError).from).toBe(from)
        } else {
          expect(transition(run, event, at(MIN)).state).toBe(to)
        }
      })
    }
  }

  it('does not change the run it was given', () => {
    const run = inState('running')
    transition(run, { type: 'pause' }, at(MIN))
    expect(run.state).toBe('running')
  })
})

describe('transition: end reasons and expiry', () => {
  it('shuts down for expiry only once a running run has used its limit', () => {
    const run = transition(fresh(5 * MIN), { type: 'started' }, T0)
    expect(() => transition(run, { type: 'shutdown', reason: 'expired' }, at(4 * MIN))).toThrow(RunTransitionError)
    const down = transition(run, { type: 'shutdown', reason: 'expired' }, at(5 * MIN))
    expect(down).toMatchObject({ state: 'shutting_down', endReason: 'expired', accumulatedRunningMs: 5 * MIN, runningSince: null })
  })

  it('keeps the shutdown reason when the run finishes and stamps endedAt', () => {
    const down = transition(inState('running'), { type: 'shutdown', reason: 'completed' }, at(MIN))
    expect(transition(down, { type: 'finish' }, at(2 * MIN))).toMatchObject({ state: 'ended', endReason: 'completed', endedAt: at(2 * MIN) })
  })

  it('an abort ends at once with its own reason, banking the running time', () => {
    const ended = transition(inState('running'), { type: 'abort', reason: 'interrupted' }, at(3 * MIN))
    expect(ended).toMatchObject({ state: 'ended', endReason: 'interrupted', accumulatedRunningMs: 3 * MIN, endedAt: at(3 * MIN) })
  })
})

describe('remainingMs', () => {
  it('counts only running time: frozen while paused, counting again after resume', () => {
    let run = transition(fresh(10 * MIN), { type: 'started' }, T0)
    expect(remainingMs(run, at(4 * MIN))).toBe(6 * MIN)
    run = transition(run, { type: 'pause' }, at(4 * MIN))
    expect(remainingMs(run, at(4 * MIN))).toBe(6 * MIN)
    expect(remainingMs(run, at(90 * MIN))).toBe(6 * MIN)
    run = transition(run, { type: 'resume' }, at(90 * MIN))
    expect(remainingMs(run, at(92 * MIN))).toBe(4 * MIN)
    expect(isExpired(run, at(95 * MIN))).toBe(false)
  })

  it('reaches zero at expiry and never goes negative', () => {
    const run = transition(fresh(10 * MIN), { type: 'started' }, T0)
    expect(remainingMs(run, at(10 * MIN))).toBe(0)
    expect(isExpired(run, at(10 * MIN))).toBe(true)
    expect(remainingMs(run, at(50 * MIN))).toBe(0)
  })

  it('is null for an unlimited run, which never expires', () => {
    const run = transition(fresh(null), { type: 'started' }, T0)
    expect(remainingMs(run, at(365 * 24 * 60 * MIN))).toBeNull()
    expect(isExpired(run, at(365 * 24 * 60 * MIN))).toBe(false)
    expect(() => transition(run, { type: 'shutdown', reason: 'expired' }, at(10 ** 12))).toThrow(RunTransitionError)
  })

  it('is frozen while shutting down', () => {
    const down = transition(transition(fresh(10 * MIN), { type: 'started' }, T0), { type: 'shutdown', reason: 'stopped' }, at(2 * MIN))
    expect(remainingMs(down, at(9 * MIN))).toBe(8 * MIN)
  })
})

describe('cap, time limit and shutdown timing rules', () => {
  it('defaults the cap to 6 and refuses more than 24, zero and fractions', () => {
    expect(DEFAULT_CAP).toBe(6)
    expect(MAX_CAP).toBe(24)
    expect(capIssue(24)).toBeNull()
    expect(capIssue(1)).toBeNull()
    expect(capIssue(25)).toMatch(/cannot exceed 24/)
    expect(capIssue(0)).not.toBeNull()
    expect(capIssue(2.5)).not.toBeNull()
  })

  it('accepts unlimited or at least one minute with no upper bound', () => {
    expect(timeLimitIssue(null)).toBeNull()
    expect(timeLimitIssue(MIN)).toBeNull()
    expect(timeLimitIssue(1000 * 24 * 60 * MIN)).toBeNull()
    expect(timeLimitIssue(MIN - 1)).not.toBeNull()
    expect(timeLimitIssue(0)).not.toBeNull()
  })

  it('bounds acolyte grace and Magos window from 30 s to 60 min with defaults 3 and 2 min', () => {
    expect(DEFAULT_ACOLYTE_GRACE_MS).toBe(3 * MIN)
    expect(DEFAULT_MAGOS_WINDOW_MS).toBe(2 * MIN)
    expect(shutdownTimingIssue(30_000)).toBeNull()
    expect(shutdownTimingIssue(60 * MIN)).toBeNull()
    expect(shutdownTimingIssue(29_999)).not.toBeNull()
    expect(shutdownTimingIssue(60 * MIN + 1)).not.toBeNull()
  })

  it('derives the backstop as grace + window + 60 s', () => {
    expect(backstopMs(DEFAULT_ACOLYTE_GRACE_MS, DEFAULT_MAGOS_WINDOW_MS)).toBe(6 * MIN)
    expect(backstopMs(30_000, 60 * MIN)).toBe(30_000 + 61 * MIN)
  })
})

describe('denyPendingPetitions', () => {
  it('denies pending petitions at the end time and keeps decided ones', () => {
    const petitions = [
      { id: 'a', state: 'pending' as const, decidedAt: null },
      { id: 'b', state: 'approved' as const, decidedAt: T0 },
      { id: 'c', state: 'denied' as const, decidedAt: T0 }
    ]
    expect(denyPendingPetitions(petitions, at(MIN))).toEqual([
      { id: 'a', state: 'denied', decidedAt: at(MIN) },
      { id: 'b', state: 'approved', decidedAt: T0 },
      { id: 'c', state: 'denied', decidedAt: T0 }
    ])
  })
})
