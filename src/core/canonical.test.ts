import { describe, expect, it } from 'vitest'
import { canonicalJson, contentHash, prettyJson, sha256Hex } from './canonical'

/** Keys `k00`..`k49` in a scrambled but deterministic order. */
function scrambledObject(): Record<string, number> {
  const entries = Array.from({ length: 50 }, (_, index) => {
    const slot = (index * 7) % 50
    return [`k${String(slot).padStart(2, '0')}`, slot] as const
  })
  return Object.fromEntries(entries)
}

describe('canonicalJson key order', () => {
  it('sorts object keys and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ c: 'x', a: [1, 2], b: { z: true } })).toBe('{"a":[1,2],"b":{"z":true},"c":"x"}')
  })

  it('is independent of insertion order at every nesting level', () => {
    const one = { z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] }
    const two = { a: [{ c: 2, d: 1 }], z: { x: 2, y: 1 } }
    expect(canonicalJson(one)).toBe('{"a":[{"c":2,"d":1}],"z":{"x":2,"y":1}}')
    expect(canonicalJson(one)).toBe(canonicalJson(two))
  })

  it('orders keys by UTF-16 code unit, so uppercase sorts before lowercase', () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, A: 4 })).toBe('{"A":4,"B":2,"a":3,"b":1}')
    expect(canonicalJson({ ab: 1, a: 2, abc: 3 })).toBe('{"a":2,"ab":1,"abc":3}')
  })

  it('sorts many keys completely', () => {
    const sorted = Object.keys(JSON.parse(canonicalJson(scrambledObject())) as Record<string, number>)
    const expected = Array.from({ length: 50 }, (_, index) => `k${String(index).padStart(2, '0')}`)
    expect(Object.keys(scrambledObject())).not.toEqual(expected)
    expect(sorted).toEqual(expected)
  })

  it('keeps array element order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalJson([{ b: 1, a: 2 }, { d: 3, c: 4 }])).toBe('[{"a":2,"b":1},{"c":4,"d":3}]')
  })
})

describe('canonicalJson undefined and primitives', () => {
  it('drops undefined object members at any depth', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}')
    expect(canonicalJson({ a: { b: undefined } })).toBe('{"a":{}}')
    expect(canonicalJson({ list: [{ x: undefined, y: 1 }] })).toBe('{"list":[{"y":1}]}')
  })

  it('turns undefined array elements into null', () => {
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]')
    expect(canonicalJson([[undefined]])).toBe('[[null]]')
    expect(canonicalJson({ list: [undefined, { a: undefined }] })).toBe('{"list":[null,{}]}')
  })

  it('preserves null members and null values', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson([null])).toBe('[null]')
  })

  it('serializes primitives like JSON', () => {
    expect(canonicalJson('x"y')).toBe('"x\\"y"')
    expect(canonicalJson(5)).toBe('5')
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson(false)).toBe('false')
    expect(canonicalJson({ n: 0, s: '', f: false })).toBe('{"f":false,"n":0,"s":""}')
  })

  it('treats empty containers as empty', () => {
    expect(canonicalJson({})).toBe('{}')
    expect(canonicalJson([])).toBe('[]')
  })
})

describe('prettyJson', () => {
  it('indents with two spaces, sorts keys and ends with a newline', () => {
    const text = prettyJson({ b: [1, { d: 1, c: 2 }], a: 'x' })
    expect(text).toBe(
      ['{', '  "a": "x",', '  "b": [', '    1,', '    {', '      "c": 2,', '      "d": 1', '    }', '  ]', '}', ''].join('\n')
    )
  })

  it('drops undefined members and nulls undefined array elements', () => {
    expect(prettyJson({ a: undefined, b: [undefined] })).toBe('{\n  "b": [\n    null\n  ]\n}\n')
  })

  it('renders empty containers compactly with a trailing newline', () => {
    expect(prettyJson({})).toBe('{}\n')
    expect(prettyJson([])).toBe('[]\n')
    expect(prettyJson('text')).toBe('"text"\n')
  })

  it('round-trips through JSON.parse and is stable across key order', () => {
    const value = { z: [1, { b: 2, a: 1 }], y: null, x: 'text' }
    expect(JSON.parse(prettyJson(value))).toEqual(value)
    expect(prettyJson(value)).toBe(prettyJson({ x: 'text', y: null, z: [1, { a: 1, b: 2 }] }))
  })
})

describe('sha256Hex', () => {
  it('matches the published SHA-256 vector for "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('hashes the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('hashes text as UTF-8', () => {
    expect(sha256Hex('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c')
  })

  it('returns 64 lowercase hex characters', () => {
    expect(sha256Hex('anything at all')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('contentHash', () => {
  it('prefixes the SHA-256 of the canonical JSON with sha256:', () => {
    expect(contentHash({ a: 1 })).toBe('sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862')
    expect(contentHash([])).toBe('sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
  })

  it('is stable across key order and ignores undefined members', () => {
    expect(contentHash({ b: [1, undefined], a: 1 })).toBe(
      'sha256:dbfeb78171a5f92517407428111cfc366735a568d313221715fa70b975154dd6'
    )
    expect(contentHash({ a: 1, b: [1, null], c: undefined })).toBe(contentHash({ b: [1, null], a: 1 }))
  })

  it('changes when the content or array order changes', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }))
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]))
    expect(contentHash({ a: null })).not.toBe(contentHash({}))
  })
})
