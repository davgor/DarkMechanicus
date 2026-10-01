import { createContext, useContext, useEffect, useState } from 'react'

/** Time source for relative labels ("started 2h ago", lease countdowns); tests inject a fixed one. */
export interface Clock {
  now(): number
  /** Calls `tick` periodically; returns an unsubscribe function. */
  subscribe(tick: () => void): () => void
}

const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  subscribe: (tick) => {
    const handle = window.setInterval(tick, 1_000)
    return () => window.clearInterval(handle)
  }
}

export const ClockContext = createContext<Clock>(SYSTEM_CLOCK)

export function useClock(): Clock {
  return useContext(ClockContext)
}

/** The current time, re-rendering on every clock tick. */
export function useNow(): number {
  const clock = useClock()
  const [now, setNow] = useState(() => clock.now())
  useEffect(() => clock.subscribe(() => setNow(clock.now())), [clock])
  return now
}
