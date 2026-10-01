import { describe, expect, it } from 'vitest'
import { defaultCapabilityProfile } from '../../shared/domain/bundle'
import type { CommandName } from '../../shared/domain/api'
import { areaServer, callTool, type McpRig, withRig } from '../../test/mcpHarness'
import { createCannedApi, type StubApi } from '../../test/stubApi'
import { registerProfileTools } from './profiles'

const MARKER = { marker: 'canned' }
const CAPABILITY = { ...defaultCapabilityProfile(), workType: 'review', reasoning: { level: 'deep', rationale: 'Careful' } }

function inRig<T>(api: StubApi, body: (rig: McpRig) => Promise<T>): Promise<T> {
  return withRig(areaServer(registerProfileTools), api, body)
}

interface Case {
  tool: string
  args: Record<string, unknown>
  method: CommandName
  input: unknown
}

const CASES: Case[] = [
  { tool: 'list_profiles', args: {}, method: 'listProfiles', input: undefined },
  { tool: 'get_profile', args: { name: 'deep-review' }, method: 'getProfile', input: { name: 'deep-review' } },
  {
    tool: 'save_profile',
    args: { name: 'deep-review', capability: CAPABILITY },
    method: 'saveProfile',
    input: { name: 'deep-review', capability: CAPABILITY }
  },
  {
    tool: 'save_profile',
    args: { name: 'deep-review', description: 'Careful review', capability: CAPABILITY, expectedRevision: 2, idempotencyKey: 'p-1' },
    method: 'saveProfile',
    input: { name: 'deep-review', description: 'Careful review', capability: CAPABILITY, expectedRevision: 2, idempotencyKey: 'p-1' }
  }
]

describe('profile tools map to the command layer', () => {
  it.each(CASES)('$tool calls $method', async ({ tool, args, method, input }) => {
    const api = createCannedApi({ [method]: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, tool, args)
      expect(outcome.isError).toBe(false)
      expect(outcome.payload).toEqual({ ok: true, data: MARKER })
      expect(api.calls).toEqual([{ name: method, input }])
    })
  })
})

describe('profile tool input validation', () => {
  it.each([
    ['get_profile without a name', 'get_profile', {}],
    ['get_profile with a traversal name', 'get_profile', { name: '../escape' }],
    ['save_profile with a device name', 'save_profile', { name: 'con', capability: CAPABILITY }],
    ['save_profile with an uppercase name', 'save_profile', { name: 'Review', capability: CAPABILITY }],
    ['save_profile without a capability', 'save_profile', { name: 'ui' }],
    ['save_profile with a partial capability', 'save_profile', { name: 'ui', capability: { workType: 'review' } }],
    ['save_profile with an unknown capability field', 'save_profile', { name: 'ui', capability: { ...CAPABILITY, vendor: 'x' } }],
    ['save_profile with a 501-character description', 'save_profile', { name: 'ui', description: 'x'.repeat(501), capability: CAPABILITY }],
    ['save_profile with a fractional revision', 'save_profile', { name: 'ui', capability: CAPABILITY, expectedRevision: 1.5 }]
  ])('rejects %s without calling the command', async (_label, tool, args) => {
    const api = createCannedApi({ getProfile: MARKER, saveProfile: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, tool, args)
      expect(outcome.isError).toBe(true)
      expect(api.calls).toEqual([])
    })
  })

  it('accepts a 500-character description and a 64-character name', async () => {
    const api = createCannedApi({ saveProfile: MARKER })
    await inRig(api, async (rig) => {
      const name = `a${'b'.repeat(63)}`
      const outcome = await callTool(rig, 'save_profile', { name, description: 'x'.repeat(500), capability: CAPABILITY })
      expect(outcome.isError).toBe(false)
      expect(api.calls.map((call) => call.name)).toEqual(['saveProfile'])
    })
  })
})

describe('profile tool descriptions', () => {
  it('teach naming, revisions, and provider neutrality', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const { tools } = await rig.client.listTools()
      const save = tools.find((tool) => tool.name === 'save_profile')?.description ?? ''
      for (const phrase of ['.darkmechanicus/profiles/<name>.json', 'expectedRevision', '`conflict`', 'never name vendors', 'modelOverride']) {
        expect(save).toContain(phrase)
      }
      expect(tools.map((tool) => tool.name)).toEqual(['list_profiles', 'get_profile', 'save_profile'])
    })
  })
})
