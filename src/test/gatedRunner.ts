/** A git runner that holds one chosen git call until the test releases it, to force an interleaving. Not shipped. */
import type { GitRunner, GitRunRequest } from '../main/git/runner'

interface GatedRunner extends GitRunner {
  /** Every request, in the order it reached the runner (the held one included). */
  calls: GitRunRequest[]
  /** Settles when the held call has arrived and is waiting. */
  reached: Promise<void>
  /** Lets the held call go on to git. */
  release(): void
}

/** Holds the first request `matches` picks until `release()`; every other request goes straight to `inner`. */
export function gatedRunner(inner: GitRunner, matches: (request: GitRunRequest) => boolean): GatedRunner {
  let arrive: () => void = () => undefined
  let open: () => void = () => undefined
  const reached = new Promise<void>((resolve) => {
    arrive = resolve
  })
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  let held = false
  const calls: GitRunRequest[] = []
  return {
    calls,
    reached,
    release: () => open(),
    async run(request) {
      calls.push(request)
      if (!held && matches(request)) {
        held = true
        arrive()
        await gate
      }
      return inner.run(request)
    }
  }
}
