/**
 * A made-up claim token (the real shape, not a real secret) and text that a shortening step would cut
 * inside its secret, for the adapters' masking tests.
 */
import { CLAIM_TOKEN_MASK } from '../claimTokenMask'

export const ATTEMPT_ID = 'at_0123456789abcdefghjkmnpqrs'
export const SECRET = 'Qk3-Zx9_Lm2Wv7TbYh5Nd8RcGf4SjA6u'
export const TOKEN = `${ATTEMPT_ID}.${SECRET}`

/**
 * Text that is `limit` characters long up to where a cut at `limit` would fall `kept` characters into the token's
 * secret, with the rest of the token, a space and `after` more characters behind the cut.
 */
export function cutInsideToken(limit: number, kept: number, after = 100): string {
  return `${'x'.repeat(limit - ATTEMPT_ID.length - 1 - kept)}${TOKEN} ${'y'.repeat(after)}`
}

/** What `cutInsideToken(limit, kept, after)` comes out as when it is masked first and then cut to `limit`. */
export function maskedThenCut(limit: number, kept: number, after = 100): string {
  const lead = limit - ATTEMPT_ID.length - 1 - kept
  return `${'x'.repeat(lead)}${CLAIM_TOKEN_MASK} ${'y'.repeat(Math.min(after, limit - lead - CLAIM_TOKEN_MASK.length - 1))}…`
}

/** True when `value`, as JSON, holds any five characters in a row of the secret. */
export function leaksSecret(value: unknown): boolean {
  const json = JSON.stringify(value)
  return Array.from({ length: SECRET.length - 4 }, (_, start) => SECRET.slice(start, start + 5)).some((piece) => json.includes(piece))
}
