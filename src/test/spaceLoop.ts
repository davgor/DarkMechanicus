/**
 * The whole SPACE loop on a two-repository machine (`twoRepoMachine.ts`), step by step through the real commands, for
 * the end-to-end tests (DM-193) and the real-app evidence seed. Not shipped.
 *
 * In the project (`shop`), epic "Checkout flow":
 *   sprint1()       Sprint 1 planned (api and page medium, budgeted at 30 min and 50,000 tokens; docs small, budgeted
 *                   at 15 min and 20,000; the acceptance node, no budget of its own), saved and run. api: 20 min, its
 *                   host relaying a cumulative total twice (18,000 then 30,000) and the token categories; page: a
 *                   10 min, 12,000-token attempt rejected, then a 15 min, 16,000-token corrective retry accepted;
 *                   docs: 10 min, 4,000 tokens; the node: 5 min, 6,000 tokens; orchestration overhead: 8 min, 5,000.
 *   report1()       The Sprint 1 report freezes its scorecard; its retro holds two experiments drawn from it: `local`
 *                   (T.actual_ms -20%, this repository) and `dm` (K.actual_tokens -20%, the Dark Mechanicus source).
 *   correctLocal()  create_corrections puts `local`'s work into a new Sprint 2 (with its Fireguard ticket and acceptance
 *                   node); the person adds two medium tickets to it and a Sprint 3, saves, adopts and approves Sprint 1;
 *                   the run advances.
 *   requestDm()     The person chooses the Dark Mechanicus checkout and the broker creates `dm`'s epic there.
 *   workDm()        In the checkout, the person saves the correction epic (with a measured Sprint 2) and its own run
 *                   delivers both sprints; each report freezes there.
 *   sprint2()       Back in the project: Sprint 2 delivered, reported, approved and advanced.
 *   sprint3()       Sprint 3 delivered and reported as the epic's last report (`complete()` approves it).
 *   statuses(), recordResult()  The orchestrator records each experiment's statuses and its result: `local` from the
 *                   project's Sprint 3 grade, `dm` from the checkout's Sprint 2 grade the broker brings back.
 *   regression()    A defect escapes into the API ticket an hour after approval (a late regression).
 */
import { parseInput, sprintReportInput } from '../core/schemas'
import type { Workspace } from '../core/workspace'
import type { DraftOp, SprintReportInput } from '../shared/domain/api'
import type { PlanBundle, TicketContent } from '../shared/domain/bundle'
import type { CorrectionPlanView, CorrectionsResultView } from '../shared/domain/corrections'
import type { CrossRepoCorrectionResult } from '../shared/domain/crossRepoCorrections'
import type { RetroExperiment } from '../shared/domain/experiments'
import type { MetricReport } from '../shared/domain/metrics'
import type { CommandResult } from '../shared/desktop/api'
import type { SprintReportView } from '../shared/domain/views'
import type { Side, TwoRepoMachine } from './twoRepoMachine'

export const MIN = 60_000

export function fail(message: string): never {
  throw new Error(message)
}

/** The data of a `{ ok: true }` answer; anything else throws with its code. */
export function data<T>(result: CommandResult<T>, label: string): T {
  if (!result.ok) fail(`${label}: ${result.error.code} ${result.error.message}`)
  return result.data
}

/** What one attempt spends: active minutes and tokens as its host relays them. */
export interface Spend {
  minutes: number
  /** Tokens the host relays; null relays no token count (the span and effort still arrive). */
  tokens: number | null
  /** Relay nothing at all for this attempt (a host without telemetry): its time and tokens stay unknown. */
  unmeasured?: boolean
  /** Relay the token total twice (a first cumulative reading, then the final one), with the token categories. */
  cumulative?: number
  /** How the agent classifies the attempt's effort; default productive. */
  effort?: 'productive' | 'corrective'
  /** Reject the attempt with this reason instead of accepting it. */
  reject?: string
  /** The worker fails the attempt with this reason instead of submitting it. */
  fail?: string
  /** The reviewer accepts it with its first criterion unmet (a confirmed failure of a mandatory outcome). */
  unmet?: string
}

/** One attempt as recorded: the spend the host relayed, for reconciling the reads against. */
interface Recorded {
  attemptId: string
  ticketId: string
  sprintId: string
  spend: Spend
  accepted: boolean
}

export interface RunLedger {
  runId: string
  attempts: Recorded[]
  /** Orchestration overhead relayed per sprint: minutes and tokens. */
  overhead: { sprintId: string; minutes: number; tokens: number }[]
}

const iso = (ms: number): string => new Date(ms).toISOString()

function hostReports(attemptId: string, span: { start: number; end: number }, spend: Spend): MetricReport[] {
  const actor = `omp:worker-${attemptId.slice(-6)}`
  const usage = { coverage: 'self' as const, parentActor: null }
  const reports: MetricReport[] = [
    {
      metric: 'active_ms',
      unit: 'milliseconds',
      source: { kind: 'host', actor },
      measurement: { state: 'observed', value: span.end - span.start },
      accumulation: 'delta',
      eventId: `span-${attemptId}`,
      observedAt: iso(span.end),
      attributes: { spanStart: iso(span.start), activeBasis: 'requests_and_tools' },
      usage
    },
    {
      metric: 'corrective_effort_ms',
      unit: 'milliseconds',
      source: { kind: 'agent', actor },
      measurement: { state: 'observed', value: span.end - span.start },
      accumulation: 'event',
      eventId: `effort-${attemptId}`,
      observedAt: iso(span.end),
      ...(spend.effort === 'corrective' ? { attributes: { classification: 'corrective' }, cause: 'implementation' as const } : { attributes: { classification: 'productive', work: 'implementation' } })
    }
  ]
  if (spend.tokens === null) return reports
  const total = (value: number, sequence: number, at: number): MetricReport => ({ metric: 'tokens_total', unit: 'tokens', source: { kind: 'host', actor }, measurement: { state: 'observed', value }, accumulation: 'cumulative', sequence, observedAt: iso(at), usage })
  if (spend.cumulative === undefined) return [...reports, total(spend.tokens, 1, span.end)]
  const category = (metric: MetricReport['metric'], value: number): MetricReport => ({ ...total(value, 2, span.end), metric })
  return [
    ...reports,
    total(spend.cumulative, 1, span.start + (span.end - span.start) / 2),
    total(spend.tokens, 2, span.end),
    category('tokens_input', Math.round(spend.tokens * 0.7)),
    category('tokens_cached_input', Math.round(spend.tokens * 0.2)),
    category('tokens_output', Math.round(spend.tokens * 0.3)),
    category('tokens_reasoning', Math.round(spend.tokens * 0.08))
  ]
}

function ticketOf(bundle: PlanBundle, ticketId: string): TicketContent {
  return bundle.tickets.find((ticket) => ticket.id === ticketId) ?? fail(`no ticket ${ticketId}`)
}

/** A run being worked: the folder's side, the run's ledger and the plan revision it executes. */
interface RunOf {
  side: Side
  ledger: RunLedger
  bundle: PlanBundle
}

/** Claims `ticketId`, works `spend.minutes`, relays the usage (unless `unmeasured`), then submits and decides it, or fails it. */
export async function attempt({ side, ledger, bundle }: RunOf, ticketId: string, spend: Spend): Promise<string> {
  const { orchestrator, clock } = side
  const ticket = ticketOf(bundle, ticketId)
  const sprintId = bundle.sprints.find((sprint) => sprint.ticketIds.includes(ticketId))?.id ?? fail(`ticket ${ticketId} is in no sprint`)
  const claim = await orchestrator.claimTicket({ runId: ledger.runId, ticketId, worker: { label: 'omp worker' } })
  const start = clock.nowMs()
  const claimToken = claim.packet.claimToken ?? fail('a claim without a token')
  for (let left = spend.minutes; left > 0; left -= 10) {
    clock.advanceSeconds(Math.min(10, left) * 60)
    await orchestrator.heartbeatAttempt({ attemptId: claim.attempt.id, claimToken })
  }
  if (spend.unmeasured !== true) await orchestrator.recordAttemptMetrics({ attemptId: claim.attempt.id, reports: hostReports(claim.attempt.id, { start, end: clock.nowMs() }, spend) })
  if (spend.fail !== undefined) {
    await orchestrator.failAttempt({ attemptId: claim.attempt.id, claimToken, failure: { reason: spend.fail } })
    clock.advanceSeconds(60)
    ledger.attempts.push({ attemptId: claim.attempt.id, ticketId, sprintId, spend, accepted: false })
    return claim.attempt.id
  }
  const criteria = ticket.acceptanceCriteria.map((criterion) => ({ criterionId: criterion.id, met: true, note: 'shown by its test' }))
  // An acceptance node names the sprint's squashed commit on the epic branch the run bound (the checked-out branch).
  const increment = ticket.kind === 'acceptance' ? { branch: side.repo.git('branch', '--show-current'), commit: side.repo.commit(`Land ${ticket.title}`) } : undefined
  await orchestrator.submitAttempt({
    ...(increment === undefined ? {} : { increment }),
    attemptId: claim.attempt.id,
    claimToken,
    outputs: { summary: `Delivered ${ticket.title}.`, commits: ['a'.repeat(40)], changedFiles: ['src/checkout.ts'], branch: `checkout-${ticketId.slice(-4)}` },
    evidence: { checks: [{ name: 'unit tests', status: 'passed', detail: 'npx vitest run src/checkout.test.ts' }], criteria, notes: '' }
  })
  clock.advanceSeconds(60)
  const verdict = criteria.map((entry, index) => (index === 0 && spend.unmet !== undefined ? { ...entry, met: false, note: spend.unmet } : { ...entry, note: 'verified' }))
  if (spend.reject === undefined) await orchestrator.acceptAttempt({ attemptId: claim.attempt.id, notes: 'reviewed', criteria: verdict })
  else await orchestrator.rejectAttempt({ attemptId: claim.attempt.id, reasons: [spend.reject] })
  clock.advanceSeconds(60)
  ledger.attempts.push({ attemptId: claim.attempt.id, ticketId, sprintId, spend, accepted: spend.reject === undefined })
  return claim.attempt.id
}

/** Orchestration overhead no attempt owns, relayed by the host into the sprint's bucket. */
async function overhead(side: Side, ledger: RunLedger, sprintId: string, spent: { minutes: number; tokens: number }): Promise<void> {
  const { minutes, tokens } = spent
  const end = side.clock.nowMs()
  const actor = 'omp:orchestrator'
  const usage = { coverage: 'self' as const, parentActor: null }
  await side.orchestrator.recordRunMetrics({
    runId: ledger.runId,
    sprintId,
    overhead: 'orchestration',
    reports: [
      {
        metric: 'active_ms',
        unit: 'milliseconds',
        source: { kind: 'host', actor },
        measurement: { state: 'observed', value: minutes * MIN },
        accumulation: 'delta',
        eventId: `orchestration-${end}`,
        observedAt: iso(end),
        attributes: { spanStart: iso(end - minutes * MIN), role: 'orchestrator', handle: 'orchestrator-main' },
        usage
      },
      { metric: 'tokens_total', unit: 'tokens', source: { kind: 'host', actor }, measurement: { state: 'observed', value: tokens }, accumulation: 'delta', eventId: `orchestration-tokens-${end}`, observedAt: iso(end), usage }
    ]
  })
  ledger.overhead.push({ sprintId, minutes, tokens })
  side.clock.advanceSeconds(60)
}

/**
 * Points every acceptance node of the draft at each work ticket of its sprint (`covers`), as a planner does: criteria
 * that cover a ticket stay, a placeholder without covers goes, and a work ticket nothing covers gets a criterion.
 */
async function coverNodes(orchestrator: Workspace, epicId: string): Promise<number> {
  const draft = await orchestrator.getPlan({ epicId, view: 'draft' })
  const byId = new Map(draft.bundle.tickets.map((ticket) => [ticket.id, ticket]))
  const ops: DraftOp[] = draft.bundle.sprints.flatMap((sprint) => {
    const tickets = sprint.ticketIds.map((id) => byId.get(id) ?? fail(`no ticket ${id}`))
    const work = tickets.filter((ticket) => ticket.kind !== 'acceptance')
    return tickets.flatMap((node): DraftOp[] => {
      if (node.kind !== 'acceptance') return []
      const kept = node.acceptanceCriteria.flatMap(({ text, covers }) => (typeof covers === 'string' ? [{ text, covers }] : []))
      const missing = work.filter((ticket) => !kept.some((criterion) => criterion.covers === ticket.id))
      if (missing.length === 0 && kept.length === node.acceptanceCriteria.length) return []
      const added = missing.map((ticket) => ({ text: `${ticket.title} is verified`, covers: ticket.id }))
      return [{ op: 'update_ticket', ticket: node.id, patch: { acceptanceCriteria: [...kept, ...added] } }]
    })
  })
  if (ops.length === 0) return (await orchestrator.getPlan({ epicId, view: 'draft' })).draftRevision ?? fail('no draft')
  return (await orchestrator.updatePlanDraft({ epicId, ops })).draftRevision
}

/** The person presses Save on the draft (desktop session); returns the saved bundle and revision. */
async function save(side: Side, epicId: string, expectedDraftRevision: number): Promise<{ bundle: PlanBundle; revisionId: string }> {
  const saved = await side.desktop.savePlan({ epicId, expectedDraftRevision })
  if (saved.status !== 'saved') fail(`the plan was not saved: ${saved.status}`)
  const plan = await side.desktop.getPlan({ epicId, view: 'saved' })
  return { bundle: plan.bundle, revisionId: plan.revisionId ?? fail('a saved plan without a revision') }
}

const budget = { tokens: 50_000, activeMs: 30 * MIN }
const smallBudget = { tokens: 20_000, activeMs: 15 * MIN }

export interface Sprint1 {
  epicId: string
  ledger: RunLedger
  bundle: PlanBundle
  sprintId: string
  tickets: { api: string; page: string; docs: string; node: string }
  /** page's rejected attempt, then its accepted retry. */
  pageAttempts: [string, string]
  apiAttempt: string
}

/** Sprint 1 of "Checkout flow" planned, saved, run and delivered (see the module comment for the spend). */
export async function sprint1(m: TwoRepoMachine): Promise<Sprint1> {
  const p = m.project
  await p.desktop.initializeRepository({ name: 'shop', keyPrefix: 'SHOP' })
  const epic = await p.orchestrator.createEpic({ title: 'Checkout flow', intent: 'Customers can pay for their cart.', successCriteria: ['A customer can check out and pay'] })
  const added = await p.orchestrator.updatePlanDraft({
    epicId: epic.id,
    ops: [
      { op: 'add_ticket', ref: 'api', sprint: '1', ticket: { title: 'Build the checkout API', body: 'POST /checkout takes the cart and returns the payment intent.', size: 'medium', acceptanceCriteria: ['The API answers', 'It is tested'], budget } },
      { op: 'add_ticket', ref: 'page', sprint: '1', ticket: { title: 'Build the checkout page', body: 'The page validates the card number before it calls the API.', size: 'medium', acceptanceCriteria: ['The page submits a valid card'], budget } },
      { op: 'add_ticket', ref: 'docs', sprint: '1', ticket: { title: 'Document the checkout', body: 'Describe the checkout flow in README.md.', size: 'small', acceptanceCriteria: ['The README explains checkout'], budget: smallBudget } }
    ]
  })
  const revision = await coverNodes(p.orchestrator, epic.id)
  p.clock.advanceSeconds(60)
  const { bundle } = await save(p, epic.id, revision)
  const ref = (name: string): string => added.refMap[name] ?? fail(`no ref ${name}`)
  const sprintId = bundle.sprints[0]?.id ?? fail('no sprint')
  const node = bundle.tickets.find((ticket) => ticket.kind === 'acceptance' && bundle.sprints[0]?.ticketIds.includes(ticket.id))?.id ?? fail('no acceptance node')
  // The budgets froze with the Save; the first claim comes later, so they are pre-dispatch baselines.
  p.clock.advanceSeconds(60)
  p.repo.branch('epic/checkout-flow')
  const run = await p.orchestrator.startRun({ epicId: epic.id })
  const ledger: RunLedger = { runId: run.id, attempts: [], overhead: [] }
  const worked: RunOf = { side: p, ledger, bundle }
  const apiAttempt = await attempt(worked, ref('api'), { minutes: 20, tokens: 30_000, cumulative: 18_000 })
  const rejected = await attempt(worked, ref('page'), { minutes: 10, tokens: 12_000, reject: 'The page sends an unvalidated card number to the API.' })
  const retried = await attempt(worked, ref('page'), { minutes: 15, tokens: 16_000, effort: 'corrective' })
  await attempt(worked, ref('docs'), { minutes: 10, tokens: 4_000 })
  await attempt(worked, node, { minutes: 5, tokens: 6_000 })
  await overhead(p, ledger, sprintId, { minutes: 8, tokens: 5_000 })
  // The person rates the sprint (S), shared with its tickets.
  await p.desktop.recordHumanFeedback({ target: { epicId: epic.id, sprintId, runId: run.id }, feedback: { kind: 'rating', value: 4, sharedWithTickets: true } })
  p.clock.advanceSeconds(60)
  return { epicId: epic.id, ledger, bundle, sprintId, tickets: { api: ref('api'), page: ref('page'), docs: ref('docs'), node }, pageAttempts: [rejected, retried], apiAttempt }
}

const DELIVERY = { measure: 'A.delivered', unit: 'count', comparator: 'at_least', threshold: 1 }

/** One experiment of the Sprint 1 retro, drawn from its scorecard. */
function experiment(s: Sprint1, patch: Record<string, unknown>): Record<string, unknown> {
  return {
    source: { subject: { level: 'sprint', id: s.sprintId } },
    concern: 'plan_context',
    issue: {
      summary: 'Sprint 1 spent 73,000 tokens and 68 active minutes; the page took a rejected attempt and a retry.',
      evidence: [{ kind: 'run', id: s.ledger.runId }, { kind: 'attempt', id: s.pageAttempts[0], detail: 'rejected attempt' }]
    },
    hypothesis: 'Hypothesis: the page ticket lacked the card validation rules, so its first attempt was rejected and retried.',
    expectedChange: { direction: 'decrease', amount: 20, unit: 'percent' },
    window: { basis: 'sprints', count: 1 },
    guardrails: [DELIVERY, { measure: 'P.regressions', unit: 'count', comparator: 'at_most', threshold: 0 }],
    ...patch
  }
}

export interface Report1 {
  report: SprintReportView
  xp: { local: RetroExperiment; dm: RetroExperiment }
}

/** The Sprint 1 report with its two experiments; `final` also states the epic outcome (a one-sprint epic's last report). */
export async function report1(m: TwoRepoMachine, s: Sprint1, options: { final?: boolean } = {}): Promise<Report1> {
  const p = m.project
  const experiments = [
    experiment(s, {
      destination: { kind: 'source_repository' },
      baseline: { measure: 'T.actual_ms', unit: 'milliseconds' },
      proposedWork: [{ title: 'Write the card validation rules into the page ticket template', body: 'Add the card number, expiry and CVC rules to docs/checkout-rules.md and link it from every checkout ticket body.', size: 'small' }]
    }),
    experiment(s, {
      concern: 'orchestration_tooling',
      hypothesis: 'Hypothesis: the claim packet omits the rejected attempt\'s review notes, so the retry re-discovers them and spends extra tokens.',
      destination: { kind: 'darkmechanicus_source' },
      baseline: { measure: 'K.actual_tokens', unit: 'tokens' },
      proposedWork: [{ title: 'Carry review notes into the retry packet', body: 'Add the rejected attempt\'s review reasons to the context section of the next claim packet of the same ticket.', size: 'small' }]
    })
  ]
  const outcome = options.final === true ? { epicOutcome: await epicOutcome(p, s.epicId, 'Customers can check out and pay.') } : {}
  const input = {
    summary: 'Sprint 1: the API, the page (after one rejected attempt) and the docs landed.',
    retro: { wentWell: ['The API landed on its first attempt'], wentPoorly: ['The page needed a retry'], experiments },
    ...outcome
  }
  // Parsed the way the command layer parses it, so the experiments read as the typed input they are.
  const report = await p.orchestrator.submitSprintReport({ runId: s.ledger.runId, sprintId: s.sprintId, report: parseInput(sprintReportInput, input, 'report') as SprintReportInput })
  p.clock.advanceSeconds(60)
  const [local, dm] = report.report.retro?.experiments ?? []
  return { report, xp: { local: local ?? fail('no local experiment'), dm: dm ?? fail('no dm experiment') } }
}

interface LocalCorrection {
  preview: CorrectionPlanView
  created: CorrectionsResultView
  /** Sprint 2: the corrective sprint create_corrections added (its work, Fireguard ticket and node), plus two medium tickets. */
  sprint2Id: string
  /** Sprint 3: measured after the work landed; like Sprint 1 and 2, two medium tickets and a small one. */
  sprint3Id: string
  revisionId: string
  bundle: PlanBundle
}

/**
 * create_corrections adds `local`'s work as a new Sprint 2; then the person's own steps: two medium tickets beside it
 * and a Sprint 3, so every sprint holds the same planned sizes (two medium, one small) and the Metrics dashboard can
 * compare each sprint with the one before; Save, adopt, approve Sprint 1, advance. `beforeSave` sees the draft as created.
 */
export async function correctLocal(m: TwoRepoMachine, s: Sprint1, r: Report1, beforeSave?: (created: CorrectionsResultView) => Promise<void>): Promise<LocalCorrection> {
  const p = m.project
  const preview = await p.orchestrator.previewCorrections({ reportId: r.report.id, experimentIds: [r.xp.local.id] })
  const created = await p.orchestrator.createCorrections({ reportId: r.report.id, experimentIds: [r.xp.local.id], expectedDraftRevision: preview.draftRevision })
  p.clock.advanceSeconds(60)
  if (beforeSave !== undefined) await beforeSave(created)
  const sprint2Id = created.target.sprintId ?? fail('create_corrections named no sprint')
  const ticket = (sprint: string, ref: string, size: 'medium' | 'small', [title, body]: [string, string]): DraftOp => ({
    op: 'add_ticket',
    ref,
    sprint,
    ticket: { title, body, size, acceptanceCriteria: [`${title} works`], budget: size === 'small' ? smallBudget : budget }
  })
  const added = await p.orchestrator.updatePlanDraft({
    epicId: s.epicId,
    ops: [
      ticket(sprint2Id, 'harden', 'medium', ['Harden the checkout', 'Retry a failed payment once and show the reason.']),
      ticket(sprint2Id, 'cards', 'medium', ['Save cards for later', 'Store a tokenized card for a returning customer.']),
      { op: 'add_sprint', ref: 's3', sprint: { goal: 'Refunds, invoices and receipts, measured after the card rules landed' } },
      ticket('s3', 'refunds', 'medium', ['Refund a payment', 'Refund a captured payment in full from the order page.']),
      ticket('s3', 'invoices', 'medium', ['Issue invoices', 'Attach a PDF invoice to every paid order.']),
      ticket('s3', 'receipt', 'small', ['Email the receipt', 'Send the receipt after a successful payment.'])
    ]
  })
  const sprint3Id = (await p.orchestrator.getPlan({ epicId: s.epicId, view: 'draft' })).bundle.sprints.find((sprint) => sprint.ticketIds.includes(added.refMap['refunds'] ?? ''))?.id ?? fail('no sprint 3')
  const { bundle, revisionId } = await save(p, s.epicId, await coverNodes(p.orchestrator, s.epicId))
  await p.desktop.adoptRevision({ runId: s.ledger.runId, revisionId })
  await p.desktop.approveCheckpoint({ runId: s.ledger.runId, reportId: r.report.id })
  await p.orchestrator.advanceSprint({ runId: s.ledger.runId })
  p.clock.advanceSeconds(60)
  return { preview, created, sprint2Id, sprint3Id, revisionId, bundle }
}

interface DmRequest {
  key: string
  created: CrossRepoCorrectionResult
  epicId: string
}

/** The person chooses the checkout; the broker creates `dm`'s correction epic there. */
export async function requestDm(m: TwoRepoMachine, r: Report1): Promise<DmRequest> {
  // The person sets the checkout up (a fresh one has no project record) and chooses it.
  if (!m.dm.desktop.isInitialized()) await m.dm.desktop.initializeRepository({ name: 'DarkMechanicus', keyPrefix: 'DM' })
  m.chooseCheckout()
  const input = { reportId: r.report.id, experimentId: r.xp.dm.id }
  const preview = data(await m.broker.previewCrossRepoCorrection(m.project.path, input), 'preview')
  const created = data(await m.broker.createCrossRepoCorrection(m.project.path, { ...input, expectedTargetProjectId: preview.target?.projectId ?? fail('no target project') }), 'create')
  m.project.clock.advanceSeconds(60)
  return { key: created.link.key, created, epicId: created.target?.epicId ?? fail('no target epic') }
}

interface DmWork {
  ledger: RunLedger
  bundle: PlanBundle
  sprintIds: [string, string]
  reports: [SprintReportView, SprintReportView]
}

/**
 * The correction epic worked in the checkout the normal way: the person adds a Sprint 2 measured after the work lands
 * (two medium tickets and a small one, sized and budgeted like the project's Sprint 1) and saves; the checkout's own run
 * delivers Sprint 1 (the corrective ticket, the Fireguard ticket, the node: 8 min, 7,000 tokens each), reports it, the
 * person approves, and Sprint 2 (12 min and 11,000 tokens per medium ticket, 6 min and 6,000 for the small one).
 */
export async function workDm(m: TwoRepoMachine, request: DmRequest): Promise<DmWork> {
  const d = m.dm
  const epicId = request.epicId
  const measured = (n: number, size: 'medium' | 'small'): DraftOp => ({
    op: 'add_ticket',
    ref: `m${n}`,
    sprint: 's2',
    ticket: { title: `Retry packet change ${n}`, body: `Ship retry packet change ${n} with its tests.`, size, acceptanceCriteria: ['It works'], budget: size === 'small' ? smallBudget : budget }
  })
  await d.orchestrator.updatePlanDraft({ epicId, ops: [{ op: 'add_sprint', ref: 's2', sprint: { goal: 'Measured after the retry packet change' } }, measured(1, 'medium'), measured(2, 'medium'), measured(3, 'small')] })
  const revision = await coverNodes(d.orchestrator, epicId)
  const { bundle } = await save(d, epicId, revision)
  const [first, second] = [...bundle.sprints].sort((a, b) => a.ordinal - b.ordinal)
  const sprintIds: [string, string] = [first?.id ?? fail('no sprint 1'), second?.id ?? fail('no sprint 2')]
  d.repo.branch('epic/retry-review-notes')
  const run = await d.orchestrator.startRun({ epicId })
  const ledger: RunLedger = { runId: run.id, attempts: [], overhead: [] }
  const worked: RunOf = { side: d, ledger, bundle }
  await deliverSprint(worked, sprintIds[0], () => ({ minutes: 8, tokens: 7_000 }))
  const report1 = await d.orchestrator.submitSprintReport({ runId: run.id, sprintId: sprintIds[0], report: { summary: 'The retry packet carries review notes.', retro: { wentWell: ['Corrective work landed'] } } })
  await d.desktop.approveCheckpoint({ runId: run.id, reportId: report1.id })
  await d.orchestrator.advanceSprint({ runId: run.id })
  d.clock.advanceSeconds(60)
  await deliverSprint(worked, sprintIds[1], (ticket) => (ticket.kind === 'acceptance' ? { minutes: 4, tokens: 4_000 } : ticket.size === 'small' ? { minutes: 6, tokens: 6_000 } : { minutes: 12, tokens: 11_000 }))
  const report2 = await d.orchestrator.submitSprintReport({
    runId: run.id,
    sprintId: sprintIds[1],
    report: { summary: 'Measured after the retry packet change.', retro: { wentWell: ['Retries carried their review notes'] }, epicOutcome: await epicOutcome(d, epicId, 'Retries carry their review notes.') }
  })
  d.clock.advanceSeconds(60)
  return { ledger, bundle, sprintIds, reports: [report1, report2] }
}

/** Delivers a sprint: its work tickets in plan order, then its acceptance node, each as `spendOf` says. */
async function deliverSprint(run: RunOf, sprintId: string, spendOf: (ticket: TicketContent) => Spend): Promise<void> {
  const tickets = (run.bundle.sprints.find((sprint) => sprint.id === sprintId)?.ticketIds ?? fail(`no sprint ${sprintId}`)).map((id) => ticketOf(run.bundle, id))
  for (const ticket of [...tickets.filter((entry) => entry.kind !== 'acceptance'), ...tickets.filter((entry) => entry.kind === 'acceptance')]) {
    await attempt(run, ticket.id, spendOf(ticket))
  }
}

/**
 * Sprint 2 in the project: the corrective ticket and the Fireguard ticket (6 min, 5,000 tokens each), harden and cards
 * (14 min, 15,000 tokens each), the node (4 min, 4,000); reported, approved and advanced.
 */
export async function sprint2(m: TwoRepoMachine, s: Sprint1, c: LocalCorrection): Promise<SprintReportView> {
  const p = m.project
  await deliverSprint({ side: p, ledger: s.ledger, bundle: c.bundle }, c.sprint2Id, (ticket) => (ticket.kind === 'acceptance' ? { minutes: 4, tokens: 4_000 } : ticket.size === 'medium' ? { minutes: 14, tokens: 15_000 } : { minutes: 6, tokens: 5_000 }))
  const report = await p.orchestrator.submitSprintReport({ runId: s.ledger.runId, sprintId: c.sprint2Id, report: { summary: 'Sprint 2: the card rules and their Fireguard grade.', retro: { wentWell: ['The card rules landed'] } } })
  p.clock.advanceSeconds(60)
  await complete(p, s.ledger.runId, report.id)
  return report
}

/**
 * Sprint 3 in the project, measured after the card rules landed: refunds and invoices (14 min, 15,000 tokens each),
 * receipt (8 min, 6,000), the node (4 min, 4,000), orchestration (5 min, 3,000); reported as the epic's last.
 */
export async function sprint3(m: TwoRepoMachine, s: Sprint1, c: LocalCorrection): Promise<SprintReportView> {
  const p = m.project
  await deliverSprint({ side: p, ledger: s.ledger, bundle: c.bundle }, c.sprint3Id, (ticket) => (ticket.kind === 'acceptance' ? { minutes: 4, tokens: 4_000 } : ticket.size === 'small' ? { minutes: 8, tokens: 6_000 } : { minutes: 14, tokens: 15_000 }))
  await overhead(p, s.ledger, c.sprint3Id, { minutes: 5, tokens: 3_000 })
  const report = await p.orchestrator.submitSprintReport({
    runId: s.ledger.runId,
    sprintId: c.sprint3Id,
    report: { summary: 'Sprint 3: refunds, invoices and receipts, no retry.', retro: { wentWell: ['No retry this sprint'] }, epicOutcome: await epicOutcome(p, s.epicId, 'Customers can check out and pay.') }
  })
  p.clock.advanceSeconds(60)
  return report
}

/** The epic outcome its last report states: every success criterion met. */
async function epicOutcome(side: Side, epicId: string, summary: string): Promise<{ summary: string; successCriteria: { criterionId: string; met: boolean; note: string }[] }> {
  const epic = await side.desktop.getEpic({ epicId })
  return { summary, successCriteria: epic.successCriteria.map((criterion) => ({ criterionId: criterion.id, met: true, note: 'shown by the sprint reports' })) }
}

/** The person approves the epic's last report and the run advances: the epic completes. */
export async function complete(side: Side, runId: string, reportId: string): Promise<void> {
  await side.desktop.approveCheckpoint({ runId, reportId })
  await side.orchestrator.advanceSprint({ runId })
  side.clock.advanceSeconds(60)
}

/** A result read from a sprint report's frozen sprint grade (a report of `side`'s project or, carried, of the target's). */
export async function recordResult(side: Side, experiment: RetroExperiment, assessment: { reportId: string; assessmentId: string }, note: string): Promise<void> {
  await side.orchestrator.recordExperimentEvent({ experimentId: experiment.id, event: { kind: 'result', result: { assessment, unit: experiment.baseline.unit }, note } })
  side.clock.advanceSeconds(60)
}

/** An experiment's statuses from selection to completion, as the orchestrator records them. */
export async function statuses(side: Side, experimentId: string, plannedIn: string): Promise<void> {
  const notes: Record<string, string> = { selected: 'Chosen at the checkpoint', scheduled: `Planned in ${plannedIn}`, in_progress: 'Its work is running', completed: 'Its work landed' }
  for (const status of ['selected', 'scheduled', 'in_progress', 'completed'] as const) {
    await side.orchestrator.recordExperimentEvent({ experimentId, event: { kind: 'status', status, note: notes[status] } })
    side.clock.advanceSeconds(60)
  }
}

/** A high-severity defect found after approval, attributed to the API ticket's attempt (a late regression). */
export async function regression(m: TwoRepoMachine, s: Sprint1): Promise<void> {
  const p = m.project
  p.clock.advanceSeconds(3_600)
  await p.desktop.recordEscapedDefects({
    target: { epicId: s.epicId, runId: s.ledger.runId },
    records: [
      {
        defectEvent: 'report',
        severity: 'high',
        attribution: 'attributed',
        discoveryPhase: 'after_epic',
        defectKey: 'SHOP-BUG-1',
        evidence: [
          { kind: 'commit', id: 'a'.repeat(40), detail: 'source build' },
          { kind: 'ticket', id: s.tickets.api, detail: 'origin' },
          { kind: 'attempt', id: s.apiAttempt, detail: 'origin' }
        ]
      }
    ]
  })
  p.clock.advanceSeconds(60)
}
