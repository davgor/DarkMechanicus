import { describe, expect, it } from 'vitest'
import { callGit, GitCommandError } from './git'

describe('callGit', () => {
  it('returns the data of an ok result', async () => {
    await expect(callGit(Promise.resolve({ ok: true as const, data: 5 }))).resolves.toBe(5)
  })

  it('throws a GitCommandError carrying code, message and detail', async () => {
    const failed = callGit(Promise.resolve({ ok: false as const, error: { code: 'index_locked' as const, message: 'm', detail: 'd' } }))
    await expect(failed).rejects.toBeInstanceOf(GitCommandError)
    await expect(failed).rejects.toMatchObject({ code: 'index_locked', message: 'm', detail: 'd' })
  })
})
