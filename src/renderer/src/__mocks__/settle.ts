import { act } from '@testing-library/react'

/**
 * Lets pending, already-resolvable promise chains finish inside act(). Effects that start new
 * requests need another round, so it runs several (each round is one macrotask boundary).
 */
export async function settle(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
  }
}
