import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import type { CommandApi } from '../../shared/domain/api'
import type { ProjectView, SessionRole } from '../../shared/domain/views'
import { callTool, withRig } from '../../test/mcpHarness'
import { createCannedApi, createStubApi } from '../../test/stubApi'
import { defineArglessTool, defineTool, grantTools, registerTools, type ToolSpec } from './define'

const PROJECT: ProjectView = {
  projectId: 'pj_00000000000000000000000001',
  name: 'Demo',
  keyPrefix: 'DM',
  repoRoot: '/repo',
  createdAt: '2026-01-01T00:00:00.000Z',
  definitionOfDone: []
}

const getProject = defineArglessTool({
  name: 'demo_get_project',
  command: 'getProject',
  description: 'Reads the project.',
  kind: 'read',
  run: (api) => api.getProject()
})

const searchDemo = defineTool({
  name: 'demo_search',
  command: 'searchHistory',
  description: 'Searches.',
  kind: 'write',
  input: { query: z.string().min(2), limit: z.number().int().default(5) },
  run: (api, input) => api.searchHistory(input)
})

const createDemo = defineTool({
  name: 'demo_create',
  command: 'createEpic',
  description: 'Creates.',
  kind: 'write',
  input: { title: z.string() },
  run: (api, input) => api.createEpic(input)
})

function serverOf(specs: ToolSpec[]): (api: CommandApi) => McpServer {
  return (api) => {
    const server = new McpServer({ name: 'test-server', version: '0.0.0' })
    registerTools(server, api, specs)
    return server
  }
}

describe('defineTool arguments', () => {
  it('passes validated input, with defaults applied, to the command', async () => {
    const api = createStubApi({ searchHistory: async () => [] })
    await withRig(serverOf([searchDemo]), api, async (rig) => {
      const outcome = await callTool(rig, 'demo_search', { query: 'abc' })
      expect(outcome.payload).toEqual({ ok: true, data: [] })
      expect(api.calls).toEqual([{ name: 'searchHistory', input: { query: 'abc', limit: 5 } }])
    })
  })

  it('rejects invalid input with a structured invalid_input failure before running the command', async () => {
    const api = createStubApi({ searchHistory: async () => [] })
    await withRig(serverOf([searchDemo]), api, async (rig) => {
      const outcome = await callTool(rig, 'demo_search', { query: 'a' })
      expect(outcome.isError).toBe(true)
      expect(outcome.payload).toEqual({
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'Invalid arguments for demo_search: query: Too small: expected string to have >=2 characters',
          details: {
            tool: 'demo_search',
            issues: [{ path: 'query', message: 'Too small: expected string to have >=2 characters' }]
          }
        }
      })
      expect(api.calls).toEqual([])
    })
  })

  it('ignores arguments sent to a tool that takes none', async () => {
    const api = createStubApi({ getProject: async () => PROJECT })
    await withRig(serverOf([getProject]), api, async (rig) => {
      const outcome = await callTool(rig, 'demo_get_project', { stray: true })
      expect(outcome.payload).toEqual({ ok: true, data: PROJECT })
      expect(api.calls).toEqual([{ name: 'getProject', input: undefined }])
    })
  })
})

describe('defineTool results', () => {
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
})

describe('defineTool published schema', () => {
  it('publishes the description and the input schema', async () => {
    await withRig(serverOf([searchDemo]), createStubApi(), async (rig) => {
      const { tools } = await rig.client.listTools()
      expect(tools).toHaveLength(1)
      expect(tools[0]?.description).toBe('Searches.')
      expect(tools[0]?.inputSchema.required).toEqual(['query'])
    })
  })

  it('publishes exactly the JSON schema of the declared input, not the validation behind it', async () => {
    await withRig(serverOf([searchDemo]), createStubApi(), async (rig) => {
      const { tools } = await rig.client.listTools()
      expect(tools[0]?.inputSchema).toEqual({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 2 },
          limit: { type: 'integer', default: 5, minimum: -9007199254740991, maximum: 9007199254740991 }
        },
        required: ['query']
      })
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
    defineArglessTool({ name: `kind_${kind}`, command: 'getProject', description: kind, kind, run: (api) => api.getProject() })
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

describe('the command a tool adapts', () => {
  it('is the camel-cased tool name unless the tool declares another', () => {
    const named = defineArglessTool({ name: 'list_branch_epics', description: 'x', kind: 'read', run: (api) => api.listBranchEpics() })
    const declared = defineArglessTool({
      name: 'list_projects',
      command: 'getProject',
      description: 'x',
      kind: 'read',
      run: (api) => api.getProject()
    })
    expect([named.command, declared.command, searchDemo.command]).toEqual(['listBranchEpics', 'getProject', 'searchHistory'])
  })

  it('must exist: a tool that names no command fails when it is defined', () => {
    const unnamed = { name: 'no_such_command', description: 'x', kind: 'read', run: async () => null }
    expect(() => defineArglessTool(unnamed as unknown as Parameters<typeof defineArglessTool>[0])).toThrow(
      'Tool no_such_command does not name a command; declare the command it adapts.'
    )
  })
})

/** A server whose session was granted the capabilities of `role` before any tool was registered. */
function grantedServerOf(role: SessionRole, specs: ToolSpec[]): (api: CommandApi) => McpServer {
  return (api) => {
    const server = new McpServer({ name: 'test-server', version: '0.0.0' })
    grantTools(server, { role, allowSave: false })
    registerTools(server, api, specs)
    return server
  }
}

describe('registerTools for a granted session', () => {
  it('registers only the tools whose command the role may call', async () => {
    await withRig(grantedServerOf('reviewer', [getProject, createDemo, searchDemo]), createStubApi(), async (rig) => {
      const { tools } = await rig.client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual(['demo_get_project', 'demo_search'])
    })
  })

  it('registers every tool for a role that holds every capability they need', async () => {
    await withRig(grantedServerOf('planner', [getProject, createDemo]), createStubApi(), async (rig) => {
      const { tools } = await rig.client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual(['demo_get_project', 'demo_create'])
    })
  })

  it('answers a withheld tool with unauthorized and never runs it', async () => {
    const api = createCannedApi({ createEpic: { id: 'ep_1' } })
    await withRig(grantedServerOf('reviewer', [getProject, createDemo]), api, async (rig) => {
      const outcome = await callTool(rig, 'demo_create', { title: 'x' })
      expect(outcome.payload).toEqual({
        ok: false,
        error: {
          code: 'unauthorized',
          message: 'This reviewer session is not permitted to perform "epic.create".',
          details: { role: 'reviewer', capability: 'epic.create', tool: 'demo_create' }
        }
      })
      expect(api.calls).toEqual([])
    })
  })
})
