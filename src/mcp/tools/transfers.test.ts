import { describe, expect, it } from 'vitest'
import type { CommandName } from '../../shared/domain/api'
import type { SessionRole } from '../../shared/domain/views'
import { areaServer, callTool, type McpRig, sampleId, withRig } from '../../test/mcpHarness'
import { createCannedApi, type StubApi } from '../../test/stubApi'
import { createMcpServer } from '../server'
import { registerTransferTools } from './transfers'

const EPIC = sampleId('epic')
const MARKER = { marker: 'canned' }
const INFO = { name: 'darkmechanicus', version: '1.2.3' }

const ISSUE = {
  linearId: 'lin-issue-1',
  identifier: 'ENG-1',
  milestoneId: 'lin-milestone-1',
  title: 'First',
  description: 'Body',
  priority: 3,
  labels: ['backend'],
  stateType: 'unstarted'
}
const READBACK = {
  project: { linearId: 'lin-project', url: 'https://linear.app/acme/project/p', name: 'Handoff', summary: 's', content: 'c' },
  milestones: [{ linearId: 'lin-milestone-1', name: 'Sprint 1', description: 'd' }],
  issues: [ISSUE, { ...ISSUE, linearId: 'lin-issue-2', identifier: 'ENG-2', milestoneId: null, sortOrder: 2.5 }],
  relations: [{ kind: 'blocks', fromId: 'lin-issue-1', toId: 'lin-issue-2' }]
}

function inRig<T>(api: StubApi, body: (rig: McpRig) => Promise<T>): Promise<T> {
  return withRig(areaServer(registerTransferTools), api, body)
}

interface Case {
  tool: string
  args: Record<string, unknown>
  method: CommandName
}

const CASES: Case[] = [
  { tool: 'get_transfer', args: { epicId: EPIC }, method: 'getTransfer' },
  { tool: 'start_transfer', args: { epicId: EPIC }, method: 'startTransfer' },
  { tool: 'start_transfer', args: { epicId: EPIC, idempotencyKey: 'start-1' }, method: 'startTransfer' },
  { tool: 'record_transfer_item', args: { epicId: EPIC, ref: 'project', linearId: 'lin-project', url: READBACK.project.url }, method: 'recordTransferItem' },
  {
    tool: 'record_transfer_item',
    args: { epicId: EPIC, ref: `rel:${sampleId('ticket', 1)}:${sampleId('ticket', 2)}`, linearId: 'lin-rel', replace: true, idempotencyKey: 'r-1' },
    method: 'recordTransferItem'
  },
  { tool: 'record_transfer_item', args: { epicId: EPIC, ref: sampleId('ticket', 1), linearId: 'lin-1', identifier: 'ENG-1' }, method: 'recordTransferItem' },
  { tool: 'submit_transfer_readback', args: { epicId: EPIC, readback: READBACK, final: true }, method: 'submitTransferReadback' },
  { tool: 'submit_transfer_readback', args: { epicId: EPIC, readback: {}, final: false }, method: 'submitTransferReadback' }
]

describe('transfer tools map to the command layer', () => {
  it.each(CASES)('$tool calls $method with its arguments', async ({ tool, args, method }) => {
    const api = createCannedApi({ [method]: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, tool, args)
      expect(outcome.isError).toBe(false)
      expect(outcome.payload).toEqual({ ok: true, data: MARKER })
      expect(api.calls).toEqual([{ name: method, input: args }])
    })
  })
})

const issueWith = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...ISSUE, ...patch })
const { stateType: _state, ...issueWithoutState } = ISSUE

const INVALID: [string, string, Record<string, unknown>, string][] = [
  ['get_transfer', 'a malformed epic id', { epicId: 'nope' }, 'epicId'],
  ['get_transfer', 'a missing epic id', {}, 'epicId'],
  ['start_transfer', 'a malformed epic id', { epicId: 'DM-1' }, 'epicId'],
  ['start_transfer', 'an empty idempotency key', { epicId: EPIC, idempotencyKey: '' }, 'idempotencyKey'],
  ['record_transfer_item', 'a missing linearId', { epicId: EPIC, ref: 'project' }, 'linearId'],
  ['record_transfer_item', 'an empty linearId', { epicId: EPIC, ref: 'project', linearId: '' }, 'linearId'],
  ['record_transfer_item', 'a ref with spaces', { epicId: EPIC, ref: 'the project', linearId: 'l' }, 'ref'],
  ['record_transfer_item', 'an over-long ref', { epicId: EPIC, ref: 'x'.repeat(201), linearId: 'l' }, 'ref'],
  ['record_transfer_item', 'an over-long url', { epicId: EPIC, ref: 'project', linearId: 'l', url: 'x'.repeat(2_001) }, 'url'],
  ['record_transfer_item', 'a non-boolean replace', { epicId: EPIC, ref: 'project', linearId: 'l', replace: 'yes' }, 'replace'],
  ['submit_transfer_readback', 'a missing final', { epicId: EPIC, readback: {} }, 'final'],
  ['submit_transfer_readback', 'a sortOrder given as text', { epicId: EPIC, readback: { issues: [issueWith({ sortOrder: '1e999' })] }, final: false }, 'sortOrder'],
  ['submit_transfer_readback', 'an issue without stateType', { epicId: EPIC, readback: { issues: [issueWithoutState] }, final: false }, 'stateType'],
  ['submit_transfer_readback', 'an issue without milestoneId', { epicId: EPIC, readback: { issues: [issueWith({ milestoneId: undefined })] }, final: false }, 'milestoneId'],
  ['submit_transfer_readback', 'a priority above 4', { epicId: EPIC, readback: { issues: [issueWith({ priority: 5 })] }, final: false }, 'priority'],
  ['submit_transfer_readback', 'an infinite sortOrder', { epicId: EPIC, readback: { issues: [issueWith({ sortOrder: '1e999' })] }, final: false }, 'sortOrder'],
  [
    'submit_transfer_readback',
    '1,001 issues in one part',
    { epicId: EPIC, readback: { issues: Array.from({ length: 1_001 }, () => ISSUE) }, final: false },
    'issues'
  ],
  [
    'submit_transfer_readback',
    'a project without content',
    { epicId: EPIC, readback: { project: { linearId: 'p', url: 'u', name: 'n', summary: 's' } }, final: false },
    'content'
  ],
  [
    'submit_transfer_readback',
    'a relation without toId',
    { epicId: EPIC, readback: { relations: [{ kind: 'blocks', fromId: 'a' }] }, final: false },
    'toId'
  ],
  [
    'submit_transfer_readback',
    'an unknown readback list',
    { epicId: EPIC, readback: { cycles: [] }, final: false },
    'cycles'
  ]
]

describe('transfer tool input', () => {
  it.each(INVALID)('%s rejects %s before anything runs', async (tool, _label, args, problem) => {
    const api = createCannedApi({ getTransfer: MARKER, startTransfer: MARKER, recordTransferItem: MARKER, submitTransferReadback: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, tool, args)
      expect(outcome.isError).toBe(true)
      expect(outcome.payload).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      expect(outcome.text).toContain(problem)
      expect(api.calls).toEqual([])
    })
  })

  it('drops an idempotency key from a read-back part: the command takes none', async () => {
    const api = createCannedApi({ submitTransferReadback: MARKER })
    await inRig(api, async (rig) => {
      await callTool(rig, 'submit_transfer_readback', { epicId: EPIC, readback: {}, final: false, idempotencyKey: 'part-1' })
      expect(api.calls).toEqual([{ name: 'submitTransferReadback', input: { epicId: EPIC, readback: {}, final: false } }])
    })
  })
})

const serverFor = (role: SessionRole) => (api: Parameters<typeof createMcpServer>[0]) =>
  createMcpServer(api, INFO, { role, allowSave: true })
const TRANSFER_TOOLS = ['get_transfer', 'start_transfer', 'record_transfer_item', 'submit_transfer_readback']
const START = { epicId: EPIC }
const RECORD = { epicId: EPIC, ref: 'project', linearId: 'lin-project' }

describe('transfer tools per role', () => {
  it('lets an orchestrator start, record, read back and get', async () => {
    const api = createCannedApi({ getTransfer: MARKER, startTransfer: MARKER, recordTransferItem: MARKER, submitTransferReadback: MARKER })
    await withRig(serverFor('orchestrator'), api, async (rig) => {
      const listed = (await rig.client.listTools()).tools.map((tool) => tool.name)
      expect(listed.filter((name) => name.includes('transfer')).sort()).toEqual([...TRANSFER_TOOLS].sort())
      expect((await callTool(rig, 'start_transfer', START)).isError).toBe(false)
      expect((await callTool(rig, 'record_transfer_item', RECORD)).isError).toBe(false)
      expect((await callTool(rig, 'submit_transfer_readback', { epicId: EPIC, readback: {}, final: false })).isError).toBe(false)
      expect((await callTool(rig, 'get_transfer', START)).isError).toBe(false)
      expect(api.calls.map((call) => call.name)).toEqual(['startTransfer', 'recordTransferItem', 'submitTransferReadback', 'getTransfer'])
    })
  })

  it.each(['worker', 'reviewer', 'planner'] as const)(
    'lets a %s get the transfer but not start, record or read back',
    async (role) => {
      const api = createCannedApi({ getTransfer: MARKER })
      await withRig(serverFor(role), api, async (rig) => {
        const listed = (await rig.client.listTools()).tools.map((tool) => tool.name)
        expect(listed.filter((name) => name.includes('transfer'))).toEqual(['get_transfer'])
        expect((await callTool(rig, 'get_transfer', START)).payload).toEqual({ ok: true, data: MARKER })
        for (const [tool, args] of [
          ['start_transfer', START],
          ['record_transfer_item', RECORD],
          ['submit_transfer_readback', { epicId: EPIC, readback: {}, final: true }]
        ] as const) {
          const outcome = await callTool(rig, tool, args)
          expect(outcome.payload).toEqual({
            ok: false,
            error: {
              code: 'unauthorized',
              message: `This ${role} session is not permitted to perform "epic.transfer".`,
              details: { role, capability: 'epic.transfer', tool }
            }
          })
        }
        expect(api.calls).toEqual([{ name: 'getTransfer', input: START }])
      })
    }
  )
})

describe('the human-only transfer commands', () => {
  it.each(['orchestrator', 'planner', 'worker', 'reviewer'] as const)('offers a %s no tool to queue or cancel a transfer', async (role) => {
    const api = createCannedApi({})
    await withRig(serverFor(role), api, async (rig) => {
      const listed = (await rig.client.listTools()).tools.map((tool) => tool.name)
      expect(listed.filter((name) => /queue|cancel_transfer/.test(name))).toEqual([])
      for (const tool of ['queue_transfer', 'cancel_transfer']) {
        expect((await callTool(rig, tool, { epicId: EPIC })).payload).toMatchObject({ ok: false, error: { code: 'not_found' } })
      }
      expect(api.calls).toEqual([])
    })
  })
})

describe('transfer tool listing', () => {
  it('publishes the four tools with their required inputs and kinds', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const { tools } = await rig.client.listTools()
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
      expect(Object.keys(byName).sort()).toEqual(['get_transfer', 'record_transfer_item', 'start_transfer', 'submit_transfer_readback'])
      expect(byName['get_transfer']?.inputSchema.required).toEqual(['epicId'])
      expect(byName['start_transfer']?.inputSchema.required).toEqual(['epicId'])
      expect(byName['record_transfer_item']?.inputSchema.required).toEqual(['epicId', 'ref', 'linearId'])
      expect(byName['submit_transfer_readback']?.inputSchema.required).toEqual(['epicId', 'readback', 'final'])
      expect(byName['get_transfer']?.annotations).toMatchObject({ readOnlyHint: true })
      expect(byName['start_transfer']?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true, destructiveHint: false })
      expect(byName['record_transfer_item']?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true, destructiveHint: false })
      expect(byName['submit_transfer_readback']?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false, destructiveHint: false })
    })
  })
})
