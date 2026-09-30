import { act } from '@testing-library/react'

/** Enough promise hops for the longest request chain in the app (load, parse, set state). */
const MICROTASKS_PER_ROUND = 40

/**
 * Lets pending, already-resolvable promise chains finish inside act(). It only yields to the
 * microtask queue (no timers), so it is deterministic. Effects that start new requests need
 * another round, so it runs several.
 */
export async function settle(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      for (let hop = 0; hop < MICROTASKS_PER_ROUND; hop += 1) {
        await Promise.resolve()
      }
    })
  }
}
