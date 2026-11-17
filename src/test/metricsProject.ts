/**
 * A real project for metrics read-model tests: a temporary repository (`createHarness`) whose epics are planned, run
 * and delivered through the real commands, each attempt relaying the usage a host would (one closed active span, its
 * token categories and total, its effort classified), or nothing (`unmeasured`). Not shipped.
 */
import type { Workspace } from '../core/workspace'
import type { DraftOp } from '../shared/domain/api'
import type { PlanBundle, PlanPolicies, TicketContent, TicketSize } from '../shared/domain/bundle'
import type { MetricReport } from '../shared/domain/metrics'
import { createHarness, type Harness } from './workspaceHarness'

const fail = (message: string): never => {
  throw new Error(message)
}

export interface Project {
  harness: Harness
  folder: string
  desktop: Workspace
  orchestrator: Workspace
}

export interface DeliveredEpic {
  epicId: string
  runId: string
  sprintId: string
  bundle: PlanBundle
  ticketIds: string[]
  attemptIds: string[]
}

/** Per attempt: usage relayed (`measured`), half its effort corrective (`corrective`), tokens estimated, or nothing. */
export type UsageKind = 'measured' | 'corrective' | 'estimated' | 'unmeasured'

/** What every measured attempt relays: a 600 s active span and these token counts. */
export const ATTEMPT_ACTIVE_MS = 600_000
export const ATTEMPT_TOKENS = { input: 20_000, cachedInput: 5_000, output: 10_000, reasoning: 2_000, total: 30_000 } as const

function ticketOf(bundle: PlanBundle, ticketId: string): TicketContent {
  return bundle.tickets.find((entry) => entry.id === ticketId) ?? fail(`No ticket ${ticketId}`)
}

/** An initialized repository with a desktop and an orchestrator session over it. */
export async function project(title: string): Promise<Project> {
  const harness = createHarness()
  const desktop = harness.open('desktop', { allowSave: true })
  await desktop.initializeRepository({ name: title })
  return { harness, folder: harness.root, desktop, orchestrator: harness.open('orchestrator', { allowSave: true }) }
}

/** The attempt's effort classified: all productive, or (for `corrective`) half of it corrective, cause implementation. */
function effortReports(attemptId: string, actor: string, kind: UsageKind, span: { ms: number; observedAt: string }): MetricReport[] {
  const { ms, observedAt } = span
  const event = (classification: string, value: number): MetricReport => ({
    metric: 'corrective_effort_ms',
    unit: 'milliseconds',
    source: { kind: 'agent', actor },
    measurement: { state: 'observed', value },
    accumulation: 'event',
    eventId: `${classification}-${attemptId}`,
    observedAt,
    attributes: classification === 'productive' ? { classification, work: 'implementation' } : { classification }
  })
  if (kind !== 'corrective') return [event('productive', ms)]
  return [event('productive', ms / 2), { ...event('corrective', ms / 2), cause: 'implementation' }]
}

/** What a host relays for one attempt: one closed active span, its token categories and total, and its effort classified. */
function usageReports(attemptId: string, span: { start: number; end: number }, kind: UsageKind): MetricReport[] {
  const actor = `omp:worker-${attemptId.slice(-6)}`
  const end = new Date(span.end).toISOString()
  const usage = { coverage: 'self' as const, parentActor: null }
  const tokens = (metric: MetricReport['metric'], value: number): MetricReport => ({
    metric,
    unit: 'tokens',
    source: { kind: 'host', actor },
    measurement: kind === 'estimated' && metric === 'tokens_total' ? { state: 'estimated', value, method: 'host estimate from request sizes' } : { state: 'observed', value },
    accumulation: 'cumulative',
    sequence: 1,
    observedAt: end,
    usage
  })
  return [
    {
      metric: 'active_ms',
      unit: 'milliseconds',
      source: { kind: 'host', actor },
      measurement: { state: 'observed', value: span.end - span.start },
      accumulation: 'delta',
      eventId: `span-${attemptId}`,
      observedAt: end,
      attributes: { spanStart: new Date(span.start).toISOString(), activeBasis: 'requests_and_tools' },
      usage
    },
    tokens('tokens_input', ATTEMPT_TOKENS.input),
    tokens('tokens_cached_input', ATTEMPT_TOKENS.cachedInput),
    tokens('tokens_output', ATTEMPT_TOKENS.output),
    tokens('tokens_reasoning', ATTEMPT_TOKENS.reasoning),
    tokens('tokens_total', ATTEMPT_TOKENS.total),
    ...effortReports(attemptId, actor, kind, { ms: span.end - span.start, observedAt: end })
  ]
}

/** The sizes of an epic's tickets (their cohort keys): every work ticket's, and the acceptance node's; unsized when absent. */
interface TicketSizes {
  work?: TicketSize
  acceptance?: TicketSize
}

/**
 * How `plan` shapes the epic: its tickets' sizes, tags on every work ticket (`administrative` makes it overhead),
 * whether to drop the acceptance nodes (as a pre-node plan), and its execution policies.
 */
interface PlanOptions extends TicketSizes {
  workTags?: string[]
  withoutAcceptanceNodes?: boolean
  policies?: Partial<PlanPolicies>
}

/**
 * Creates an epic with `tickets` work tickets in sprint 1 (or, given a list, that many in each sprint in turn, each
 * sprint's checkpoint automatic), each sprint's acceptance node covering its work tickets (or none, when
 * `withoutAcceptanceNodes`), and saves the plan.
 */
export async function plan(p: Project, title: string, tickets: number | readonly number[], options: PlanOptions = {}): Promise<{ epicId: string; bundle: PlanBundle }> {
  const { orchestrator } = p
  const perSprint = typeof tickets === 'number' ? [tickets] : tickets
  const epic = await orchestrator.createEpic({ title, intent: 'Measure the project.', successCriteria: ['Numbers read alike everywhere'] })
  const sprints: DraftOp[] = perSprint.slice(1).map((_, n) => ({ op: 'add_sprint', ref: `s${n + 2}`, sprint: { goal: `Sprint ${n + 2} of ${title}`, checkpoint: { mode: 'auto' } } }))
  const ops: DraftOp[] = perSprint.flatMap((count, s) =>
    Array.from({ length: count }, (_, n): DraftOp => ({
      op: 'add_ticket',
      sprint: s === 0 ? '1' : `s${s + 1}`,
      ticket: {
        title: `${title} ticket ${s === 0 ? '' : `${s + 1}.`}${n + 1}`,
        acceptanceCriteria: ['It works'],
        budget: { tokens: 50_000, activeMs: 30 * 60_000 },
        ...(options.work === undefined ? {} : { size: options.work }),
        ...(options.workTags === undefined ? {} : { tags: options.workTags })
      }
    }))
  )
  const policies: DraftOp[] = options.policies === undefined ? [] : [{ op: 'set_policies', patch: options.policies }]
  await orchestrator.updatePlanDraft({ epicId: epic.id, ops: [...policies, ...sprints, ...ops] })
  const draft = await orchestrator.getPlan({ epicId: epic.id, view: 'draft' })
  const ticketsOf = new Map(draft.bundle.tickets.map((ticket) => [ticket.id, ticket]))
  const cover: DraftOp[] = draft.bundle.sprints.flatMap((sprint) => {
    const inSprint = sprint.ticketIds.map((id) => ticketsOf.get(id) ?? fail(`No ticket ${id}`))
    const work = inSprint.filter((ticket) => ticket.kind !== 'acceptance')
    return inSprint
      .filter((ticket) => ticket.kind === 'acceptance')
      .map(
        (node): DraftOp =>
          options.withoutAcceptanceNodes === true
            ? { op: 'remove_ticket', ticket: node.id }
            : {
                op: 'update_ticket',
                ticket: node.id,
                patch: { acceptanceCriteria: work.map((ticket) => ({ text: `${ticket.title} is verified`, covers: ticket.id })), ...(options.acceptance === undefined ? {} : { size: options.acceptance }) }
              }
      )
  })
  const revision = (await orchestrator.updatePlanDraft({ epicId: epic.id, ops: cover })).draftRevision
  const saved = await orchestrator.savePlan({ epicId: epic.id, expectedDraftRevision: revision })
  if (saved.status !== 'saved') fail(`The plan was not saved: ${saved.status}`)
  return { epicId: epic.id, bundle: (await orchestrator.getPlan({ epicId: epic.id, view: 'saved' })).bundle }
}

interface EpicSpec {
  title: string
  /** Per work ticket, how its attempt reports usage. */
  tickets: UsageKind[]
  /** Accept every delivered attempt (and run the acceptance node), else they stay submitted. */
  accept: boolean
  /** How the plan is shaped (sizes, tags); unsized and untagged when absent. */
  shape?: PlanOptions
  /** How the acceptance node (run when `accept`) reports usage; `measured` when absent. */
  acceptance?: UsageKind
  /** Runs started and canceled before the delivering run, executing nothing (a restarted epic). */
  emptyRuns?: number
}

/** Claims, reports usage for (unless `unmeasured`), submits and (when `accept`) accepts one ticket; returns the attempt id. */
async function deliverTicket(p: Project, run: { runId: string; bundle: PlanBundle }, ticketId: string, how: { kind: UsageKind; accept: boolean }): Promise<string> {
  const { harness, orchestrator } = p
  const ticket = ticketOf(run.bundle, ticketId)
  const claim = await orchestrator.claimTicket({ runId: run.runId, ticketId, worker: { label: 'test-worker' } })
  const start = harness.clock.nowMs()
  harness.clock.advanceSeconds(ATTEMPT_ACTIVE_MS / 1000)
  if (how.kind !== 'unmeasured') await orchestrator.recordAttemptMetrics({ attemptId: claim.attempt.id, reports: usageReports(claim.attempt.id, { start, end: harness.clock.nowMs() }, how.kind) })
  await orchestrator.submitAttempt({
    attemptId: claim.attempt.id,
    claimToken: claim.packet.claimToken ?? fail('The claim carries no token.'),
    outputs: { summary: `Delivered ${ticket.title}.`, commits: ['abcdef1'], changedFiles: ['src/demo.ts'] },
    evidence: {
      checks: [{ name: 'unit tests', status: 'passed', detail: 'npx vitest run src/demo.test.ts' }],
      criteria: ticket.acceptanceCriteria.map((criterion) => ({ criterionId: criterion.id, met: true, note: 'shown by the test' })),
      notes: ''
    }
  })
  harness.clock.advanceSeconds(60)
  if (how.accept) {
    const criteria = ticket.acceptanceCriteria.map((criterion) => ({ criterionId: criterion.id, met: true, note: 'verified' }))
    await orchestrator.acceptAttempt({ attemptId: claim.attempt.id, notes: 'reviewed', criteria })
    harness.clock.advanceSeconds(60)
  }
  return claim.attempt.id
}

/** Plans an epic, starts its run (after `emptyRuns` restarts that executed nothing) and delivers each work ticket. */
export async function deliverEpic(p: Project, spec: EpicSpec): Promise<DeliveredEpic> {
  const { harness, orchestrator } = p
  const { epicId, bundle } = await plan(p, spec.title, spec.tickets.length, spec.shape)
  harness.clock.advanceSeconds(60)
  for (let n = 0; n < (spec.emptyRuns ?? 0); n += 1) {
    const empty = await orchestrator.startRun({ epicId })
    harness.clock.advanceSeconds(30)
    await orchestrator.cancelRun({ runId: empty.id, reason: 'restarted before any work' })
    harness.clock.advanceSeconds(30)
  }
  const run = await orchestrator.startRun({ epicId })
  const sprintId = bundle.sprints[0]?.id ?? fail('No sprint')
  const delivered = await deliverSprint(p, { runId: run.id, bundle }, sprintId, spec)
  return { epicId, runId: run.id, sprintId, bundle, ...delivered }
}

/**
 * Delivers one sprint of a running run: each work ticket as `spec.tickets` says, then (when `spec.accept`) its
 * acceptance node, so its outcomes are verified end to end.
 */
export async function deliverSprint(
  p: Project,
  run: { runId: string; bundle: PlanBundle },
  sprintId: string,
  spec: Pick<EpicSpec, 'tickets' | 'accept' | 'acceptance'>
): Promise<{ ticketIds: string[]; attemptIds: string[] }> {
  const sprint = run.bundle.sprints.find((entry) => entry.id === sprintId) ?? fail(`No sprint ${sprintId}`)
  const inSprint = sprint.ticketIds.map((id) => ticketOf(run.bundle, id))
  const ticketIds = inSprint.filter((ticket) => ticket.kind !== 'acceptance').map((ticket) => ticket.id)
  const acceptance = inSprint.filter((ticket) => ticket.kind === 'acceptance').map((ticket) => ticket.id)
  const delivered = spec.accept ? [...ticketIds, ...acceptance] : ticketIds
  const attemptIds: string[] = []
  for (const [index, ticketId] of delivered.entries()) {
    const kind = spec.tickets[index] ?? spec.acceptance ?? 'measured'
    attemptIds.push(await deliverTicket(p, run, ticketId, { kind, accept: spec.accept }))
  }
  return { ticketIds, attemptIds }
}

export function report(p: Project, epic: DeliveredEpic, summary: string) {
  return p.orchestrator.submitSprintReport({ runId: epic.runId, sprintId: epic.sprintId, report: { summary } })
}

/** Delivers, reports and closes an epic's run: its sprint is then frozen with the report. */
export async function reportedEpic(p: Project, spec: EpicSpec): Promise<DeliveredEpic> {
  const epic = await deliverEpic(p, spec)
  await report(p, epic, `Sprint 1 of ${spec.title} is done.`)
  await p.orchestrator.cancelRun({ runId: epic.runId, reason: 'closing the run' })
  p.harness.clock.advanceSeconds(120)
  return epic
}
