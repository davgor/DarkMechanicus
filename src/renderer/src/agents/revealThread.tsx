import { createContext } from 'react'

/**
 * A request to show one subagent thread in the transcript: every block on `path` (the target's enclosing
 * threads and the target itself) opens, and the `target` block scrolls into view once per `nonce`.
 */
export interface RevealThread {
  path: ReadonlySet<string>
  target: string | null
  nonce: number
}

export const RevealThreadContext = createContext<RevealThread>({ path: new Set(), target: null, nonce: 0 })
