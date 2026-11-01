import { describe, expect, it } from 'vitest'
import { CLAIM_TOKEN_MASK } from './claimTokenMask'
import { GRANT_TOKEN_MASK, storableJson } from './storedSecrets'

const CLAIM_TOKEN = 'at_01j8z3k5m7n9p2q4r6s8t0v1w2.Zk9_aB3dEf7-Hj2LmN5pQr8TuVw0XyZa'
const GRANT_TOKEN = `dmg_${'0123456789abcdef'.repeat(4)}`

function stored(value: unknown): unknown {
  return JSON.parse(storableJson(value))
}

describe('storableJson field names', () => {
  it('stores every listed secret field as null, whatever its value', () => {
    const value = { claimToken: 'a.b', claimSecret: 'c', claim_secret: 'd', token: { nested: 'e' }, secret: 7 }
    expect(stored(value)).toEqual({ claimToken: null, claimSecret: null, claim_secret: null, token: null, secret: null })
  })

  it('stores any other field whose name ends in a secret word as null (fail closed)', () => {
    const names = [
      'sessionToken',
      'sessionToken2',
      'refreshTokens',
      'API_SECRET',
      'dbPassword',
      'x-auth-token',
      'credentials',
      'apiKey',
      'APIKey',
      'private_key',
      'passphrase'
    ]
    const value = Object.fromEntries(names.map((name) => [name, `value of ${name}`]))
    expect(stored(value)).toEqual(Object.fromEntries(names.map((name) => [name, null])))
  })

  it('keeps fields that only look like secrets', () => {
    const value = {
      fencingToken: 3,
      contextWindowTokens: 200_000,
      estimatedInputTokens: 900,
      tokenHash: 'abc',
      key: 'DM-1',
      idempotencyKey: 'k1',
      refMap: { 'refresh-token': 'tk_1', api_key: 'tk_2', token: 'tk_3' },
      secretary: 'Ada'
    }
    expect(stored(value)).toEqual(value)
  })

  it('reads refMap keys as data, still masking tokens in them and redacting by name below them', () => {
    const value = { refMap: { [CLAIM_TOKEN]: 'tk_1', nested: { token: 'x' } } }
    expect(stored(value)).toEqual({ refMap: { [CLAIM_TOKEN_MASK]: 'tk_1', nested: { token: null } } })
  })

  it('redacts in arrays and nested objects', () => {
    expect(stored([{ list: [{ claimToken: 'x' }] }])).toEqual([{ list: [{ claimToken: null }] }])
  })
})

describe('storableJson text', () => {
  it('masks claim and grant tokens in any string and field name', () => {
    const value = { summary: `done; token was ${CLAIM_TOKEN}, grant ${GRANT_TOKEN}`, [CLAIM_TOKEN]: 1 }
    expect(stored(value)).toEqual({
      summary: `done; token was ${CLAIM_TOKEN_MASK}, grant ${GRANT_TOKEN_MASK}`,
      [CLAIM_TOKEN_MASK]: 1
    })
  })

  it('masks a whole claim token, and leaves an attempt id or a short tail at the end of a text alone', () => {
    const attemptId = CLAIM_TOKEN.slice(0, 29)
    const value = {
      whole: `ends with ${CLAIM_TOKEN}`,
      retry: `Retry of ${attemptId}.`,
      path: `docs/${attemptId}.json`,
      short: `cut ${CLAIM_TOKEN.slice(0, 35)}`
    }
    expect(stored(value)).toEqual({ ...value, whole: `ends with ${CLAIM_TOKEN_MASK}` })
  })

  it('leaves ids and ordinary text alone', () => {
    const value = { attemptId: 'at_01j8z3k5m7n9p2q4r6s8t0v1w2', note: 'dmg_test is not a grant', count: 2, flag: true, none: null }
    expect(stored(value)).toEqual(value)
  })
})

describe('storableJson serialization', () => {
  it('stores undefined as null', () => {
    expect(storableJson(undefined)).toBe('null')
  })

  it('redacts the serialized form of class instances and toJSON results', () => {
    class Holder {
      constructor(readonly claimToken: string) {}
    }
    const value = { holder: new Holder('x'), viaJson: { toJSON: () => ({ token: GRANT_TOKEN }) }, when: new Date(0) }
    expect(stored(value)).toEqual({ holder: { claimToken: null }, viaJson: { token: null }, when: '1970-01-01T00:00:00.000Z' })
  })
})
