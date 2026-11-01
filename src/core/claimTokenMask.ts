/**
 * Masks Dark Mechanicus claim tokens. A claim token is `<attempt id>.<secret>` (see
 * `src/core/services/attempts.ts`): an `at_` stable id (26 Crockford base32 characters) and a
 * base64url secret (32 characters when generated). Orchestrator chats hand execution packets, which
 * carry tokens, to their workers; anything stored or sent to the renderer goes through here first.
 *
 * Three shapes beyond a whole token are masked too:
 * - a secret of 16 characters or more, which is how a shortened or tail-adjacent token still reads;
 * - two tokens glued together with no separator: a secret has no `.`, so the next `at_<id>.` is where
 *   a secret ends, not part of it;
 * - a token cut short at the end of a text (`at_<id>.` and 0 to 15 secret characters), the way a long
 *   string cut to a limit leaves it.
 */
const ID_CHAR = '[0-9a-hjkmnp-tv-z]'
const SECRET_CHAR = '[A-Za-z0-9_-]'

/** What every token starts with: its attempt id and the dot before its secret. */
const TOKEN_START = `at_${ID_CHAR}{26}[.]`

/** A secret character of this token: one that does not start the next token of a glued pair. */
const OWN_SECRET_CHAR = `(?:(?!${TOKEN_START})${SECRET_CHAR})`

/** A whole token, or a short secret that the next token or the end of the text cuts off. */
const CLAIM_TOKEN = new RegExp(`${TOKEN_START}(?:${OWN_SECRET_CHAR}{16,}|${OWN_SECRET_CHAR}*(?=${TOKEN_START}|$))`, 'g')

export const CLAIM_TOKEN_MASK = '[claim token masked]'

export function maskClaimTokens(text: string): string {
  return text.replace(CLAIM_TOKEN, CLAIM_TOKEN_MASK)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function maskValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return maskClaimTokens(value)
  }
  if (Array.isArray(value)) {
    return value.map(maskValue)
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [maskClaimTokens(key), maskValue(item)]))
  }
  return value
}

/** A copy of `value` with claim tokens masked in every string, object key and nested array or object. */
export function maskClaimTokensDeep<T>(value: T): T {
  return maskValue(value) as T
}

/** A whole token only: an attempt id, its dot, and 16 or more secret characters. */
const WHOLE_CLAIM_TOKEN = new RegExp(`${TOKEN_START}${OWN_SECRET_CHAR}{16,}`, 'g')

/**
 * Masks whole claim tokens only, for text that is stored as it was given and never cut: there a
 * token cannot have been cut short, so an attempt id at the end of a text (`Retry of at_<id>.`,
 * `docs/at_<id>.json`) is an id, and is kept.
 */
export function maskWholeClaimTokens(text: string): string {
  return text.replace(WHOLE_CLAIM_TOKEN, CLAIM_TOKEN_MASK)
}
