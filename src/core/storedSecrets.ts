/**
 * What may be stored of a command's response. An idempotent command keeps its response so that a
 * repeat of the request can return it (`withIdempotency`), and that copy outlives the call in
 * `state.sqlite` and is handed to anyone who replays the key. A secret is shown once, to the caller
 * that caused it, so the stored copy never holds one:
 *
 * - a field listed in `SECRET_FIELDS` is stored as null;
 * - so is any other field whose name ends in a secret word (`sessionToken`, `API_SECRET`,
 *   `dbPassword`), unless `PUBLIC_FIELDS` lists it: a new secret-bearing field is redacted before
 *   anyone remembers to list it, not leaked until they do;
 * - every string, field names included, has whole claim tokens and grant tokens masked, wherever a
 *   person or agent pasted one. Stored text is never cut, so a token cannot be cut short in it, and
 *   an attempt id at the end of a text (`Retry of at_<id>.`) is kept as the id it is;
 * - the keys of a `DATA_KEYED_FIELDS` map are data, not field names: masked, never judged by name.
 *
 * The response is serialized before it is redacted, so what is checked is exactly what is stored:
 * a class instance or a `toJSON` cannot hide a field from the check.
 */
import { maskWholeClaimTokens } from './claimTokenMask'

/**
 * Fields known to carry a secret: the claim token in `claim_ticket`'s packet, the token a grant is
 * issued with, and an attempt's stored claim secret.
 */
const SECRET_FIELDS: Record<string, true> = { claimToken: true, token: true, claimSecret: true, claim_secret: true, secret: true }

/**
 * Fields named like a secret that hold none: a fencing token is the attempt's public claim number, and
 * the others are token counts of a model's context window and a ticket's estimated input.
 */
const PUBLIC_FIELDS: Record<string, true> = { fencingToken: true, contextWindowTokens: true, estimatedInputTokens: true }

/** The last word of a field name, trailing digits dropped, that makes it a secret. */
const SECRET_WORDS: Record<string, true> = {
  token: true,
  tokens: true,
  secret: true,
  secrets: true,
  password: true,
  passphrase: true,
  credential: true,
  credentials: true,
  apikey: true
}

/** The last two words of a field name that make it a secret. */
const SECRET_WORD_PAIRS: Record<string, true> = { 'api key': true, 'private key': true, 'access key': true, 'signing key': true }

/** A grant token (`dmg_` and 64 hex characters, `services/grants.ts`), or 16 or more of them cut short. */
const GRANT_TOKEN = /dmg_[0-9a-f]{16,}/gi

export const GRANT_TOKEN_MASK = '[grant token masked]'

function isSecretField(name: string): boolean {
  if (SECRET_FIELDS[name] === true) {
    return true
  }
  if (PUBLIC_FIELDS[name] === true) {
    return false
  }
  const words = name
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .map((word) => word.toLowerCase().replace(/\d+$/, ''))
    .filter((word) => word !== '')
  const last = words.at(-1) ?? ''
  return SECRET_WORDS[last] === true || SECRET_WORD_PAIRS[`${words.at(-2) ?? ''} ${last}`] === true
}

function maskSecretText(text: string): string {
  return maskWholeClaimTokens(text).replace(GRANT_TOKEN, GRANT_TOKEN_MASK)
}

/**
 * Fields whose keys are data a caller chose, not field names: `refMap` maps a draft's client refs
 * (any `[A-Za-z0-9_.-]`, so `api-key` is a valid ref) to the ticket ids they became. Those keys are
 * masked as text but never read as secret names; the values are redacted as usual.
 */
const DATA_KEYED_FIELDS: Record<string, true> = { refMap: true }

/** `value` is parsed JSON: null, a boolean, number, string, array or plain object. */
function redact(value: unknown, keysAreData = false): unknown {
  if (typeof value === 'string') {
    return maskSecretText(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => {
        const secret = !keysAreData && isSecretField(name)
        return [maskSecretText(name), secret ? null : redact(item, !keysAreData && DATA_KEYED_FIELDS[name] === true)]
      })
    )
  }
  return value
}

/** `parsed` (a value as `JSON.parse` returns it) with every secret redacted, as JSON. */
export function redactedJson(parsed: unknown): string {
  return JSON.stringify(redact(parsed))
}

/** The JSON that may be stored for `response`: its serialized form, redacted (what serializes to nothing is stored as null). */
export function storableJson(response: unknown): string {
  return redactedJson(JSON.parse(JSON.stringify(response) ?? 'null'))
}
