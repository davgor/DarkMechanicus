/**
 * `window.dm.terminals` for renderer tests that are not about terminals: every attach and sign-in is refused as
 * unavailable, and no terminal ever runs.
 */
import type { TerminalsApi } from '../../../shared/agents/terminalApi'

export function idleTerminals(): TerminalsApi {
  const refused = { ok: false, error: { code: 'unsupported_capability', message: 'Terminals are not part of this test.' } } as const
  return {
    attach: () => Promise.resolve(refused),
    signIn: () => Promise.resolve(refused)
  }
}
