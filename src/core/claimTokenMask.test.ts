import { describe, expect, it } from 'vitest'
import { createIdGenerator } from './ids'
import { CLAIM_TOKEN_MASK, createStreamMasker, maskClaimTokens, maskClaimTokensDeep } from './claimTokenMask'

/** A token built by the real id generator, so it has exactly the shape attempts.ts hands out. */
function realShapedToken(): { token: string; attemptId: string; secret: string } {
  const random = (size: number): Buffer => Buffer.from(Array.from({ length: size }, (_, index) => (index * 37 + 11) % 256))
  const ids = createIdGenerator(() => 1_700_000_000_000, random)
  const attemptId = ids.next('attempt')
  const secret = ids.secret()
  return { token: `${attemptId}.${secret}`, attemptId, secret }
}

const { token, attemptId, secret } = realShapedToken()

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
