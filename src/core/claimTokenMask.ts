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
 *   string cut to a limit leaves it. Text that is shortened must still be masked before it is cut
 *   (`clipMasked`): after the cut, a token with an ellipsis behind it no longer ends the text.
 */
const ID_CHAR = '[0-9a-hjkmnp-tv-z]'
const SECRET_CHAR = '[A-Za-z0-9_-]'

/** What every token starts with: its attempt id and the dot before its secret. */
const TOKEN_START = `at_${ID_CHAR}{26}[.]`

/** A secret character of this token: one that does not start the next token of a glued pair. */
const OWN_SECRET_CHAR = `(?:(?!${TOKEN_START})${SECRET_CHAR})`

/** A whole token, or a short secret that the next token or the end of the text cuts off. */
const CLAIM_TOKEN = new RegExp(`${TOKEN_START}(?:${OWN_SECRET_CHAR}{16,}|${OWN_SECRET_CHAR}*(?=${TOKEN_START}|$))`, 'g')

/**
 * The end of a text that is, or may still grow into, a claim token: a token whose secret may go on,
 * a partial attempt id, or a lone `a`/`at`. Searching finds the earliest such start. The secret
 * of a glued pair's first token cannot reach the end of the text (the second token's dot is in the
 * way), so the tail is the second token and the first is released, masked, ahead of it.
 */
const TOKEN_TAIL = new RegExp(`(?:${TOKEN_START}${SECRET_CHAR}*|at_${ID_CHAR}{0,26}|at?)$`)

export const CLAIM_TOKEN_MASK = '[claim token masked]'

export function maskClaimTokens(text: string): string {
  return text.replace(CLAIM_TOKEN, CLAIM_TOKEN_MASK)
}

/**
 * `text` masked, then cut to `limit` characters with an ellipsis when it is longer. Masking first
 * means a cut that lands inside a token's secret cannot leave a part of it that is too short to
 * recognise. Every place that shortens text before storing or sending it uses this.
 */
export function clipMasked(text: string, limit: number): string {
  const masked = maskClaimTokens(text)
  return masked.length <= limit ? masked : `${masked.slice(0, limit)}…`
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

/** Masks one stream of text that arrives in pieces (streamed assistant text). */
export interface StreamMasker {
  /** The masked text that is safe to release now; a possible token at the end is held back. */
  push(delta: string): string
  /** Releases what is held (the stream ended); a held secret, even a cut-off one, is masked. */
  flush(): string
}

/**
 * Masking each piece alone would miss a token split across pieces, so the masker holds back any
 * end of the text that is or may become a token until the next piece (or the end) settles it.
 */
export function createStreamMasker(): StreamMasker {
  let held = ''
  return {
    push(delta) {
      const text = held + delta
      const tail = text.search(TOKEN_TAIL)
      const cut = tail === -1 ? text.length : tail
      held = text.slice(cut)
      return maskClaimTokens(text.slice(0, cut))
    },
    flush() {
      const rest = held
      held = ''
      return maskClaimTokens(rest)
    }
  }
}
