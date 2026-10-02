import { describe, expect, it } from 'vitest'
import type { SessionRole } from '../shared/domain/views'
import { callTool, sampleId, withRig } from '../test/mcpHarness'
import { createCannedApi, createStubApi } from '../test/stubApi'
import { createMcpServer } from './server'

const INFO = { name: 'darkmechanicus', version: '1.2.3' }

/** Read-only tools: every role sees them. */
const READ_TOOLS = [
  'get_capabilities',
  'get_project',
  'list_projects',
  'get_storage_status',
  'search_history',
  'list_branch_epics',
  'list_sessions',
  'list_epics',
  'get_epic',
  'list_tickets',
  'get_ticket',
  'get_plan',
  'validate_plan',
  'list_revisions',
  'match_capabilities',
  'get_run',
  'get_ready_tickets',
  'get_sprint_report',
  'get_checkpoint',
  'get_run_events',
  'list_comments',
  'list_profiles',
  'get_profile',
  'preview_board_import'
]

/** Every role may comment. */
const COMMENT_TOOLS = ['add_comment']

const PLANNER_TOOLS = [
  ...READ_TOOLS,
  ...COMMENT_TOOLS,
  'initialize_repository',
  'flush_portable_state',
  'reconcile_repository',
  'create_epic',
  'import_board',
  'create_ticket',
  'update_ticket',
  'open_plan_draft',
  'update_plan_draft',
  'discard_plan_draft',
  'save_profile'
]

const ORCHESTRATOR_TOOLS = [
  ...PLANNER_TOOLS,
  'set_epic_status',
  'set_epic_branch',
  'set_ticket_status',
  'register_host',
  'start_run',
  'pause_run',
  'resume_run',
  'cancel_run',
  'takeover_run',
  'adopt_revision',
  'claim_ticket',
  'heartbeat_attempt',
  'submit_attempt',
  'accept_attempt',
  'reject_attempt',
  'fail_attempt',
  'reconcile_attempt',
  'carry_forward_ticket',
  'submit_sprint_report',
  'advance_sprint'
]

const WORKER_TOOLS = [...READ_TOOLS, ...COMMENT_TOOLS, 'heartbeat_attempt', 'submit_attempt', 'fail_attempt']
const REVIEWER_TOOLS = [...READ_TOOLS, ...COMMENT_TOOLS, 'accept_attempt', 'reject_attempt']

interface ListingCase {
  role: SessionRole
  allowSave: boolean
  tools: string[]
}

const LISTINGS: ListingCase[] = [
  { role: 'planner', allowSave: false, tools: PLANNER_TOOLS },
  { role: 'planner', allowSave: true, tools: [...PLANNER_TOOLS, 'save_plan'] },
  { role: 'orchestrator', allowSave: false, tools: ORCHESTRATOR_TOOLS },
  { role: 'orchestrator', allowSave: true, tools: [...ORCHESTRATOR_TOOLS, 'save_plan'] },
  { role: 'worker', allowSave: false, tools: WORKER_TOOLS },
  { role: 'worker', allowSave: true, tools: WORKER_TOOLS },
  { role: 'reviewer', allowSave: false, tools: REVIEWER_TOOLS },
  { role: 'reviewer', allowSave: true, tools: REVIEWER_TOOLS }
]

/** Tools for the actions only a person may take in the desktop app; no session ever lists one. */
const HUMAN_ONLY_TOOLS = /approve|queue|authorize|grant|backup/

function serverFor(role: SessionRole, allowSave: boolean): (api: Parameters<typeof createMcpServer>[0]) => ReturnType<typeof createMcpServer> {
  return (api) => createMcpServer(api, INFO, { role, allowSave })
}

describe('tools/list per role', () => {
  it.each(LISTINGS)('lists exactly the $role tools when allowSave is $allowSave', async ({ role, allowSave, tools }) => {
    await withRig(serverFor(role, allowSave), createStubApi(), async (rig) => {
      const listed = (await rig.client.listTools()).tools.map((tool) => tool.name)
      expect(listed.sort()).toEqual([...tools].sort())
      expect(listed.filter((name) => HUMAN_ONLY_TOOLS.test(name))).toEqual([])
    })
  })

  it.each(LISTINGS)('lists every read-only tool to the $role (allowSave $allowSave)', async ({ role, allowSave }) => {
    await withRig(serverFor(role, allowSave), createStubApi(), async (rig) => {
      const { tools } = await rig.client.listTools()
      const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name)
      expect(readOnly.sort()).toEqual([...READ_TOOLS].sort())
    })
  })
})

describe('calls to tools the role does not list', () => {
  it('answers save_plan without --allow-save with unauthorized and runs nothing', async () => {
    const api = createStubApi()
    await withRig(serverFor('planner', false), api, async (rig) => {
      const outcome = await callTool(rig, 'save_plan', { epicId: sampleId('epic'), expectedDraftRevision: 1 })
      expect(outcome.isError).toBe(true)
      expect(outcome.payload).toEqual({
        ok: false,
        error: {
          code: 'unauthorized',
          message: 'This planner session is not permitted to perform "plan.save".',
          details: { role: 'planner', capability: 'plan.save', tool: 'save_plan' }
        }
      })
      expect(JSON.parse(outcome.text)).toEqual(outcome.payload)
      expect(api.calls).toEqual([])
    })
  })

  it('answers a worker calling an orchestrator tool with unauthorized, even with bad arguments', async () => {
    const api = createStubApi()
    await withRig(serverFor('worker', false), api, async (rig) => {
      const claim = await callTool(rig, 'claim_ticket', { runId: 'nope' })
      expect(claim.payload).toEqual({
        ok: false,
        error: {
          code: 'unauthorized',
          message: 'This worker session is not permitted to perform "attempt.claim".',
          details: { role: 'worker', capability: 'attempt.claim', tool: 'claim_ticket' }
        }
      })
      expect(api.calls).toEqual([])
    })
  })
})

describe('calls to tools that do not exist or that the role lists', () => {
  it('answers a tool that exists for no session as not found', async () => {
    const api = createStubApi()
    await withRig(serverFor('orchestrator', true), api, async (rig) => {
      const outcome = await callTool(rig, 'approve_checkpoint', { runId: sampleId('run'), reportId: sampleId('report') })
      expect(outcome.isError).toBe(true)
      expect(outcome.payload).toEqual({
        ok: false,
        error: { code: 'not_found', message: 'Tool approve_checkpoint not found.', details: { tool: 'approve_checkpoint' } }
      })
      expect(api.calls).toEqual([])
    })
  })

  it('still runs the tools the role lists', async () => {
    const api = createCannedApi({ submitAttempt: { marker: 'submitted' } })
    await withRig(serverFor('worker', false), api, async (rig) => {
      const outcome = await callTool(rig, 'submit_attempt', {
        attemptId: sampleId('attempt'),
        claimToken: 'token',
        outputs: { summary: 'Done.' }
      })
      expect(outcome.payload).toEqual({ ok: true, data: { marker: 'submitted' } })
      expect(api.calls.map((call) => call.name)).toEqual(['submitAttempt'])
    })
  })
})
