import { describe, expect, it } from 'vitest'
import { createIdGenerator } from './ids'
import { CLAIM_TOKEN_MASK, clipMasked, createStreamMasker, maskClaimTokens, maskClaimTokensDeep } from './claimTokenMask'

/** A token built by the real id generator, so it has exactly the shape attempts.ts hands out; another seed, another token. */
function realShapedToken(seed = 0): { token: string; attemptId: string; secret: string } {
  const random = (size: number): Buffer => Buffer.from(Array.from({ length: size }, (_, index) => (index * 37 + 11 + seed * 53) % 256))
  const ids = createIdGenerator(() => 1_700_000_000_000 + seed * 86_400_000, random)
  const attemptId = ids.next('attempt')
  const secret = ids.secret()
  return { token: `${attemptId}.${secret}`, attemptId, secret }
}

const { token, attemptId, secret } = realShapedToken()
const other = realShapedToken(1)

describe('maskClaimTokens', () => {
  it('uses a token shaped like the one attempts.ts issues', () => {
    expect(attemptId).toMatch(/^at_[0-9a-hjkmnp-tv-z]{26}$/)
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('masks a token inside prose, whole', () => {
    const masked = maskClaimTokens(`Use claim token ${token} to heartbeat.`)
    expect(masked).toBe(`Use claim token ${CLAIM_TOKEN_MASK} to heartbeat.`)
    expect(masked).not.toContain(secret)
  })

  it('masks every token in a string, and one that is quoted or glued to punctuation', () => {
    const masked = maskClaimTokens(`{"claimToken":"${token}"} and (${token}), ${token}.`)
    expect(masked).not.toContain(secret)
    expect(masked.split(CLAIM_TOKEN_MASK)).toHaveLength(4)
  })

  it('masks secrets made of dashes and underscores', () => {
    const odd = `${attemptId}.-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_`
    expect(maskClaimTokens(`x ${odd} y`)).toBe(`x ${CLAIM_TOKEN_MASK} y`)
  })

  it('leaves an attempt id alone when no secret follows it', () => {
    const text = `attempt ${attemptId} (see ${attemptId}.json)`
    expect(maskClaimTokens(text)).toBe(text)
  })

  it('leaves ordinary text and other stable ids alone', () => {
    const text = 'rn_01m44m0qnd0nn90p29a12041js started; tk_01m418f9qznrfb3hfjryft06qz is ready'
    expect(maskClaimTokens(text)).toBe(text)
  })

  it('has a second token of the same shape, different from the first, for the cases below', () => {
    expect(other.attemptId).not.toBe(attemptId)
    expect(other.secret).not.toBe(secret)
    expect(other.token).toMatch(/^at_[0-9a-hjkmnp-tv-z]{26}[.][A-Za-z0-9_-]{32}$/)
  })
})

describe('maskClaimTokens: glued tokens', () => {
  it('masks two tokens with nothing between them, each whole', () => {
    const masked = maskClaimTokens(`go ${token}${other.token} now`)

    expect(masked).toBe(`go ${CLAIM_TOKEN_MASK}${CLAIM_TOKEN_MASK} now`)
    expect(masked).not.toContain(secret.slice(0, 6))
    expect(masked).not.toContain(other.secret.slice(0, 6))
  })

  it('masks a glued pair at the start and the end of a text, and three or more in a row', () => {
    expect(maskClaimTokens(`${token}${other.token}`)).toBe(`${CLAIM_TOKEN_MASK}${CLAIM_TOKEN_MASK}`)
    expect(maskClaimTokens(`${token}${other.token}${token}`)).toBe(CLAIM_TOKEN_MASK.repeat(3))
  })

  it('masks a glued pair when the first secret ends in characters that look like a token start', () => {
    const tricky = `${attemptId}.${secret.slice(0, 29)}at_`

    expect(maskClaimTokens(`${tricky}${other.token}!`)).toBe(`${CLAIM_TOKEN_MASK}${CLAIM_TOKEN_MASK}!`)
  })

  it('masks a first token whose secret is short when another token follows it directly', () => {
    const masked = maskClaimTokens(`${attemptId}.${secret.slice(0, 9)}${other.token} end`)

    expect(masked).toBe(`${CLAIM_TOKEN_MASK}${CLAIM_TOKEN_MASK} end`)
  })

  it('masks a bare attempt id and dot glued to the token after it', () => {
    expect(maskClaimTokens(`${attemptId}.${other.token}`)).toBe(`${CLAIM_TOKEN_MASK}${CLAIM_TOKEN_MASK}`)
  })

  it('masks a glued pair whose second token is cut short at the end', () => {
    for (let kept = 0; kept < 16; kept += 1) {
      const masked = maskClaimTokens(`${token}${other.attemptId}.${other.secret.slice(0, kept)}`)

      expect(masked).toBe(`${CLAIM_TOKEN_MASK}${CLAIM_TOKEN_MASK}`)
    }
  })
})

describe('maskClaimTokens: cut-short tokens', () => {
  it('masks a token at the end of a text whatever length of its secret is left', () => {
    for (let kept = 0; kept <= secret.length; kept += 1) {
      const masked = maskClaimTokens(`result: ${attemptId}.${secret.slice(0, kept)}`)

      expect(masked).toBe(`result: ${CLAIM_TOKEN_MASK}`)
    }
  })

  it('masks a shortened token inside a JSON string that was cut mid-secret', () => {
    const cut = `{"claimToken":"${attemptId}.${secret.slice(0, 7)}`

    expect(maskClaimTokens(cut)).toBe(`{"claimToken":"${CLAIM_TOKEN_MASK}`)
  })

  it('leaves a short secret alone when text follows it, since only a cut token ends the string', () => {
    const text = `${attemptId}.${secret.slice(0, 7)} and ${attemptId}. Then ${attemptId}.json ok`

    expect(maskClaimTokens(text)).toBe(text)
  })

  it('leaves a partial attempt id at the end alone: no secret has started', () => {
    const text = `see ${attemptId.slice(0, 20)}`

    expect(maskClaimTokens(text)).toBe(text)
  })

  it('leaves text that ends in a stable id of another kind alone', () => {
    const text = 'finished rn_01m44m0qnd0nn90p29a12041js.abc'

    expect(maskClaimTokens(text)).toBe(text)
  })
})

describe('clipMasked', () => {
  it('leaves text without tokens as it is, clipping past the limit with an ellipsis', () => {
    expect(clipMasked('abc', 3)).toBe('abc')
    expect(clipMasked('abcd', 3)).toBe('abc…')
    expect(clipMasked('', 3)).toBe('')
  })

  it('masks a token before cutting, so a cut inside its secret leaves no part of it', () => {
    const text = `${'x'.repeat(40)}${token} and more text after it`
    for (let limit = 30; limit < text.length; limit += 1) {
      const clipped = clipMasked(text, limit)

      expect(clipped).not.toContain(secret.slice(0, 4))
      expect(clipped).not.toContain(attemptId.slice(3, 12))
    }
  })

  it('cuts the masked text, not the original', () => {
    const text = `${token} then ${'y'.repeat(30)}`

    expect(clipMasked(text, CLAIM_TOKEN_MASK.length + 5)).toBe(`${CLAIM_TOKEN_MASK} then…`)
    expect(clipMasked(`${token}${other.token}`, 200)).toBe(`${CLAIM_TOKEN_MASK}${CLAIM_TOKEN_MASK}`)
  })

  it('masks a token already cut short at the end of the text', () => {
    expect(clipMasked(`${attemptId}.${secret.slice(0, 5)}`, 1000)).toBe(CLAIM_TOKEN_MASK)
  })
})

describe('maskClaimTokensDeep', () => {
  it('masks strings nested in objects and arrays, including keys', () => {
    const input = { args: [{ packet: { claimToken: token, list: [`a ${token} b`, 3, true, null] } }], [token]: 'x' }
    const masked = maskClaimTokensDeep(input)
    expect(JSON.stringify(masked)).not.toContain(secret)
    expect(masked.args[0]?.packet.claimToken).toBe(CLAIM_TOKEN_MASK)
    expect(masked.args[0]?.packet.list).toEqual([`a ${CLAIM_TOKEN_MASK} b`, 3, true, null])
    expect(Object.keys(masked)).toEqual(['args', CLAIM_TOKEN_MASK])
  })

  it('does not mutate its input and passes non-string leaves through', () => {
    const input = { text: token, count: 2, flag: false, nothing: null }
    const masked = maskClaimTokensDeep(input)
    expect(input.text).toBe(token)
    expect(masked).toEqual({ text: CLAIM_TOKEN_MASK, count: 2, flag: false, nothing: null })
  })

  it('returns clean values unchanged in content', () => {
    const clean = { a: ['b', { c: 'd' }], e: 1 }
    expect(maskClaimTokensDeep(clean)).toEqual(clean)
  })

  it('masks an object made without a prototype, and a glued pair or a cut-short token inside nested text', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { note: `${token}${other.token}`, cut: [`${attemptId}.${secret.slice(0, 4)}`] })

    expect(maskClaimTokensDeep(bare)).toEqual({ note: `${CLAIM_TOKEN_MASK}${CLAIM_TOKEN_MASK}`, cut: [CLAIM_TOKEN_MASK] })
  })
})

/** Feeds `deltas` through one stream masker and returns every chunk it released, flush last. */
function streamed(deltas: readonly string[]): string[] {
  const masker = createStreamMasker()
  return [...deltas.map((delta) => masker.push(delta)), masker.flush()]
}

describe('createStreamMasker', () => {
  const text = `Worker packet: claim with ${token} then heartbeat.`
  const expected = `Worker packet: claim with ${CLAIM_TOKEN_MASK} then heartbeat.`

  it('masks a token split across deltas, so no piece of the secret is ever released', () => {
    const split = text.indexOf(secret) + 5
    const deltas = [text.slice(0, text.indexOf(attemptId) + 4), text.slice(text.indexOf(attemptId) + 4, split), text.slice(split)]

    const chunks = streamed(deltas)

    expect(chunks.join('')).toBe(expected)
    expect(chunks.some((chunk) => chunk.includes(secret.slice(0, 5)))).toBe(false)
  })

  it('masks a token streamed one character at a time', () => {
    expect(streamed([...text]).join('')).toBe(expected)
  })

  it('holds a complete token back while its secret may still be growing', () => {
    const masker = createStreamMasker()

    expect(masker.push(`go ${attemptId}.${secret.slice(0, 20)}`)).toBe('go ')
    expect(masker.push(`${secret.slice(20)} now`)).toBe(`${CLAIM_TOKEN_MASK} now`)
    expect(masker.flush()).toBe('')
  })

  it('masks two tokens in one stream and one at the very start', () => {
    const chunks = streamed([token.slice(0, 10), `${token.slice(10)} and ${token.slice(0, 31)}`, `${token.slice(31)}!`])

    expect(chunks.join('')).toBe(`${CLAIM_TOKEN_MASK} and ${CLAIM_TOKEN_MASK}!`)
  })

  it('passes ordinary text through, holding back only a possible token start until the next delta', () => {
    const masker = createStreamMasker()

    expect(masker.push('read the data')).toBe('read the dat')
    expect(masker.push(' and stop at')).toBe('a and stop ')
    expect(masker.push('_')).toBe('')
    expect(masker.push('user')).toBe('at_user')
    expect(masker.flush()).toBe('')
  })

  it('masks a cut-off secret when the stream ends, and releases a bare attempt id as it is', () => {
    const cut = createStreamMasker()
    expect(cut.push(`x ${attemptId}.${secret.slice(0, 6)}`)).toBe('x ')
    expect(cut.flush()).toBe(CLAIM_TOKEN_MASK)

    const bare = createStreamMasker()
    expect(bare.push(`see ${attemptId}`)).toBe('see ')
    expect(bare.flush()).toBe(attemptId)
    expect(bare.flush()).toBe('')
  })

  it('takes only a dot as the separator between attempt id and secret', () => {
    const text = `${attemptId}-${secret} and ${attemptId}x${secret}`

    expect(maskClaimTokens(text)).toBe(text)
    expect(streamed([text]).join('')).toBe(text)
  })
})

describe('createStreamMasker: glued and cut-short tokens', () => {
  it('masks two tokens glued together in one delta', () => {
    expect(streamed([`go ${token}${other.token} now`]).join('')).toBe(`go ${CLAIM_TOKEN_MASK}${CLAIM_TOKEN_MASK} now`)
  })

  it('masks a glued pair split at every position, never releasing a piece of either secret', () => {
    const text = `Packets: ${token}${other.token}, done.`
    const expected = `Packets: ${CLAIM_TOKEN_MASK}${CLAIM_TOKEN_MASK}, done.`

    for (let at = 1; at < text.length; at += 1) {
      const chunks = streamed([text.slice(0, at), text.slice(at)])

      expect(chunks.join('')).toBe(expected)
      expect(chunks.some((chunk) => chunk.includes(secret.slice(0, 5)) || chunk.includes(other.secret.slice(0, 5)))).toBe(false)
    }
  })

  it('masks a glued pair streamed one character at a time and in three uneven pieces', () => {
    const text = `${token}${other.token} ok`
    const expected = `${CLAIM_TOKEN_MASK}${CLAIM_TOKEN_MASK} ok`

    expect(streamed([...text]).join('')).toBe(expected)
    for (let first = 1; first < text.length - 1; first += 4) {
      for (let second = first + 1; second < text.length; second += 5) {
        expect(streamed([text.slice(0, first), text.slice(first, second), text.slice(second)]).join('')).toBe(expected)
      }
    }
  })

  it('holds the second token of a glued pair back until its secret settles', () => {
    const masker = createStreamMasker()

    expect(masker.push(`${token}${other.attemptId}.${other.secret.slice(0, 10)}`)).toBe(CLAIM_TOKEN_MASK)
    expect(masker.push(`${other.secret.slice(10)}.`)).toBe(`${CLAIM_TOKEN_MASK}.`)
    expect(masker.flush()).toBe('')
  })

  it('masks a glued pair cut off by the end of the stream, in the second token or the first', () => {
    const second = createStreamMasker()
    expect(second.push(`${token}${other.attemptId}.${other.secret.slice(0, 3)}`)).toBe(CLAIM_TOKEN_MASK)
    expect(second.flush()).toBe(CLAIM_TOKEN_MASK)

    const first = createStreamMasker()
    expect(first.push(`${attemptId}.${secret.slice(0, 20)}${other.attemptId.slice(0, 8)}`)).toBe('')
    expect(first.flush()).toBe(CLAIM_TOKEN_MASK)
  })

  it('masks a token cut short at the very end of the stream, even with nothing after the dot', () => {
    const bare = createStreamMasker()

    expect(bare.push(`ok ${attemptId}.`)).toBe('ok ')
    expect(bare.flush()).toBe(CLAIM_TOKEN_MASK)
  })
})
