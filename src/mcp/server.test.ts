import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../core/errors'
import { draftOp } from '../core/schemas'
import { DOMAIN_ERROR_CODES } from '../shared/domain/errors'
import type { CommandName } from '../shared/domain/api'
import { ATTEMPT_STATES, RUN_STATES, TICKET_EXECUTION_STATES, WORK_STATUSES } from '../shared/domain/status'
import { REASONING_LEVELS, RELATION_KINDS, TICKET_FAILURE_POLICIES, TOOL_CAPABILITIES, WORK_TYPES } from '../shared/domain/bundle'
import type { ProjectView } from '../shared/domain/views'
import { callTool, sampleId, withRig } from '../test/mcpHarness'
import { COMMAND_NAMES, createCannedApi, createStubApi } from '../test/stubApi'
import { promptName } from './prompts'
import { createMcpServer } from './server'
import { SKILLS } from './skills'

const INFO = { name: 'darkmechanicus', version: '1.2.3' }

type Kind = 'read' | 'idempotent' | 'write' | 'destructive'

/** Every tool the server exposes, the command it adapts, and how it is annotated. */
const TOOLS: Record<string, { method: CommandName; kind: Kind }> = {
  get_capabilities: { method: 'getCapabilities', kind: 'read' },
  get_project: { method: 'getProject', kind: 'read' },
  list_projects: { method: 'getProject', kind: 'read' },
  initialize_repository: { method: 'initializeRepository', kind: 'idempotent' },
  get_storage_status: { method: 'getStorageStatus', kind: 'read' },
  flush_portable_state: { method: 'flushPortableState', kind: 'idempotent' },
  reconcile_repository: { method: 'reconcileRepository', kind: 'idempotent' },
  search_history: { method: 'searchHistory', kind: 'read' },
  list_branch_epics: { method: 'listBranchEpics', kind: 'read' },
  list_sessions: { method: 'listSessions', kind: 'read' },
  list_epics: { method: 'listEpics', kind: 'read' },
  create_epic: { method: 'createEpic', kind: 'write' },
  get_epic: { method: 'getEpic', kind: 'read' },
  set_epic_status: { method: 'setEpicStatus', kind: 'idempotent' },
  set_epic_branch: { method: 'setEpicBranch', kind: 'idempotent' },
  preview_board_import: { method: 'previewBoardImport', kind: 'read' },
  import_board: { method: 'importBoard', kind: 'idempotent' },
  list_tickets: { method: 'listTickets', kind: 'read' },
  get_ticket: { method: 'getTicket', kind: 'read' },
  create_ticket: { method: 'updatePlanDraft', kind: 'write' },
  update_ticket: { method: 'updatePlanDraft', kind: 'write' },
  set_ticket_status: { method: 'setTicketStatus', kind: 'idempotent' },
  add_comment: { method: 'addComment', kind: 'write' },
  list_comments: { method: 'listComments', kind: 'read' },
  list_profiles: { method: 'listProfiles', kind: 'read' },
  get_profile: { method: 'getProfile', kind: 'read' },
  save_profile: { method: 'saveProfile', kind: 'write' },
  get_plan: { method: 'getPlan', kind: 'read' },
  open_plan_draft: { method: 'openDraft', kind: 'idempotent' },
  update_plan_draft: { method: 'updatePlanDraft', kind: 'write' },
  validate_plan: { method: 'validatePlan', kind: 'read' },
  save_plan: { method: 'savePlan', kind: 'write' },
  discard_plan_draft: { method: 'discardPlanDraft', kind: 'idempotent' },
  list_revisions: { method: 'listRevisions', kind: 'read' },
  register_host: { method: 'registerHost', kind: 'write' },
  match_capabilities: { method: 'matchCapabilities', kind: 'read' },
  start_run: { method: 'startRun', kind: 'write' },
  get_run: { method: 'getRun', kind: 'read' },
  get_ready_tickets: { method: 'getReadyTickets', kind: 'read' },
  claim_ticket: { method: 'claimTicket', kind: 'write' },
  heartbeat_attempt: { method: 'heartbeatAttempt', kind: 'idempotent' },
  submit_attempt: { method: 'submitAttempt', kind: 'write' },
  accept_attempt: { method: 'acceptAttempt', kind: 'write' },
  reject_attempt: { method: 'rejectAttempt', kind: 'write' },
  fail_attempt: { method: 'failAttempt', kind: 'write' },
  reconcile_attempt: { method: 'reconcileAttempt', kind: 'write' },
  carry_forward_ticket: { method: 'carryForwardTicket', kind: 'write' },
  pause_run: { method: 'pauseRun', kind: 'idempotent' },
  resume_run: { method: 'resumeRun', kind: 'idempotent' },
  cancel_run: { method: 'cancelRun', kind: 'destructive' },
  takeover_run: { method: 'takeoverRun', kind: 'idempotent' },
  adopt_revision: { method: 'adoptRevision', kind: 'write' },
  submit_sprint_report: { method: 'submitSprintReport', kind: 'write' },
  get_sprint_report: { method: 'getSprintReport', kind: 'read' },
  get_checkpoint: { method: 'getCheckpoint', kind: 'read' },
  advance_sprint: { method: 'advanceSprint', kind: 'write' },
  get_run_events: { method: 'listEvents', kind: 'read' }
}

/** Commands only a person can perform in the desktop app; no tool may adapt them. */
const HUMAN_ONLY: CommandName[] = [
  'queueRun',
  'approveCheckpoint',
  'approveAndAdvance',
  'authorizeAutoContinue',
  'grantRetry',
  'backupDatabase',
  'deleteEpic',
  'deleteTicket'
]

function kindOf(annotations: ToolAnnotations | undefined): Kind {
  if (annotations?.readOnlyHint === true) {
    return 'read'
  }
  if (annotations?.destructiveHint === true) {
    return 'destructive'
  }
  return annotations?.idempotentHint === true ? 'idempotent' : 'write'
}

const PROJECT: ProjectView = {
  projectId: sampleId('project'),
  name: 'Demo',
  keyPrefix: 'DM',
  repoRoot: '/repo',
  createdAt: '2026-01-01T00:00:00.000Z'
}

/** An orchestrator allowed to save holds every capability an MCP tool needs, so it lists them all. */
const build = (api: Parameters<typeof createMcpServer>[0]) =>
  createMcpServer(api, INFO, { role: 'orchestrator', allowSave: true })

describe('tool inventory', () => {
  it('exposes exactly the expected tools', async () => {
    await withRig(build, createStubApi(), async (rig) => {
      const { tools } = await rig.client.listTools()
      expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(TOOLS).sort())
      expect(tools).toHaveLength(57)
    })
  })

  it('never exposes the human-only actions', async () => {
    await withRig(build, createStubApi(), async (rig) => {
      const { tools } = await rig.client.listTools()
      const names = tools.map((tool) => tool.name)
      const forbidden = ['queue_run', 'approve_checkpoint', 'approve_and_advance', 'authorize_auto_continue', 'grant_retry', 'backup_database', 'delete_epic', 'delete_ticket']
      for (const name of forbidden) {
        expect(names).not.toContain(name)
      }
      expect(names.filter((name) => /approve|queue|authorize|grant|backup|delete/.test(name))).toEqual([])
    })
  })

  it('adapts every command an agent may use, and none of the human-only ones', () => {
    const adapted = new Set(Object.values(TOOLS).map((tool) => tool.method))
    const agentCommands = COMMAND_NAMES.filter((name) => !HUMAN_ONLY.includes(name))
    expect([...adapted].sort()).toEqual([...agentCommands].sort())
    expect(COMMAND_NAMES).toHaveLength(agentCommands.length + HUMAN_ONLY.length)
  })

  it('annotates each tool by kind and only cancel_run as destructive', async () => {
    await withRig(build, createStubApi(), async (rig) => {
      const { tools } = await rig.client.listTools()
      const kinds = Object.fromEntries(tools.map((tool) => [tool.name, kindOf(tool.annotations)]))
      expect(kinds).toEqual(Object.fromEntries(Object.entries(TOOLS).map(([name, tool]) => [name, tool.kind])))
      expect(tools.filter((tool) => tool.annotations?.destructiveHint === true).map((tool) => tool.name)).toEqual(['cancel_run'])
    })
  })

  it('describes every tool well enough to teach its rules and takes object input', async () => {
    await withRig(build, createStubApi(), async (rig) => {
      const { tools } = await rig.client.listTools()
      for (const tool of tools) {
        expect(tool.description?.length ?? 0).toBeGreaterThan(50)
        expect(tool.inputSchema.type).toBe('object')
      }
    })
  })
})

describe('tool results', () => {
  it('returns ok payloads in structured content and in text', async () => {
    await withRig(build, createCannedApi({ getProject: PROJECT }), async (rig) => {
      const outcome = await callTool(rig, 'get_project')
      expect(outcome.isError).toBe(false)
      expect(outcome.payload).toEqual({ ok: true, data: PROJECT })
      expect(JSON.parse(outcome.text)).toEqual({ ok: true, data: PROJECT })
    })
  })

  it('returns domain errors as structured failures with isError', async () => {
    const api = createStubApi({
      getEpic: async () => {
        throw new DomainError('not_found', 'No such epic.', { epicId: 'x' })
      }
    })
    await withRig(build, api, async (rig) => {
      const outcome = await callTool(rig, 'get_epic', { epicId: sampleId('epic') })
      expect(outcome.isError).toBe(true)
      expect(outcome.payload).toEqual({
        ok: false,
        error: { code: 'not_found', message: 'No such epic.', details: { epicId: 'x' } }
      })
    })
  })

  it('reports unexpected failures as internal errors', async () => {
    await withRig(build, createStubApi(), async (rig) => {
      const outcome = await callTool(rig, 'get_capabilities')
      expect(outcome.payload).toEqual({ ok: false, error: { code: 'internal', message: 'not stubbed: getCapabilities' } })
    })
  })
})

describe('calls rejected before execution', () => {
  it('rejects malformed input before any command runs', async () => {
    const api = createCannedApi({ getEpic: {}, updatePlanDraft: {} })
    await withRig(build, api, async (rig) => {
      const badId = await callTool(rig, 'get_epic', { epicId: 'nope' })
      const noOps = await callTool(rig, 'update_plan_draft', { epicId: sampleId('epic'), ops: [] })
      expect(badId.isError).toBe(true)
      expect(badId.text).toContain('epicId')
      expect(noOps.isError).toBe(true)
      expect(noOps.text).toContain('ops')
      expect(api.calls).toEqual([])
    })
  })

  it('answers a call to a human-only action as an unknown tool without running anything', async () => {
    const api = createStubApi()
    await withRig(build, api, async (rig) => {
      const outcome = await callTool(rig, 'approve_checkpoint', { runId: sampleId('run'), reportId: sampleId('report') })
      expect(outcome.isError).toBe(true)
      expect(outcome.text).toContain('not found')
      expect(api.calls).toEqual([])
    })
  })
})

describe('server metadata', () => {
  it('reports the server name and version it was given', async () => {
    await withRig(build, createStubApi(), async (rig) => {
      expect(rig.client.getServerVersion()).toMatchObject(INFO)
      expect(rig.client.getServerCapabilities()).toMatchObject({ tools: {}, prompts: {} })
    })
  })

  it('ships instructions that teach the workflow and its limits', async () => {
    await withRig(build, createStubApi(), async (rig) => {
      const instructions = rig.client.getInstructions() ?? ''
      for (const phrase of [
        'get_capabilities',
        'update_plan_draft',
        'saved revisions',
        'save_plan',
        '--allow-save',
        'press Save',
        'claim_ticket',
        'heartbeat_attempt',
        'submit_attempt',
        'submit_sprint_report',
        'get_checkpoint',
        'cannot approve',
        'task data',
        'add_comment',
        'list_comments',
        'isError',
        'darkmechanicus-planner',
        'darkmechanicus-sprint-reporter'
      ]) {
        expect(instructions).toContain(phrase)
      }
    })
  })
})

describe('skills as prompts', () => {
  it('lists the six skills and returns their bodies', async () => {
    await withRig(build, createStubApi(), async (rig) => {
      const { prompts } = await rig.client.listPrompts()
      expect(prompts.map((prompt) => prompt.name)).toEqual(SKILLS.map((skill) => promptName(skill.name)))
      expect(prompts).toHaveLength(6)
      const planner = await rig.client.getPrompt({ name: 'darkmechanicus-planner' })
      expect(planner.messages[0]?.content).toEqual({ type: 'text', text: SKILLS[0]?.body })
    })
  })
})

/** Words in backticks that are not tools but are real vocabulary of the contract. */
const GATE_CONDITIONS = ['report_submitted', 'no_active_leases', 'required_accepted', 'exit_criteria', 'epic_outcome']
const BLOCKER_KINDS = ['retry_limit', 'run_state']
const DRAFT_OPS: string[] = draftOp.options.map((option) => option.shape.op.value)

const VOCABULARY = new Set<string>([
  ...WORK_STATUSES,
  ...RUN_STATES,
  ...ATTEMPT_STATES,
  ...TICKET_EXECUTION_STATES,
  ...DOMAIN_ERROR_CODES,
  ...REASONING_LEVELS,
  ...TOOL_CAPABILITIES,
  ...WORK_TYPES,
  ...RELATION_KINDS,
  ...TICKET_FAILURE_POLICIES,
  ...GATE_CONDITIONS,
  ...BLOCKER_KINDS,
  ...DRAFT_OPS
])

describe('skills only name real tools', () => {
  it.each(SKILLS.map((skill) => [skill.name, skill.body]))('%s uses known tools and vocabulary', (_name, body) => {
    const tokens = new Set(body.match(/`[a-z][a-z0-9]*(?:_[a-z0-9]+)+`/g)?.map((token) => token.slice(1, -1)))
    const unknown = [...tokens].filter((token) => !Object.hasOwn(TOOLS, token) && !VOCABULARY.has(token))
    expect(unknown).toEqual([])
  })
})
