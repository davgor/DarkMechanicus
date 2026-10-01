import { describe, expect, it } from 'vitest'
import { contentHash } from '../core/canonical'
import { callTool, sampleId, withRig } from '../test/mcpHarness'
import { createCannedApi, createStubApi } from '../test/stubApi'
import { createMcpServer } from './server'

const INFO = { name: 'darkmechanicus', version: '1.2.3' }
const EPIC = sampleId('epic')

/** An orchestrator allowed to save lists every tool. */
const build = (api: Parameters<typeof createMcpServer>[0]) =>
  createMcpServer(api, INFO, { role: 'orchestrator', allowSave: true })

describe('missing or mistyped arguments', () => {
  it('answer a missing required field with invalid_input naming the field, before any command runs', async () => {
    const api = createStubApi()
    await withRig(build, api, async (rig) => {
      const outcome = await callTool(rig, 'get_epic', {})
      expect(outcome.isError).toBe(true)
      expect(outcome.payload).toEqual({
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'Invalid arguments for get_epic: epicId: Invalid input: expected string, received undefined',
          details: {
            tool: 'get_epic',
            issues: [{ path: 'epicId', message: 'Invalid input: expected string, received undefined' }]
          }
        }
      })
      expect(JSON.parse(outcome.text)).toEqual(outcome.payload)
      expect(api.calls).toEqual([])
    })
  })

  it('answer a wrong type with invalid_input', async () => {
    const api = createStubApi()
    await withRig(build, api, async (rig) => {
      const outcome = await callTool(rig, 'search_history', { query: 'login', limit: 'ten' })
      expect(outcome.payload).toEqual({
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'Invalid arguments for search_history: limit: Invalid input: expected number, received string',
          details: {
            tool: 'search_history',
            issues: [{ path: 'limit', message: 'Invalid input: expected number, received string' }]
          }
        }
      })
      expect(api.calls).toEqual([])
    })
  })
})

describe('unknown values and nested problems in the arguments', () => {
  it('answer an unknown enum value with invalid_input listing the allowed values', async () => {
    const api = createStubApi()
    await withRig(build, api, async (rig) => {
      const outcome = await callTool(rig, 'get_plan', { epicId: EPIC, view: 'published' })
      expect(outcome.payload).toEqual({
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'Invalid arguments for get_plan: view: Invalid option: expected one of "saved"|"draft"',
          details: { tool: 'get_plan', issues: [{ path: 'view', message: 'Invalid option: expected one of "saved"|"draft"' }] }
        }
      })
      expect(api.calls).toEqual([])
    })
  })

  it('answer a wrong type deep inside the arguments with its full path', async () => {
    const api = createStubApi()
    await withRig(build, api, async (rig) => {
      const outcome = await callTool(rig, 'update_plan_draft', {
        epicId: EPIC,
        ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 42 } }]
      })
      expect(outcome.payload).toEqual({
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'Invalid arguments for update_plan_draft: ops.0.ticket.title: Invalid input: expected string, received number',
          details: {
            tool: 'update_plan_draft',
            issues: [{ path: 'ops.0.ticket.title', message: 'Invalid input: expected string, received number' }]
          }
        }
      })
      expect(api.calls).toEqual([])
    })
  })
})

describe('extra fields and several failures in the arguments', () => {
  it('answer an extra nested field with invalid_input naming the object it was sent in', async () => {
    const api = createStubApi()
    await withRig(build, api, async (rig) => {
      const outcome = await callTool(rig, 'claim_ticket', {
        runId: sampleId('run'),
        ticketId: sampleId('ticket'),
        worker: { label: 'w1', model: 'large' }
      })
      expect(outcome.payload).toEqual({
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'Invalid arguments for claim_ticket: worker: Unrecognized key: "model"',
          details: { tool: 'claim_ticket', issues: [{ path: 'worker', message: 'Unrecognized key: "model"' }] }
        }
      })
      expect(api.calls).toEqual([])
    })
  })

  it('report every failing field in one answer', async () => {
    await withRig(build, createStubApi(), async (rig) => {
      const outcome = await callTool(rig, 'set_epic_status', { status: 'done' })
      expect(outcome.payload).toEqual({
        ok: false,
        error: {
          code: 'invalid_input',
          message:
            'Invalid arguments for set_epic_status: epicId: Invalid input: expected string, received undefined; status: Invalid option: expected one of "backlog"|"in_progress"|"completed"',
          details: {
            tool: 'set_epic_status',
            issues: [
              { path: 'epicId', message: 'Invalid input: expected string, received undefined' },
              { path: 'status', message: 'Invalid option: expected one of "backlog"|"in_progress"|"completed"' }
            ]
          }
        }
      })
    })
  })
})

describe('omitted arguments', () => {
  it('are treated as an empty object', async () => {
    const api = createCannedApi({ initializeRepository: { marker: 'initialized' } })
    await withRig(build, api, async (rig) => {
      const initialized = await rig.client.callTool({ name: 'initialize_repository' })
      const epic = await rig.client.callTool({ name: 'get_epic' })
      expect(initialized.structuredContent).toEqual({ ok: true, data: { marker: 'initialized' } })
      expect(epic.structuredContent).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      expect(api.calls).toEqual([{ name: 'initializeRepository', input: {} }])
    })
  })
})

describe('arguments that pass the input schema', () => {
  it('reach the command parsed, with defaults applied', async () => {
    const api = createCannedApi({ listTickets: [] })
    await withRig(build, api, async (rig) => {
      const outcome = await callTool(rig, 'list_tickets', { epicId: EPIC })
      expect(outcome.payload).toEqual({ ok: true, data: [] })
      expect(api.calls).toEqual([{ name: 'listTickets', input: { epicId: EPIC, view: 'saved' } }])
    })
  })

  it('still go through tool-level refinements', async () => {
    const api = createCannedApi({ updatePlanDraft: { draftRevision: 3 } })
    await withRig(build, api, async (rig) => {
      const empty = await callTool(rig, 'update_ticket', { epicId: EPIC, ticket: 'DM-1', patch: {} })
      const renamed = await callTool(rig, 'update_ticket', { epicId: EPIC, ticket: 'DM-1', patch: { title: 'Renamed' } })
      expect(empty.payload).toEqual({
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'Invalid arguments for update_ticket: patch: Provide at least one field to change.',
          details: { tool: 'update_ticket', issues: [{ path: 'patch', message: 'Provide at least one field to change.' }] }
        }
      })
      expect(renamed.payload).toEqual({ ok: true, data: { draftRevision: 3 } })
      expect(api.calls).toEqual([
        {
          name: 'updatePlanDraft',
          input: {
            epicId: EPIC,
            ops: [{ op: 'update_ticket', ticket: 'DM-1', patch: { title: 'Renamed' } }],
            expectedDraftRevision: undefined,
            idempotencyKey: undefined
          }
        }
      ])
    })
  })
})

/**
 * Fingerprints (first 16 hex digits of the canonical-JSON SHA-256) of every tool's advertised input
 * schema, recorded before argument validation moved into the server. Validation must not change
 * what agents are told; when a schema changes on purpose, update its fingerprint.
 */
const SCHEMA_FINGERPRINTS: Record<string, string> = {
  get_capabilities: 'efddc7bd8bbcef73',
  get_project: 'efddc7bd8bbcef73',
  list_projects: 'efddc7bd8bbcef73',
  initialize_repository: 'f11b9b72dcf6b080',
  get_storage_status: 'efddc7bd8bbcef73',
  flush_portable_state: 'efddc7bd8bbcef73',
  reconcile_repository: 'efddc7bd8bbcef73',
  search_history: 'd75d0c0f7abf0652',
  list_branch_epics: 'efddc7bd8bbcef73',
  list_sessions: 'efddc7bd8bbcef73',
  list_epics: 'efddc7bd8bbcef73',
  create_epic: '41b06b34becd8292',
  get_epic: 'f7874c5f7d17c6c5',
  set_epic_status: '94ffe4e9da368b55',
  set_epic_branch: '8bd6928c81a9be3a',
  list_tickets: '188aa9fa45c88ef2',
  get_ticket: '2e36fb18f2deeaf5',
  create_ticket: '5420104052915a1a',
  update_ticket: '12a6cb03b46c2cb7',
  set_ticket_status: '2f0069162106363a',
  get_plan: '57dd5f19d19a669e',
  open_plan_draft: 'f7874c5f7d17c6c5',
  update_plan_draft: '88f99140e1b8d7d4',
  validate_plan: '3b52b9b5157a2fba',
  save_plan: 'a77f363be76d0e70',
  discard_plan_draft: 'e242b76040271758',
  list_revisions: 'f7874c5f7d17c6c5',
  register_host: '9dfd2ed78fa19f57',
  match_capabilities: 'f4c7e82b30f2a0aa',
  start_run: '34b2624801200ad2',
  get_run: '404c90791e4f466b',
  get_ready_tickets: 'd481e0f29f2ca1c1',
  claim_ticket: '82a0056c560ecdfd',
  heartbeat_attempt: 'b841056c07b49b29',
  submit_attempt: '434ce415740aca2f',
  accept_attempt: '1f6d74d0987c0a6e',
  reject_attempt: 'a75cbd153cdd82ca',
  fail_attempt: '90e46283afbb645f',
  reconcile_attempt: '6323339383e6f737',
  carry_forward_ticket: '96660ba8e2cc4f98',
  pause_run: 'be49650976f9ddba',
  resume_run: 'd481e0f29f2ca1c1',
  cancel_run: 'be49650976f9ddba',
  takeover_run: 'd481e0f29f2ca1c1',
  adopt_revision: '18e63e4a9fe69b58',
  submit_sprint_report: '1bdc412486359786',
  get_sprint_report: '3fe78b4c15e34139',
  get_checkpoint: 'd481e0f29f2ca1c1',
  advance_sprint: 'faf1d60dc4eb197e',
  get_run_events: 'c770fc89a5438af4'
}

describe('advertised input schemas', () => {
  it('are exactly the JSON schemas published before validation moved into the server', async () => {
    await withRig(build, createStubApi(), async (rig) => {
      const { tools } = await rig.client.listTools()
      const fingerprints = Object.fromEntries(
        tools
          .filter((tool) => Object.hasOwn(SCHEMA_FINGERPRINTS, tool.name))
          .map((tool) => [tool.name, contentHash(tool.inputSchema).slice('sha256:'.length, 23)])
      )
      expect(fingerprints).toEqual(SCHEMA_FINGERPRINTS)
    })
  })

  it('still describe required fields and allowed values to agents', async () => {
    await withRig(build, createStubApi(), async (rig) => {
      const { tools } = await rig.client.listTools()
      const getPlan = tools.find((tool) => tool.name === 'get_plan')?.inputSchema
      expect(getPlan?.required).toEqual(['epicId', 'view'])
      expect(getPlan?.properties?.['view']).toEqual({
        type: 'string',
        enum: ['saved', 'draft'],
        description: "'saved' = the current saved revision (what execution uses); 'draft' = the unsaved working copy."
      })
    })
  })
})
