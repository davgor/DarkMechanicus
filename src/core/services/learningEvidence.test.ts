import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import { LEARNING_EVIDENCE_KINDS, type LearningEvidenceItem, learningEvidenceSnapshotSchema } from '../../shared/domain/learnings'
import type { SprintReportInput } from '../../shared/domain/api'
import { makeBundle, sid, tid } from '../../test/bundles'
import { errorOf, seedAttempt, seedRun, type SeededRun } from '../../test/checkpointSeed'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { collectLearningEvidence } from './learningEvidence'
import { submitSprintReport } from './reports'
import { recordRowCheck } from './rowChecks'

/** Sprint 1 = {DM-1, DM-2, DM-3}: DM-2 requires DM-1 (rows 1 and 2), DM-3 is the acceptance node. Sprint 2 = {DM-4, DM-5}. */
function plan(): PlanBundle {
  const bundle = makeBundle([[1, 2, 3], [4, 5]], [[1, 2]])
  bundle.tickets = bundle.tickets.map((ticket) =>
    ticket.id === tid(3) || ticket.id === tid(5) ? { ...ticket, kind: 'acceptance' as const } : ticket
  )
  return bundle
}

function setup(): { ctx: TestCtx; run: SeededRun } {
  const ctx = createTestCtx()
  return { ctx, run: seedRun(ctx, { bundle: plan() }) }
}

function collect(ctx: TestCtx, run: SeededRun, sprint = 1) {
  return collectLearningEvidence(ctx, { runId: run.runId, sprintId: sid(sprint) })
}

function setColumns(ctx: TestCtx, attemptId: string, columns: Record<string, string | null>): void {
  for (const [column, value] of Object.entries(columns)) {
    ctx.db.run(`UPDATE attempts SET ${column} = ? WHERE id = ?`, value, attemptId)
  }
}

function report(ctx: TestCtx, run: SeededRun, input: Omit<SprintReportInput, 'summary'>) {
  return submitSprintReport(ctx, { runId: run.runId, sprintId: sid(1), report: { summary: 'Sprint finished.', ...input } })
}

function rowCheck(ctx: TestCtx, run: SeededRun, check: { row: number; status: 'passed' | 'failed' | 'skipped'; detail: string }) {
  const { row, status, detail } = check
  return recordRowCheck(ctx, { runId: run.runId, sprintId: sid(1), row, commit: `${row}`.repeat(40), checks: [{ name: 'npm test', status, detail }] })
}

interface History {
  rejected: string
  failed: string
  reconciled: string
  superseded: string
  nodeFailed: string
  nodeAccepted: string
  staleRowCheck: string
  standingRowCheck: string
  reportId: string
}

/** One sprint with every source kind, retries, a rerun after a failed row check and two report revisions. */
function seedHistory(ctx: TestCtx, run: SeededRun): History {
  const rejected = seedAttempt(ctx, run, { ticket: 1, state: 'rejected', checks: [{ name: 'lint', status: 'failed', detail: '3 errors' }] })
  setColumns(ctx, rejected, {
    decision_json: JSON.stringify({ outcome: 'rejected', notes: 'Retry with the fixture.', reasons: ['Missing migration test', 'c2 unmet'], decidedBy: 'reviewer' }),
    decided_at: '2026-01-01T00:01:00.000Z',
    outputs_json: JSON.stringify({ summary: '', artifacts: [], commits: [], changedFiles: ['src/b.ts', 'src/a.ts', 'C:/abs.ts'], branch: null })
  })
  ctx.clock.advanceSeconds(120)
  const failed = seedAttempt(ctx, run, { ticket: 1, state: 'failed' })
  setColumns(ctx, failed, { failure_json: JSON.stringify({ reason: 'tool missing', details: 'ts-prune not installed', retryable: true }) })
  ctx.clock.advanceSeconds(60)
  const reconciled = seedAttempt(ctx, run, { ticket: 1, state: 'lease_expired', reconciled: true })
  setColumns(ctx, reconciled, { failure_json: JSON.stringify({ reason: 'lease expired', details: 'worker crashed', retryable: true }) })
  ctx.clock.advanceSeconds(60)
  seedAttempt(ctx, run, { ticket: 1, state: 'accepted' })
  const superseded = seedAttempt(ctx, run, { ticket: 2, state: 'rejected', superseded: true })
  setColumns(ctx, superseded, { decision_json: JSON.stringify({ outcome: 'rejected', notes: '', reasons: ['Old plan'], decidedBy: 'reviewer' }) })
  seedAttempt(ctx, run, { ticket: 2, state: 'accepted' })
  ctx.clock.advanceSeconds(60)
  const staleRowCheck = rowCheck(ctx, run, { row: 1, status: 'failed', detail: 'flaky timeout' }).id
  ctx.clock.advanceSeconds(60)
  rowCheck(ctx, run, { row: 1, status: 'passed', detail: 'green after fix' })
  const standingRowCheck = rowCheck(ctx, run, { row: 2, status: 'skipped', detail: 'not run' }).id
  ctx.clock.advanceSeconds(60)
  const nodeFailed = seedAttempt(ctx, run, {
    ticket: 3,
    state: 'rejected',
    checks: [{ name: 'e2e', status: 'failed', detail: 'login broken' }],
    increment: { passed: false, reasons: ['Not squashed'], checks: [{ name: 'Squashed, not merged', status: 'failed', detail: 'merge commit' }] }
  })
  ctx.clock.advanceSeconds(60)
  const nodeAccepted = seedAttempt(ctx, run, { ticket: 3, state: 'accepted', checks: [{ name: 'coverage', status: 'skipped', detail: 'left to CI' }, { name: 'unit', status: 'passed', detail: '' }], increment: {} })
  // Sprint 2's work never belongs to sprint 1's snapshot.
  seedAttempt(ctx, run, { ticket: 4, state: 'failed' })
  ctx.clock.advanceSeconds(60)
  report(ctx, run, { retro: { wentPoorly: ['Superseded complaint'], actions: ['Superseded action'] } })
  ctx.clock.advanceSeconds(60)
  const latest = report(ctx, run, {
    checks: [{ name: 'build', status: 'failed', detail: 'electron-vite failed' }],
    retro: { wentPoorly: ['Reviews  were SLOW', 'Reviews were slow'], actions: ['Pin the fixture clock'] }
  })
  return { rejected, failed, reconciled, superseded, nodeFailed, nodeAccepted, staleRowCheck, standingRowCheck, reportId: latest.id }
}

function find(items: LearningEvidenceItem[], kind: string, sourceId: string): LearningEvidenceItem {
  const item = items.find((candidate) => candidate.kind === kind && candidate.sourceId === sourceId)
  if (item === undefined) throw new Error(`No ${kind} item ${sourceId}`)
  return item
}

describe('collectLearningEvidence: rejected attempts with provenance', () => {
  it('collects each kind from stored facts only, quoting them verbatim', () => {
    const { ctx, run } = setup()
    const history = seedHistory(ctx, run)
    const snapshot = learningEvidenceSnapshotSchema.parse(collect(ctx, run))

    expect(new Set(snapshot.items.map((item) => item.kind))).toEqual(new Set(LEARNING_EVIDENCE_KINDS))
    expect(snapshot).toMatchObject({ runId: run.runId, sprintId: sid(1), sprintOrdinal: 1, revisionId: run.revisionId })

    const rejected = find(snapshot.items, 'rejected_attempt', history.rejected)
    expect(rejected.provenance).toEqual({
      runId: run.runId,
      sprintId: sid(1),
      revisionId: run.revisionId,
      ticketId: tid(1),
      ticketKey: 'DM-1',
      attemptId: history.rejected,
      attemptNumber: 1,
      rowCheckId: null,
      row: null,
      checkNumber: null,
      reportId: null,
      reportRevision: null
    })
    expect(rejected.occurredAt).toBe('2026-01-01T00:01:00.000Z')
    expect(rejected.paths).toEqual(['src/a.ts', 'src/b.ts'])
    expect(rejected.statements).toEqual([
      { field: 'decision.reasons', text: 'Missing migration test' },
      { field: 'decision.reasons', text: 'c2 unmet' },
      { field: 'decision.notes', text: 'Retry with the fixture.' },
      { field: 'evidence.checks.name', text: 'lint' },
      { field: 'evidence.checks.status', text: 'failed' },
      { field: 'evidence.checks.detail', text: '3 errors' }
    ])
  })
})

describe('collectLearningEvidence: failed, reconciled and superseded attempts', () => {
  it('quotes failure reasons of failed and reconciled attempts, and nothing that is not stored', () => {
    const { ctx, run } = setup()
    const history = seedHistory(ctx, run)
    const snapshot = collect(ctx, run)
    expect(find(snapshot.items, 'failed_attempt', history.failed).statements).toEqual([
      { field: 'failure.reason', text: 'tool missing' },
      { field: 'failure.details', text: 'ts-prune not installed' }
    ])
    expect(find(snapshot.items, 'reconciled_attempt', history.reconciled).statements).toEqual([
      { field: 'failure.reason', text: 'lease expired' },
      { field: 'failure.details', text: 'worker crashed' }
    ])
    // Every statement is a stored text: nothing the collector made up.
    const columns = [
      ...ctx.db.all<Record<string, unknown>>('SELECT * FROM attempts'),
      ...ctx.db.all<Record<string, unknown>>('SELECT * FROM row_checks'),
      ...ctx.db.all<Record<string, unknown>>('SELECT content_json FROM sprint_reports')
    ].flatMap((row) => Object.values(row).map(String))
    for (const item of snapshot.items) for (const statement of item.statements) expect(columns.some((value) => value.includes(statement.text))).toBe(true)
  })

  it('keeps superseded attempts as history, not standing', () => {
    const { ctx, run } = setup()
    const history = seedHistory(ctx, run)
    const item = find(collect(ctx, run).items, 'rejected_attempt', history.superseded)
    expect(item.standing).toBe(false)
    expect(item.statements).toEqual([{ field: 'decision.reasons', text: 'Old plan' }])
    expect(find(collect(ctx, run).items, 'rejected_attempt', history.rejected).standing).toBe(true)
  })
})

describe('collectLearningEvidence: row checks, acceptance checks and the latest report', () => {
  it('marks a failed row check a later passing rerun replaced as not standing, and the latest failure as standing', () => {
    const { ctx, run } = setup()
    const history = seedHistory(ctx, run)
    const items = collect(ctx, run).items.filter((item) => item.kind === 'failed_row_check')
    expect(items.map((item) => [item.sourceId, item.provenance.row, item.provenance.checkNumber, item.standing])).toEqual([
      [history.staleRowCheck, 1, 1, false],
      [history.standingRowCheck, 2, 3, true]
    ])
    expect(items[0].statements).toEqual([
      { field: 'commit', text: '1'.repeat(40) },
      { field: 'checks.name', text: 'npm test' },
      { field: 'checks.status', text: 'failed' },
      { field: 'checks.detail', text: 'flaky timeout' }
    ])
  })

  it('collects the acceptance node checks, standing only for its latest attempt', () => {
    const { ctx, run } = setup()
    const history = seedHistory(ctx, run)
    const items = collect(ctx, run).items.filter((item) => item.kind === 'failed_acceptance_check')
    // Ordered by time: the increment was verified (2026-01-01T00:00) before either node attempt was stored.
    expect(items.map((item) => [item.sourceId, item.standing])).toEqual([
      [`${history.nodeFailed}/increment.checks/0`, false],
      [`${history.nodeFailed}/evidence.checks/0`, false],
      [`${history.nodeAccepted}/evidence.checks/0`, true],
      [`${history.reportId}/checks/0`, true]
    ])
    expect(find(items, 'failed_acceptance_check', `${history.nodeAccepted}/evidence.checks/0`).statements).toEqual([
      { field: 'check.name', text: 'coverage' },
      { field: 'check.status', text: 'skipped' },
      { field: 'check.detail', text: 'left to CI' }
    ])
    expect(find(items, 'failed_acceptance_check', `${history.reportId}/checks/0`).provenance).toMatchObject({ reportId: history.reportId, reportRevision: 2 })
  })

  it('reads only the latest report revision', () => {
    const { ctx, run } = setup()
    const history = seedHistory(ctx, run)
    const snapshot = collect(ctx, run)
    expect(snapshot.report).toMatchObject({ id: history.reportId, reportRevision: 2 })
    const retro = snapshot.items.filter((item) => item.kind === 'retro_went_poorly' || item.kind === 'retro_action')
    expect(retro.map((item) => [item.kind, item.sourceId, item.statements[0].text])).toEqual([
      ['retro_went_poorly', `${history.reportId}/retro.wentPoorly/0`, 'Reviews  were SLOW'],
      ['retro_went_poorly', `${history.reportId}/retro.wentPoorly/1`, 'Reviews were slow'],
      ['retro_action', `${history.reportId}/retro.actions/0`, 'Pin the fixture clock']
    ])
    expect(JSON.stringify(snapshot)).not.toContain('Superseded complaint')
  })
})

describe('collectLearningEvidence: stability', () => {
  it('is byte-stable across repeated collection of unchanged state, whatever the clock says', () => {
    const { ctx, run } = setup()
    seedHistory(ctx, run)
    const first = JSON.stringify(collect(ctx, run))
    ctx.clock.advanceSeconds(3600)
    expect(JSON.stringify(collect(ctx, run))).toBe(first)
  })

  it('orders items by kind, time and source id, with hashes over their content', () => {
    const { ctx, run } = setup()
    seedHistory(ctx, run)
    const { items, contentHash } = collect(ctx, run)
    const order = items.map((item) => LEARNING_EVIDENCE_KINDS.indexOf(item.kind))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(new Set(items.map((item) => `${item.kind}/${item.sourceId}`)).size).toBe(items.length)
    expect(new Set(items.map((item) => item.contentHash)).size).toBe(items.length)
    expect(contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('gives restatements that differ only in case and spacing the same fingerprint', () => {
    const { ctx, run } = setup()
    seedHistory(ctx, run)
    const [spaced, plain] = collect(ctx, run).items.filter((item) => item.kind === 'retro_went_poorly')
    expect(spaced.fingerprint).toBe(plain.fingerprint)
    expect(spaced.contentHash).not.toBe(plain.contentHash)
  })

  it('changes the snapshot when a new report revision or row check lands', () => {
    const { ctx, run } = setup()
    seedHistory(ctx, run)
    const before = collect(ctx, run)
    rowCheck(ctx, run, { row: 2, status: 'passed', detail: 'rerun green' })
    const after = collect(ctx, run)
    expect(after.contentHash).not.toBe(before.contentHash)
    expect(after.items.find((item) => item.kind === 'failed_row_check' && item.provenance.row === 2)?.standing).toBe(false)
    const revised = report(ctx, run, { retro: { wentWell: ['All good now'] } })
    const latest = collect(ctx, run)
    expect(latest.report?.reportRevision).toBe(revised.reportRevision)
    expect(latest.items.some((item) => item.kind === 'retro_went_poorly')).toBe(false)
  })
})

describe('collectLearningEvidence: empty and legacy sprints', () => {
  it('gives a valid empty snapshot for a sprint without negative evidence or a report', () => {
    const { ctx, run } = setup()
    for (const ticket of [1, 2, 3]) seedAttempt(ctx, run, { ticket, state: 'accepted' })
    const snapshot = learningEvidenceSnapshotSchema.parse(collect(ctx, run))
    expect(snapshot.items).toEqual([])
    expect(snapshot.report).toBeNull()
    expect(collect(ctx, run, 2).items).toEqual([])
  })

  it('gives a valid empty snapshot for a clean report with a retro saying nothing poor', () => {
    const { ctx, run } = setup()
    report(ctx, run, { checks: [{ name: 'test', status: 'passed', detail: '' }], retro: { wentWell: ['Smooth'] } })
    const snapshot = learningEvidenceSnapshotSchema.parse(collect(ctx, run))
    expect(snapshot.items).toEqual([])
    expect(snapshot.report?.reportRevision).toBe(1)
  })

  it('reads a null retro and a legacy report stored without a retro key as no retro evidence', () => {
    const { ctx, run } = setup()
    const nullRetro = report(ctx, run, { retro: null, checks: [{ name: 'build', status: 'failed', detail: 'x' }] })
    expect(collect(ctx, run).items.map((item) => item.kind)).toEqual(['failed_acceptance_check'])
    const legacy = JSON.parse(ctx.db.get<{ content_json: string }>('SELECT content_json FROM sprint_reports WHERE id = ?', nullRetro.id)?.content_json ?? '{}') as Record<string, unknown>
    delete legacy.retro
    ctx.db.run('UPDATE sprint_reports SET content_json = ? WHERE id = ?', JSON.stringify(legacy), nullRetro.id)
    expect(learningEvidenceSnapshotSchema.parse(collect(ctx, run)).items.map((item) => item.kind)).toEqual(['failed_acceptance_check'])
  })

  it('refuses a sprint that is not in the pinned plan', () => {
    const { ctx, run } = setup()
    expect(errorOf(() => collectLearningEvidence(ctx, { runId: run.runId, sprintId: sid(9) })).code).toBe('not_found')
  })
})
