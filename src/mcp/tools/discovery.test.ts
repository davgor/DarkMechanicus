import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import type { CommandName } from '../../shared/domain/api'
import type { ProjectView } from '../../shared/domain/views'
import { areaServer, callTool, sampleId, withRig } from '../../test/mcpHarness'
import { createCannedApi, createStubApi } from '../../test/stubApi'
import { registerDiscoveryTools } from './discovery'

const EPIC = sampleId('epic')
const MARKER = { marker: 'canned' }

interface Case {
  tool: string
  args: Record<string, unknown>
  method: CommandName
  input: unknown
}

const CASES: Case[] = [
  { tool: 'get_capabilities', args: {}, method: 'getCapabilities', input: undefined },
  { tool: 'get_project', args: {}, method: 'getProject', input: undefined },
  {
    tool: 'set_definition_of_done',
    args: { checks: [{ name: 'lint', command: 'npm run lint', description: 'oxlint' }, { name: 'build', command: 'npm run build' }] },
    method: 'setDefinitionOfDone',
    input: {
      checks: [
        { name: 'lint', command: 'npm run lint', description: 'oxlint' },
        { name: 'build', command: 'npm run build', description: '' }
      ]
    }
  },
  { tool: 'set_definition_of_done', args: { checks: [] }, method: 'setDefinitionOfDone', input: { checks: [] } },
  {
    tool: 'initialize_repository',
    args: { name: 'Demo', keyPrefix: 'DM' },
    method: 'initializeRepository',
    input: { name: 'Demo', keyPrefix: 'DM' }
  },
  { tool: 'initialize_repository', args: {}, method: 'initializeRepository', input: {} },
  { tool: 'get_storage_status', args: {}, method: 'getStorageStatus', input: undefined },
  { tool: 'flush_portable_state', args: {}, method: 'flushPortableState', input: undefined },
  { tool: 'reconcile_repository', args: {}, method: 'reconcileRepository', input: undefined },
  {
    tool: 'search_history',
    args: { query: 'login flow', limit: 5, epicId: EPIC },
    method: 'searchHistory',
    input: { query: 'login flow', limit: 5, epicId: EPIC }
  },
  { tool: 'search_history', args: { query: 'x' }, method: 'searchHistory', input: { query: 'x' } },
  { tool: 'list_branch_epics', args: {}, method: 'listBranchEpics', input: undefined },
  { tool: 'list_sessions', args: {}, method: 'listSessions', input: undefined }
]

describe('discovery tools map to the command layer', () => {
  it.each(CASES)('$tool calls $method', async ({ tool, args, method, input }) => {
    const api = createCannedApi({ [method]: MARKER })
    await withRig(areaServer(registerDiscoveryTools), api, async (rig) => {
      const outcome = await callTool(rig, tool, args)
      expect(outcome.isError).toBe(false)
      expect(outcome.payload).toEqual({ ok: true, data: MARKER })
      expect(api.calls).toEqual([{ name: method, input }])
    })
  })
})

describe('list_projects', () => {
  it('lists the single project this session serves', async () => {
    const project: ProjectView = {
      projectId: sampleId('project'),
      name: 'Demo',
      keyPrefix: 'DM',
      repoRoot: '/repo',
      createdAt: '2026-01-01T00:00:00.000Z',
      definitionOfDone: [{ name: 'lint', command: 'npm run lint', description: 'oxlint' }]
    }
    const api = createCannedApi({ getProject: project })
    await withRig(areaServer(registerDiscoveryTools), api, async (rig) => {
      const outcome = await callTool(rig, 'list_projects')
      expect(outcome.payload).toEqual({ ok: true, data: [project] })
      expect(api.calls).toEqual([{ name: 'getProject', input: undefined }])
    })
  })

  it('propagates command errors instead of returning an empty list', async () => {
    const api = createStubApi({
      getProject: async () => {
        throw new DomainError('not_initialized', 'Initialize the repository first.')
      }
    })
    await withRig(areaServer(registerDiscoveryTools), api, async (rig) => {
      const outcome = await callTool(rig, 'list_projects')
      expect(outcome.isError).toBe(true)
      expect(outcome.payload).toEqual({
        ok: false,
        error: { code: 'not_initialized', message: 'Initialize the repository first.' }
      })
    })
  })
})

interface InvalidCase {
  label: string
  tool: string
  args: Record<string, unknown>
}

const INVALID: InvalidCase[] = [
  { label: 'lowercase key prefix', tool: 'initialize_repository', args: { keyPrefix: 'dm' } },
  { label: 'overlong repository name', tool: 'initialize_repository', args: { name: 'n'.repeat(201) } },
  { label: 'empty search query', tool: 'search_history', args: { query: '' } },
  { label: 'search limit of zero', tool: 'search_history', args: { query: 'x', limit: 0 } },
  { label: 'search limit above 100', tool: 'search_history', args: { query: 'x', limit: 101 } },
  { label: 'fractional search limit', tool: 'search_history', args: { query: 'x', limit: 1.5 } },
  { label: 'malformed epic id', tool: 'search_history', args: { query: 'x', epicId: 'nope' } },
  { label: 'missing query', tool: 'search_history', args: {} },
  { label: 'no checks member', tool: 'set_definition_of_done', args: {} },
  { label: 'a blank check name', tool: 'set_definition_of_done', args: { checks: [{ name: ' ', command: 'npm test' }] } },
  { label: 'a check without a command', tool: 'set_definition_of_done', args: { checks: [{ name: 'test' }] } },
  {
    label: 'two checks whose names differ only in case',
    tool: 'set_definition_of_done',
    args: { checks: [{ name: 'test', command: 'npm test' }, { name: 'TEST', command: 'npm run test' }] }
  },
  { label: 'more than 50 checks', tool: 'set_definition_of_done', args: { checks: Array.from({ length: 51 }, (_unused, index) => ({ name: `c${index}`, command: 'x' })) } }
]

describe('discovery input validation', () => {
  it.each(INVALID)('rejects $label without calling the command', async ({ tool, args }) => {
    const api = createCannedApi({ initializeRepository: MARKER, searchHistory: MARKER, setDefinitionOfDone: MARKER })
    await withRig(areaServer(registerDiscoveryTools), api, async (rig) => {
      const outcome = await callTool(rig, tool, args)
      expect(outcome.isError).toBe(true)
      expect(api.calls).toEqual([])
    })
  })

  it('accepts the boundaries of the search limit', async () => {
    const api = createCannedApi({ searchHistory: MARKER })
    await withRig(areaServer(registerDiscoveryTools), api, async (rig) => {
      await callTool(rig, 'search_history', { query: 'x', limit: 1 })
      await callTool(rig, 'search_history', { query: 'x', limit: 100 })
      expect(api.calls.map((call) => call.input)).toEqual([
        { query: 'x', limit: 1 },
        { query: 'x', limit: 100 }
      ])
    })
  })
})
