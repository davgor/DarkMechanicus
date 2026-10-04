import { randomBytes } from 'node:crypto'

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
  rowCheck: 'rk'
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

export function createIdGenerator(
  nowMs: () => number = Date.now,
  random: (size: number) => Buffer = randomBytes
): IdGenerator {
  return {
    next(kind) {
      const time = encodeBase32(BigInt(Math.max(0, Math.floor(nowMs()))), TIME_CHARS)
      return `${ID_PREFIXES[kind]}_${time}${randomChars(random(RANDOM_CHARS), RANDOM_CHARS)}`
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
