import { useEffect, useState } from 'react'
import type { Scheduler } from './scheduler'

interface TickOptions {
  scheduler: Scheduler
  everyMs: number
  /** Ticks only run while enabled. */
  enabled: boolean
}

/**
 * A counter that goes up on every interval and whenever the window regains focus. Feed it into a
 * refetch key for things no event announces, such as agent sessions coming and going or files
 * committed outside the app.
 */
export function useRefreshTick({ scheduler, everyMs, enabled }: TickOptions): number {
  const [ticks, setTicks] = useState(0)
  useEffect(() => {
    if (!enabled) {
      return undefined
    }
    const bump = (): void => setTicks((previous) => previous + 1)
    const stop = scheduler.every(everyMs, bump)
    window.addEventListener('focus', bump)
    return () => {
      stop()
      window.removeEventListener('focus', bump)
    }
  }, [scheduler, everyMs, enabled])
  return ticks
}
