import { createContext } from 'react'

/**
 * A request to show one subagent thread in the transcript: every block on `path` (the target's enclosing
 * threads and the target itself) opens, and the `target` block scrolls into view, once per `nonce`.
 * `handled` is owned by the request's issuer and outlives the blocks: it maps a thread id to the last nonce that
 * block acted on, so a block that remounts under the same nonce (its parent collapsed and reopened) stays as the
 * person left it instead of revealing itself again.
 */
export interface RevealThread {
  path: ReadonlySet<string>
  target: string | null
  nonce: number
  handled: Map<string, number>
}

export const RevealThreadContext = createContext<RevealThread>({ path: new Set(), target: null, nonce: 0, handled: new Map() })
