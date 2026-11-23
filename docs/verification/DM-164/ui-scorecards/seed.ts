// DM-164 sprint acceptance (c13-c16, c19, c23): seeds one isolated root for the built app, one variant per run.
//   loop     the DM-193 SPACE loop on two real repositories (shop + a marker Dark Mechanicus checkout), every step to
//            the completed epic (c13 ticket Scorecard tabs, c19 Metrics dashboard)
//   regress  the same loop, then a high-severity defect an hour after the last approval (c15 reassessment)
//   report1  Sprint 1 delivered and reported with one experiment drawn from the rank-1 measured finding, the
//            checkpoint awaiting approval; no correction created yet (c16, c23)
//   failed   "Payment receipts": every feature ticket accepted, the Sprint 2 acceptance node accepted with an unmet
//            criterion, so the integrated outcome fails (c14)
// Writes <root>/fixture.json: folders, ids, the spend ledger and every MCP read (the `reader` role) the screens are
// compared against. Run from the worktree root:
//   node --import ./docs/verification/DM-193/raw-hooks.mjs --import tsx docs/verification/DM-164/ui-scorecards/seed.ts <root> <variant>
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseInput, sprintReportInput } from '../../../../src/core/schemas'
import type { Workspace } from '../../../../src/core/workspace'
import type { DraftOp, SprintReportInput } from '../../../../src/shared/domain/api'
import { callTool, withServer } from '../../../../src/test/mcpHarness'
import { attempt, complete, correctLocal, fail, MIN, regression, report1, requestDm, type RunLedger, sprint1, sprint2, sprint3, workDm } from '../../../../src/test/spaceLoop'
import { type Side, type TwoRepoMachine, twoRepoMachine } from '../../../../src/test/twoRepoMachine'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const [rootArg, variant] = process.argv.slice(2)
const VARIANTS = ['loop', 'regress', 'report1', 'failed']
if (rootArg === undefined || variant === undefined || !VARIANTS.includes(variant)) throw new Error(`usage: seed.ts <root> <${VARIANTS.join('|')}>`)
const root = resolve(rootArg)
const buildCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
mkdirSync(root, { recursive: true })

type Reads = Record<string, unknown>

/** Every MCP read through a `reader` session of `side`; a refused read is kept as its error, never dropped. */
async function mcpReads(m: TwoRepoMachine, side: Side, asks: [string, string, Record<string, unknown>][]): Promise<Reads> {
  const reads: Reads = {}
  await withServer(m.mcp(side, 'reader'), async (rig) => {
    for (const [key, tool, args] of asks) {
      const outcome = await callTool(rig, tool, args)
      reads[key] = outcome.isError ? { error: outcome.payload ?? outcome.text, tool, args } : outcome.payload
    }
  })
  return reads
}

/** The approval records of a run, read from the folder's database (the binding of each approval to its report). */
function approvals(side: Side, runId: string): unknown[] {
  return side.desktop.ctx().db.all('SELECT id, run_id, sprint_id, report_id, report_hash, action, issued_by, issued_at, consumed_at FROM approvals WHERE run_id = ? ORDER BY issued_at', runId)
}

function write(fixture: Record<string, unknown>): void {
  writeFileSync(join(root, 'fixture.json'), `${JSON.stringify({ buildCommit, variant, root, ...fixture }, null, 2)}\n`)
  console.log(`seeded ${root} (${variant})`)
}

const machineDirs = (m: TwoRepoMachine) => ({ userData: m.userData, dmHome: m.dmHome, home: m.home })

/** The DM-193 loop: Sprint 1, its report, both corrections, Sprint 2 and 3, the epic completed. */
async function loop(m: TwoRepoMachine, withRegression: boolean): Promise<void> {
  const s = await sprint1(m)
  const r = await report1(m, s)
  const c = await correctLocal(m, s, r)
  const req = await requestDm(m, r)
  const w = await workDm(m, req)
  await complete(m.dm, w.ledger.runId, w.reports[1].id)
  const rep2 = await sprint2(m, s, c)
  const rep3 = await sprint3(m, s, c)
  await complete(m.project, s.ledger.runId, rep3.id)
  const { runId } = s.ledger
  const asks: [string, string, Record<string, unknown>][] = [
    ...Object.entries(s.tickets).map(([name, ticketId]): [string, string, Record<string, unknown>] => [`ticket:${name}`, 'get_ticket_grade', { runId, ticketId }]),
    ['sprint', 'get_sprint_grade', { runId, sprintId: s.sprintId }],
    ['epic', 'get_epic_grade', { epicId: s.epicId }],
    ['report1', 'get_report_scorecard', { reportId: r.report.id, reportRevision: r.report.reportRevision }],
    ['metrics', 'get_metrics_summary', {}]
  ]
  let regressedAt: string | null = null
  const before = withRegression ? await mcpReads(m, m.project, asks) : null
  if (withRegression) {
    regressedAt = m.project.clock.nowIso()
    await regression(m, s)
    asks.push(['reassess1', 'reassess_report_scorecard', { reportId: r.report.id }])
  }
  const reads = await mcpReads(m, m.project, asks)
  m.chooseCheckout()
  write({
    ...machineDirs(m),
    project: { path: m.project.path, name: m.project.name, epicTitle: 'Checkout flow', epicId: s.epicId, runId, sprintId: s.sprintId, tickets: s.tickets, pageAttempts: s.pageAttempts, reports: [r.report.id, rep2.id, rep3.id], report1Revision: r.report.reportRevision },
    dm: { path: m.dm.path, epicId: req.epicId, runId: w.ledger.runId },
    ledger: s.ledger,
    approvals: approvals(m.project, runId),
    regressedAt,
    beforeRegression: before,
    unexpected: m.unexpected,
    reads
  })
}

/**
 * Sprint 1 delivered and reported; the checkpoint awaits the person (no correction created, nothing approved). The
 * report's one experiment is drawn from the scorecard's rank-1 finding (corrective concentration on the page ticket,
 * E.corrective_ms), so the Improvement tab links it to that measured finding.
 */
async function stoppedAtReport1(m: TwoRepoMachine): Promise<void> {
  const s = await sprint1(m)
  const p = m.project
  const experiment = {
    source: { subject: { level: 'ticket', id: s.tickets.page } },
    concern: 'plan_context',
    issue: {
      summary: 'The page ticket spent 15 min of corrective effort, all of the sprint\'s, after one rejected attempt.',
      evidence: [{ kind: 'attempt', id: s.pageAttempts[0], detail: 'rejected attempt' }]
    },
    hypothesis: 'Hypothesis: the page ticket lacked the card validation rules, so its first attempt was rejected and retried.',
    destination: { kind: 'source_repository' },
    proposedWork: [{ title: 'Write the card validation rules into the page ticket template', body: 'Add the card number, expiry and CVC rules to docs/checkout-rules.md and link it from every checkout ticket body.', size: 'small' }],
    baseline: { measure: 'E.corrective_ms', unit: 'milliseconds' },
    expectedChange: { direction: 'decrease', amount: 50, unit: 'percent' },
    guardrails: [{ measure: 'A.delivered', unit: 'count', comparator: 'at_least', threshold: 1 }],
    window: { basis: 'sprints', count: 1 }
  }
  const input = { summary: 'Sprint 1: the API, the page (after one rejected attempt) and the docs landed.', retro: { wentWell: ['The API landed on its first attempt'], wentPoorly: ['The page needed a retry'], experiments: [experiment] } }
  const report = await p.orchestrator.submitSprintReport({ runId: s.ledger.runId, sprintId: s.sprintId, report: parseInput(sprintReportInput, input, 'report') as SprintReportInput })
  p.clock.advanceSeconds(60)
  const xp = report.report.retro?.experiments?.[0] ?? fail('no experiment')
  const r = { report, xp: { local: xp } }
  const { runId } = s.ledger
  const reads = await mcpReads(m, m.project, [
    ...Object.entries(s.tickets).map(([name, ticketId]): [string, string, Record<string, unknown>] => [`ticket:${name}`, 'get_ticket_grade', { runId, ticketId }]),
    ['sprint', 'get_sprint_grade', { runId, sprintId: s.sprintId }],
    ['report1', 'get_report_scorecard', { reportId: r.report.id, reportRevision: r.report.reportRevision }],
    ['findings', 'get_retro_findings', { reportId: r.report.id, reportRevision: r.report.reportRevision }],
    ['experimentLocal', 'get_experiment', { experimentId: r.xp.local.id }],
    ['run', 'get_run', { epicId: s.epicId }],
    ['epic', 'get_epic', { epicId: s.epicId }],
    ['draft', 'get_plan', { epicId: s.epicId, view: 'draft' }],
    ['saved', 'get_plan', { epicId: s.epicId, view: 'saved' }],
    ['baselines', 'get_planned_baselines', { epicId: s.epicId, runId }],
    ['signals', 'get_space_signals', { level: 'sprint', id: s.sprintId, runId }],
    ['signalsApi', 'get_space_signals', { level: 'ticket', id: s.tickets.api, runId }]
  ])
  write({
    ...machineDirs(m),
    project: { path: m.project.path, name: m.project.name, epicTitle: 'Checkout flow', epicId: s.epicId, runId, sprintId: s.sprintId, tickets: s.tickets, pageAttempts: s.pageAttempts, reportId: r.report.id, reportRevision: r.report.reportRevision, experiments: { local: r.xp.local.id } },
    ledger: s.ledger,
    runs: m.project.desktop.ctx().db.all('SELECT id, number, state, revision_id, active_sprint_id, created_at, started_at, updated_at, ended_at, (SELECT COUNT(*) FROM attempts a WHERE a.run_id = runs.id) AS attempts FROM runs WHERE epic_id = ? ORDER BY number', s.epicId),
    unexpected: m.unexpected,
    reads
  })
}

// ---------------------------------------------------------------------------------------------------------------
// "Payment receipts": feature tickets pass, the integrated outcome fails

/** As spaceLoop's `coverNodes`: every acceptance node covers each work ticket of its sprint. */
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

async function failedIntegration(m: TwoRepoMachine): Promise<void> {
  const p = m.project
  await p.desktop.initializeRepository({ name: 'shop', keyPrefix: 'SHOP' })
  const epic = await p.orchestrator.createEpic({ title: 'Payment receipts', intent: 'Every paid order gets a receipt.', successCriteria: ['A paid order sends its receipt'] })
  const budget = { tokens: 50_000, activeMs: 30 * MIN }
  const small = { tokens: 20_000, activeMs: 15 * MIN }
  const added = await p.orchestrator.updatePlanDraft({
    epicId: epic.id,
    ops: [
      { op: 'add_sprint', ref: 's2', sprint: { goal: 'Send the receipt' } },
      { op: 'add_ticket', ref: 'render', sprint: '1', ticket: { title: 'Render the receipt', body: 'Render an HTML receipt for a paid order.', size: 'medium', acceptanceCriteria: ['The receipt shows every line'], budget } },
      { op: 'add_ticket', ref: 'store', sprint: '1', ticket: { title: 'Store receipts', body: 'Keep each rendered receipt with its order.', size: 'small', acceptanceCriteria: ['A receipt is stored once'], budget: small } },
      { op: 'add_ticket', ref: 'email', sprint: 's2', ticket: { title: 'Email the receipt', body: 'Send the stored receipt to the customer.', size: 'medium', acceptanceCriteria: ['The mailer sends it'], budget } },
      { op: 'add_ticket', ref: 'pdf', sprint: 's2', ticket: { title: 'Attach a PDF copy', body: 'Attach the receipt as a PDF.', size: 'small', acceptanceCriteria: ['The PDF opens'], budget: small } }
    ]
  })
  const revision = await coverNodes(p.orchestrator, epic.id)
  p.clock.advanceSeconds(60)
  const saved = await p.desktop.savePlan({ epicId: epic.id, expectedDraftRevision: revision })
  if (saved.status !== 'saved') fail(`not saved: ${saved.status}`)
  const bundle = (await p.desktop.getPlan({ epicId: epic.id, view: 'saved' })).bundle
  const sprints = [...bundle.sprints].sort((a, b) => a.ordinal - b.ordinal)
  const ref = (name: string): string => added.refMap[name] ?? fail(`no ref ${name}`)
  const nodeOf = (n: number): string => bundle.tickets.find((ticket) => ticket.kind === 'acceptance' && sprints[n]?.ticketIds.includes(ticket.id))?.id ?? fail(`no node in sprint ${n + 1}`)
  p.clock.advanceSeconds(60)
  p.repo.branch('epic/payment-receipts')
  const run = await p.orchestrator.startRun({ epicId: epic.id })
  const ledger: RunLedger = { runId: run.id, attempts: [], overhead: [] }
  const worked = { side: p, ledger, bundle }
  await attempt(worked, ref('render'), { minutes: 20, tokens: 25_000 })
  await attempt(worked, ref('store'), { minutes: 10, tokens: 8_000 })
  await attempt(worked, nodeOf(0), { minutes: 5, tokens: 4_000 })
  const reportA = await p.orchestrator.submitSprintReport({ runId: run.id, sprintId: sprints[0]?.id ?? fail('no sprint 1'), report: { summary: 'Sprint 1: the receipt renders and is stored.', retro: { wentWell: ['Both tickets landed on their first attempt'] } } })
  p.clock.advanceSeconds(60)
  await complete(p, run.id, reportA.id)
  await attempt(worked, ref('email'), { minutes: 15, tokens: 18_000 })
  await attempt(worked, ref('pdf'), { minutes: 10, tokens: 9_000 })
  await attempt(worked, nodeOf(1), { minutes: 5, tokens: 5_000, unmet: 'Integrated check: a real paid order sends no receipt; the checkout never calls the mailer.' })
  const reportB = await p.orchestrator.submitSprintReport({ runId: run.id, sprintId: sprints[1]?.id ?? fail('no sprint 2'), report: { summary: 'Sprint 2: the email and PDF tickets landed; the integrated check failed.' } })
  p.clock.advanceSeconds(60)
  const tickets = { render: ref('render'), store: ref('store'), node1: nodeOf(0), email: ref('email'), pdf: ref('pdf'), node2: nodeOf(1) }
  const sprintIds = sprints.map((sprint) => sprint.id)
  const reads = await mcpReads(m, p, [
    ['epic', 'get_epic_grade', { epicId: epic.id }],
    ['sprint1', 'get_sprint_grade', { runId: run.id, sprintId: sprintIds[0] }],
    ['sprint2', 'get_sprint_grade', { runId: run.id, sprintId: sprintIds[1] }],
    ...Object.entries(tickets).map(([name, ticketId]): [string, string, Record<string, unknown>] => [`ticket:${name}`, 'get_ticket_grade', { runId: run.id, ticketId }]),
    ['runMetrics', 'get_run_metrics', { runId: run.id }],
    ['report2', 'get_report_scorecard', { reportId: reportB.id }],
    ['metrics', 'get_metrics_summary', {}]
  ])
  const sum = (key: 'minutes' | 'tokens', sprintId?: string): number =>
    ledger.attempts.filter((entry) => sprintId === undefined || entry.sprintId === sprintId).reduce((total, entry) => total + (entry.spend[key] ?? 0), 0)
  write({
    ...machineDirs(m),
    project: { path: p.path, name: p.name, epicTitle: 'Payment receipts', epicId: epic.id, runId: run.id, sprintIds, tickets, reports: [reportA.id, reportB.id] },
    ledger,
    ledgerTotals: { tokens: sum('tokens'), minutes: sum('minutes'), perSprint: sprintIds.map((id) => ({ sprintId: id, tokens: sum('tokens', id), minutes: sum('minutes', id) })) },
    unexpected: m.unexpected,
    reads
  })
}

async function main(): Promise<void> {
  const m = twoRepoMachine({ root })
  try {
    if (variant === 'loop') await loop(m, false)
    else if (variant === 'regress') await loop(m, true)
    else if (variant === 'report1') await stoppedAtReport1(m)
    else await failedIntegration(m)
  } finally {
    await m.cleanup()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
