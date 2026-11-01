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

describe('Kanban card tool descriptions', () => {
  it('say what a card is and that only a person plays, approves or kicks back', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const { tools } = await rig.client.listTools()
      expect(tools).toHaveLength(8)
      for (const tool of tools) {
        expect(tool.description).toContain('no prerequisites and nothing depending on it, done in one attempt')
        expect(tool.description).toContain('Only a person presses Play, approves or kicks back, in the desktop app')
      }
    })
  })

  it('tell the claimer that a claim needs a person\'s Play', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const claim = (await rig.client.listTools()).tools.find((tool) => tool.name === 'claim_kanban_card')
      expect(claim?.description).toContain("Claim needs a person's Play")
      expect(claim?.description).toContain('play_required')
    })
  })
})
