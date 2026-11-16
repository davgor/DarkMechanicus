// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandResult } from '../../../shared/desktop/api'
import { deferred } from '../__mocks__/deferred'
import { settle } from '../__mocks__/settle'
import { useMailAction } from './useInboxPages'

afterEach(cleanup)

describe('useMailAction', () => {
  it('runs one request at a time: a second run before the first answers asks nothing, and the next one after does', async () => {
    const gate = deferred()
    const answered: string[] = []
    let calls = 0
    const call = async (): Promise<CommandResult<string>> => {
      calls += 1
      await gate.promise
      return { ok: true, data: `answer ${calls}` }
    }
    const { result } = renderHook(() => useMailAction())
    act(() => {
      result.current.run(call, (data) => answered.push(data))
      result.current.run(call, (data) => answered.push(data))
    })
    expect(calls).toBe(1)
    expect(result.current.busy).toBe(true)
    await act(async () => gate.resolve())
    await settle()
    expect(answered).toEqual(['answer 1'])
    act(() => result.current.run(call, (data) => answered.push(data)))
    await settle()
    expect(answered).toEqual(['answer 1', 'answer 2'])
    expect(result.current.busy).toBe(false)
  })
})
