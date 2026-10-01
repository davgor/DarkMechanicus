import { describe, expect, it } from 'vitest'
import type { ProjectView } from '../shared/domain/views'
import { COMMAND_NAMES, createCannedApi, createStubApi } from './stubApi'

const PROJECT: ProjectView = {
  projectId: 'pj_00000000000000000000000001',
  name: 'Demo',
  keyPrefix: 'DM',
  repoRoot: '/repo',
  createdAt: '2026-01-01T00:00:00.000Z'
}

describe('createStubApi', () => {
  it('rejects unimplemented methods with a not stubbed internal error', async () => {
    const api = createStubApi()
    await expect(api.getProject()).rejects.toMatchObject({
      name: 'DomainError',
      code: 'internal',
      message: 'not stubbed: getProject'
    })
  })

  it('records every call, including unstubbed ones, in order', async () => {
    const api = createStubApi({ getProject: async () => PROJECT })
    await api.getProject()
    await api.getEpic({ epicId: 'ep_1' }).catch(() => undefined)
    expect(api.calls).toEqual([
      { name: 'getProject', input: undefined },
      { name: 'getEpic', input: { epicId: 'ep_1' } }
    ])
  })

  it('delegates to overrides with the call input and returns their value', async () => {
    const api = createStubApi({
      searchHistory: async (input) => [
        {
          docType: 'epic',
          docId: input.query,
          epicId: 'ep_1',
          epicTitle: 'T',
          runId: null,
          ticketId: null,
          title: 'T',
          snippet: ''
        }
      ]
    })
    const rows = await api.searchHistory({ query: 'abc' })
    expect(rows.map((row) => row.docId)).toEqual(['abc'])
  })

  it('exposes a method for every command plus the calls list', () => {
    const api = createStubApi()
    expect(Object.keys(api).sort()).toEqual([...COMMAND_NAMES, 'calls'].sort())
    expect(COMMAND_NAMES).toContain('approveCheckpoint')
  })

  it('keeps separate call logs per stub', async () => {
    const first = createStubApi({ getProject: async () => PROJECT })
    const second = createStubApi({ getProject: async () => PROJECT })
    await first.getProject()
    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(0)
  })
})

describe('createCannedApi', () => {
  it('resolves listed methods to the canned value and records the call', async () => {
    const api = createCannedApi({ getProject: PROJECT, listEpics: [] })
    expect(await api.getProject()).toEqual(PROJECT)
    expect(await api.listEpics()).toEqual([])
    expect(api.calls.map((call) => call.name)).toEqual(['getProject', 'listEpics'])
  })

  it('leaves unlisted methods unstubbed', async () => {
    const api = createCannedApi({ getProject: PROJECT })
    await expect(api.listSessions()).rejects.toMatchObject({ message: 'not stubbed: listSessions' })
  })

  it('returns null for a canned null value', async () => {
    const api = createCannedApi({ getRun: null })
    expect(await api.getRun({ runId: 'rn_1' })).toBeNull()
    expect(api.calls).toEqual([{ name: 'getRun', input: { runId: 'rn_1' } }])
  })
})
