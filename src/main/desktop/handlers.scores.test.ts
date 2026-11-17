import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson } from '../../core/canonical'
import { getRunEfficiency } from '../../core/services/efficiency'
import { getRunMetrics } from '../../core/services/metricReports'
import { getMetricsSummary } from '../../core/services/metricsSummary'
import { getEscapedDefects, getTicketPerformance } from '../../core/services/performance'
import { getPlannedBaselines } from '../../core/services/plannedBaselines'
import { getReportScorecard, reassessReportScorecard } from '../../core/services/scorecards'
import { getEpicGrade, getRunGrade, getSprintGrade, getTicketGrade } from '../../core/services/spaceGrades'
import { getSpaceSignals } from '../../core/services/spaceSignals'
import { DESKTOP_COMMANDS } from '../../shared/desktop/api'
import type { CommandName } from '../../shared/domain/api'
import type { SessionRole } from '../../shared/domain/views'
import { desktopBridge, laterRecords, type ScoreProject, scoreProject, submitReport } from '../../test/scoreWorld'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function project(title: string, options: Parameters<typeof scoreProject>[1] = {}): Promise<ScoreProject> {
  const p = await scoreProject(title, options)
  cleanups.push(() => p.harness.cleanup())
  return p
}

/** What a rejected call failed with: its code, or `ok` when it succeeded. */
function codeOf(attempt: Promise<unknown>): Promise<string> {
  return attempt.then(
    () => 'ok',
    (error: { code?: string }) => error.code ?? 'thrown'
  )
}

const AGENT_ROLES: SessionRole[] = ['planner', 'orchestrator', 'worker', 'reviewer', 'reader']

describe('scorecard reads through the desktop bridge (DM-179 c1)', () => {
  it('returns the core read model’s assessment for each read of the same identity and cutoff, unmoved by later records', async () => {
    const p = await project('Parity')
    const report = await submitReport(p, 'Sprint 1 is over.')
    p.harness.clock.advanceSeconds(60)
    const bridge = desktopBridge([p])
    const ctx = p.desktop.ctx()
    const cutoff = p.harness.clock.nowIso()
    const ticket = { runId: p.runId, ticketId: p.apiTicket, cutoff }
    // Each read with its cutoff and the core read model it adapts.
    const reads: [CommandName, Record<string, unknown>, (input: never) => unknown][] = [
      ['getTicketGrade', ticket, (input) => getTicketGrade(ctx, input)],
      ['getSprintGrade', { runId: p.runId, sprintId: p.sprintId, cutoff }, (input) => getSprintGrade(ctx, input)],
      ['getRunGrade', { runId: p.runId, cutoff }, (input) => getRunGrade(ctx, input)],
      ['getEpicGrade', { epicId: p.epicId, cutoff }, (input) => getEpicGrade(ctx, input)],
      ['reassessReportScorecard', { reportId: report.id, reportRevision: 1, cutoff }, (input) => reassessReportScorecard(ctx, input)],
      ['getSpaceSignals', { level: 'ticket', id: p.apiTicket, runId: p.runId, cutoff }, (input) => getSpaceSignals(ctx, input)],
      ['getTicketPerformance', ticket, (input) => getTicketPerformance(ctx, input)],
      ['getEscapedDefects', { epicId: p.epicId, cutoff }, (input) => getEscapedDefects(ctx, input)],
      ['getRunEfficiency', { runId: p.runId, cutoff }, (input) => getRunEfficiency(ctx, input)]
    ]
    const before = new Map<CommandName, string>()
    for (const [name, input] of reads) before.set(name, canonicalJson(await bridge.command(p.folder, name, input as never)))
    await laterRecords(p)
    for (const [name, input, core] of reads) {
      const bridged = canonicalJson(await bridge.command(p.folder, name, input as never))
      const { cutoff: _cutoff, ...live } = input
      expect({ name, bridged }).toEqual({ name, bridged: canonicalJson({ ok: true, data: core(input as never) }) })
      expect({ name, bridged }).toEqual({ name, bridged: before.get(name) })
      expect({ name, live: canonicalJson({ ok: true, data: core(live as never) }) === bridged }).toEqual({ name, live: false })
    }
    // Reads that take no cutoff: the report revision's frozen scorecard, the run's usage and its budgets.
    const unpinned: [CommandName, Record<string, unknown>, () => unknown][] = [
      ['getReportScorecard', { reportId: report.id, reportRevision: 1 }, () => getReportScorecard(ctx, { reportId: report.id })],
      ['getRunMetrics', { runId: p.runId }, () => getRunMetrics(ctx, { runId: p.runId })],
      ['getPlannedBaselines', { epicId: p.epicId, runId: p.runId }, () => getPlannedBaselines(ctx, { epicId: p.epicId, runId: p.runId })]
    ]
    for (const [name, input, core] of unpinned) {
      expect({ name, answer: canonicalJson(await bridge.command(p.folder, name, input as never)) }).toEqual({ name, answer: canonicalJson({ ok: true, data: core() }) })
    }
  })
})

describe('report scorecards through the desktop bridge (DM-179 c1)', () => {
  it('reads a report revision’s frozen snapshot after the live grade moved, and reassesses it without changing it', async () => {
    const p = await project('Pinned')
    const bridge = desktopBridge([p])
    const first = await submitReport(p, 'Sprint 1 is over.')
    const frozen = await bridge.call(p.folder, 'getReportScorecard', { reportId: first.id, reportRevision: 1 })
    p.harness.clock.advanceSeconds(3_600)
    await bridge.call(p.folder, 'recordHumanFeedback', { target: { epicId: p.epicId, sprintId: p.sprintId }, feedback: { kind: 'rating', value: 2, sharedWithTickets: true } })
    const live = await bridge.call(p.folder, 'getSprintGrade', { runId: p.runId, sprintId: p.sprintId })
    const again = await bridge.call(p.folder, 'getReportScorecard', { reportId: first.id, reportRevision: 1 })
    const reassessed = await bridge.call(p.folder, 'reassessReportScorecard', { reportId: first.id, reportRevision: 1 })

    if (frozen.state !== 'frozen') throw new Error('the report froze a scorecard')
    expect(frozen.scorecard.snapshot.cutoff).toBe(first.createdAt)
    expect(live.grade.inputHash).not.toBe(frozen.scorecard.sprint.grade.inputHash)
    expect(canonicalJson(again)).toBe(canonicalJson(frozen))
    expect(canonicalJson(reassessed.approved)).toBe(canonicalJson(frozen.scorecard.snapshot))
    expect(reassessed.assessedAt > first.createdAt).toBe(true)
  })
})

describe('scope of the desktop bridge (DM-179 c2)', () => {
  it('reads a project only in its own folder: another project’s ids are not_found there', async () => {
    const a = await project('Project A')
    const b = await project('Project B', { warmUps: 3 })
    const bridge = desktopBridge([a, b])
    const reads: [CommandName, Record<string, unknown>][] = [
      ['getRunGrade', { runId: a.runId }],
      ['getTicketGrade', { runId: a.runId, ticketId: a.apiTicket }],
      ['getSprintGrade', { runId: a.runId, sprintId: a.sprintId }],
      ['getEpicGrade', { epicId: a.epicId }],
      ['getSpaceSignals', { level: 'run', id: a.runId }],
      ['getRunEfficiency', { runId: a.runId }],
      ['getRunMetrics', { runId: a.runId }],
      ['getEscapedDefects', { epicId: a.epicId }]
    ]
    for (const [name, input] of reads) {
      const own = await bridge.command(a.folder, name, input as never)
      const other = await bridge.command(b.folder, name, input as never)
      expect({ name, own: own.ok, other }).toMatchObject({ name, own: true, other: { ok: false, error: { code: 'not_found' } } })
    }
  })

  it('refuses an untracked folder and an agent-only command before any workspace opens', async () => {
    const p = await project('Guarded')
    const bridge = desktopBridge([p])
    const untracked = await bridge.command(`${p.folder}-elsewhere`, 'getRunGrade', { runId: p.runId })
    const agentOnly = await bridge.command(p.folder, 'recordAttemptMetrics' as never, { attemptId: p.apiAttempt, reports: [] } as never)
    expect(untracked).toEqual({ ok: false, error: { code: 'unauthorized', message: 'That folder is not tracked by Dark Mechanicus.' } })
    expect(agentOnly).toEqual({ ok: false, error: { code: 'unauthorized', message: 'The desktop may not call "recordAttemptMetrics".' } })
    expect(bridge.opened).toEqual([])
  })
})

describe('ownership of human inputs through the desktop bridge (DM-179 c2)', () => {
  it('records a person’s rating and defect only from the desktop; every agent role is refused both', async () => {
    const p = await project('People')
    const bridge = desktopBridge([p])
    const rating = { target: { epicId: p.epicId, ticketId: p.apiTicket }, feedback: { kind: 'rating' as const, value: 4 } }
    const defect = {
      target: { epicId: p.epicId },
      records: [{ defectEvent: 'report' as const, severity: 'low' as const, attribution: 'unassigned' as const, discoveryPhase: 'after_epic' as const, evidence: [{ kind: 'commit' as const, id: 'abcdef1', detail: 'build' }] }]
    }
    const refusals: Record<string, string[]> = {}
    for (const role of AGENT_ROLES) {
      const session = p.harness.open(role, { allowSave: true })
      refusals[role] = [await codeOf(session.recordHumanFeedback(rating)), await codeOf(session.recordEscapedDefects(defect))]
    }
    expect(refusals).toEqual(Object.fromEntries(AGENT_ROLES.map((role) => [role, ['unauthorized', 'unauthorized']])))
    const recorded = await bridge.call(p.folder, 'recordHumanFeedback', rating)
    expect(recorded).toMatchObject({ metric: 'human_rating', source: { kind: 'human' }, measurement: { state: 'observed', value: 4 }, scope: { ticketId: p.apiTicket } })
    expect(typeof recorded.attributes.machine).toBe('string')
  })

  it('keeps a desktop budget edit in the draft until a save, and refuses budget edits to agents without that ownership', async () => {
    const p = await project('Budgets')
    const bridge = desktopBridge([p])
    const opened = await bridge.call(p.folder, 'openDraft', { epicId: p.epicId })
    const edited = await bridge.call(p.folder, 'setTicketBudget', { epicId: p.epicId, ticketId: p.apiTicket, budget: { tokens: 200_000 }, expectedDraftRevision: opened.draftRevision ?? 0, runId: p.runId })
    const tokens = edited.ticket?.budgets.find((budget) => budget.metric === 'tokens')
    expect({ draft: tokens?.draft?.value, applied: tokens?.applied?.value, appliesTo: edited.appliesTo }).toEqual({ draft: 200_000, applied: 50_000, appliesTo: 'later_dispatches' })
    const worker = await codeOf(p.harness.open('worker').setTicketBudget({ epicId: p.epicId, ticketId: p.apiTicket, budget: { tokens: 1 }, expectedDraftRevision: edited.draftRevision }))
    const unsavedPlanner = await codeOf(p.harness.open('planner', { allowSave: false }).savePlan({ epicId: p.epicId, expectedDraftRevision: edited.draftRevision }))
    expect({ worker, unsavedPlanner }).toEqual({ worker: 'unauthorized', unsavedPlanner: 'unauthorized' })
    const saved = await bridge.call(p.folder, 'getPlannedBaselines', { epicId: p.epicId, runId: p.runId })
    expect(saved.tickets.find((ticket) => ticket.ticketId === p.apiTicket)?.budgets.find((budget) => budget.metric === 'tokens')?.versions).toHaveLength(1)
  })
})

describe('the metrics summary on the desktop command channel (DM-265 c5)', () => {
  it('answers getMetricsSummary through dm:command, allow-listed, with the core summary', async () => {
    const p = await project('Summary')
    await submitReport(p, 'Sprint 1 is over.')
    const bridge = desktopBridge([p])
    expect(DESKTOP_COMMANDS).toContain('getMetricsSummary')
    const answer = await bridge.command(p.folder, 'getMetricsSummary', {})
    expect(canonicalJson(answer)).toBe(canonicalJson({ ok: true, data: getMetricsSummary(p.desktop.ctx(), {}) }))
    expect(answer).toMatchObject({ ok: true, data: { epics: [{ epicId: p.epicId }] } })
    expect(bridge.opened).toEqual([p.folder])
  })

  it('refuses the summary of an untracked folder in requireTracked, opening nothing', async () => {
    const p = await project('Untracked summary')
    const bridge = desktopBridge([p])
    for (const folder of [`${p.folder}-copy`, 'relative/folder', '']) {
      const answer = await bridge.command(folder, 'getMetricsSummary', {})
      expect({ folder, answer }).toMatchObject({ folder, answer: { ok: false, error: { code: folder === '' ? 'invalid_input' : 'unauthorized' } } })
    }
    expect(bridge.opened).toEqual([])
  })
})

describe('human inputs and budgets at the command and bridge layer (DM-183 c4)', () => {
  it('refuses inputs out of bounds with invalid_input and records nothing', async () => {
    const p = await project('Bounds')
    const bridge = desktopBridge([p])
    const target = { epicId: p.epicId, sprintId: p.sprintId }
    const budget = (value: Record<string, unknown>) => ({ epicId: p.epicId, ticketId: p.guideTicket, budget: value, expectedDraftRevision: 0 })
    const cases: [string, CommandName, unknown][] = [
      ['a rating of 0', 'recordHumanFeedback', { target, feedback: { kind: 'rating', value: 0 } }],
      ['a rating of 6', 'recordHumanFeedback', { target, feedback: { kind: 'rating', value: 6 } }],
      ['a rating of 2.5', 'recordHumanFeedback', { target, feedback: { kind: 'rating', value: 2.5 } }],
      ['rescue of 0.5 minutes', 'recordHumanFeedback', { target, feedback: { kind: 'rescue', minutes: 0.5, intervention: 'rescue', cause: 'context' } }],
      ['rescue of 2401 minutes', 'recordHumanFeedback', { target, feedback: { kind: 'rescue', minutes: 2_401, intervention: 'rescue', cause: 'context' } }],
      ['rescue without a cause', 'recordHumanFeedback', { target, feedback: { kind: 'rescue', minutes: 5, intervention: 'rescue' } }],
      ['planned review of 0 minutes', 'recordHumanFeedback', { target, feedback: { kind: 'planned_review', activity: 'review', minutes: 0 } }],
      ['a budget of 0 tokens', 'setTicketBudget', budget({ tokens: 0 })],
      ['a budget of 1.5 tokens', 'setTicketBudget', budget({ tokens: 1.5 })],
      ['a basis without an amount', 'setTicketBudget', budget({ basis: 'person_estimate' })]
    ]
    const before = canonicalJson(p.desktop.ctx().db.all('SELECT * FROM metric_observations ORDER BY 1'))
    for (const [label, name, input] of cases) {
      const answer = await bridge.command(p.folder, name, input as never)
      expect({ label, answer }).toMatchObject({ label, answer: { ok: false, error: { code: 'invalid_input' } } })
    }
    expect(canonicalJson(p.desktop.ctx().db.all('SELECT * FROM metric_observations ORDER BY 1'))).toBe(before)
    // The refused budget edits opened no draft either.
    expect(await bridge.command(p.folder, 'getPlan', { epicId: p.epicId, view: 'draft' })).toMatchObject({ ok: false, error: { message: 'No draft. Open one with openDraft or update_plan_draft.' } })
  })
})

describe('optional human inputs and budget conflicts at the command and bridge layer (DM-183 c4)', () => {
  it('keeps omitted inputs omitted: rescue without minutes is missing, an unrated ticket has no S, a cleared budget is none', async () => {
    const p = await project('Omission')
    const bridge = desktopBridge([p])
    const rescue = await bridge.call(p.folder, 'recordHumanFeedback', { target: { epicId: p.epicId, ticketId: p.guideTicket, runId: p.runId }, feedback: { kind: 'rescue', intervention: 'clarification', cause: 'requirement' } })
    expect(rescue.measurement).toEqual({ state: 'missing', reason: expect.any(String) })
    const grade = await bridge.call(p.folder, 'getTicketGrade', { runId: p.runId, ticketId: p.apiTicket })
    expect(grade.grade.components.find((component) => component.component === 'S')).toMatchObject({ score: null, missingReason: 'no_rating', effectiveWeight: 0 })
    const opened = await bridge.call(p.folder, 'openDraft', { epicId: p.epicId })
    const cleared = await bridge.call(p.folder, 'setTicketBudget', { epicId: p.epicId, ticketId: p.apiTicket, budget: null, expectedDraftRevision: opened.draftRevision ?? 0 })
    const draft = await bridge.call(p.folder, 'getPlan', { epicId: p.epicId, view: 'draft' })
    expect(cleared.draftRevision).toBeGreaterThan(opened.draftRevision ?? 0)
    expect(draft.bundle.tickets.find((ticket) => ticket.id === p.apiTicket)?.budget).toBeUndefined()
  })

  it('refuses a budget edit made on a draft that moved since, keeps the newer draft, and accepts the edit reapplied', async () => {
    const p = await project('Conflict')
    const bridge = desktopBridge([p])
    const opened = (await bridge.call(p.folder, 'openDraft', { epicId: p.epicId })).draftRevision ?? 0
    const firstWindow = await bridge.call(p.folder, 'setTicketBudget', { epicId: p.epicId, ticketId: p.guideTicket, budget: { tokens: 40_000 }, expectedDraftRevision: opened })
    const stale = await bridge.command(p.folder, 'setTicketBudget', { epicId: p.epicId, ticketId: p.guideTicket, budget: null, expectedDraftRevision: opened })
    expect(stale).toMatchObject({ ok: false, error: { code: 'conflict' } })
    const kept = await bridge.call(p.folder, 'getPlan', { epicId: p.epicId, view: 'draft' })
    expect({ revision: kept.draftRevision, budget: kept.bundle.tickets.find((ticket) => ticket.id === p.guideTicket)?.budget }).toEqual({ revision: firstWindow.draftRevision, budget: { tokens: 40_000 } })
    const reapplied = await bridge.call(p.folder, 'setTicketBudget', { epicId: p.epicId, ticketId: p.guideTicket, budget: null, expectedDraftRevision: firstWindow.draftRevision })
    const after = await bridge.call(p.folder, 'getPlan', { epicId: p.epicId, view: 'draft' })
    expect(reapplied.draftRevision).toBeGreaterThan(firstWindow.draftRevision)
    expect(after.bundle.tickets.find((ticket) => ticket.id === p.guideTicket)?.budget).toBeUndefined()
  })
})

describe('frozen grades against later human inputs and budgets (DM-183 c4)', () => {
  it('cannot improve a frozen grade: a later raised budget and rating leave K and the frozen report as they were', async () => {
    // 30,000 tokens spent against a 10,000-token budget frozen before dispatch: K reads 0.
    const p = await project('Frozen', { apiBudgetTokens: 10_000 })
    const bridge = desktopBridge([p])
    const report = await submitReport(p, 'Sprint 1 is over.')
    const k = async () => (await bridge.call(p.folder, 'getTicketGrade', { runId: p.runId, ticketId: p.apiTicket })).grade.components.find((component) => component.component === 'K')?.score
    const frozenBefore = canonicalJson(await bridge.call(p.folder, 'getReportScorecard', { reportId: report.id }))
    expect(await k()).toBe(0)

    p.harness.clock.advanceSeconds(60)
    const opened = await bridge.call(p.folder, 'openDraft', { epicId: p.epicId })
    const raised = await bridge.call(p.folder, 'setTicketBudget', { epicId: p.epicId, ticketId: p.apiTicket, budget: { tokens: 100_000, activeMs: 3_600_000, basis: 'person_estimate' }, expectedDraftRevision: opened.draftRevision ?? 0, runId: p.runId })
    expect(await bridge.call(p.folder, 'savePlan', { epicId: p.epicId, expectedDraftRevision: raised.draftRevision })).toMatchObject({ status: 'saved' })
    await bridge.call(p.folder, 'recordHumanFeedback', { target: { epicId: p.epicId, sprintId: p.sprintId, runId: p.runId }, feedback: { kind: 'rating', value: 5, sharedWithTickets: true } })

    const baselines = await bridge.call(p.folder, 'getPlannedBaselines', { epicId: p.epicId, runId: p.runId })
    const tokens = baselines.tickets.find((ticket) => ticket.ticketId === p.apiTicket)?.budgets.find((budget) => budget.metric === 'tokens')
    expect({ applied: tokens?.applied?.version, statuses: tokens?.versions.map((version) => version.status) }).toEqual({ applied: 1, statuses: ['pinned', 'prospective'] })
    expect(await k()).toBe(0)
    expect(canonicalJson(await bridge.call(p.folder, 'getReportScorecard', { reportId: report.id }))).toBe(frozenBefore)
    const reassessed = await bridge.call(p.folder, 'reassessReportScorecard', { reportId: report.id })
    const api = reassessed.subjects.find((subject) => subject.subject.level === 'ticket' && subject.subject.id === p.apiTicket)
    expect(api?.differences.map((difference) => difference.component)).toEqual(['S'])
  })
})
