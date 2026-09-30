import { describe, expect, it } from 'vitest'
import { SKILLS_VERSION } from '../../core/version'
import type { CommandName } from '../../shared/domain/api'
import { areaServer, callTool, type McpRig, sampleId, withRig } from '../../test/mcpHarness'
import { createCannedApi, type StubApi } from '../../test/stubApi'
import { registerExecutionTools } from './execution'

const EPIC = sampleId('epic')
const RUN = sampleId('run')
const ATTEMPT = sampleId('attempt')
const TICKET = sampleId('ticket', 3)
const REVISION = sampleId('revision')
const CATALOG = sampleId('hostCatalog')
const MARKER = { marker: 'canned' }
const BRANCH = { repository: null, name: 'epic/checkout', startCommit: 'abc1234' }

function inRig<T>(api: StubApi, body: (rig: McpRig) => Promise<T>): Promise<T> {
  return withRig(areaServer(registerExecutionTools), api, body)
}

const HOST = {
  hostId: 'host-1',
  hostType: 'agent-cli',
  catalogRevision: 'r7',
  tools: ['shell', 'repo_read'],
  canSelectWorkerModel: true,
  models: [
    {
      id: 'model-a',
      label: 'Model A',
      reasoningLevels: ['routine', 'deep'],
      modalities: ['text'],
      contextWindowTokens: 200000,
      skills: ['typescript'],
      costTier: 'normal',
      latencyTier: 'low'
    }
  ]
}

const OUTPUTS = {
  summary: 'Done',
  artifacts: [{ label: 'report', location: 'docs/report.md', hash: null, remoteOnly: false }],
  commits: ['abc1234'],
  changedFiles: ['src/a.ts'],
  branch: 'epic/checkout'
}
const EVIDENCE = {
  checks: [{ name: 'unit', status: 'passed', detail: '12 tests' }],
  criteria: [{ criterionId: 'c1', met: true, note: 'covered by unit tests' }],
  notes: 'ok'
}

interface Case {
  tool: string
  args: Record<string, unknown>
  method: CommandName
  input: unknown
}

const CASES: Case[] = [
  { tool: 'register_host', args: HOST, method: 'registerHost', input: HOST },
  {
    tool: 'match_capabilities',
    args: { ticketId: TICKET, runId: RUN },
    method: 'matchCapabilities',
    input: { ticketId: TICKET, runId: RUN }
  },
  { tool: 'get_run', args: { runId: RUN }, method: 'getRun', input: { runId: RUN } },
  { tool: 'get_run', args: { epicId: EPIC }, method: 'getRun', input: { epicId: EPIC } },
  { tool: 'get_ready_tickets', args: { runId: RUN }, method: 'getReadyTickets', input: { runId: RUN } },
  {
    tool: 'claim_ticket',
    args: {
      runId: RUN,
      ticketId: TICKET,
      worker: { label: 'worker-1', modelId: 'model-a', hostId: 'host-1', catalogRevision: 'r7', rationale: 'deep reasoning needed' },
      leaseSeconds: 600,
      idempotencyKey: 'claim-1'
    },
    method: 'claimTicket',
    input: {
      runId: RUN,
      ticketId: TICKET,
      worker: { label: 'worker-1', modelId: 'model-a', hostId: 'host-1', catalogRevision: 'r7', rationale: 'deep reasoning needed' },
      leaseSeconds: 600,
      idempotencyKey: 'claim-1'
    }
  },
  {
    tool: 'heartbeat_attempt',
    args: { attemptId: ATTEMPT, claimToken: 'at.secret', leaseSeconds: 300 },
    method: 'heartbeatAttempt',
    input: { attemptId: ATTEMPT, claimToken: 'at.secret', leaseSeconds: 300 }
  },
  {
    tool: 'submit_attempt',
    args: { attemptId: ATTEMPT, claimToken: 'at.secret', outputs: OUTPUTS, evidence: EVIDENCE, idempotencyKey: 's-1' },
    method: 'submitAttempt',
    input: { attemptId: ATTEMPT, claimToken: 'at.secret', outputs: OUTPUTS, evidence: EVIDENCE, idempotencyKey: 's-1' }
  },
  {
    tool: 'accept_attempt',
    args: { attemptId: ATTEMPT, notes: 'verified', criteria: EVIDENCE.criteria, idempotencyKey: 'a-1' },
    method: 'acceptAttempt',
    input: { attemptId: ATTEMPT, notes: 'verified', criteria: EVIDENCE.criteria, idempotencyKey: 'a-1' }
  },
  {
    tool: 'reject_attempt',
    args: { attemptId: ATTEMPT, reasons: ['c2 has no test'], notes: 'add tests' },
    method: 'rejectAttempt',
    input: { attemptId: ATTEMPT, reasons: ['c2 has no test'], notes: 'add tests' }
  },
  {
    tool: 'fail_attempt',
    args: { attemptId: ATTEMPT, claimToken: 'at.secret', failure: { reason: 'blocked', details: 'API down', retryable: true } },
    method: 'failAttempt',
    input: { attemptId: ATTEMPT, claimToken: 'at.secret', failure: { reason: 'blocked', details: 'API down', retryable: true } }
  },
  {
    tool: 'reconcile_attempt',
    args: { attemptId: ATTEMPT, resolution: 'resubmit', outputs: OUTPUTS, evidence: EVIDENCE, notes: 'finished' },
    method: 'reconcileAttempt',
    input: { attemptId: ATTEMPT, resolution: 'resubmit', outputs: OUTPUTS, evidence: EVIDENCE, notes: 'finished' }
  },
  {
    tool: 'reconcile_attempt',
    args: { attemptId: ATTEMPT, resolution: 'abandon' },
    method: 'reconcileAttempt',
    input: { attemptId: ATTEMPT, resolution: 'abandon' }
  },
  {
    tool: 'carry_forward_ticket',
    args: { runId: RUN, ticketId: TICKET, note: 'unchanged since run 1' },
    method: 'carryForwardTicket',
    input: { runId: RUN, ticketId: TICKET, note: 'unchanged since run 1' }
  },
  { tool: 'pause_run', args: { runId: RUN, reason: 'lunch' }, method: 'pauseRun', input: { runId: RUN, reason: 'lunch' } },
  { tool: 'resume_run', args: { runId: RUN }, method: 'resumeRun', input: { runId: RUN } },
  { tool: 'cancel_run', args: { runId: RUN, reason: 'obsolete' }, method: 'cancelRun', input: { runId: RUN, reason: 'obsolete' } },
  { tool: 'takeover_run', args: { runId: RUN }, method: 'takeoverRun', input: { runId: RUN } },
  {
    tool: 'adopt_revision',
    args: { runId: RUN, revisionId: REVISION, carryForward: [TICKET] },
    method: 'adoptRevision',
    input: { runId: RUN, revisionId: REVISION, carryForward: [TICKET] }
  }
]

describe('execution tools map to the command layer', () => {
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

describe('start_run', () => {
  it('records the shipped skills version when the caller gives none', async () => {
    const api = createCannedApi({ startRun: MARKER })
    await inRig(api, async (rig) => {
      await callTool(rig, 'start_run', { epicId: EPIC })
      expect(api.calls).toEqual([{ name: 'startRun', input: { epicId: EPIC, skillVersion: SKILLS_VERSION } }])
    })
  })

  it('also records it when the caller passes null', async () => {
    const api = createCannedApi({ startRun: MARKER })
    await inRig(api, async (rig) => {
      await callTool(rig, 'start_run', { epicId: EPIC, skillVersion: null })
      expect(api.calls[0]?.input).toMatchObject({ skillVersion: SKILLS_VERSION })
    })
  })

  it('keeps an explicit skill version and forwards every other input', async () => {
    const api = createCannedApi({ startRun: MARKER })
    const args = {
      epicId: EPIC,
      host: { label: 'Agent CLI', type: 'agent-cli' },
      hostCatalogId: CATALOG,
      skillVersion: '9.9.9',
      branch: BRANCH,
      carryForward: [{ ticketId: TICKET, note: 'unchanged' }],
      idempotencyKey: 'run-1'
    }
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'start_run', args)
      expect(outcome.payload).toEqual({ ok: true, data: MARKER })
      expect(api.calls).toEqual([{ name: 'startRun', input: args }])
    })
  })
})

describe('get_run', () => {
  it('needs a run id or an epic id and does not call the command otherwise', async () => {
    const api = createCannedApi({ getRun: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'get_run', {})
      expect(outcome.isError).toBe(true)
      expect(outcome.payload).toEqual({
        ok: false,
        error: { code: 'invalid_input', message: 'Give runId or epicId.' }
      })
      expect(api.calls).toEqual([])
    })
  })

  it('returns null data when the epic has never run', async () => {
    const api = createCannedApi({ getRun: null })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'get_run', { epicId: EPIC })
      expect(outcome.payload).toEqual({ ok: true, data: null })
    })
  })
})

describe('register_host defaults', () => {
  it('fills optional model fields with explicit nulls and empty lists', async () => {
    const api = createCannedApi({ registerHost: MARKER })
    const minimal = { ...HOST, models: [{ id: 'm', reasoningLevels: ['routine'], modalities: ['text'] }] }
    await inRig(api, async (rig) => {
      await callTool(rig, 'register_host', minimal)
      const input = api.calls[0]?.input as { models: unknown[] }
      expect(input.models).toEqual([
        {
          id: 'm',
          label: '',
          reasoningLevels: ['routine'],
          modalities: ['text'],
          contextWindowTokens: null,
          skills: [],
          costTier: null,
          latencyTier: null
        }
      ])
    })
  })
})

const WORKER = { label: 'w' }

describe('execution input validation', () => {
  it.each([
    ['claim_ticket without a worker label', 'claim_ticket', { runId: RUN, ticketId: TICKET, worker: {} }],
    ['claim_ticket with a lease below 30 seconds', 'claim_ticket', { runId: RUN, ticketId: TICKET, worker: WORKER, leaseSeconds: 29 }],
    ['claim_ticket with a lease above a day', 'claim_ticket', { runId: RUN, ticketId: TICKET, worker: WORKER, leaseSeconds: 86401 }],
    ['claim_ticket with a ticket key instead of an id', 'claim_ticket', { runId: RUN, ticketId: 'DM-1', worker: WORKER }],
    ['heartbeat_attempt without a claim token', 'heartbeat_attempt', { attemptId: ATTEMPT }],
    ['heartbeat_attempt with an empty claim token', 'heartbeat_attempt', { attemptId: ATTEMPT, claimToken: '' }],
    ['submit_attempt without a summary', 'submit_attempt', { attemptId: ATTEMPT, claimToken: 't', outputs: {} }],
    ['submit_attempt with an unknown check status', 'submit_attempt', { attemptId: ATTEMPT, claimToken: 't', outputs: { summary: 's' }, evidence: { checks: [{ name: 'x', status: 'maybe' }] } }],
    ['reject_attempt without reasons', 'reject_attempt', { attemptId: ATTEMPT, reasons: [] }],
    ['reject_attempt with an empty reason', 'reject_attempt', { attemptId: ATTEMPT, reasons: [''] }],
    ['fail_attempt without a reason', 'fail_attempt', { attemptId: ATTEMPT, failure: {} }],
    ['reconcile_attempt with an unknown resolution', 'reconcile_attempt', { attemptId: ATTEMPT, resolution: 'ignore' }],
    ['carry_forward_ticket without a note', 'carry_forward_ticket', { runId: RUN, ticketId: TICKET, note: '' }],
    ['start_run with an invalid branch name', 'start_run', { epicId: EPIC, branch: { repository: null, name: 'a b', startCommit: null } }],
    ['adopt_revision with a malformed revision id', 'adopt_revision', { runId: RUN, revisionId: 'r1' }],
    ['register_host without models', 'register_host', { hostId: 'h', hostType: 't', catalogRevision: '1', tools: [], canSelectWorkerModel: false }],
    ['register_host with an unknown reasoning level', 'register_host', { ...HOST, models: [{ id: 'm', reasoningLevels: ['genius'], modalities: ['text'] }] }]
  ])('rejects %s without calling the command', async (_label, tool, args) => {
    const api = createCannedApi({ claimTicket: MARKER, submitAttempt: MARKER, failAttempt: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, tool, args)
      expect(outcome.isError).toBe(true)
      expect(api.calls).toEqual([])
    })
  })
})

describe('cancel_run', () => {
  it('is the only tool annotated as destructive', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const { tools } = await rig.client.listTools()
      const destructive = tools.filter((tool) => tool.annotations?.destructiveHint === true)
      expect(destructive.map((tool) => tool.name)).toEqual(['cancel_run'])
    })
  })
})
