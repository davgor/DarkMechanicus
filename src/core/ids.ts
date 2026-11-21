import { createHash, randomBytes } from 'node:crypto'
import { fail } from './errors'

/** Crockford base32, lowercase (no i, l, o, u). */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
const TIME_CHARS = 10
const RANDOM_CHARS = 16

export const ID_PREFIXES = {
  project: 'pj',
  machine: 'mc',
  session: 'ss',
  epic: 'ep',
  ticket: 'tk',
  sprint: 'sp',
  revision: 'rv',
  run: 'rn',
  attempt: 'at',
  report: 'rp',
  approval: 'ap',
  checkpoint: 'ck',
  hostCatalog: 'hc',
  comment: 'cm',
  rowCheck: 'rk',
  grant: 'gr',
  savePermission: 'sv',
  kanbanCard: 'kc',
  kanbanAttempt: 'ka',
  kanbanEvent: 'ke',
  attachment: 'im',
  mailEndpoint: 'me',
  mailMessage: 'mm',
  /** Reserved for persisted legacy wake-attempt ids; automatic context delivery creates none. */
  mailWake: 'mw',
  /** A SPACE metric observation in the measurement ledger. */
  metricObservation: 'mo',
  /** A frozen token or execution-time baseline (a ticket budget version or a prior cohort). */
  baseline: 'bl',
  /** A frozen SPACE grade snapshot (assessment). */
  assessment: 'as',
  /** A structured improvement experiment written into a sprint retro. */
  experiment: 'xp',
  /** A later status or result of an experiment, stored beside the run's reports. */
  experimentEvent: 'xe'
} as const

export type IdKind = keyof typeof ID_PREFIXES

/** Collision-resistant stable ids: 2-letter prefix, 10 time chars, 16 random chars. */
export const STABLE_ID_PATTERN = /^[a-z]{2}_[0-9a-hjkmnp-tv-z]{26}$/

export interface IdGenerator {
  next(kind: IdKind): string
  /** Opaque secret for claim tokens and approval grants. */
  secret(): string
}

export function encodeBase32(value: bigint, length: number): string {
  let remaining = value
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out = ALPHABET[Number(remaining % 32n)] + out
    remaining /= 32n
  }
  return out
}

function randomChars(bytes: Buffer, length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[(bytes[i] ?? 0) % 32]
  }
  return out
}

/** A lowercase ULID: 10 time chars and 16 random chars, the body of every stable id. */
export function newUlid(nowMs: () => number = Date.now, random: (size: number) => Buffer = randomBytes): string {
  const time = encodeBase32(BigInt(Math.max(0, Math.floor(nowMs()))), TIME_CHARS)
  return `${time}${randomChars(random(RANDOM_CHARS), RANDOM_CHARS)}`
}

export function createIdGenerator(
  nowMs: () => number = Date.now,
  random: (size: number) => Buffer = randomBytes
): IdGenerator {
  return {
    next(kind) {
      return `${ID_PREFIXES[kind]}_${newUlid(nowMs, random)}`
    },
    secret() {
      return random(24).toString('base64url')
    }
  }
}

export function isStableId(value: unknown, kind?: IdKind): value is string {
  if (typeof value !== 'string' || !STABLE_ID_PATTERN.test(value)) {
    return false
  }
  return kind === undefined || value.startsWith(`${ID_PREFIXES[kind]}_`)
}

/**
 * The stable id right after `id` in sort order: the same prefix with its 26-character body plus one. Ids allocated
 * one after another this way sort in allocation order even within one millisecond. An id whose body is all `z` has
 * no successor: that is a `conflict` with the record already holding it.
 */
export function nextStableId(id: string): string {
  const prefix = id.slice(0, 3)
  const body = id.slice(3).split('')
  for (let index = body.length - 1; index >= 0; index -= 1) {
    const digit = ALPHABET.indexOf(body[index] ?? '0')
    if (digit < ALPHABET.length - 1) {
      body[index] = ALPHABET[digit + 1] ?? '0'
      return `${prefix}${body.join('')}`
    }
    body[index] = '0'
  }
  fail('conflict', `No stable id sorts after ${id}.`, { id })
}

/**
 * The stable id a record with this identity always has: the same `seed` gives the same id on every machine and every
 * retry, so a repeated delivery lands on the record it already made. The body is the seed's SHA-256 digest in base32
 * (time chars included), so such ids order by digest, not by time.
 */
export function derivedStableId(kind: IdKind, seed: string): string {
  const digest = createHash('sha256').update(seed, 'utf8').digest()
  return `${ID_PREFIXES[kind]}_${randomChars(digest, TIME_CHARS + RANDOM_CHARS)}`
}
