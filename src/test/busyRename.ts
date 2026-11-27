/**
 * A `node:fs` whose `renameSync` refuses as Windows does while another handle holds the target open. Install it with
 * `vi.mock('node:fs', async original => (await import('<path>/test/busyRename')).withBusyRename(await original()))`,
 * then `refuseRenames(...)` before the writer under test. Not shipped. This module imports no `node:fs` itself, so the
 * mock factory can load it.
 *
 * While renames are refused, the writer's pauses between tries (`Atomics.wait`, see `replaceForgeFile`) are recorded
 * and return at once: a test asserts the retry schedule with `pausesTaken()` instead of timing a run whose journal
 * writes and promise turns a loaded runner can stall for longer than the whole bound.
 */
import type * as NodeFs from 'node:fs'
import { vi, type MockInstance } from 'vitest'

const state = { codes: [] as string[], calls: 0, armed: false, pauses: [] as number[] }
let pausing: MockInstance<typeof Atomics.wait> | undefined

/**
 * The next renames throw `codes` in turn (an empty code renames for real), then rename for real; counts every rename
 * asked from now on, and records every pause instead of waiting it.
 */
export function refuseRenames(...codes: string[]): void {
  Object.assign(state, { codes, calls: 0, armed: true, pauses: [] })
  pausing ??= vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {
    state.pauses.push(timeout ?? Number.POSITIVE_INFINITY)
    return 'timed-out'
  })
}

/** How many renames were asked since `refuseRenames`. */
export function renamesAsked(): number {
  return state.calls
}

/** The pauses, in milliseconds, the writer took between rename tries since `refuseRenames`. */
export function pausesTaken(): number[] {
  return state.pauses
}

/** Stops counting and refusing renames, and lets pauses wait again. */
export function releaseRenames(): void {
  Object.assign(state, { codes: [], calls: 0, armed: false, pauses: [] })
  pausing?.mockRestore()
  pausing = undefined
}

export function withBusyRename(fs: typeof NodeFs): typeof NodeFs {
  return {
    ...fs,
    renameSync(from: NodeFs.PathLike, to: NodeFs.PathLike): void {
      if (state.armed) {
        state.calls++
        const code = state.codes.shift()
        if (code) throw Object.assign(new Error(`${code}: rename refused`), { code })
      }
      fs.renameSync(from, to)
    }
  }
}
