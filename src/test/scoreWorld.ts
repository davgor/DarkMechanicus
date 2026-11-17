/**
 * A measured project for scorecard adapter tests, built through the real commands in a fresh harness folder: a desktop
 * and an orchestrator workspace, an epic whose sprint 1 holds a budgeted feature ticket (usage relayed by its host,
 * accepted), an unmeasured guide ticket (submitted, undecided) and the sprint's acceptance node, and the desktop's
 * `dm:command` handler (`createDesktopHandlers`: allow-list and tracked-folder guard) over a pool of such projects.
 * Every project lives in its own temporary folder; callers clean up with `cleanup()`. Not shipped.
 */
import { createDesktopHandlers, type DesktopHandlerDeps, type DesktopHandlers } from '../main/desktop/handlers'
import type { Workspace } from '../core/workspace'
import { DomainError } from '../core/errors'
import type { CommandInput, CommandOutput, CommandResult, TrackedFolderView } from '../shared/desktop/api'
import type { CommandName, DraftOp } from '../shared/domain/api'
import type { PlanBundle, TicketContent } from '../shared/domain/bundle'
import type { MetricReport } from '../shared/domain/metrics'
import type { SprintReportView } from '../shared/domain/views'
import { idleAgentDeps } from './idleAgents'
import { createHarness, type Harness } from './workspaceHarness'

export interface ScoreProject {
  harness: Harness
  folder: string
  desktop: Workspace
  orchestrator: Workspace
  epicId: string
  runId: string
  sprintId: string
  bundle: PlanBundle
  /** Budgeted (`apiBudgetTokens`, 50,000 by default, and 30 min; it spends 30,000 tokens), measured, accepted. */
  apiTicket: string
  apiAttempt: string
  /** No budget, no usage reported, submitted and undecided. */
  guideTicket: string
  guideAttempt: string
  acceptanceTicket: string
}

function never(what: string): never {
  throw new Error(`${what} is not part of this test`)
}

function ticketOf(bundle: PlanBundle, ticketId: string): TicketContent {
  return bundle.tickets.find((entry) => entry.id === ticketId) ?? never(`ticket ${ticketId}`)
}

/** Every criterion of the ticket met, as an acceptance or a submission states it. */
export function criteriaMet(bundle: PlanBundle, ticketId: string, note = 'verified'): { criterionId: string; met: boolean; note: string }[] {
  return ticketOf(bundle, ticketId).acceptanceCriteria.map((criterion) => ({ criterionId: criterion.id, met: true, note }))
}

/** What a host relays for one attempt: one closed active span, its token total, and the effort classified productive. */
function usageReports(attemptId: string, span: { start: number; end: number }, tokens = 30_000): MetricReport[] {
  const actor = `host:worker-${attemptId.slice(-6)}`
  const end = new Date(span.end).toISOString()
  const usage = { coverage: 'self' as const, parentActor: null }
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
    { metric: 'tokens_total', unit: 'tokens', source: { kind: 'host', actor }, measurement: { state: 'observed', value: tokens }, accumulation: 'cumulative', sequence: 1, observedAt: end, usage },
    {
      metric: 'corrective_effort_ms',
      unit: 'milliseconds',
      source: { kind: 'agent', actor },
      measurement: { state: 'observed', value: span.end - span.start },
      accumulation: 'event',
      eventId: `productive-${attemptId}`,
      observedAt: end,
      attributes: { classification: 'productive', work: 'implementation' }
    }
  ]
}

async function savedPlan(orchestrator: Workspace, title: string, apiBudgetTokens: number): Promise<{ epicId: string; bundle: PlanBundle }> {
  const epic = await orchestrator.createEpic({ title, intent: 'Read scorecards through every channel.', successCriteria: ['Grades read alike everywhere'] })
  const ops: DraftOp[] = [
    { op: 'add_ticket', ref: 'api', sprint: '1', ticket: { title: 'Build the API', acceptanceCriteria: ['The API answers'], budget: { tokens: apiBudgetTokens, activeMs: 30 * 60_000 } } },
    { op: 'add_ticket', ref: 'guide', sprint: '1', ticket: { title: 'Write the guide', acceptanceCriteria: ['The guide exists'] } }
  ]
  await orchestrator.updatePlanDraft({ epicId: epic.id, ops })
  const draft = await orchestrator.getPlan({ epicId: epic.id, view: 'draft' })
  const work = draft.bundle.tickets.filter((ticket) => ticket.kind !== 'acceptance')
  const cover: DraftOp[] = draft.bundle.tickets
    .filter((ticket) => ticket.kind === 'acceptance')
    .map((node) => ({ op: 'update_ticket', ticket: node.id, patch: { acceptanceCriteria: work.map((ticket) => ({ text: `${ticket.title} is verified`, covers: ticket.id })) } }))
  const covered = await orchestrator.updatePlanDraft({ epicId: epic.id, ops: cover })
  const saved = await orchestrator.savePlan({ epicId: epic.id, expectedDraftRevision: covered.draftRevision })
  if (saved.status !== 'saved') never(`a plan that does not save (${saved.status})`)
  return { epicId: epic.id, bundle: (await orchestrator.getPlan({ epicId: epic.id, view: 'saved' })).bundle }
}

interface Delivery {
  p: Pick<ScoreProject, 'harness' | 'orchestrator' | 'bundle'>
  runId: string
  ticketId: string
  measured: boolean
}

/** Claims, works ten minutes (relaying usage when measured) and submits with every criterion met; returns the attempt id. */
async function deliver({ p, runId, ticketId, measured }: Delivery): Promise<string> {
  const claim = await p.orchestrator.claimTicket({ runId, ticketId, worker: { label: 'test-worker' } })
  const start = p.harness.clock.nowMs()
  p.harness.clock.advanceSeconds(600)
  if (measured) {
    await p.orchestrator.recordAttemptMetrics({ attemptId: claim.attempt.id, reports: usageReports(claim.attempt.id, { start, end: p.harness.clock.nowMs() }) })
  }
  await p.orchestrator.submitAttempt({
    attemptId: claim.attempt.id,
    claimToken: claim.packet.claimToken ?? never('a claim without a token'),
    outputs: { summary: `Delivered ${ticketOf(p.bundle, ticketId).title}.`, commits: ['abcdef1'], changedFiles: ['src/demo.ts'] },
    evidence: {
      checks: [{ name: 'unit tests', status: 'passed', detail: 'npx vitest run src/demo.test.ts' }],
      criteria: criteriaMet(p.bundle, ticketId, 'shown by the demo test'),
      notes: ''
    }
  })
  return claim.attempt.id
}

interface ProjectOptions {
  /**
   * Kanban cards created first. Every harness hands out the same sequential ids, so they shift this project's ids: a
   * read of another project's id then names nothing here.
   */
  warmUps?: number
  apiBudgetTokens?: number
}

/** The plan's sprint 1, its two work tickets and its acceptance node. */
function planIds(bundle: PlanBundle): Pick<ScoreProject, 'sprintId' | 'apiTicket' | 'guideTicket' | 'acceptanceTicket'> {
  const [apiTicket = '', guideTicket = ''] = bundle.tickets.filter((ticket) => ticket.kind !== 'acceptance').map((ticket) => ticket.id)
  return {
    sprintId: bundle.sprints[0]?.id ?? never('a plan without a sprint'),
    apiTicket,
    guideTicket,
    acceptanceTicket: bundle.tickets.find((ticket) => ticket.kind === 'acceptance')?.id ?? never('a plan without an acceptance node')
  }
}

/** One project in its own folder. */
export async function scoreProject(title: string, { warmUps = 0, apiBudgetTokens = 50_000 }: ProjectOptions = {}): Promise<ScoreProject> {
  const harness = createHarness()
  const desktop = harness.open('desktop', { allowSave: true })
  await desktop.initializeRepository({ name: title })
  const orchestrator = harness.open('orchestrator', { allowSave: true })
  for (let n = 0; n < warmUps; n += 1) {
    await orchestrator.createKanbanCard({ title: `${title} warm-up ${n + 1}` })
  }
  const { epicId, bundle } = await savedPlan(orchestrator, title, apiBudgetTokens)
  const ids = planIds(bundle)
  // The budget froze at the save; the first claim comes later, so it is a pre-dispatch baseline.
  harness.clock.advanceSeconds(60)
  const run = await orchestrator.startRun({ epicId })
  const base = { p: { harness, orchestrator, bundle }, runId: run.id }
  const apiAttempt = await deliver({ ...base, ticketId: ids.apiTicket, measured: true })
  harness.clock.advanceSeconds(60)
  await orchestrator.acceptAttempt({ attemptId: apiAttempt, notes: 'reviewed', criteria: criteriaMet(bundle, ids.apiTicket) })
  harness.clock.advanceSeconds(60)
  const guideAttempt = await deliver({ ...base, ticketId: ids.guideTicket, measured: false })
  harness.clock.advanceSeconds(60)
  return { harness, folder: harness.root, desktop, orchestrator, epicId, runId: run.id, bundle, ...ids, apiAttempt, guideAttempt }
}

/** Submits a sprint report revision for sprint 1 through the orchestrator's real command. */
export function submitReport(p: ScoreProject, summary: string): Promise<SprintReportView> {
  return p.orchestrator.submitSprintReport({ runId: p.runId, sprintId: p.sprintId, report: { summary } })
}

/**
 * Records made after a read's cutoff, an hour later, that move every live score read: a person's sprint rating shared
 * with the tickets (S), an escaped defect charged to the API ticket (P), and more tokens relayed for its attempt (E, K).
 */
export async function laterRecords(p: ScoreProject): Promise<void> {
  p.harness.clock.advanceSeconds(3_600)
  await p.desktop.recordHumanFeedback({ target: { epicId: p.epicId, sprintId: p.sprintId, runId: p.runId }, feedback: { kind: 'rating', value: 2, sharedWithTickets: true } })
  const origin = [
    { kind: 'commit' as const, id: 'abcdef1', detail: 'source build' },
    { kind: 'ticket' as const, id: p.apiTicket, detail: 'origin' },
    { kind: 'attempt' as const, id: p.apiAttempt, detail: 'origin' }
  ]
  await p.desktop.recordEscapedDefects({
    target: { epicId: p.epicId, runId: p.runId },
    records: [{ defectEvent: 'report', severity: 'high', attribution: 'attributed', discoveryPhase: 'sprint_review', defectKey: 'ISSUE-7', evidence: origin }]
  })
  const actor = { kind: 'host' as const, actor: 'host:late-relay' }
  await p.orchestrator.recordAttemptMetrics({
    attemptId: p.apiAttempt,
    reports: [{ metric: 'tokens_total', unit: 'tokens', source: actor, measurement: { state: 'observed', value: 90_000 }, accumulation: 'delta', eventId: 'late-tokens', observedAt: p.harness.clock.nowIso() }]
  })
  p.harness.clock.advanceSeconds(60)
}

export interface Bridge {
  handlers: DesktopHandlers
  /** `dm:command` as the renderer sends it: the folder, the command name and the raw input. */
  command<K extends CommandName>(folder: string, name: K, input: CommandInput<K>): Promise<CommandResult<CommandOutput<K>>>
  /** Like `command`, unwrapped as the renderer's `runCommand` does: the data, or a thrown `CommandError`. */
  call<K extends CommandName>(folder: string, name: K, input: CommandInput<K>): Promise<CommandOutput<K>>
  /** Folders a workspace was requested for, in order. */
  opened: string[]
}

/** The desktop's `dm:command` handler over these projects: only their folders are tracked. */
export function desktopBridge(projects: readonly Pick<ScoreProject, 'folder' | 'desktop'>[]): Bridge {
  const workspaces = new Map(projects.map((p) => [p.folder, p.desktop]))
  return bridgeOver(
    {
      list: (): TrackedFolderView[] => [],
      track: () => never('tracking a folder'),
      untrack: () => never('untracking a folder'),
      resolve: (path) => (workspaces.has(path) ? path : null),
      storageMode: () => 'repo'
    },
    { get: (path) => workspaces.get(path) ?? never(`a workspace for ${path}`), close: () => undefined }
  )
}

/** The desktop's `dm:command` handler over a folder registry and workspace pool (real ones, or a test's own). */
export function bridgeOver(registry: DesktopHandlerDeps['registry'], pool: DesktopHandlerDeps['pool']): Bridge {
  const opened: string[] = []
  const handlers = createDesktopHandlers({
    registry,
    pool: {
      get: (path) => {
        opened.push(path)
        return pool.get(path)
      },
      close: (path) => pool.close(path)
    },
    pickDirectory: () => never('the folder dialog'),
    writeClipboard: () => never('the clipboard'),
    openExternal: () => never('opening a link'),
    mcpConfig: () => never('the MCP snippet'),
    installSkills: () => never('installing skills'),
    connectClaudeCode: () => never('connecting Claude Code'),
    previewBoardRemoval: () => never('the board preview'),
    removeBoardFiles: () => never('removing board files'),
    onUnexpectedError: (error) => {
      throw error
    },
    ...idleAgentDeps()
  })
  const command = <K extends CommandName>(folder: string, name: K, input: CommandInput<K>) =>
    handlers.command(folder, name, input) as Promise<CommandResult<CommandOutput<K>>>
  async function call<K extends CommandName>(folder: string, name: K, input: CommandInput<K>): Promise<CommandOutput<K>> {
    const result = await command(folder, name, input)
    if (result.ok) return result.data
    // What the renderer's `runCommand` throws: the failure's code, message and details on an Error.
    throw new DomainError(result.error.code, result.error.message, result.error.details)
  }
  return { handlers, opened, command, call }
}
