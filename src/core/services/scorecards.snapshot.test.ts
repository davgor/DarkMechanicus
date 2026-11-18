/**
 * DM-178 c3/c4 inside one database: a report revision freezes its scorecard once (policy, plan revision, report hash,
 * cutoff, inputs, sources), a restart and later records, ratings and adoptions leave it byte for byte, a changed report
 * follows the stale-approval rules, legacy reports stay readable and ungraded, and a dated reassessment keeps the
 * approved grade while explaining every difference over comparable windows. Export and import: src/core/repo.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ScorecardReassessment, ScorecardSnapshot } from '../../shared/domain/spaceGrades'
import { makeTicket, sid, tid } from '../../test/bundles'
import { domainError, tempDatabasePath } from '../../test/execution'
import { createStubGit, importerDeps, initProject } from '../../test/repoEnv'
import { adopt, deliver, MIN, moveToSprint2, overhead, reject, report, spaceWorld, type SpaceWorld, work } from '../../test/spaceWorld'
import { createRepoEnv } from '../../test/repoEnv'
import { createTestCtx } from '../../test/testContext'
import { canonicalJson } from '../canonical'
import { openDatabase } from '../db/database'
import { reconcileRepository } from '../repo/importer'
import { ownedPaths } from '../repo/paths'
import { frozenInput } from '../space/snapshot'
import { underPolicyV1 } from '../../test/policyV1'
import { approveCheckpoint, getCheckpoint } from './checkpoints'
import { recordHumanFeedback } from './humanFeedback'
import { getSprintReport } from './reports'
import { freezeScorecard, getReportScorecard, reassessReportScorecard, storedScorecard } from './scorecards'
import { getSprintGrade } from './spaceGrades'
import { projectRunTiming } from './timing'

const storedBytes = (w: SpaceWorld, reportId: string): string | null =>
  w.ctx.db.get<{ scorecard_json: string | null }>('SELECT scorecard_json FROM sprint_reports WHERE id = ?', reportId)?.scorecard_json ?? null

function frozenSnapshot(w: SpaceWorld, reportId: string): ScorecardSnapshot {
  const read = getReportScorecard(w.ctx, { reportId })
  if (read.state !== 'frozen') throw new Error(`report ${reportId} has no scorecard`)
  return read.scorecard.snapshot
}

/** Tickets 1-3 delivered (ticket 2 after one rejected try), 10 minutes of sprint orchestration, the sprint reported. */
function reportedSprint() {
  const w = spaceWorld({ overhead: false, retryLimit: 3 })
  deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 18, corrective: 2 })
  reject(w, work(w, 2, { minutes: 10, tokens: 10_000, productive: 8, corrective: 2 }), 'not yet')
  deliver(w, 2, { minutes: 20, tokens: 30_000, productive: 18, corrective: 2 })
  deliver(w, 3, { minutes: 20, tokens: 30_000, productive: 18, corrective: 2 })
  overhead(w, 10, 20_000)
  return { w, first: report(w) }
}

describe('DM-178 c3: a report revision freezes its scorecard', () => {
  it('records the policy, plan revision, report hash, cutoff, every grade input and the source ids', () => {
    const { w, first } = reportedSprint()
    const snapshot = frozenSnapshot(w, first.id)
    const revisionId = w.ctx.db.get<{ revision_id: string }>('SELECT revision_id FROM runs WHERE id = ?', w.runId)?.revision_id
    expect(snapshot.report).toEqual({ reportId: first.id, reportRevision: 1, contentHash: first.contentHash })
    expect(snapshot.planRevisionId).toBe(revisionId)
    expect(snapshot.cutoff).toBe(first.createdAt)
    expect(snapshot.policy.version).toBe(2)
    expect(frozenInput(snapshot, snapshot.sprint).components.T.baseline.state).toBe('selected')
    expect(snapshot.tickets.map((grade) => grade.subject.id)).toEqual([tid(1), tid(2), tid(3)])
    expect(snapshot.sources).toMatchObject({ runIds: [w.runId], ticketIds: [tid(1), tid(2), tid(3)] })
    expect(snapshot.sources.attemptIds).toHaveLength(4)
    expect(snapshot.epic?.subject).toEqual({ level: 'epic', id: w.epicId })
    expect(snapshot.timing).toMatchObject({ asOf: first.createdAt, basis: { window: 'activation', totals: 'current_plan' } })
    expect(snapshot.timing.tickets.find((ticket) => ticket.ticketId === tid(1))?.active.ms).toBe(20 * MIN)
  })

  it('shows the frozen sprint, run and epic grades on the report view', () => {
    const { first } = reportedSprint()
    expect(first.scorecard?.grades.map((grade) => [grade.subject.level, grade.displayScore, grade.letter])).toEqual([
      ['sprint', '92.9', 'A'],
      ['run', '92.9', 'A'],
      ['epic', '92.9', 'A']
    ])
  })

  it('survives a restart byte for byte', () => {
    const { w, first } = reportedSprint()
    const bytes = storedBytes(w, first.id)
    const file = tempDatabasePath()
    try {
      w.ctx.db.run(`VACUUM INTO '${file.path.replace(/'/g, "''")}'`)
      const reopened = openDatabase(file.path)
      try {
        const after = createTestCtx({ db: reopened, clock: w.ctx.clock })
        expect(reopened.get<{ scorecard_json: string }>('SELECT scorecard_json FROM sprint_reports WHERE id = ?', first.id)?.scorecard_json).toBe(bytes)
        expect(getSprintReport(after, { runId: w.runId })?.scorecard).toEqual(first.scorecard)
      } finally {
        reopened.close()
      }
    } finally {
      file.cleanup()
    }
  })
})

describe('DM-178 c3: a frozen scorecard stays as written', () => {
  it('stays byte for byte as written after later ratings, overhead and an adoption that move the live grade', () => {
    const { w, first } = reportedSprint()
    const bytes = storedBytes(w, first.id)
    const read = canonicalJson(getReportScorecard(w.ctx, { reportId: first.id }))
    recordHumanFeedback(w.desktop, { target: { epicId: w.epicId, ticketId: tid(1), runId: w.runId }, feedback: { kind: 'rating', value: 2 }, person: 'Dana' })
    w.ctx.clock.advanceSeconds(600)
    overhead(w, 60, 500_000)
    adopt(w, (plan) => ({ ...plan, tickets: [...plan.tickets, makeTicket(7, { size: 'medium' })], sprints: plan.sprints.map((s) => ({ ...s, ticketIds: [...s.ticketIds, tid(7)] })) }))
    const live = getSprintGrade(w.ctx, { runId: w.runId, sprintId: w.sprintId })
    expect(live.grade.score).not.toBe(frozenSnapshot(w, first.id).sprint.result.score)
    expect(storedBytes(w, first.id)).toBe(bytes)
    expect(canonicalJson(getReportScorecard(w.ctx, { reportId: first.id }))).toBe(read)
  })

  it('keeps reading a snapshot under the policy it was frozen with while another policy is current', () => {
    const { w, first } = reportedSprint()
    w.ctx.db.run('UPDATE sprint_reports SET scorecard_json = ? WHERE id = ?', storedScorecard(underPolicyV1(frozenSnapshot(w, first.id))), first.id)
    const read = getReportScorecard(w.ctx, { reportId: first.id })
    const ticket2 = read.state === 'frozen' ? read.scorecard.tickets[1] : undefined
    expect(ticket2?.policy.version).toBe(1)
    // Under v1 the rejected submission's passed checks still count passed; v2 (current) would read C 50.
    expect(ticket2?.components.find((entry) => entry.component === 'C')?.score).toBe(100)
  })

  it('freezes a changed report as a new revision with its own snapshot under the existing stale-approval rules', () => {
    const { w, first } = reportedSprint()
    const bytes = storedBytes(w, first.id)
    adopt(w, (plan) => ({ ...plan, tickets: [...plan.tickets, makeTicket(7, { size: 'medium' })], sprints: plan.sprints.map((s) => ({ ...s, ticketIds: [...s.ticketIds, tid(7)] })) }))
    expect(domainError(() => approveCheckpoint(w.desktop, { runId: w.runId, reportId: first.id })).code).toBe('gate_blocked')
    w.ctx.clock.advanceSeconds(60)
    const second = report(w, 'Sprint 1 is over (revised).')
    const snapshot = frozenSnapshot(w, second.id)
    expect(second.reportRevision).toBe(2)
    expect(snapshot.snapshotId).not.toBe(frozenSnapshot(w, first.id).snapshotId)
    expect(snapshot.report).toEqual({ reportId: second.id, reportRevision: 2, contentHash: second.contentHash })
    expect(snapshot.cutoff).toBe(second.createdAt)
    expect(getCheckpoint(w.ctx, { runId: w.runId }).approval).toBeNull()
    expect(domainError(() => approveCheckpoint(w.desktop, { runId: w.runId, reportId: first.id })).code).toBe('conflict')
    expect(storedBytes(w, first.id)).toBe(bytes)
  })
})

const LEGACY_DIR = fileURLToPath(new URL('../repo/__mocks__/legacy/', import.meta.url))
const LEGACY = { epicId: 'ep_01m3txy30qavmd5wewct90804g', revisionId: 'rv_01m3txzpv9ws6fbj6p211ghkn9', runId: 'rn_01m3txzt9wj79mxsq50f5ktf1q' }
const legacyText = (...parts: string[]): string => readFileSync(join(LEGACY_DIR, ...parts), 'utf8').replace(/\r\n/g, '\n')

/** A database that imported the real records of a run whose report predates scorecards. */
function legacyImport() {
  const env = createRepoEnv({ root: '/legacy' })
  initProject(env)
  const paths = ownedPaths(env.layout)
  const { epicId, revisionId, runId } = LEGACY
  env.fs.put(join(env.layout.dmDir, 'project.json'), legacyText('project.json'))
  env.fs.put(paths.epicPointerFile(epicId), legacyText('epics', epicId, 'current.json'))
  env.fs.put(paths.epicStateFile(epicId), legacyText('epics', epicId, 'state.json'))
  env.fs.put(paths.snapshotFile(epicId, revisionId), legacyText('epics', epicId, 'snapshots', `${revisionId}.json`))
  env.fs.put(paths.runHistoryFile(runId), legacyText('history', runId, 'run.json'))
  const result = reconcileRepository(importerDeps(env, createStubGit()))
  const ctx = createTestCtx({ db: env.db, clock: env.clock })
  const reportId = env.db.get<{ id: string }>('SELECT id FROM sprint_reports WHERE run_id = ? ORDER BY report_revision DESC', runId)?.id ?? ''
  return { env, ctx, result, reportId }
}

describe('DM-178 c4: legacy reports stay readable and ungraded', () => {
  it('imports a report recorded before scorecards and reads it with its content and no scorecard', () => {
    const { ctx, result } = legacyImport()
    expect(result.rejected).toEqual([])
    const sprintId = ctx.db.get<{ sprint_id: string }>('SELECT sprint_id FROM sprint_reports WHERE run_id = ?', LEGACY.runId)?.sprint_id ?? ''
    const view = getSprintReport(ctx, { runId: LEGACY.runId, sprintId })
    expect(view?.scorecard).toBeUndefined()
    expect(view?.report.summary.length).toBeGreaterThan(0)
  })

  it('reads its scorecard as legacy (ungraded), never a live grade standing in', () => {
    const { ctx, reportId } = legacyImport()
    expect(getReportScorecard(ctx, { reportId })).toMatchObject({ state: 'legacy', report: { reportId, runId: LEGACY.runId } })
  })

  it('reassesses it as a dated reading only: no approved grade, every subject legacy, nothing written', () => {
    const { ctx, env, reportId } = legacyImport()
    const reassessed = reassessReportScorecard(ctx, { reportId })
    expect(reassessed).toMatchObject({ legacy: true, approved: null })
    expect(reassessed.subjects.length).toBeGreaterThan(0)
    expect(reassessed.subjects.every((subject) => subject.membership === 'legacy' && subject.approved === null)).toBe(true)
    expect(env.db.get<{ scorecard_json: string | null }>('SELECT scorecard_json FROM sprint_reports WHERE id = ?', reportId)?.scorecard_json).toBeNull()
  })
})

const find = (reassessment: ScorecardReassessment, level: string, id: string) => reassessment.subjects.find((s) => s.subject.level === level && s.subject.id === id)

/** Sprint 1 reported; then a rating, overhead and an adoption moving ticket 3 to sprint 2 and adding ticket 7. */
function laterChanges() {
  const w = spaceWorld({ overhead: false, secondSprint: true, retryLimit: 3 })
  deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
  reject(w, work(w, 2, { minutes: 10, tokens: 10_000, productive: 10 }), 'not yet')
  deliver(w, 2, { minutes: 20, tokens: 30_000, productive: 20 })
  deliver(w, 3, { minutes: 20, tokens: 30_000, productive: 20 })
  const first = report(w)
  const approved = storedBytes(w, first.id)
  w.ctx.clock.advanceSeconds(3600)
  recordHumanFeedback(w.desktop, { target: { epicId: w.epicId, ticketId: tid(1), runId: w.runId }, feedback: { kind: 'rating', value: 2 }, person: 'Dana' })
  overhead(w, 30, 100_000)
  adopt(w, (plan) => ({
    ...plan,
    tickets: [...plan.tickets, makeTicket(7, { size: 'medium' })],
    sprints: plan.sprints.map((s) => (s.id === sid(1) ? { ...s, ticketIds: [...s.ticketIds.filter((id) => id !== tid(3)), tid(7)] } : { ...s, ticketIds: [...s.ticketIds, tid(3)] }))
  }))
  return { w, first, approved, later: reassessReportScorecard(w.ctx, { reportId: first.id }) }
}

describe('DM-178 c4: a dated reassessment keeps the approved grade and explains differences', () => {
  it('returns the approved snapshot untouched and never rewrites the stored bytes', () => {
    const { w, first, approved, later } = laterChanges()
    expect(canonicalJson(later.approved)).toBe(approved)
    expect(storedBytes(w, first.id)).toBe(approved)
  })

  it('names a rating recorded after the cutoff as the cause of a moved S, with the same window agreeing with the approved grade', () => {
    const ticket1 = find(laterChanges().later, 'ticket', tid(1))
    expect(ticket1).toMatchObject({ membership: 'kept', windows: { comparable: true } })
    expect(ticket1?.differences.find((difference) => difference.component === 'S')).toMatchObject({ causes: ['later_records'], approved: { state: 'missing' }, current: { score: 25 } })
    expect(ticket1?.sameWindow?.score).toBe(ticket1?.approved?.score)
    expect(ticket1?.windows.approved.from).toBe(ticket1?.windows.current.from)
  })

  it('lists a frozen ticket since moved out as left and one added later as joined', () => {
    const { later } = laterChanges()
    expect(find(later, 'ticket', tid(3))).toMatchObject({ membership: 'left', approved: expect.objectContaining({ letter: 'A' }) })
    expect(find(later, 'ticket', tid(7))).toMatchObject({ membership: 'joined', approved: null })
  })

  it('explains the sprint’s moved T by its changed inputs', () => {
    const { later } = laterChanges()
    const t = find(later, 'sprint', sid(1))?.differences.find((difference) => difference.component === 'T')
    expect(t?.causes).toContain('later_records')
    expect(t?.detail).toContain('actual')
  })
})

describe('DM-178 c4: what a reassessment compares with', () => {
  it('names the policy as the only cause when the approved snapshot was frozen under another policy', () => {
    const w = spaceWorld({ overhead: false, retryLimit: 3 })
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
    reject(w, work(w, 2, { minutes: 10, tokens: 10_000, productive: 10 }), 'not yet')
    deliver(w, 2, { minutes: 20, tokens: 30_000, productive: 20 })
    const first = report(w)
    w.ctx.db.run('UPDATE sprint_reports SET scorecard_json = ? WHERE id = ?', storedScorecard(underPolicyV1(frozenSnapshot(w, first.id))), first.id)
    const c = find(reassessReportScorecard(w.ctx, { reportId: first.id }), 'ticket', tid(2))?.differences.find((difference) => difference.component === 'C')
    expect(c).toMatchObject({ causes: ['policy_changed'], approved: { score: 100 }, sameWindow: { score: 50 } })
  })

  it('freezes the readiness a moved ticket had in the sprint that held it at its first claim', () => {
    const w = spaceWorld({ overhead: false, secondSprint: true, retryLimit: 3 })
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
    reject(w, work(w, 3, { minutes: 10, tokens: 10_000, productive: 10 }), 'not yet')
    const before = projectRunTiming(w.ctx, { runId: w.runId }).tickets.find((ticket) => ticket.ticketId === tid(3))?.readyAt
    moveToSprint2(w, tid(3))
    const after = projectRunTiming(w.ctx, { runId: w.runId })
    expect(before).toBe('2026-11-15T09:00:00.000Z')
    expect(after.tickets.find((ticket) => ticket.ticketId === tid(3))?.readyAt).toBe(before)
    expect(after.anomalies.map((anomaly) => anomaly.kind)).not.toContain('event_out_of_place')
  })

  it('freezes a lease expiry the records do not hold as an estimated_time anomaly', () => {
    const w = spaceWorld({ overhead: false })
    const resubmitted = work(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
    // As a run imported from another machine holds it: the lease expired and a reconcile resubmitted the attempt.
    w.ctx.db.run('UPDATE attempts SET reconciled_at = ? WHERE id = ?', w.ctx.clock.nowIso(), resubmitted)
    w.ctx.db.run("DELETE FROM events WHERE kind = 'attempt.lease_expired'")
    const frozen = freezeScorecard(w.ctx, { runId: w.runId, sprintId: w.sprintId, report: { reportId: 'rp_00000000000000000000000zzz', reportRevision: 1, contentHash: `sha256:${'0'.repeat(64)}` }, cutoff: w.ctx.clock.nowIso() })
    expect(frozen.timing.anomalies).toContainEqual(expect.objectContaining({ kind: 'estimated_time', subject: resubmitted }))
    expect(frozen.timing.tickets.find((ticket) => ticket.ticketId === tid(1))?.active.ms).toBe(20 * MIN)
  })
})
