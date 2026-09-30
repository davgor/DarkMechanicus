import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createIdGenerator,
  encodeBase32,
  ID_PREFIXES,
  type IdKind,
  isStableId,
  STABLE_ID_PATTERN
} from './ids'

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
const BODY = 'a0b1c2d3e4f5g6h7j8k9m0n1p2'
const ID_KINDS = Object.keys(ID_PREFIXES) as IdKind[]

/** A random source that records the sizes it was asked for and fills bytes from `fill`. */
function fixedRandom(fill: (index: number) => number): {
  random: (size: number) => Buffer
  sizes: number[]
} {
  const sizes: number[] = []
  const random = (size: number): Buffer => {
    sizes.push(size)
    return Buffer.from(Array.from({ length: size }, (_, index) => fill(index)))
  }
  return { random, sizes }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('encodeBase32 alphabet and padding', () => {
  it('encodes each single digit with the lowercase Crockford alphabet', () => {
    const digits = Array.from({ length: 32 }, (_, value) => encodeBase32(BigInt(value), 1))
    expect(digits.join('')).toBe(ALPHABET)
  })

  it('carries between digits', () => {
    expect(encodeBase32(32n, 2)).toBe('10')
    expect(encodeBase32(1023n, 2)).toBe('zz')
    expect(encodeBase32(1024n, 3)).toBe('100')
  })

  it('left-pads with zeros up to the requested length', () => {
    expect(encodeBase32(0n, 4)).toBe('0000')
    expect(encodeBase32(5n, 6)).toBe('000005')
    expect(encodeBase32(123456789n, 8)).toBe('003nqk8n')
    expect(encodeBase32(1n, 26)).toBe(`${'0'.repeat(25)}1`)
  })

  it('keeps only the low digits when the value does not fit', () => {
    expect(encodeBase32(1025n, 2)).toBe('01')
    expect(encodeBase32(1024n, 2)).toBe('00')
  })

  it('returns an empty string for length zero and all z for the 50-bit maximum', () => {
    expect(encodeBase32(99n, 0)).toBe('')
    expect(encodeBase32(2n ** 50n - 1n, 10)).toBe('zzzzzzzzzz')
  })
})

describe('createIdGenerator ids', () => {
  it('builds prefix, 10 time chars and 16 random chars', () => {
    const { random } = fixedRandom(() => 0)
    const ids = createIdGenerator(() => 1_700_000_000_000, random)
    expect(ids.next('ticket')).toBe(`tk_01hf7yat00${'0'.repeat(16)}`)
  })

  it('maps random bytes to the alphabet modulo 32', () => {
    const low = fixedRandom((index) => index)
    const shifted = fixedRandom((index) => index + 32)
    const high = fixedRandom(() => 255)
    expect(createIdGenerator(() => 0, low.random).next('epic')).toBe(`ep_${'0'.repeat(10)}0123456789abcdef`)
    expect(createIdGenerator(() => 0, shifted.random).next('epic')).toBe(`ep_${'0'.repeat(10)}0123456789abcdef`)
    expect(createIdGenerator(() => 0, high.random).next('epic')).toBe(`ep_${'0'.repeat(10)}${'z'.repeat(16)}`)
  })

  it('pads missing random bytes with zeros', () => {
    const ids = createIdGenerator(() => 0, () => Buffer.from([1, 2]))
    expect(ids.next('run')).toBe(`rn_${'0'.repeat(10)}12${'0'.repeat(14)}`)
  })

  it('asks for 16 random bytes per id', () => {
    const { random, sizes } = fixedRandom(() => 1)
    const ids = createIdGenerator(() => 0, random)
    ids.next('run')
    ids.next('attempt')
    expect(sizes).toEqual([16, 16])
  })

  it('uses the injected clock on every call', () => {
    let now = 0
    const ids = createIdGenerator(() => now, fixedRandom(() => 0).random)
    const first = ids.next('report')
    now = 32
    expect(first.slice(3, 13)).toBe('0000000000')
    expect(ids.next('report').slice(3, 13)).toBe('0000000010')
  })
})

describe('createIdGenerator time handling', () => {
  it('floors fractional milliseconds and clamps negative time to zero', () => {
    const zeros = fixedRandom(() => 0).random
    expect(createIdGenerator(() => 32.9, zeros).next('epic').slice(3, 13)).toBe('0000000010')
    expect(createIdGenerator(() => -5, zeros).next('epic').slice(3, 13)).toBe('0000000000')
  })

  it('sorts ids lexicographically in creation order as time advances', () => {
    let now = 0
    const ids = createIdGenerator(() => now, fixedRandom(() => 0).random)
    const created: string[] = []
    for (const time of [0, 31, 32, 1023, 1024, 40_000, 1_000_000_000_000]) {
      now = time
      created.push(ids.next('epic'))
    }
    expect([...created].sort()).toEqual(created)
    expect(new Set(created).size).toBe(created.length)
  })

  it('reads Date.now and real random bytes by default', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const ids = createIdGenerator()
    const id = ids.next('epic')
    expect(id.slice(0, 13)).toBe('ep_01hf7yat00')
    expect(STABLE_ID_PATTERN.test(id)).toBe(true)
    expect(ids.secret()).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })
})

describe('createIdGenerator kinds and secrets', () => {
  it.each(ID_KINDS)('generates a valid 29-char %s id with its own prefix', (kind) => {
    const id = createIdGenerator(() => 1_700_000_000_000, fixedRandom((i) => i * 7).random).next(kind)
    expect(id.startsWith(`${ID_PREFIXES[kind]}_`)).toBe(true)
    expect(id).toHaveLength(29)
    expect(isStableId(id, kind)).toBe(true)
  })

  it('pins the prefix of every id kind', () => {
    expect(ID_PREFIXES).toEqual({
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
      hostCatalog: 'hc'
    })
  })

  it('encodes 24 random bytes as unpadded base64url secrets', () => {
    const sequence = fixedRandom((index) => index)
    const ids = createIdGenerator(() => 0, sequence.random)
    expect(ids.secret()).toBe('AAECAwQFBgcICQoLDA0ODxAREhMUFRYX')
    expect(sequence.sizes).toEqual([24])
  })

  it('uses the url-safe alphabet for secrets', () => {
    expect(createIdGenerator(() => 0, fixedRandom(() => 255).random).secret()).toBe('_'.repeat(32))
    expect(createIdGenerator(() => 0, fixedRandom(() => 0xfb).random).secret()).toBe('-_v7'.repeat(8))
  })
})

describe('isStableId shape', () => {
  it('accepts a 2-letter prefix, underscore and 26 alphabet characters', () => {
    expect(isStableId(`tk_${BODY}`)).toBe(true)
    expect(isStableId(`zz_${'0'.repeat(26)}`)).toBe(true)
    expect(isStableId(`ab_${'z'.repeat(26)}`)).toBe(true)
  })

  it('rejects bodies that are one character too short or too long', () => {
    expect(isStableId(`tk_${BODY.slice(1)}`)).toBe(false)
    expect(isStableId(`tk_${BODY}0`)).toBe(false)
    expect(isStableId('tk_')).toBe(false)
  })

  it('rejects uppercase letters in prefix or body', () => {
    expect(isStableId(`TK_${BODY}`)).toBe(false)
    expect(isStableId(`tk_${BODY.toUpperCase()}`)).toBe(false)
    expect(isStableId(`tK_${BODY}`)).toBe(false)
  })

  it.each(['i', 'l', 'o', 'u'])('rejects the excluded letter %s in the body', (letter) => {
    expect(isStableId(`tk_${letter}${BODY.slice(1)}`)).toBe(false)
    expect(isStableId(`tk_${BODY.slice(1)}${letter}`)).toBe(false)
  })

  it('rejects malformed prefixes and separators', () => {
    expect(isStableId(`t_${BODY}`)).toBe(false)
    expect(isStableId(`tkx_${BODY}`)).toBe(false)
    expect(isStableId(`tk-${BODY}`)).toBe(false)
    expect(isStableId(`t1_${BODY}`)).toBe(false)
    expect(isStableId(BODY)).toBe(false)
  })

  it('rejects surrounding whitespace and embedded newlines', () => {
    expect(isStableId(` tk_${BODY}`)).toBe(false)
    expect(isStableId(`tk_${BODY}\n`)).toBe(false)
    expect(isStableId(`x\ntk_${BODY}`)).toBe(false)
  })

  it.each([[undefined], [null], [42], [{}], [[]], [true], [['tk_']], [Symbol.for('id')]])(
    'rejects the non-string value %s',
    (value) => {
      expect(isStableId(value)).toBe(false)
      expect(isStableId(value, 'ticket')).toBe(false)
    }
  )
})

describe('isStableId kind filter', () => {
  it('requires the prefix of the requested kind', () => {
    expect(isStableId(`tk_${BODY}`, 'ticket')).toBe(true)
    expect(isStableId(`tk_${BODY}`, 'sprint')).toBe(false)
    expect(isStableId(`sp_${BODY}`, 'ticket')).toBe(false)
    expect(isStableId(`sp_${BODY}`, 'sprint')).toBe(true)
  })

  it.each(ID_KINDS)('accepts only %s ids for that kind', (kind) => {
    const own = `${ID_PREFIXES[kind]}_${BODY}`
    const others = ID_KINDS.filter((other) => other !== kind).map((other) => `${ID_PREFIXES[other]}_${BODY}`)
    expect(isStableId(own, kind)).toBe(true)
    expect(others.filter((candidate) => isStableId(candidate, kind))).toEqual([])
  })

  it('still rejects bad shapes when a kind is given', () => {
    expect(isStableId(`tk_${BODY}0`, 'ticket')).toBe(false)
    expect(isStableId('tk_short', 'ticket')).toBe(false)
  })
})
