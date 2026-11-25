import { CLAIM_TOKEN, claimedAttemptId } from '../../core/space/claimedAttempt'

/** Main-memory only. Never log, persist, or push this event; verify the token before binding. */
export interface ThreadClaimEvent {
  type: 'thread_claim'
  threadId: string
  attemptId: string
  token: string
}

/** Reject ambiguity even when two different secrets name the same attempt. Not claim verification. */
export function threadClaim(threadId: string, prompt: string): ThreadClaimEvent | null {
  const attemptId = claimedAttemptId(prompt)
  if (attemptId === null) return null
  const tokens = new Set([...prompt.matchAll(CLAIM_TOKEN)].map((match) => match[0]))
  const token = tokens.size === 1 ? tokens.values().next().value : undefined
  return token === undefined ? null : { type: 'thread_claim', threadId, attemptId, token }
}
