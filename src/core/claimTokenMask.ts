/**
 * Masks Dark Mechanicus claim tokens. A claim token is `<attempt id>.<secret>` (see
 * `src/core/services/attempts.ts`): an `at_` stable id (26 Crockford base32 characters) and a
 * base64url secret (32 characters when generated; matched from 16 up so a shortened or
 * tail-adjacent token is still caught). Orchestrator chats hand execution packets, which carry
 * tokens, to their workers; anything stored or sent to the renderer goes through here first.
 */
const ID_CHAR = '[0-9a-hjkmnp-tv-z]'
const SECRET_CHAR = '[A-Za-z0-9_-]'

const CLAIM_TOKEN = new RegExp(`at_${ID_CHAR}{26}[.]${SECRET_CHAR}{16,}`, 'g')

/**
 * The end of a text that is, or may still grow into, a claim token: a token whose secret may go on,
 * a partial attempt id, or a lone `a`/`at`. Searching finds the earliest such start.
 */
const TOKEN_TAIL = new RegExp(`(?:at_${ID_CHAR}{26}[.]${SECRET_CHAR}*|at_${ID_CHAR}{0,26}|at?)$`)

/** A held tail that already reached the secret part. */
const SECRET_STARTED = new RegExp(`^at_${ID_CHAR}{26}[.]`)

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
      return SECRET_STARTED.test(rest) ? CLAIM_TOKEN_MASK : rest
    }
  }
}
