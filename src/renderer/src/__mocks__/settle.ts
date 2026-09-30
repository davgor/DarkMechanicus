import { act } from '@testing-library/react'

/** Lets every pending, already-resolvable promise chain finish, inside act(). */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
}
