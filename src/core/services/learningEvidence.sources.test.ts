/**
 * DM-933: sprint learning evidence from sparse, folder-of-repositories and legacy records: evidence without checks or
 * criteria, per-repository increment verdicts, superseded acceptance attempts, blank retro entries, a row check
 * for a row the plan no longer has, and many items of one kind at one time ordered by source id.
 */
import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import { learningEvidenceSnapshotSchema } from '../../shared/domain/learnings'
import { makeBundle, makeTicket, sid } from '../../test/bundles'
import { incrementVerdict, seedAttempt, seedRun, type SeededRun } from '../../test/checkpointSeed'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { collectLearningEvidence } from './learningEvidence'
import { submitSprintReport } from './reports'

/** Sprint 1 = {DM-1 in repository api, DM-2 in no repository, DM-3 the acceptance node}. */
function plan(): PlanBundle {
  const bundle = makeBundle([[1, 2, 3]])
  bundle.tickets = [makeTicket(1, { repo: 'api', title: 'api - Ticket 1' }), makeTicket(2), makeTicket(3, { kind: 'acceptance' })]
  return bundle
}

function setup(): { ctx: TestCtx; run: SeededRun } {
  const ctx = createTestCtx()
  return { ctx, run: seedRun(ctx, { bundle: plan() }) }
}

const collect = (ctx: TestCtx, run: SeededRun) => learningEvidenceSnapshotSchema.parse(collectLearningEvidence(ctx, { runId: run.runId, sprintId: sid(1) }))

function setColumn(ctx: TestCtx, attemptId: string, column: 'decision_json' | 'evidence_json' | 'increment_json', value: unknown): void {
  ctx.db.run(`UPDATE attempts SET ${column} = ? WHERE id = ?`, JSON.stringify(value), attemptId)
}

describe('collectLearningEvidence: sparse attempt evidence and repositories', () => {
  it('quotes worker notes of evidence stored without checks or criteria, scoped to the ticket repository', () => {
    const { ctx, run } = setup()
    const inApi = seedAttempt(ctx, run, { ticket: 1, state: 'rejected' })
    setColumn(ctx, inApi, 'decision_json', { outcome: 'rejected', notes: '', reasons: ['Too slow'], decidedBy: 'reviewer' })
    setColumn(ctx, inApi, 'evidence_json', { notes: 'Ran out of time' })
    const anywhere = seedAttempt(ctx, run, { ticket: 2, state: 'rejected' })
    setColumn(ctx, anywhere, 'decision_json', { outcome: 'rejected', notes: '', reasons: ['No tests'], decidedBy: 'reviewer' })
    const items = collect(ctx, run).items
    expect(items.map((item) => [item.sourceId, item.repositories, item.statements])).toEqual([
      [inApi, ['api'], [{ field: 'decision.reasons', text: 'Too slow' }, { field: 'evidence.notes', text: 'Ran out of time' }]],
      [anywhere, [], [{ field: 'decision.reasons', text: 'No tests' }]]
    ])
  })
})

describe('collectLearningEvidence: acceptance node verdicts', () => {
  it('collects each repository verdict of a folder under its own repository, standing only for the latest attempt', () => {
    const { ctx, run } = setup()
    const failing = { passed: false, checks: [{ name: 'Squashed, not merged', status: 'failed' as const, detail: 'merge commit' }] }
    const earlier = seedAttempt(ctx, run, { ticket: 3, state: 'rejected', superseded: true })
    setColumn(ctx, earlier, 'increment_json', [incrementVerdict({ ...failing, repo: 'api' })])
    const latest = seedAttempt(ctx, run, { ticket: 3, state: 'rejected' })
    setColumn(ctx, latest, 'increment_json', [incrementVerdict({ repo: 'api' }), incrementVerdict({ ...failing, repo: 'web' })])
    const items = collect(ctx, run).items.filter((item) => item.kind === 'failed_acceptance_check')
    expect(items.map((item) => [item.sourceId, item.standing, item.repositories])).toEqual([
      [`${earlier}/increments/0/checks/0`, false, ['api']],
      [`${latest}/increments/1/checks/0`, true, ['web']]
    ])
  })
})

describe('collectLearningEvidence: legacy and blank records', () => {
  it('collects a failed row check of a row the pinned plan no longer has without a repository', () => {
    const { ctx, run } = setup()
    ctx.db.run(
      `INSERT INTO row_checks (id, run_id, number, sprint_id, row_no, commit_ref, checks_json, recorded_by, created_at)
       VALUES ('rk_00000000000000000000000001', ?, 1, ?, 9, ?, ?, 'test orchestrator', ?)`,
      run.runId, sid(1), '9'.repeat(40), JSON.stringify([{ name: 'npm test', status: 'failed', detail: 'red' }]), ctx.clock.nowIso()
    )
    expect(collect(ctx, run).items.map((item) => [item.kind, item.provenance.row, item.repositories])).toEqual([['failed_row_check', 9, []]])
  })

  it('skips a blank retro entry and orders many entries of one time by source id', () => {
    const { ctx, run } = setup()
    const wentPoorly = Array.from({ length: 12 }, (_, index) => `Problem ${index}`)
    const report = submitSprintReport(ctx, { runId: run.runId, sprintId: sid(1), report: { summary: 'Done.', retro: { wentPoorly, actions: ['Pin clocks'] } } })
    const content = JSON.parse(ctx.db.get<{ content_json: string }>('SELECT content_json FROM sprint_reports WHERE id = ?', report.id)?.content_json ?? '{}')
    content.retro.actions = ['   ']
    ctx.db.run('UPDATE sprint_reports SET content_json = ? WHERE id = ?', JSON.stringify(content), report.id)
    const items = collect(ctx, run).items
    const ids = wentPoorly.map((_, index) => `${report.id}/retro.wentPoorly/${index}`)
    expect(items.map((item) => item.sourceId)).toEqual([...ids].sort())
    expect(items.every((item) => item.kind === 'retro_went_poorly')).toBe(true)
  })
})
