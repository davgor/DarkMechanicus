import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import type { CommandApi } from '../../shared/domain/api'
import type { ProjectView } from '../../shared/domain/views'
import { callTool, withRig } from '../../test/mcpHarness'
import { createStubApi } from '../../test/stubApi'
import { defineArglessTool, defineTool, registerTools, type ToolSpec } from './define'

const PROJECT: ProjectView = {
  projectId: 'pj_00000000000000000000000001',
  name: 'Demo',
  keyPrefix: 'DM',
  repoRoot: '/repo',
  createdAt: '2026-01-01T00:00:00.000Z'
}

const getProject = defineArglessTool({
  name: 'demo_get_project',
  description: 'Reads the project.',
  kind: 'read',
  run: (api) => api.getProject()
})

const searchDemo = defineTool({
  name: 'demo_search',
  description: 'Searches.',
  kind: 'write',
  input: { query: z.string().min(2), limit: z.number().int().default(5) },
  run: (api, input) => api.searchHistory(input)
})

function serverOf(specs: ToolSpec[]): (api: CommandApi) => McpServer {
  return (api) => {
    const server = new McpServer({ name: 'test-server', version: '0.0.0' })
    registerTools(server, api, specs)
    return server
  }
}

describe('defineTool', () => {
  it('passes validated input, with defaults applied, to the command', async () => {
    const api = createStubApi({ searchHistory: async () => [] })
    await withRig(serverOf([searchDemo]), api, async (rig) => {
      const outcome = await callTool(rig, 'demo_search', { query: 'abc' })
      expect(outcome.payload).toEqual({ ok: true, data: [] })
      expect(api.calls).toEqual([{ name: 'searchHistory', input: { query: 'abc', limit: 5 } }])
    })
  })

  it('rejects invalid input before running the command', async () => {
    const api = createStubApi({ searchHistory: async () => [] })
    await withRig(serverOf([searchDemo]), api, async (rig) => {
      const outcome = await callTool(rig, 'demo_search', { query: 'a' })
      expect(outcome.isError).toBe(true)
      expect(outcome.text).toContain('query')
      expect(api.calls).toEqual([])
    })
  })

  it('turns command errors into structured failures', async () => {
    const api = createStubApi({
      searchHistory: async () => {
        throw new DomainError('not_initialized', 'Run initialize_repository first.')
      }
    })
    await withRig(serverOf([searchDemo]), api, async (rig) => {
      const outcome = await callTool(rig, 'demo_search', { query: 'abc' })
      expect(outcome.isError).toBe(true)
      expect(outcome.payload).toEqual({
        ok: false,
        error: { code: 'not_initialized', message: 'Run initialize_repository first.' }
      })
    })
  })

  it('publishes the description and the input schema', async () => {
    await withRig(serverOf([searchDemo]), createStubApi(), async (rig) => {
      const { tools } = await rig.client.listTools()
      expect(tools).toHaveLength(1)
      expect(tools[0]?.description).toBe('Searches.')
      expect(tools[0]?.inputSchema.required).toEqual(['query'])
    })
  })
})

describe('defineArglessTool', () => {
  it('runs without arguments and publishes an empty input schema', async () => {
    const api = createStubApi({ getProject: async () => PROJECT })
    await withRig(serverOf([getProject]), api, async (rig) => {
      const result = await rig.client.callTool({ name: 'demo_get_project' })
      expect(result.structuredContent).toEqual({ ok: true, data: PROJECT })
      const { tools } = await rig.client.listTools()
      expect(tools[0]?.inputSchema).toEqual({ type: 'object', properties: {} })
      expect(api.calls).toEqual([{ name: 'getProject', input: undefined }])
    })
  })
})

describe('tool kinds', () => {
  const kinds = (['read', 'idempotent', 'write', 'destructive'] as const).map((kind) =>
    defineArglessTool({ name: `kind_${kind}`, description: kind, kind, run: (api) => api.getProject() })
  )

  it('maps each kind to its MCP annotation hints', async () => {
    await withRig(serverOf(kinds), createStubApi(), async (rig) => {
      const { tools } = await rig.client.listTools()
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))
      expect(byName['kind_read']).toEqual({ readOnlyHint: true, openWorldHint: false })
      expect(byName['kind_idempotent']).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      })
      expect(byName['kind_write']).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      })
      expect(byName['kind_destructive']).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      })
    })
  })
})

describe('registerTools', () => {
  it('registers every spec, in order', async () => {
    await withRig(serverOf([getProject, searchDemo]), createStubApi(), async (rig) => {
      const { tools } = await rig.client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual(['demo_get_project', 'demo_search'])
    })
  })

  it('refuses to register the same tool twice', () => {
    const server = new McpServer({ name: 'test-server', version: '0.0.0' })
    expect(() => registerTools(server, createStubApi(), [getProject, getProject])).toThrow(
      /already registered/
    )
  })
})
