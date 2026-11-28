/**
 * A `node:fs` whose `renameSync` refuses as Windows does while another handle holds the target open, and whose
 * `unlinkSync` can refuse a delete the same way. Install it with
 * `vi.mock('node:fs', async original => (await import('<path>/test/busyRename')).withBusyRename(await original()))`,
 * then `refuseRenames(...)` or `refuseUnlinks(...)` before the writer under test. Not shipped. This module imports no
 * `node:fs` itself, so the mock factory can load it.
 */
import type * as NodeFs from 'node:fs'

const state = { codes: [] as string[], calls: 0, armed: false }
const unlinks = { pattern: null as RegExp | null, code: '' }
const BUSY = ['EPERM', 'EACCES', 'EBUSY']
const realWait = Atomics.wait

/** The next renames throw `codes` in turn (an empty code renames for real), then rename for real; counts every rename asked from now on. */
export function refuseRenames(...codes: string[]): void {
  Object.assign(state, { codes, calls: 0, armed: true })
}

/**
 * Refuses each of a writer's `attempts` renames as busy (EPERM, EACCES, EBUSY in turn) and skips its blocking pauses
 * between them, so a test of the bound takes no wall time; returns the refused codes in order. `releaseRenames`
 * restores the pauses.
 */
export function refuseUntilLocked(attempts: number): string[] {
  const codes = Array.from({ length: attempts }, (_, index) => BUSY[index % BUSY.length])
  refuseRenames(...codes)
  Atomics.wait = () => 'timed-out'
  return codes
}

/** How many renames were asked since `refuseRenames`. */
export function renamesAsked(): number {
  return state.calls
}

/** Every delete of a path matching `pattern` throws `code` until `releaseRenames`, as Windows refuses to delete a held file. */
export function refuseUnlinks(pattern: RegExp, code = 'EPERM'): void {
  Object.assign(unlinks, { pattern, code })
}

/** Stops counting and refusing renames and deletes, and lets pauses block again. */
export function releaseRenames(): void {
  Object.assign(state, { codes: [], calls: 0, armed: false })
  Object.assign(unlinks, { pattern: null, code: '' })
  Atomics.wait = realWait
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
    },
    unlinkSync(path: NodeFs.PathLike): void {
      if (unlinks.pattern?.test(String(path))) throw Object.assign(new Error(`${unlinks.code}: delete refused`), { code: unlinks.code })
      fs.unlinkSync(path)
    }
  }
}
