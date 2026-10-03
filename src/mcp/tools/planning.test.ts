import { describe, expect, it } from 'vitest'
import type { CommandName } from '../../shared/domain/api'
import { areaServer, callTool, type McpRig, sampleId, withRig } from '../../test/mcpHarness'
import { createCannedApi, type StubApi } from '../../test/stubApi'
import { registerPlanningTools } from './planning'

const EPIC = sampleId('epic')
const REVISION = sampleId('revision')
const MARKER = { marker: 'canned' }

const OP_NAMES = [
  'set_epic',
  'add_sprint',
  'update_sprint',
  'remove_sprint',
  'add_ticket',
  'update_ticket',
  'remove_ticket',
  'move_ticket',
  'add_dependency',
  'remove_dependency',
  'add_relation',
  'remove_relation',
  'set_policies',
  'set_rationale'
]

function inRig<T>(api: StubApi, body: (rig: McpRig) => Promise<T>): Promise<T> {
  return withRig(areaServer(registerPlanningTools), api, body)
}

interface Case {
  tool: string
  args: Record<string, unknown>
  method: CommandName
  input: unknown
}

const OPS = [
  { op: 'add_sprint', ref: 's2', sprint: { goal: 'Second', checkpoint: { mode: 'human' } } },
  {
    op: 'add_ticket',
    ref: 'a',
    sprint: 's2',
    ticket: { title: 'A', capability: { reasoning: { level: 'deep', rationale: 'novel design' } } }
  },
  { op: 'add_dependency', from: 'DM-1', to: 'a' },
  { op: 'set_policies', patch: { retryLimit: 2, onTicketFailure: 'pause_run' } }
]

const CASES: Case[] = [
  {
    tool: 'get_plan',
    args: { epicId: EPIC, view: 'saved' },
    method: 'getPlan',
    input: { epicId: EPIC, view: 'saved' }
  },
  {
    tool: 'get_plan',
    args: { epicId: EPIC, view: 'saved', revisionId: REVISION },
    method: 'getPlan',
    input: { epicId: EPIC, view: 'saved', revisionId: REVISION }
  },
  { tool: 'open_plan_draft', args: { epicId: EPIC }, method: 'openDraft', input: { epicId: EPIC } },
  {
    tool: 'update_plan_draft',
    args: { epicId: EPIC, ops: OPS, expectedDraftRevision: 2, idempotencyKey: 'k-1' },
    method: 'updatePlanDraft',
    input: { epicId: EPIC, ops: OPS, expectedDraftRevision: 2, idempotencyKey: 'k-1' }
  },
  {
    tool: 'validate_plan',
    args: { epicId: EPIC, view: 'draft' },
    method: 'validatePlan',
    input: { epicId: EPIC, view: 'draft' }
  },
  {
    tool: 'save_plan',
    args: { epicId: EPIC, expectedDraftRevision: 3, idempotencyKey: 'save-1' },
    method: 'savePlan',
    input: { epicId: EPIC, expectedDraftRevision: 3, idempotencyKey: 'save-1' }
  },
  {
    tool: 'discard_plan_draft',
    args: { epicId: EPIC, expectedDraftRevision: 3 },
    method: 'discardPlanDraft',
    input: { epicId: EPIC, expectedDraftRevision: 3 }
  },
  { tool: 'discard_plan_draft', args: { epicId: EPIC }, method: 'discardPlanDraft', input: { epicId: EPIC } },
  { tool: 'list_revisions', args: { epicId: EPIC }, method: 'listRevisions', input: { epicId: EPIC } }
]

describe('planning tools map to the command layer', () => {
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

const MANY_OPS = (count: number) => Array.from({ length: count }, () => ({ op: 'set_rationale', rationale: 'r' }))

describe('update_plan_draft ops', () => {
  it('accepts the maximum number of operations in one request', async () => {
    const api = createCannedApi({ updatePlanDraft: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'update_plan_draft', { epicId: EPIC, ops: MANY_OPS(500) })
      expect(outcome.isError).toBe(false)
      expect(api.calls).toHaveLength(1)
    })
  })

  it.each([
    ['no operations', { epicId: EPIC, ops: [] }],
    ['one operation too many', { epicId: EPIC, ops: MANY_OPS(501) }],
    ['an unknown operation', { epicId: EPIC, ops: [{ op: 'explode', ticket: 'DM-1' }] }],
    ['an operation with an unknown field', { epicId: EPIC, ops: [{ op: 'remove_ticket', ticket: 'DM-1', force: true }] }],
    ['a dependency without a target', { epicId: EPIC, ops: [{ op: 'add_dependency', from: 'DM-1' }] }],
    ['a malformed epic id', { epicId: 'nope', ops: [{ op: 'set_rationale', rationale: 'r' }] }],
    ['a negative draft revision', { epicId: EPIC, ops: MANY_OPS(1), expectedDraftRevision: -1 }]
  ])('rejects %s without touching the draft', async (_label, args) => {
    const api = createCannedApi({ updatePlanDraft: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'update_plan_draft', args)
      expect(outcome.isError).toBe(true)
      expect(api.calls).toEqual([])
    })
  })
})

describe('planning input validation', () => {
  it.each([
    ['get_plan without an explicit view', 'get_plan', { epicId: EPIC }],
    ['get_plan with an unknown view', 'get_plan', { epicId: EPIC, view: 'latest' }],
    ['get_plan with a malformed revision id', 'get_plan', { epicId: EPIC, view: 'saved', revisionId: 'rev-1' }],
    ['validate_plan without an explicit view', 'validate_plan', { epicId: EPIC }],
    ['save_plan without the draft revision', 'save_plan', { epicId: EPIC }],
    ['save_plan with a fractional draft revision', 'save_plan', { epicId: EPIC, expectedDraftRevision: 1.5 }],
    ['open_plan_draft with an id of the wrong length', 'open_plan_draft', { epicId: EPIC.slice(0, -1) }]
  ])('rejects %s without calling the command', async (_label, tool, args) => {
    const api = createCannedApi({ getPlan: MARKER, validatePlan: MARKER, savePlan: MARKER, openDraft: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, tool, args)
      expect(outcome.isError).toBe(true)
      expect(api.calls).toEqual([])
    })
  })
})

describe('planning tool descriptions', () => {
  it('tells agents how saving is authorized', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const { tools } = await rig.client.listTools()
      const save = tools.find((tool) => tool.name === 'save_plan')
      expect(save?.description).toContain('Validates the whole draft and replaces the saved plan.')
      expect(save?.description).toContain('--allow-save')
      expect(save?.description).toContain('press Save in the desktop app')
    })
  })

  it('lists every draft operation and the ref/refMap contract', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const { tools } = await rig.client.listTools()
      const update = tools.find((tool) => tool.name === 'update_plan_draft')
      for (const op of OP_NAMES) {
        expect(update?.description).toContain(op)
      }
      expect(update?.description).toContain('refMap')
    })
  })
})

describe('update_plan_draft with ticket size and reasoning effort', () => {
  const OPS_WITH_SIZE = [
    {
      op: 'add_ticket',
      ref: 'a',
      sprint: '1',
      ticket: { title: 'Tiny', size: 'micro', capability: { reasoning: { level: 'routine', effort: 'low' } } }
    },
    { op: 'update_ticket', ticket: 'DM-2', patch: { size: 'medium', capability: { reasoning: { effort: 'high' } } } }
  ]

  it('forwards the size and effort of added and updated tickets', async () => {
    const api = createCannedApi({ updatePlanDraft: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'update_plan_draft', { epicId: EPIC, ops: OPS_WITH_SIZE })
      expect(outcome.isError).toBe(false)
      expect(api.calls).toEqual([{ name: 'updatePlanDraft', input: { epicId: EPIC, ops: OPS_WITH_SIZE } }])
    })
  })

  it.each([
    ['an unknown size', { op: 'update_ticket', ticket: 'DM-2', patch: { size: 'tiny' } }],
    ['an unknown effort', { op: 'update_ticket', ticket: 'DM-2', patch: { capability: { reasoning: { effort: 'max' } } } }]
  ])('rejects %s without calling the command', async (_label, op) => {
    const api = createCannedApi({ updatePlanDraft: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'update_plan_draft', { epicId: EPIC, ops: [op] })
      expect(outcome.isError).toBe(true)
      expect(api.calls).toEqual([])
    })
  })

  it('mentions both fields in the tool description, and the new validation warnings in validate_plan', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const { tools } = await rig.client.listTools()
      const update = tools.find((tool) => tool.name === 'update_plan_draft')
      expect(update?.description).toContain('size')
      expect(update?.description).toContain('reasoning.effort')
      const validate = tools.find((tool) => tool.name === 'validate_plan')
      expect(validate?.description).toContain('large')
      expect(validate?.description).toContain('micro')
    })
  })
})
