/**
 * The clock a cult supervisor runs on: wall time for the run's running-time arithmetic (`runState.ts`), and timeouts.
 * A delay past what the platform's `setTimeout` takes (2^31 - 1 ms, about 24.8 days) is waited out in chunks.
 */

export interface SupervisorClock {
  /** Wall time, ISO: what the cult store stamps transitions with, so the timer and the store agree. */
  now(): string
  /** Runs `callback` once after `ms` (at most `MAX_TIMEOUT_MS`); the returned function cancels it. */
  after(callback: () => void, ms: number): () => void
}

/** The longest delay `setTimeout` honours; a longer one fires at once. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1

/** Runs `callback` once after `ms`, re-arming in chunks of at most `MAX_TIMEOUT_MS`; the returned function cancels it. */
export function schedule(clock: Pick<SupervisorClock, 'after'>, ms: number, callback: () => void): () => void {
  let cancel: () => void = () => {}
  const arm = (left: number): void => {
    const chunk = Math.min(Math.max(0, left), MAX_TIMEOUT_MS)
    cancel = clock.after(() => {
      if (left > chunk) arm(left - chunk)
      else callback()
    }, chunk)
  }
  arm(ms)
  return () => {
    cancel()
  }
}

/** The real clock: `Date` and `setTimeout`. */
export const systemClock: SupervisorClock = {
  now: () => new Date().toISOString(),
  after: (callback, ms) => {
    const timeout = setTimeout(callback, ms)
    return () => {
      clearTimeout(timeout)
    }
  }
}
