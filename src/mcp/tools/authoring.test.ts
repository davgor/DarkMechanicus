import { describe, expect, it } from 'vitest'
import type { CommandName, DraftOp } from '../../shared/domain/api'
import type { DraftUpdateResultView } from '../../shared/domain/views'
import { areaServer, callTool, type McpRig, sampleId, withRig } from '../../test/mcpHarness'
import { createCannedApi, type StubApi } from '../../test/stubApi'
import { registerAuthoringTools } from './authoring'

const EPIC = sampleId('epic')
const TICKET = sampleId('ticket', 7)
const MARKER = { marker: 'canned' }
const BRANCH = { repository: null, name: 'epic/checkout', startCommit: 'abc1234' }

/** Runs a body against a server carrying only the authoring tools. */
function inRig<T>(api: StubApi, body: (rig: McpRig) => Promise<T>): Promise<T> {
  return withRig(areaServer(registerAuthoringTools), api, body)
}

interface Case {
  tool: string
  args: Record<string, unknown>
  method: CommandName
  input: unknown
}

const CASES: Case[] = [
  { tool: 'list_epics', args: {}, method: 'listEpics', input: undefined },
  {
    tool: 'create_epic',
    args: { title: 'Checkout' },
    method: 'createEpic',
    input: { title: 'Checkout' }
  },
  {
    tool: 'create_epic',
    args: {
      title: 'Checkout v2',
      intent: 'Redo checkout.',
      successCriteria: ['Pays', { id: 's4', text: 'Refunds' }],
      ownerRole: 'planner',
      branch: BRANCH,
      provenance: { sourceEpicId: EPIC, note: 'Follow-up' },
      idempotencyKey: 'create-1'
    },
    method: 'createEpic',
    input: {
      title: 'Checkout v2',
      intent: 'Redo checkout.',
      successCriteria: ['Pays', { id: 's4', text: 'Refunds' }],
      ownerRole: 'planner',
      branch: BRANCH,
      provenance: { sourceEpicId: EPIC, note: 'Follow-up' },
      idempotencyKey: 'create-1'
    }
  },
  { tool: 'get_epic', args: { epicId: EPIC }, method: 'getEpic', input: { epicId: EPIC } },
  {
    tool: 'set_epic_status',
    args: { epicId: EPIC, status: 'in_progress', expectedRevision: 3 },
    method: 'setEpicStatus',
    input: { epicId: EPIC, status: 'in_progress', expectedRevision: 3 }
  },
  {
    tool: 'set_epic_branch',
    args: { epicId: EPIC, branch: BRANCH, expectedRevision: 0 },
    method: 'setEpicBranch',
    input: { epicId: EPIC, branch: BRANCH, expectedRevision: 0 }
  },
  {
    tool: 'list_tickets',
    args: { epicId: EPIC },
    method: 'listTickets',
    input: { epicId: EPIC, view: 'saved' }
  },
  {
    tool: 'list_tickets',
    args: { epicId: EPIC, view: 'draft' },
    method: 'listTickets',
    input: { epicId: EPIC, view: 'draft' }
  },
  {
    tool: 'get_ticket',
    args: { epicId: EPIC, ticketId: 'DM-12' },
    method: 'getTicket',
    input: { epicId: EPIC, ticketId: 'DM-12', view: 'saved' }
  },
  {
    tool: 'get_ticket',
    args: { epicId: EPIC, ticketId: TICKET, view: 'draft' },
    method: 'getTicket',
    input: { epicId: EPIC, ticketId: TICKET, view: 'draft' }
  },
  {
    tool: 'set_ticket_status',
    args: { ticketId: TICKET, status: 'in_progress' },
    method: 'setTicketStatus',
    input: { ticketId: TICKET, status: 'in_progress' }
  }
]

describe('authoring tools map to the command layer', () => {
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

const DRAFT_RESULT: DraftUpdateResultView = {
  epicId: EPIC,
  draftRevision: 4,
  refMap: { new: TICKET },
  validation: { valid: true, errors: [], warnings: [] }
}

function opsSent(api: { calls: { input: unknown }[] }): DraftOp[] {
  const input = api.calls[0]?.input as { ops: DraftOp[] }
  return input.ops
}

const JOIN_TICKET = { title: 'Join', acceptanceCriteria: ['Both branches merged'], priority: 'high' }

describe('create_ticket ops', () => {
  it('adds one ticket to sprint 1 of the draft and returns its stable id', async () => {
    const api = createCannedApi({ updatePlanDraft: DRAFT_RESULT })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'create_ticket', { epicId: EPIC, ticket: { title: 'Do it' } })
      expect(outcome.payload).toEqual({
        ok: true,
        data: { ticketId: TICKET, draftRevision: 4, validation: DRAFT_RESULT.validation }
      })
      expect(api.calls).toEqual([
        {
          name: 'updatePlanDraft',
          input: {
            epicId: EPIC,
            ops: [{ op: 'add_ticket', ref: 'new', sprint: '1', ticket: { title: 'Do it' } }]
          }
        }
      ])
    })
  })

  it('adds a dependency op per prerequisite and forwards revision inputs', async () => {
    const api = createCannedApi({ updatePlanDraft: DRAFT_RESULT })
    await inRig(api, async (rig) => {
      await callTool(rig, 'create_ticket', {
        epicId: EPIC,
        sprint: '2',
        ticket: JOIN_TICKET,
        requires: ['DM-1', TICKET],
        expectedDraftRevision: 3,
        idempotencyKey: 'ticket-1'
      })
      expect(opsSent(api)).toEqual([
        { op: 'add_ticket', ref: 'new', sprint: '2', ticket: JOIN_TICKET },
        { op: 'add_dependency', from: 'DM-1', to: 'new' },
        { op: 'add_dependency', from: TICKET, to: 'new' }
      ])
      expect(api.calls[0]?.input).toMatchObject({ expectedDraftRevision: 3, idempotencyKey: 'ticket-1' })
    })
  })
})

describe('create_ticket validation', () => {
  it('fails with an internal error when the draft update does not report the new id', async () => {
    const api = createCannedApi({ updatePlanDraft: { ...DRAFT_RESULT, refMap: {} } })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'create_ticket', { epicId: EPIC, ticket: { title: 'Do it' } })
      expect(outcome.isError).toBe(true)
      expect(outcome.payload).toMatchObject({ ok: false, error: { code: 'internal' } })
    })
  })

  it.each([
    ['a malformed epic id', { epicId: 'nope', ticket: { title: 'T' } }],
    ['a missing ticket', { epicId: EPIC }],
    ['an empty title', { epicId: EPIC, ticket: { title: '' } }],
    ['an unknown ticket field', { epicId: EPIC, ticket: { title: 'T', colour: 'red' } }],
    ['a prerequisite that is not a reference', { epicId: EPIC, ticket: { title: 'T' }, requires: ['not a ref'] }],
    ['an empty sprint reference', { epicId: EPIC, ticket: { title: 'T' }, sprint: '' }]
  ])('rejects %s without touching the draft', async (_label, args) => {
    const api = createCannedApi({ updatePlanDraft: DRAFT_RESULT })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'create_ticket', args)
      expect(outcome.isError).toBe(true)
      expect(api.calls).toEqual([])
    })
  })
})

describe('update_ticket ops', () => {
  it('sends one update_ticket op with the patch and forwards revision inputs', async () => {
    const api = createCannedApi({ updatePlanDraft: DRAFT_RESULT })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'update_ticket', {
        epicId: EPIC,
        ticket: 'DM-3',
        patch: { title: 'Renamed', capability: { reasoning: { level: 'deep' } } },
        expectedDraftRevision: 4,
        idempotencyKey: 'edit-1'
      })
      expect(outcome.payload).toEqual({ ok: true, data: DRAFT_RESULT })
      expect(opsSent(api)).toEqual([
        {
          op: 'update_ticket',
          ticket: 'DM-3',
          patch: { title: 'Renamed', capability: { reasoning: { level: 'deep' } } }
        }
      ])
      expect(api.calls[0]?.input).toMatchObject({ expectedDraftRevision: 4, idempotencyKey: 'edit-1' })
    })
  })

  it('accepts a patch with a single field', async () => {
    const api = createCannedApi({ updatePlanDraft: DRAFT_RESULT })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'update_ticket', { epicId: EPIC, ticket: TICKET, patch: { optional: true } })
      expect(outcome.isError).toBe(false)
      expect(opsSent(api)).toEqual([{ op: 'update_ticket', ticket: TICKET, patch: { optional: true } }])
    })
  })
})

describe('update_ticket validation', () => {
  it.each([
    ['an empty patch', { epicId: EPIC, ticket: TICKET, patch: {} }],
    ['a missing patch', { epicId: EPIC, ticket: TICKET }],
    ['an unknown patch field', { epicId: EPIC, ticket: TICKET, patch: { colour: 'red' } }],
    ['an empty title', { epicId: EPIC, ticket: TICKET, patch: { title: '' } }],
    ['a malformed ticket reference', { epicId: EPIC, ticket: 'bad ref', patch: { title: 'x' } }]
  ])('rejects %s without touching the draft', async (_label, args) => {
    const api = createCannedApi({ updatePlanDraft: DRAFT_RESULT })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'update_ticket', args)
      expect(outcome.isError).toBe(true)
      expect(api.calls).toEqual([])
    })
  })
})

describe('authoring input validation', () => {
  it.each([
    ['create_epic without a title', 'create_epic', {}],
    ['create_epic with an empty title', 'create_epic', { title: '' }],
    ['create_epic with a malformed branch name', 'create_epic', { title: 'T', branch: { repository: null, name: 'bad name', startCommit: null } }],
    ['get_epic with a malformed id', 'get_epic', { epicId: 'ep_short' }],
    ['set_epic_status with an unknown status', 'set_epic_status', { epicId: EPIC, status: 'done' }],
    ['set_ticket_status with a ticket key', 'set_ticket_status', { ticketId: 'DM-1', status: 'backlog' }],
    ['list_tickets with an unknown view', 'list_tickets', { epicId: EPIC, view: 'latest' }]
  ])('rejects %s without calling the command', async (_label, tool, args) => {
    const api = createCannedApi({ createEpic: MARKER, getEpic: MARKER, setEpicStatus: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, tool, args)
      expect(outcome.isError).toBe(true)
      expect(api.calls).toEqual([])
    })
  })
})
