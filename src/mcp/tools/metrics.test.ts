import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../../cli/main'
import type { Workspace } from '../../core/workspace'
import type { CommandName } from '../../shared/domain/api'
import type { SessionRole, SprintReportView } from '../../shared/domain/views'
import { callTool, sampleId, withRig, withServer } from '../../test/mcpHarness'
import { type Bridge, criteriaMet, desktopBridge, laterRecords, type ScoreProject, scoreProject, submitReport } from '../../test/scoreWorld'
import { createStubApi } from '../../test/stubApi'
import { createMcpServer } from '../server'

const INFO = { name: 'darkmechanicus', version: '0.0.0-test' }

/** The twelve scorecard and metrics tools DM-266 added, and the command each adapts. */
const SCORE_TOOLS: Record<string, CommandName> = {
  get_ticket_grade: 'getTicketGrade',
  get_sprint_grade: 'getSprintGrade',
  get_run_grade: 'getRunGrade',
  get_epic_grade: 'getEpicGrade',
  get_report_scorecard: 'getReportScorecard',
  reassess_report_scorecard: 'reassessReportScorecard',
  get_space_signals: 'getSpaceSignals',
  get_ticket_performance: 'getTicketPerformance',
  get_escaped_defects: 'getEscapedDefects',
  get_run_efficiency: 'getRunEfficiency',
  get_run_timing: 'getRunTiming',
  get_metrics_summary: 'getMetricsSummary'
}

/** What the twelve take: ids, a cutoff, a report revision, a subject level, a window. Nothing a person states. */
const ID_AND_WINDOW_INPUTS = ['cutoff', 'epicId', 'epicIds', 'id', 'level', 'reportId', 'reportRevision', 'runId', 'since', 'sprintId', 'ticketId', 'until']

/** A person's records and budget edits: desktop-only, so no session lists a tool for them. */
const DESKTOP_ONLY_TOOLS = ['record_human_feedback', 'record_escaped_defects', 'set_ticket_budget']

const ROLES: { role: SessionRole; allowSave: boolean }[] = [
  { role: 'planner', allowSave: true },
  { role: 'orchestrator', allowSave: true },
  { role: 'worker', allowSave: false },
  { role: 'reviewer', allowSave: false },
  { role: 'reader', allowSave: false }
]

interface Measured {
  p: ScoreProject
  bridge: Bridge
  report: SprintReportView
  /** Every read is pinned to this server time, so channels in other sessions agree. */
  cutoff: string
}

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** A delivered epic whose sprint 1 report is submitted (scorecard frozen), read a minute later. */
async function measured(): Promise<Measured> {
  const p = await scoreProject('Metrics tools')
  cleanups.push(() => p.harness.cleanup())
  const report = await submitReport(p, 'Sprint 1 is over.')
  p.harness.clock.advanceSeconds(60)
  return { p, bridge: desktopBridge([p]), report, cutoff: p.harness.clock.nowIso() }
}

/** One call per score tool: the same identity and cutoff for every channel. */
function scoreCalls({ p, report, cutoff }: Measured): [string, Record<string, unknown>][] {
  const { epicId, runId, sprintId, apiTicket: ticketId } = p
  const reportRef = { reportId: report.id, reportRevision: report.reportRevision }
  const args: Record<string, Record<string, unknown>> = {
    get_ticket_grade: { runId, ticketId, cutoff },
    get_sprint_grade: { runId, sprintId, cutoff },
    get_run_grade: { runId, cutoff },
    get_epic_grade: { epicId, cutoff },
    get_report_scorecard: reportRef,
    reassess_report_scorecard: { ...reportRef, cutoff },
    get_space_signals: { level: 'sprint', id: sprintId, runId, cutoff },
    get_ticket_performance: { runId, ticketId, cutoff },
    get_escaped_defects: { epicId, cutoff },
    get_run_efficiency: { runId, cutoff },
    get_run_timing: { runId, cutoff },
    get_metrics_summary: { until: cutoff }
  }
  return Object.keys(SCORE_TOOLS).map((tool) => [tool, args[tool] ?? {}])
}

/** `dm call <tool> <json>` in process, as a person's shell runs it without a grant (a reader session). */
async function dmCall(p: ScoreProject, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const stdout: string[] = []
  await runCli({
    argv: ['--repo', p.folder, 'call', tool, JSON.stringify(args)],
    env: {},
    cwd: p.folder,
    execPath: 'node',
    cliPath: 'out/main/cli.js',
    open: (options) => p.harness.open(options.role, { transport: options.transport }),
    readFile: () => '',
    readStdin: () => '',
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => undefined,
    exit: () => undefined
  })
  return JSON.parse(stdout.join('')) as unknown
}

/** Summary fields read as stored now: token categories cannot be cut at a cutoff (see `asOfCutoff`). */
const UNCUT_SUMMARY_KEYS: Record<string, true> = { input: true, cachedInput: true, output: true, reasoning: true, unavailable: true }

/**
 * An answer as JSON text, as it stood at its cutoff. The summary's token categories (input, cached input, output,
 * reasoning) are read as stored now and cannot be cut at a cutoff: once later records exist they read missing with
 * that reason (their total and every grade still cut), so they and the unavailable list that names them are left out.
 */
function asOfCutoff(tool: string, answer: unknown): string {
  return JSON.stringify(answer, (key: string, value: unknown) => (tool === 'get_metrics_summary' && UNCUT_SUMMARY_KEYS[key] === true ? undefined : value))
}

/** Every row of every table of the project database, by table. */
function allRows(workspace: Workspace): Record<string, unknown[]> {
  const { db } = workspace.ctx()
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  return Object.fromEntries(tables.map(({ name }) => [name, db.all(`SELECT * FROM "${name}" ORDER BY 1`)]))
}

/** The rows each table gained and lost between two `allRows` dumps; tables that did not change are left out. */
function rowChanges(before: Record<string, unknown[]>, after: Record<string, unknown[]>): Record<string, { added: unknown[]; removed: unknown[] }> {
  const changes: Record<string, { added: unknown[]; removed: unknown[] }> = {}
  for (const table of Object.keys(after)) {
    const was = (before[table] ?? []).map((row) => JSON.stringify(row))
    const now = (after[table] ?? []).map((row) => JSON.stringify(row))
    const added = now.filter((row) => !was.includes(row)).map((row) => JSON.parse(row) as unknown)
    const removed = was.filter((row) => !now.includes(row)).map((row) => JSON.parse(row) as unknown)
    if (added.length + removed.length > 0) changes[table] = { added, removed }
  }
  return changes
}

function serverFor(api: Parameters<typeof createMcpServer>[0], role: SessionRole, allowSave = false) {
  return createMcpServer(api, INFO, { role, allowSave })
}

describe('scorecard and metrics tools: listing (DM-266 c1, c2)', () => {
  it.each(ROLES)('lists the twelve to a $role session, read-only, taking ids, cutoffs and windows only', async ({ role, allowSave }) => {
    await withRig((api) => serverFor(api, role, allowSave), createStubApi(), async (rig) => {
      const { tools } = await rig.client.listTools()
      const score = tools.filter((tool) => Object.hasOwn(SCORE_TOOLS, tool.name))
      expect(score.map((tool) => tool.name).sort()).toEqual(Object.keys(SCORE_TOOLS).sort())
      expect(score.filter((tool) => tool.annotations?.readOnlyHint !== true || tool.annotations.destructiveHint === true)).toEqual([])
      const inputs = new Set(score.flatMap((tool) => Object.keys(tool.inputSchema.properties ?? {})))
      expect([...inputs].sort()).toEqual(ID_AND_WINDOW_INPUTS)
      expect(tools.filter((tool) => DESKTOP_ONLY_TOOLS.includes(tool.name))).toEqual([])
    })
  })

  it('describes units, coverage and grade-status semantics in every one of the twelve', async () => {
    await withRig((api) => serverFor(api, 'reader'), createStubApi(), async (rig) => {
      const described = (await rig.client.listTools()).tools.filter((tool) => Object.hasOwn(SCORE_TOOLS, tool.name))
      const lacking = described.filter(
        ({ description = '' }) => !/milliseconds|tokens|points|counts/.test(description) || !/coverage/i.test(description) || !/final.*provisional.*ungraded/s.test(description)
      )
      expect(lacking.map((tool) => tool.name)).toEqual([])
      expect(described).toHaveLength(12)
    })
  })
})

describe('scorecard and metrics tools: parity (DM-266 c1)', () => {
  it('answers each tool with the JSON the desktop bridge and `dm call` return as of the cutoff, not the later live data', async () => {
    const m = await measured()
    const reader = m.p.harness.open('reader')
    const calls = scoreCalls(m)
    // What every read says at the cutoff, before anything later is recorded.
    const atCutoff = new Map<string, unknown>()
    for (const [tool, args] of calls) {
      atCutoff.set(tool, JSON.parse(JSON.stringify(await m.bridge.command(m.p.folder, SCORE_TOOLS[tool] ?? 'getProject', args as never))))
    }
    await laterRecords(m.p)
    await withServer(serverFor(reader, 'reader'), async (rig) => {
      for (const [tool, args] of calls) {
        const mcp = await callTool(rig, tool, args)
        const bridged = await m.bridge.command(m.p.folder, SCORE_TOOLS[tool] ?? 'getProject', args as never)
        expect({ tool, ok: bridged.ok }).toEqual({ tool, ok: true })
        expect(mcp.payload, tool).toEqual(JSON.parse(JSON.stringify(bridged)))
        expect(await dmCall(m.p, tool, args), tool).toEqual(mcp.payload)
        expect(asOfCutoff(tool, mcp.payload), tool).toEqual(asOfCutoff(tool, atCutoff.get(tool)))
        // The same identity without its cutoff reads the later records: the cutoff is what kept them out.
        const { cutoff: _cutoff, until: _until, ...live } = args
        if (tool !== 'get_report_scorecard') expect(JSON.stringify((await callTool(rig, tool, live)).payload), tool).not.toEqual(JSON.stringify(mcp.payload))
      }
    })
  })
})

describe('scorecard and metrics tools: reader access (DM-266 c2, DM-271 c4)', () => {
  it('lets a reader session read every scorecard and metrics tool without changing a row', async () => {
    const m = await measured()
    const reader = m.p.harness.open('reader')
    const reads: [string, Record<string, unknown>][] = [
      ...scoreCalls(m),
      ['get_run_metrics', { runId: m.p.runId }],
      ['get_planned_baselines', { epicId: m.p.epicId, runId: m.p.runId }],
      ['get_retro_findings', { reportId: m.report.id, reportRevision: m.report.reportRevision }]
    ]
    // Every attempt has settled (no lease is open), so not even a lease is due to be settled by a read.
    const before = allRows(m.p.desktop)
    await withServer(serverFor(reader, 'reader'), async (rig) => {
      for (const [tool, args] of reads) {
        const answer = await callTool(rig, tool, args)
        expect({ tool, ok: answer.payload?.ok, isError: answer.isError }).toEqual({ tool, ok: true, isError: false })
      }
    })
    expect(allRows(m.p.desktop)).toEqual(before)
  })
})

/** The score reads that read a run's records, so settle its overdue leases first (like get_run), and those that do not. */
const SETTLING_TOOLS = ['get_ticket_grade', 'get_sprint_grade', 'get_run_grade', 'get_epic_grade', 'reassess_report_scorecard', 'get_run_efficiency', 'get_run_timing', 'get_metrics_summary']

/** A project whose acceptance node was claimed before sprint 1's report and whose lease ran out three hours ago. */
async function overdueLease(): Promise<{ m: Measured; attemptId: string }> {
  const p = await scoreProject('Overdue lease')
  cleanups.push(() => p.harness.cleanup())
  await p.orchestrator.acceptAttempt({ attemptId: p.guideAttempt, notes: 'reviewed', criteria: criteriaMet(p.bundle, p.guideTicket) })
  const claim = await p.orchestrator.claimTicket({ runId: p.runId, ticketId: p.acceptanceTicket, worker: { label: 'test-worker' } })
  const report = await submitReport(p, 'Sprint 1 is over.')
  p.harness.clock.advanceSeconds(3 * 3_600)
  return { m: { p, bridge: desktopBridge([p]), report, cutoff: p.harness.clock.nowIso() }, attemptId: claim.attempt.id }
}

describe('scorecard and metrics tools: what a reader read may write (DM-266 c2)', () => {
  it.each(Object.keys(SCORE_TOOLS))('%s: a reader read settles at most the read run’s overdue lease, and a second read changes no row', async (tool) => {
    const { m, attemptId } = await overdueLease()
    const reader = m.p.harness.open('reader')
    const args = Object.fromEntries(scoreCalls(m))[tool] ?? {}
    const first = allRows(m.p.desktop)
    await withServer(serverFor(reader, 'reader'), async (rig) => {
      expect((await callTool(rig, tool, args)).payload).toMatchObject({ ok: true })
      const settled = allRows(m.p.desktop)
      const changes = rowChanges(first, settled)
      if (SETTLING_TOOLS.includes(tool)) {
        expect(Object.keys(changes).sort()).toEqual(['attempts', 'events', 'outbox', 'sqlite_sequence'])
        expect(changes.attempts).toEqual({ added: [expect.objectContaining({ id: attemptId, state: 'lease_expired' })], removed: [expect.objectContaining({ id: attemptId, state: 'claimed' })] })
        expect(changes.events).toEqual({ added: [expect.objectContaining({ kind: 'attempt.lease_expired', run_id: m.p.runId })], removed: [] })
        expect(changes.outbox).toEqual({ added: [expect.objectContaining({ kind: 'run_history', run_id: m.p.runId })], removed: [] })
      } else {
        expect(changes).toEqual({})
      }
      expect((await callTool(rig, tool, args)).payload).toMatchObject({ ok: true })
      expect(rowChanges(settled, allRows(m.p.desktop))).toEqual({})
    })
  })
})

describe('scorecard and metrics tools: reader refusals (DM-266 c2, DM-271 c4)', () => {
  it('refuses a reader every write this epic added, over MCP and in the core, writing nothing', async () => {
    const m = await measured()
    const reader = m.p.harness.open('reader')
    const { epicId, runId, sprintId, apiTicket: ticketId, apiAttempt: attemptId } = m.p
    const usage = { metric: 'tokens_total', unit: 'tokens', source: { kind: 'host', actor: 'host:reader' }, measurement: { state: 'observed', value: 1 }, accumulation: 'delta', eventId: 'reader-1', observedAt: m.cutoff }
    const writes: [string, string, Record<string, unknown>][] = [
      ['record_attempt_metrics', 'metrics.report', { attemptId, reports: [usage] }],
      ['record_run_metrics', 'metrics.report_run', { runId, overhead: 'review', reports: [usage] }],
      ['record_experiment_event', 'report.submit', { experimentId: sampleId('experiment', 900), event: { kind: 'status', status: 'selected' } }],
      ['create_corrections', 'draft.edit', { reportId: m.report.id, experimentIds: [sampleId('experiment', 900)], expectedDraftRevision: null }]
    ]
    const before = allRows(m.p.desktop)
    await withServer(serverFor(reader, 'reader'), async (rig) => {
      const listed = (await rig.client.listTools()).tools.map((tool) => tool.name)
      expect(listed.filter((name) => writes.some(([tool]) => tool === name) || DESKTOP_ONLY_TOOLS.includes(name))).toEqual([])
      for (const [tool, capability, args] of writes) {
        expect((await callTool(rig, tool, args)).payload).toEqual({
          ok: false,
          error: { code: 'unauthorized', message: `This reader session is not permitted to perform "${capability}".`, details: { role: 'reader', capability, tool } }
        })
      }
      for (const tool of DESKTOP_ONLY_TOOLS) {
        expect((await callTool(rig, tool, { epicId })).payload).toEqual({ ok: false, error: { code: 'not_found', message: `Tool ${tool} not found.`, details: { tool } } })
      }
    })
    const core: [string, () => Promise<unknown>][] = [
      ['recordAttemptMetrics', () => reader.recordAttemptMetrics({ attemptId, reports: [usage] as never })],
      ['recordRunMetrics', () => reader.recordRunMetrics({ runId, overhead: 'review', reports: [usage] as never })],
      ['recordHumanFeedback', () => reader.recordHumanFeedback({ target: { epicId, sprintId }, feedback: { kind: 'rating', value: 5 } })],
      ['recordEscapedDefects', () => reader.recordEscapedDefects({ target: { epicId }, records: [{ defectEvent: 'report', severity: 'low', attribution: 'unassigned', discoveryPhase: 'after_epic', evidence: [{ kind: 'commit', id: 'abcdef1', detail: 'build' }] }] })],
      ['setTicketBudget', () => reader.setTicketBudget({ epicId, ticketId, budget: { tokens: 1 }, expectedDraftRevision: 0 })]
    ]
    for (const [name, attempt] of core) {
      await expect(attempt(), name).rejects.toMatchObject({ code: 'unauthorized' })
    }
    expect(allRows(m.p.desktop)).toEqual(before)
  })
})

describe('scorecard and metrics tools: pinned report snapshots (DM-266 c3)', () => {
  it('reads the scorecard frozen with the requested report revision, never later live data', async () => {
    const m = await measured()
    const { p } = m
    const reader = p.harness.open('reader')
    await withServer(serverFor(reader, 'reader'), async (rig) => {
      const first = await callTool(rig, 'get_report_scorecard', { reportId: m.report.id, reportRevision: 1 })
      // Later records move the live grade: a person rates the sprint, the guide is accepted, a revised report follows.
      await m.bridge.call(p.folder, 'recordHumanFeedback', { target: { epicId: p.epicId, sprintId: p.sprintId }, feedback: { kind: 'rating', value: 2, sharedWithTickets: true } })
      await p.orchestrator.acceptAttempt({ attemptId: p.guideAttempt, notes: 'reviewed', criteria: criteriaMet(p.bundle, p.guideTicket) })
      p.harness.clock.advanceSeconds(60)
      const revised = await submitReport(p, 'Sprint 1 is over (revised).')
      const again = await callTool(rig, 'get_report_scorecard', { reportId: m.report.id, reportRevision: 1 })
      const second = await callTool(rig, 'get_report_scorecard', { reportId: revised.id, reportRevision: 2 })
      const live = await callTool(rig, 'get_sprint_grade', { runId: p.runId, sprintId: p.sprintId })

      expect(again.payload).toEqual(first.payload)
      expect(first.payload).toMatchObject({ ok: true, data: { state: 'frozen', report: { reportRevision: 1 }, scorecard: { snapshot: { cutoff: m.report.createdAt } } } })
      expect(second.payload).toMatchObject({ ok: true, data: { state: 'frozen', report: { reportRevision: 2 }, scorecard: { snapshot: { cutoff: revised.createdAt } } } })
      // The same channel's typed answers (parity is pinned above) for what the frozen and live grades are graded from.
      const [frozen, later, current] = await Promise.all([
        m.bridge.call(p.folder, 'getReportScorecard', { reportId: m.report.id, reportRevision: 1 }),
        m.bridge.call(p.folder, 'getReportScorecard', { reportId: revised.id, reportRevision: 2 }),
        m.bridge.call(p.folder, 'getSprintGrade', { runId: p.runId, sprintId: p.sprintId })
      ])
      expect(first.payload).toEqual({ ok: true, data: JSON.parse(JSON.stringify(frozen)) })
      expect(live.payload).toEqual({ ok: true, data: JSON.parse(JSON.stringify(current)) })
      if (frozen.state !== 'frozen' || later.state !== 'frozen') throw new Error('both revisions froze a scorecard')
      expect(later.scorecard.snapshot.snapshotId).not.toBe(frozen.scorecard.snapshot.snapshotId)
      expect(current.grade.inputHash).not.toBe(frozen.scorecard.sprint.grade.inputHash)
      expect(current.grade.inputHash).toBe(later.scorecard.sprint.grade.inputHash)
    })
  })
})

describe('scorecard and metrics tools: unknown identities (DM-266 c3)', () => {
  it('fails with not_found for a revision the report id does not have and for ids the project does not hold', async () => {
    const m = await measured()
    const { runId } = m.p
    const unknown = (kind: Parameters<typeof sampleId>[0]) => sampleId(kind, 1_000_000)
    const calls: [string, Record<string, unknown>][] = [
      ['get_report_scorecard', { reportId: m.report.id, reportRevision: 2 }],
      ['reassess_report_scorecard', { reportId: m.report.id, reportRevision: 2 }],
      ['get_report_scorecard', { reportId: unknown('report') }],
      ['get_run_grade', { runId: unknown('run') }],
      ['get_epic_grade', { epicId: unknown('epic') }],
      ['get_ticket_grade', { runId, ticketId: unknown('ticket') }],
      ['get_sprint_grade', { runId, sprintId: unknown('sprint') }],
      ['get_metrics_summary', { epicIds: [unknown('epic')] }]
    ]
    await withServer(serverFor(m.p.harness.open('reader'), 'reader'), async (rig) => {
      for (const [tool, args] of calls) {
        const answer = await callTool(rig, tool, args)
        expect({ tool, args, payload: answer.payload }).toMatchObject({ tool, args, payload: { ok: false, error: { code: 'not_found' } } })
      }
    })
  })
})
