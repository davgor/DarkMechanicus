import { describe, expect, it } from 'vitest'
import { createIdGenerator } from './ids'
import { CLAIM_TOKEN_MASK, maskClaimTokens, maskClaimTokensDeep, maskWholeClaimTokens } from './claimTokenMask'

/**
 * A token built by the real id generator, so it has exactly the shape a claim hands out (a plan attempt's, or a Kanban
 * card attempt's); another seed, another token.
 */
function realShapedToken(seed = 0, kind: 'attempt' | 'kanbanAttempt' = 'attempt'): { token: string; attemptId: string; secret: string } {
  const random = (size: number): Buffer => Buffer.from(Array.from({ length: size }, (_, index) => (index * 37 + 11 + seed * 53) % 256))
  const ids = createIdGenerator(() => 1_700_000_000_000 + seed * 86_400_000, random)
  const attemptId = ids.next(kind)
  const secret = ids.secret()
  return { token: `${attemptId}.${secret}`, attemptId, secret }
}

const { token, attemptId, secret } = realShapedToken()
const other = realShapedToken(1)
const card = realShapedToken(2, 'kanbanAttempt')

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

describe('Kanban card claim tokens', () => {
  it('uses a token shaped like the one a Kanban claim issues', () => {
    expect(card.token).toMatch(/^ka_[0-9a-hjkmnp-tv-z]{26}[.][A-Za-z0-9_-]{32}$/)
  })

  it('masks a card token whole, cut short at the end of a text, and glued to a plan token', () => {
    expect(maskClaimTokens(`claim ${card.token} now`)).toBe(`claim ${CLAIM_TOKEN_MASK} now`)
    expect(maskClaimTokens(`cut ${card.attemptId}.${card.secret.slice(0, 5)}`)).toBe(`cut ${CLAIM_TOKEN_MASK}`)
    expect(maskClaimTokens(`${token}${card.token}`)).toBe(`${CLAIM_TOKEN_MASK}${CLAIM_TOKEN_MASK}`)
  })

  it('masks only whole card tokens in text stored as given, keeping a card attempt id in a path', () => {
    const text = `see ${card.token}; docs/${card.attemptId}.json`
    expect(maskWholeClaimTokens(text)).toBe(`see ${CLAIM_TOKEN_MASK}; docs/${card.attemptId}.json`)
  })
})
