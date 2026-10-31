import { setTimeout as delay } from 'node:timers/promises'

/**
 * Resolves true once process `pid` is gone, false when it is still running after `ms`. This polls the real clock,
 * for a process that is neither the test's child nor holding one of its pipes: no event says such a process ended,
 * and a real process does not run on fake timers.
 */
export async function goneWithin(pid: number, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await delay(10)
  }
}
