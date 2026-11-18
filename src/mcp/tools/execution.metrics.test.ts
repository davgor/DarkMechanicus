import { afterEach, describe, expect, it } from 'vitest'
import type { Workspace } from '../../core/workspace'
import type { SessionRole } from '../../shared/domain/views'
import { dropAcceptanceNodes } from '../../test/acceptanceNodes'
import { callTool, withServer } from '../../test/mcpHarness'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { createMcpServer } from '../server'

const INFO = { name: 'darkmechanicus', version: '0.0.0-test' }

interface Claimed {
  id: string
  token: string
}

interface Run {
  harness: Harness
  orchestrator: Workspace
  runId: string
  ticket: Record<string, string>
  attempt: Record<string, Claimed>
}

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** One sprint holding `refs` as tickets, saved, a run started and every ticket claimed in order a minute apart. */
async function claimedRun(refs: string[]): Promise<Run> {
  const harness = createHarness()
  cleanups.push(() => harness.cleanup())
  const orchestrator = harness.open('orchestrator')
  await orchestrator.initializeRepository({ name: 'metric reporting' })
  const epic = await orchestrator.createEpic({ title: 'Metric reporting' })
  await dropAcceptanceNodes(orchestrator, epic.id)
  const draft = await orchestrator.updatePlanDraft({ epicId: epic.id, ops: refs.map((ref) => ({ op: 'add_ticket' as const, ref, sprint: '1', ticket: { title: ref } })) })
  await orchestrator.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  const run = await orchestrator.startRun({ epicId: epic.id })
  const ticket = Object.fromEntries(refs.map((ref) => [ref, draft.refMap[ref] ?? '']))
  const attempt: Record<string, Claimed> = {}
  for (const ref of refs) {
    harness.clock.advanceSeconds(60)
    const claim = await orchestrator.claimTicket({ runId: run.id, ticketId: ticket[ref] ?? '', worker: { label: `worker-${ref}` } })
    attempt[ref] = { id: claim.attempt.id, token: claim.packet.claimToken ?? '' }
  }
  return { harness, orchestrator, runId: run.id, ticket, attempt }
}

/** A token report as an external host's stream relays it (delta by default). */
function usage(run: Run, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    metric: 'tokens_input',
    unit: 'tokens',
    source: { kind: 'host', actor: 'external-host:session-a' },
    measurement: { state: 'observed', value: 1_000 },
    accumulation: 'delta',
    eventId: 'evt-1',
    observedAt: run.harness.clock.nowIso(),
    ...patch
  }
}

function observationCount(run: Run): number {
  return run.orchestrator.ctx().db.get<{ count: number }>('SELECT COUNT(*) AS count FROM metric_observations')?.count ?? -1
}

function sessionFor(run: Run, role: SessionRole): Workspace {
  return role === 'orchestrator' ? run.orchestrator : run.harness.open(role)
}

/** Calls `tool` over an MCP server granted `role` (as the stdio entry point grants it) and returns its payload. */
async function asRole(run: Run, role: SessionRole, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const server = createMcpServer(sessionFor(run, role), INFO, { role, allowSave: role === 'orchestrator' })
  return withServer(server, async (rig) => (await callTool(rig, tool, args)).payload)
}

const HUMAN_RATING = { metric: 'human_rating', unit: 'rating_1_5', measurement: { state: 'observed', value: 5 }, accumulation: 'event', eventId: 'rate-1' }

interface Refusal {
  label: string
  role: SessionRole
  tool: string
  args: (run: Run) => Record<string, unknown>
  code: string
  /** What the refusal names, when the rule that refuses it is specific. */
  details?: Record<string, unknown>
}

const ownAttempt = (r: Run) => ({ attemptId: r.attempt.alpha?.id, claimToken: r.attempt.alpha?.token })

const REFUSALS: Refusal[] = [
  { label: 'a worker using its claim token on another attempt', role: 'worker', tool: 'record_attempt_metrics', args: (r) => ({ ...ownAttempt(r), attemptId: r.attempt.beta?.id, reports: [usage(r)] }), code: 'stale_claim' },
  { label: 'a worker without a claim token', role: 'worker', tool: 'record_attempt_metrics', args: (r) => ({ attemptId: r.attempt.alpha?.id, reports: [usage(r)] }), code: 'unauthorized' },
  { label: 'a worker writing to the run overhead bucket', role: 'worker', tool: 'record_run_metrics', args: (r) => ({ runId: r.runId, overhead: 'review', reports: [usage(r)] }), code: 'unauthorized' },
  { label: 'a reader recording usage', role: 'reader', tool: 'record_attempt_metrics', args: (r) => ({ ...ownAttempt(r), reports: [usage(r)] }), code: 'unauthorized' },
  {
    label: 'a worker reporting a rating as an agent',
    role: 'worker',
    tool: 'record_attempt_metrics',
    args: (r) => ({ ...ownAttempt(r), reports: [usage(r, { ...HUMAN_RATING, source: { kind: 'agent', actor: 'worker' } })] }),
    code: 'unauthorized',
    details: { index: 0, metric: 'human_rating' }
  },
  // Token usage an agent may report, but stated as a person's: the source kind alone refuses it.
  { label: 'a worker naming a human source for token usage', role: 'worker', tool: 'record_attempt_metrics', args: (r) => ({ ...ownAttempt(r), reports: [usage(r, { source: { kind: 'human', actor: 'owner' } })] }), code: 'unauthorized', details: { index: 0, sourceKind: 'human' } },
  {
    label: 'an orchestrator naming a server source for token usage',
    role: 'orchestrator',
    tool: 'record_attempt_metrics',
    args: (r) => ({ attemptId: r.attempt.alpha?.id, reports: [usage(r, { eventId: 'evt-ok' }), usage(r, { eventId: 'evt-2', source: { kind: 'server', actor: 'dm' } })] }),
    code: 'unauthorized',
    details: { index: 1, sourceKind: 'server' }
  },
  {
    label: 'an orchestrator reporting rescue minutes',
    role: 'orchestrator',
    tool: 'record_run_metrics',
    args: (r) => ({ runId: r.runId, overhead: 'review', reports: [usage(r, { metric: 'rescue_minutes', unit: 'minutes', accumulation: 'event', eventId: 'rescue-1', source: { kind: 'agent', actor: 'orch' } })] }),
    code: 'unauthorized',
    details: { index: 0, metric: 'rescue_minutes' }
  },
  {
    label: 'a reviewer claiming a server handoff check',
    role: 'reviewer',
    tool: 'record_run_metrics',
    args: (r) => ({ runId: r.runId, overhead: 'review', reports: [usage(r, { metric: 'handoff_check', unit: 'pass_fail', accumulation: 'event', eventId: 'h-1', measurement: { state: 'observed', value: 1 } })] }),
    code: 'unauthorized',
    details: { index: 0, metric: 'handoff_check' }
  }
]

describe('metric reporting over MCP: refusals (DM-171 c1)', () => {
  it.each(REFUSALS)('refuses $label with $code, recording nothing', async ({ role, tool, args, code, details }) => {
    const run = await claimedRun(['alpha', 'beta'])
    const payload = await asRole(run, role, tool, args(run))
    expect(payload).toMatchObject({ ok: false, error: details === undefined ? { code } : { code, details } })
    expect(observationCount(run)).toBe(0)
  })

  it('refuses a worker whose lease expired with expired_claim, while the orchestrator may still attribute host usage to the attempt', async () => {
    const run = await claimedRun(['alpha'])
    const alpha = run.attempt.alpha ?? { id: '', token: '' }
    run.harness.clock.advanceSeconds(3 * 3600)
    const late = await asRole(run, 'worker', 'record_attempt_metrics', { attemptId: alpha.id, claimToken: alpha.token, reports: [usage(run, { eventId: 'late-1' })] })
    expect(late).toMatchObject({ ok: false, error: { code: 'expired_claim' } })
    expect(observationCount(run)).toBe(0)
    const relayed = await asRole(run, 'orchestrator', 'record_attempt_metrics', { attemptId: alpha.id, reports: [usage(run, { eventId: 'late-relay' })] })
    expect(relayed).toMatchObject({ ok: true, data: { observations: [{ scope: { attemptId: alpha.id } }] } })
    expect(observationCount(run)).toBe(1)
  })
})

describe('metric reporting over MCP: scoped reporting (DM-171 c1)', () => {
  it('records a worker’s usage on its own claimed attempt, in a scope the server fixes', async () => {
    const run = await claimedRun(['alpha', 'beta'])
    const alpha = run.attempt.alpha ?? { id: '', token: '' }
    const own = await asRole(run, 'worker', 'record_attempt_metrics', { attemptId: alpha.id, claimToken: alpha.token, reports: [usage(run)] })
    expect(own).toMatchObject({
      ok: true,
      data: { observations: [{ scope: { level: 'attempt', attemptId: alpha.id, runId: run.runId, ticketId: run.ticket.alpha }, source: { kind: 'host' } }] }
    })
  })

  it('records run overhead from the orchestrator and the reviewer, labelled and charged to no attempt', async () => {
    const run = await claimedRun(['alpha'])
    const orchestration = await asRole(run, 'orchestrator', 'record_run_metrics', { runId: run.runId, overhead: 'orchestration', reports: [usage(run, { eventId: 'orch-1', source: { kind: 'agent', actor: 'orchestrator' } })] })
    const review = await asRole(run, 'reviewer', 'record_run_metrics', { runId: run.runId, overhead: 'review', reports: [usage(run, { eventId: 'review-1', source: { kind: 'agent', actor: 'reviewer' } })] })
    expect(orchestration).toMatchObject({ ok: true, data: { observations: [{ attributes: { overhead: 'orchestration' }, scope: { runId: run.runId, attemptId: null } }] } })
    expect(review).toMatchObject({ ok: true, data: { observations: [{ attributes: { overhead: 'review' }, scope: { runId: run.runId, attemptId: null } }] } })
  })
})

describe('external host usage over MCP (DM-171 c4)', () => {
  it('takes actual usage from a plain MCP host, keeps what it cannot measure unavailable, and shows coverage to a reader', async () => {
    const run = await claimedRun(['alpha', 'beta'])
    const [alpha = '', beta = ''] = [run.attempt.alpha?.id, run.attempt.beta?.id]
    const host = { kind: 'host', actor: 'ci-runner:alpha' }
    const totals = async () => (await asRole(run, 'reader', 'get_run_metrics', { runId: run.runId }))?.data
    // Nothing reported yet: missing, never zero.
    expect(await totals()).toMatchObject({ totals: expect.arrayContaining([expect.objectContaining({ metric: 'tokens_input', measurement: { state: 'missing', reason: 'not_reported' }, reportedValue: null, attempts: expect.objectContaining({ unreported: 2 }) })]) })

    const alphaUsage = await asRole(run, 'orchestrator', 'record_attempt_metrics', {
      attemptId: alpha,
      reports: [
        usage(run, { source: host, accumulation: 'cumulative', eventId: undefined, sequence: 1, measurement: { state: 'observed', value: 10_000 } }),
        usage(run, { source: host, accumulation: 'cumulative', eventId: undefined, sequence: 2, measurement: { state: 'observed', value: 25_000 } }),
        usage(run, { source: host, metric: 'tokens_reasoning', eventId: 'cap-1', measurement: { state: 'missing', reason: 'host_unavailable' } })
      ]
    })
    expect(alphaUsage).toMatchObject({ ok: true })
    // Beta is still unreported: the input total is a lower bound, not a complete total.
    expect(await totals()).toMatchObject({ totals: expect.arrayContaining([expect.objectContaining({ metric: 'tokens_input', measurement: { state: 'missing', reason: 'partial_coverage' }, reportedValue: 25_000 })]) })

    const betaUsage = await asRole(run, 'orchestrator', 'record_attempt_metrics', {
      attemptId: beta,
      reports: [
        usage(run, { source: { kind: 'host', actor: 'ci-runner:beta' }, eventId: 'beta-in', measurement: { state: 'observed', value: 8_000 } }),
        usage(run, { source: { kind: 'host', actor: 'ci-runner:beta' }, metric: 'tokens_reasoning', eventId: 'beta-cap', measurement: { state: 'missing', reason: 'host_unavailable' } })
      ]
    })
    expect(betaUsage).toMatchObject({ ok: true })
    const read = await asRole(run, 'reader', 'get_run_metrics', { runId: run.runId })
    expect(read).toMatchObject({
      ok: true,
      data: {
        totals: expect.arrayContaining([
          expect.objectContaining({ metric: 'tokens_input', measurement: { state: 'observed', value: 33_000 } }),
          expect.objectContaining({ metric: 'tokens_reasoning', measurement: { state: 'missing', reason: 'host_unavailable' }, reportedValue: null, attempts: expect.objectContaining({ unavailable: 2 }) })
        ]),
        attempts: expect.arrayContaining([
          expect.objectContaining({ attemptId: alpha, usage: expect.arrayContaining([expect.objectContaining({ metric: 'tokens_reasoning', coverage: 'unavailable', value: null })]) })
        ])
      }
    })
  })
})
