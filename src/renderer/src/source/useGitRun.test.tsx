// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitResult } from '../../../shared/git/api'
import type { GitCommandError } from '../api/git'
import { settle } from '../__mocks__/settle'
import { useGitRun } from './useGitRun'

afterEach(cleanup)

const REFUSED: GitResult<string> = { ok: false, error: { code: 'branch_exists', message: 'That branch already exists.' } }

describe('useGitRun', () => {
  it('hands the data to onDone and clears busy', async () => {
    const { result } = renderHook(() => useGitRun())
    const done: string[] = []
    act(() => result.current.run(() => Promise.resolve({ ok: true, data: 'abc' }), (data) => done.push(data)))
    expect(result.current.busy).toBe(true)
    await settle()
    expect(done).toEqual(['abc'])
    expect(result.current.busy).toBe(false)
    expect(result.current.failure).toBeNull()
  })

  it('leaves a failure the handler took care of unshown', async () => {
    const { result } = renderHook(() => useGitRun())
    const seen: string[] = []
    const handled = (error: GitCommandError): boolean => {
      seen.push(error.code)
      return true
    }
    act(() => result.current.run(() => Promise.resolve(REFUSED), () => undefined, handled))
    await settle()
    expect(seen).toEqual(['branch_exists'])
    expect(result.current.failure).toBeNull()
    expect(result.current.busy).toBe(false)
  })
})

describe('useGitRun failures', () => {
  it('shows the message when the handler declines the failure or there is none', async () => {
    const { result } = renderHook(() => useGitRun())
    act(() => result.current.run(() => Promise.resolve(REFUSED), () => undefined, () => false))
    await settle()
    expect(result.current.failure).toBe('That branch already exists.')
    act(() => result.current.run(() => Promise.resolve({ ok: true, data: 'x' }), () => undefined))
    expect(result.current.failure).toBeNull()
    await settle()
    act(() => result.current.run(() => Promise.resolve(REFUSED), () => undefined))
    await settle()
    expect(result.current.failure).toBe('That branch already exists.')
  })

  it('does not offer a thrown non-git error to the handler, and names a non-Error rejection', async () => {
    const { result } = renderHook(() => useGitRun())
    let offered = 0
    const handler = (): boolean => {
      offered += 1
      return true
    }
    act(() => result.current.run(() => Promise.reject(new Error('IPC closed.')), () => undefined, handler))
    await settle()
    expect(offered).toBe(0)
    expect(result.current.failure).toBe('IPC closed.')
    act(() => result.current.run(() => Promise.reject('gone'), () => undefined, handler))
    await settle()
    expect(result.current.failure).toBe('Git did not answer.')
  })
})
