import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bindAgentMailEndpoint, provisionAgentMailEndpoint } from '../core/services/agentMail'
import type { GrantableRole, SessionRole } from '../shared/domain/views'
import { callTool, sampleId, withRig } from '../test/mcpHarness'
import { createCannedApi, createStubApi } from '../test/stubApi'
import { createHarness, type Harness } from '../test/workspaceHarness'
import type { Workspace } from '../core/workspace'
import { createMcpServer } from './server'

const INFO = { name: 'darkmechanicus', version: '1.2.3' }

/** Read-only tools: every role sees them. */
const READ_TOOLS = [
  'get_human_answer',
  'get_capabilities',
  'get_project',
  'list_projects',
  'get_storage_status',
  'get_context',
  'search_history',
  'list_branch_epics',
  'list_sessions',
  'list_save_permission_requests',
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
  'get_attachment',
  'list_profiles',
  'get_profile',
  'preview_board_import',
  'get_transfer',
  'list_kanban_cards',
  'get_kanban_card',
  'list_kanban_messages',
  'get_run_metrics',
  'get_planned_baselines',
  'get_ticket_grade',
  'get_sprint_grade',
  'get_run_grade',
  'get_epic_grade',
  'get_report_scorecard',
  'reassess_report_scorecard',
  'get_space_signals',
  'get_ticket_performance',
  'get_escaped_defects',
  'get_run_efficiency',
  'get_run_timing',
  'get_metrics_summary',
  'get_retro_findings',
  'get_experiment',
  'preview_corrections'
]

/** Every role may comment. */
const COMMENT_TOOLS = ['ask_human', 'add_comment', 'add_kanban_message', 'name_chat']

/** Every role that writes records may attach an image from a local path (attachment.write); the desktop refuses it. */
const ATTACHMENT_WRITE_TOOLS = ['add_attachment']

/** Agent mail tools that only read. */
const MAIL_READ_TOOLS = ['get_agent_identity', 'list_agent_peers', 'read_agent_inbox', 'get_agent_mail_status']

/** Every hosted role holds mail.use and lists these; a call still needs a desktop-bound dm CLI grant (see below). */
const MAIL_TOOLS = [...MAIL_READ_TOOLS, 'send_agent_message', 'acknowledge_agent_messages']

/** Tools a planner and an orchestrator both hold. */
const PLANNER_SHARED_TOOLS = [
  ...READ_TOOLS,
  ...COMMENT_TOOLS,
  ...ATTACHMENT_WRITE_TOOLS,
  ...MAIL_TOOLS,
  'recover_tooling',
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
  'save_profile',
  'rescan_repositories',
  // kanban.write: adding and editing cards; only a person presses Play, approves or kicks back.
  'create_kanban_card',
  'update_kanban_card',
  // draft.edit: corrective work from a retro's experiments, created as draft work the person reviews and saves.
  'create_corrections'
]

/** Only a planner (and the desktop) sets the Definition of Done: the orchestrator accepts work against it. */
const PLANNER_ONLY_TOOLS = ['set_definition_of_done', 'set_delivery_standards', 'standardize_project_work']

const PLANNER_TOOLS = [...PLANNER_SHARED_TOOLS, ...PLANNER_ONLY_TOOLS]

const ORCHESTRATOR_TOOLS = [
  ...PLANNER_SHARED_TOOLS,
  'request_save_permission',
  'decide_save_permission',
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
  'record_row_check',
  'submit_sprint_report',
  'redraft_next_sprint',
  'advance_sprint',
  // ticket.auto_retry: the orchestrator's own bounded retry of a ticket at its retry limit.
  'retry_ticket',
  // epic.transfer: carrying out a transfer the person queued.
  'start_transfer',
  'record_transfer_item',
  'submit_transfer_readback',
  // External orchestrators queue named cards, then use the existing claim/report workflow.
  'launch_kanban_cards',
  'claim_kanban_card',
  'heartbeat_kanban_card',
  'submit_kanban_card',
  'fail_kanban_card',
  // Usage of the run's attempts and the run's own overhead bucket.
  'record_attempt_metrics',
  'record_run_metrics',
  // Later statuses and results of retro experiments (report.submit).
  'record_experiment_event'
]

const WORKER_TOOLS = [
  ...READ_TOOLS,
  ...COMMENT_TOOLS,
  ...ATTACHMENT_WRITE_TOOLS,
  ...MAIL_TOOLS,
  'heartbeat_attempt',
  'submit_attempt',
  'fail_attempt',
  'heartbeat_kanban_card',
  'submit_kanban_card',
  'fail_kanban_card',
  'record_attempt_metrics'
]
const REVIEWER_TOOLS = [...READ_TOOLS, ...COMMENT_TOOLS, ...ATTACHMENT_WRITE_TOOLS, ...MAIL_TOOLS, 'accept_attempt', 'reject_attempt', 'record_run_metrics']

interface ListingCase {
  role: SessionRole
  allowSave: boolean
  tools: string[]
}

const LISTINGS: ListingCase[] = [
  { role: 'planner', allowSave: false, tools: PLANNER_TOOLS },
  { role: 'planner', allowSave: true, tools: [...PLANNER_TOOLS, 'save_plan'] },
  // The service decides an orchestrator's save per epic (its own active run), so save_plan is listed either way.
  { role: 'orchestrator', allowSave: false, tools: [...ORCHESTRATOR_TOOLS, 'save_plan'] },
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
      expect(readOnly.sort()).toEqual([...READ_TOOLS, ...MAIL_READ_TOOLS].sort())
    })
  })

  it.each(LISTINGS)('lists no Kanban tool to play, approve or kick back a card to the $role (allowSave $allowSave)', async ({ role, allowSave }) => {
    await withRig(serverFor(role, allowSave), createStubApi(), async (rig) => {
      const kanban = (await rig.client.listTools()).tools.map((tool) => tool.name).filter((name) => name.includes('kanban'))
      expect(kanban.filter((name) => /play|approve|kick/.test(name))).toEqual([])
      expect(kanban.length).toBeGreaterThan(0)
    })
  })
})

describe('set_definition_of_done', () => {
  it.each(['orchestrator', 'worker', 'reviewer'] as const)(
    'answers a call from a %s with unauthorized and runs nothing',
    async (role) => {
      const api = createStubApi()
      await withRig(serverFor(role, true), api, async (rig) => {
        const outcome = await callTool(rig, 'set_definition_of_done', { checks: [{ name: 'lint', command: 'npm run lint' }] })
        expect(outcome.isError).toBe(true)
        expect(outcome.payload).toEqual({
          ok: false,
          error: {
            code: 'unauthorized',
            message: `This ${role} session is not permitted to perform "project.definition_of_done".`,
            details: { role, capability: 'project.definition_of_done', tool: 'set_definition_of_done' }
          }
        })
        expect(api.calls).toEqual([])
      })
    }
  )

  it('runs for a planner', async () => {
    const api = createCannedApi({ setDefinitionOfDone: { marker: 'set' } })
    await withRig(serverFor('planner', false), api, async (rig) => {
      const outcome = await callTool(rig, 'set_definition_of_done', { checks: [{ name: 'lint', command: 'npm run lint' }] })
      expect(outcome.payload).toEqual({ ok: true, data: { marker: 'set' } })
      expect(api.calls.map((call) => call.name)).toEqual(['setDefinitionOfDone'])
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

/** A real repository whose `own` chat has a `role` grant the desktop bound to it, beside a `peer` mailbox. */
async function boundMailRepo(h: Harness, role: GrantableRole): Promise<{ desktop: Workspace; peerId: string; token: string }> {
  const desktop = h.open('desktop')
  await desktop.initializeRepository({ name: 'Mail over MCP' })
  const own = provisionAgentMailEndpoint(desktop.ctx(), { chatId: 'own', name: 'Own chat' })
  const peer = provisionAgentMailEndpoint(desktop.ctx(), { chatId: 'peer', name: 'Peer chat' })
  const { grant, token } = await desktop.issueGrant({ role, label: 'own' })
  bindAgentMailEndpoint(desktop.ctx(), { endpointId: own.id, grantId: grant.id })
  return { desktop, peerId: peer.id, token }
}

describe('agent mail over MCP', () => {
  let h: Harness
  beforeEach(() => {
    h = createHarness()
  })
  afterEach(() => {
    h.cleanup()
  })

  it.each(['planner', 'orchestrator', 'worker', 'reviewer'] as const satisfies readonly GrantableRole[])(
    'refuses every mail tool to a %s stdio session, even one holding a bound grant token, and changes no mail',
    async (role) => {
      const { desktop, peerId, token } = await boundMailRepo(h, role)
      const send = { to: peerId, clientMessageId: 'probe', body: 'probe' }
      const calls = { ...Object.fromEntries(MAIL_TOOLS.map((tool) => [tool, {}])), send_agent_message: send, acknowledge_agent_messages: { messageIds: [sampleId('mailMessage')] } }
      // An MCP server is a stdio session: a DM_SESSION_TOKEN it inherited never makes the grant its own.
      const api = h.open(role, { transport: 'stdio', grantToken: token })
      await withRig((target) => createMcpServer(target, INFO, { role, allowSave: false }), Object.assign(api, { calls: [] }), async (rig) => {
        const listed = (await rig.client.listTools()).tools.map((tool) => tool.name)
        for (const [tool, args] of Object.entries(calls)) {
          expect(listed).toContain(tool)
          const outcome = await callTool(rig, tool, args)
          expect(outcome.payload).toMatchObject({ ok: false, error: { code: 'unauthorized', message: expect.stringContaining('This session has no usable mailbox.') } })
          expect(outcome.text).not.toContain('Peer chat')
        }
        expect((await callTool(rig, 'get_capabilities')).payload).toMatchObject({ ok: true, data: { mailbox: { bound: false, reason: 'no_grant' } } })
      })
      expect(desktop.ctx().db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_mail_messages')?.n).toBe(0)
      // Positive control: the same grant through the dm CLI is the bound mailbox.
      await expect(h.open('reader', { transport: 'cli', grantToken: token }).sendAgentMessage(send)).resolves.toMatchObject({ duplicate: false })
    }
  )

  it('lists no mail tool to a reader, and refuses a direct call before the command runs', async () => {
    const api = createStubApi()
    await withRig(serverFor('reader', false), api, async (rig) => {
      const listed = (await rig.client.listTools()).tools.map((tool) => tool.name)
      expect(listed.filter((name) => MAIL_TOOLS.includes(name))).toEqual([])
      for (const tool of MAIL_TOOLS) {
        expect((await callTool(rig, tool, {})).payload).toMatchObject({
          ok: false,
          error: { code: 'unauthorized', details: { role: 'reader', capability: 'mail.use', tool } }
        })
      }
      expect(api.calls).toEqual([])
    })
  })
})
