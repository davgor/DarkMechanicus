/**
 * A `node:fs` whose `renameSync` refuses as Windows does while another handle holds the target open. Install it with
 * `vi.mock('node:fs', async original => (await import('<path>/test/busyRename')).withBusyRename(await original()))`,
 * then `refuseRenames(...)` before the writer under test. Not shipped. This module imports no `node:fs` itself, so the
 * mock factory can load it.
 */
import type * as NodeFs from 'node:fs'

const state = { codes: [] as string[], calls: 0, armed: false }

/** The next renames throw `codes` in turn (an empty code renames for real), then rename for real; counts every rename asked from now on. */
export function refuseRenames(...codes: string[]): void {
  Object.assign(state, { codes, calls: 0, armed: true })
}

/** How many renames were asked since `refuseRenames`. */
export function renamesAsked(): number {
  return state.calls
}

/** Stops counting and refusing renames. */
export function releaseRenames(): void {
  Object.assign(state, { codes: [], calls: 0, armed: false })
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
