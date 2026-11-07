import { describe, expect, it } from 'vitest'
import type { CommandName } from '../../shared/domain/api'
import { areaServer, callTool, type McpRig, sampleId, withRig } from '../../test/mcpHarness'
import { createCannedApi, type StubApi } from '../../test/stubApi'
import { registerKanbanTools } from './kanban'

const CARD = sampleId('kanbanCard')
const ATTEMPT = sampleId('kanbanAttempt')
const MARKER = { marker: 'canned' }

function inRig<T>(api: StubApi, body: (rig: McpRig) => Promise<T>): Promise<T> {
  return withRig(areaServer(registerKanbanTools), api, body)
}

interface Case {
  tool: string
  args: Record<string, unknown>
  method: CommandName
}

const CASES: Case[] = [
  { tool: 'create_kanban_card', args: { title: 'Fix the clock', priority: 'high', size: 'small' }, method: 'createKanbanCard' },
  { tool: 'update_kanban_card', args: { cardId: CARD, expectedRevision: 2, size: null }, method: 'updateKanbanCard' },
  { tool: 'list_kanban_cards', args: { doneLimit: 5 }, method: 'listKanbanCards' },
  { tool: 'get_kanban_card', args: { cardId: CARD }, method: 'getKanbanCard' },
  { tool: 'launch_kanban_cards', args: { cardIds: [CARD] }, method: 'launchKanbanCards' },
  { tool: 'claim_kanban_card', args: { cardId: CARD, leaseSeconds: 600, idempotencyKey: 'claim-1' }, method: 'claimKanbanCard' },
  {
    tool: 'heartbeat_kanban_card',
    args: { attemptId: ATTEMPT, claimToken: 'tok', progressNote: 'testing' },
    method: 'heartbeatKanbanCard'
  },
  {
    tool: 'submit_kanban_card',
    args: { attemptId: ATTEMPT, claimToken: 'tok', outputs: { summary: 'Done.' } },
    method: 'submitKanbanCard'
  },
  { tool: 'fail_kanban_card', args: { attemptId: ATTEMPT, claimToken: 'tok', reason: 'Blocked' }, method: 'failKanbanCard' }
]

describe('Kanban card tools map to the command layer', () => {
  it.each(CASES)('$tool calls $method with its arguments', async ({ tool, args, method }) => {
    const api = createCannedApi({ [method]: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, tool, args)
      expect(outcome.payload).toEqual({ ok: true, data: MARKER })
      expect(api.calls).toEqual([{ name: method, input: args }])
    })
  })

  it('refuses a card without a title before running anything', async () => {
    const api = createCannedApi({ createKanbanCard: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'create_kanban_card', { body: 'No title' })
      expect(outcome.payload).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      expect(api.calls).toEqual([])
    })
  })
})

describe('lost Kanban claim recovery discovery', () => {
  it('advertises tokenless release without weakening heartbeat or submission requirements', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const tools = (await rig.client.listTools()).tools
      const failure = tools.find((tool) => tool.name === 'fail_kanban_card')
      expect(failure?.inputSchema.required).toEqual(['attemptId', 'reason'])
      for (const name of ['heartbeat_kanban_card', 'submit_kanban_card']) {
        expect(tools.find((tool) => tool.name === name)?.inputSchema.required).toContain('claimToken')
      }
    })
  })
})

describe('external launch discovery contract', () => {
  it('requires an explicit nonempty array of stable card IDs', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const launch = (await rig.client.listTools()).tools.find((tool) => tool.name === 'launch_kanban_cards')
      expect(launch?.inputSchema).toMatchObject({
        type: 'object', required: ['cardIds'],
        properties: { cardIds: { type: 'array', minItems: 1, items: { type: 'string', pattern: expect.any(String) } } }
      })
    })
  })

  it.each([{}, { cardIds: [] }, { cardIds: ['not-an-id'] }])('refuses malformed launch input before forwarding: %j', async (input) => {
    const api = createCannedApi({ launchKanbanCards: MARKER })
    await inRig(api, async (rig) => {
      expect((await callTool(rig, 'launch_kanban_cards', input)).payload).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      expect(api.calls).toEqual([])
    })
  })
})
