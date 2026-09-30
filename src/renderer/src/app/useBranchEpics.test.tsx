// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { settle } from '../__mocks__/settle'
import { useBranchEpics } from './useBranchEpics'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

describe('useBranchEpics', () => {
  it('loads the epics recorded on other branches for the folder', async () => {
    const entry = { branch: 'feature/x', epicId: 'ep_1', title: 'X', status: 'backlog', revisionNumber: 2, presentLocally: false }
    dm.responses.listBranchEpics = [entry]
    const view = renderHook(() => useBranchEpics('/a', () => undefined))
    expect(view.result.current).toEqual({ status: 'loading' })
    await settle()
    expect(view.result.current).toEqual({ status: 'ready', value: [entry] })
    expect(dm.callsOf('listBranchEpics').map((call) => call.folder)).toEqual(['/a'])
  })

  it('reports a failure', async () => {
    dm.failures.listBranchEpics = { code: 'internal', message: 'git unavailable' }
    const errors: unknown[] = []
    const view = renderHook(() => useBranchEpics('/a', (e) => errors.push(e)))
    await settle()
    expect(view.result.current).toEqual({ status: 'error' })
    expect((errors[0] as Error).message).toBe('git unavailable')
  })
})
