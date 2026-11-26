import type { Clock } from '../epic/clock'

export function createManualClock(start: number): Clock & { set(ms: number): void; advance(ms: number): void } {
  let now = start
  const ticks = new Set<() => void>()
  function set(ms: number): void {
    now = ms
    for (const tick of ticks) tick()
  }
  return {
    now: () => now,
    subscribe(tick) {
      ticks.add(tick)
      return () => { ticks.delete(tick) }
    },
    set,
    advance: (ms) => set(now + ms)
  }
}
