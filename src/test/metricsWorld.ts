/** Fixture helpers for metric ingestion and planned-budget tests that drive a Workspace per role. Not shipped. */
import type { Workspace } from '../core/workspace'
import type { TicketInput } from '../shared/domain/api'
import type { MetricReport } from '../shared/domain/metrics'
import { dropAcceptanceNodes } from './acceptanceNodes'
import type { Harness } from './workspaceHarness'

/**
 * A token usage report from a host stream, delta by default. Typed loosely so a test can send what the schema
 * refuses (a wrong unit, a missing event id) and see the refusal.
 */
export function usage(patch: Record<string, unknown> = {}): MetricReport {
  return {
    metric: 'tokens_input',
    unit: 'tokens',
    source: { kind: 'host', actor: 'external-host:session-a' },
    measurement: { state: 'observed', value: 1_000 },
    accumulation: 'delta',
    eventId: 'evt-1',
    observedAt: '2026-03-01T10:05:00.000Z',
    ...patch
  } as MetricReport
}

export interface MetricsWorld {
  orchestrator: Workspace
  epicId: string
  runId: string
  /** Ticket ids by plan ref. */
  ticket: Record<string, string>
  /** Claimed attempts (id and claim token) by plan ref. */
  attempt: Record<string, { id: string; token: string }>
}

/**
 * An epic whose single sprint holds `tickets` (by ref), saved at the harness clock's start (10:00:00), with a run
 * started 60 s later and the refs in `claim` claimed in order, 60 s apart. A budget saved by the plan is therefore
 * frozen before every dispatch.
 */
export async function metricsWorld(harness: Harness, tickets: Record<string, TicketInput>, claim: string[]): Promise<MetricsWorld> {
  const orchestrator = harness.open('orchestrator')
  await orchestrator.initializeRepository({ name: 'metrics-repo' })
  const epic = await orchestrator.createEpic({ title: 'Metrics epic' })
  await dropAcceptanceNodes(orchestrator, epic.id)
  const draft = await orchestrator.updatePlanDraft({
    epicId: epic.id,
    ops: Object.entries(tickets).map(([ref, ticket]) => ({
      op: 'add_ticket' as const,
      ref,
      sprint: '1',
      ticket
    }))
  })
  await orchestrator.savePlan({
    epicId: epic.id,
    expectedDraftRevision: draft.draftRevision
  })
  const ticket = Object.fromEntries(Object.keys(tickets).map((ref) => [ref, draft.refMap[ref] ?? '']))
  harness.clock.advanceSeconds(60)
  const run = await orchestrator.startRun({ epicId: epic.id })
  const attempt: MetricsWorld['attempt'] = {}
  for (const ref of claim) {
    harness.clock.advanceSeconds(60)
    const claimed = await orchestrator.claimTicket({
      runId: run.id,
      ticketId: ticket[ref] ?? '',
      worker: { label: `worker-${ref}` }
    })
    attempt[ref] = {
      id: claimed.attempt.id,
      token: claimed.packet.claimToken ?? ''
    }
  }
  return { orchestrator, epicId: epic.id, runId: run.id, ticket, attempt }
}
