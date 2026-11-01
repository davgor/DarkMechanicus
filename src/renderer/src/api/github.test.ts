import { describe, expect, it } from 'vitest'
import { callGithub, GithubCommandError } from './github'

describe('callGithub', () => {
  it('returns the data of an ok result', async () => {
    await expect(callGithub(Promise.resolve({ ok: true as const, data: null }))).resolves.toBeNull()
  })

  it('throws a GithubCommandError carrying the code and message', async () => {
    const failed = callGithub(Promise.resolve({ ok: false as const, error: { code: 'gh_not_signed_in' as const, message: 'Not signed in.' } }))
    await expect(failed).rejects.toBeInstanceOf(GithubCommandError)
    await expect(failed).rejects.toMatchObject({ code: 'gh_not_signed_in', message: 'Not signed in.' })
  })
})
