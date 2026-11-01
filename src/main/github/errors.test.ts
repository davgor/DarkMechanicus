import { describe, expect, it } from 'vitest'
import { GithubError, redactSecrets } from './errors'

const TOKEN = 'gho_FAKE_TOKEN_never_leak_123'

describe('GithubError', () => {
  it('carries a code and the fixed message written for it', () => {
    const error = new GithubError('gh_not_installed')
    expect(error).toMatchObject({ name: 'GithubError', code: 'gh_not_installed', message: expect.stringContaining('GitHub CLI') })
    expect(error.detail).toBeUndefined()
  })

  it('keeps an optional detail beside the fixed message', () => {
    expect(new GithubError('gh_not_signed_in', undefined, 'not logged in')).toMatchObject({ code: 'gh_not_signed_in', detail: 'not logged in' })
  })
})

describe('redactSecrets', () => {
  it('replaces each secret in the message, stack and cause, and drops every other property', () => {
    const cause = new Error(`inner ${TOKEN}`)
    const error = Object.assign(new TypeError(`outer ${TOKEN} and dc_code`, { cause }), { request: { headers: { Authorization: `Bearer ${TOKEN}` } } })
    const safe = redactSecrets(error, [TOKEN, 'dc_code', ''])
    expect(safe.name).toBe('TypeError')
    expect(safe.message).toBe('outer [redacted] and [redacted]')
    expect(String(safe.cause)).toBe('Error: inner [redacted]')
    expect(`${safe.stack ?? ''}${(safe.cause as Error).stack ?? ''}`).not.toContain(TOKEN)
    expect(Object.keys(safe).sort()).toEqual(['cause', 'name'])
  })

  it('turns a thrown non-error into an error, and survives a cause cycle', () => {
    expect(redactSecrets(`text ${TOKEN}`, [TOKEN]).message).toBe('text [redacted]')
    const looped = new Error(`loop ${TOKEN}`)
    looped.cause = looped
    const safe = redactSecrets(looped, [TOKEN])
    expect(safe.message).toBe('loop [redacted]')
    expect(JSON.stringify(safe, ['message', 'cause'])).not.toContain(TOKEN)
  })
})
