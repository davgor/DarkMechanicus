import { describe, expect, it } from 'vitest'
import type { SprintReportInput } from '../../shared/domain/api'
import type { SprintReportContent } from '../../shared/domain/views'
import { sid } from '../../test/bundles'
import {
  errorOf,
  eventLog,
  outboxEntries,
  runRow,
  seedRun,
  type SeedRunOptions
} from '../../test/checkpointSeed'
import { createTestCtx, withRole, type TestCtx } from '../../test/testContext'
import { contentHash } from '../canonical'
import { getSprintReport, submitSprintReport } from './reports'

function setup(options: SeedRunOptions = {}): { ctx: TestCtx; runId: string; epicId: string } {
  const ctx = createTestCtx()
  const run = seedRun(ctx, options)
  return { ctx, runId: run.runId, epicId: run.epicId }
}

function submit(ctx: TestCtx, runId: string, report: SprintReportInput, sprintId = sid(1)) {
  return submitSprintReport(ctx, { runId, sprintId, report })
}

const MINIMAL: SprintReportContent = {
  summary: 'Sprint 1 delivered the parts.',
  accepted: [],
  failed: [],
  blocked: [],
  changes: { files: [], commits: [] },
  checks: [],
  risks: [],
  followUps: [],
  exitCriteria: [],
  epicOutcome: null
}

const FULL: SprintReportContent = {
  summary: 'Driver selection finished; macOS signing is unproven.',
  accepted: ['DM-1'],
  failed: ['DM-2'],
  blocked: ['DM-3'],
  changes: { files: ['src/db.ts'], commits: ['3f9a0d1'] },
  checks: [
    { name: 'Typecheck', status: 'passed', detail: '0 errors' },
    { name: 'Package macos', status: 'failed', detail: 'codesign identity missing' }
  ],
  risks: ['Keychain access on CI runners'],
  followUps: [{ title: 'Provide a signing identity', body: 'Certificate access needs a person' }],
  exitCriteria: [{ criterionId: 'x1', met: false, note: 'macOS unverified' }],
  epicOutcome: { summary: 'Partially delivered', successCriteria: [{ criterionId: 's1', met: false, note: '' }] }
}

describe('submitSprintReport storage', () => {
  it('stores a minimal report with defaults as revision 1 and moves the run to its checkpoint', () => {
    const { ctx, runId } = setup()
    const view = submit(ctx, runId, { summary: MINIMAL.summary })
    expect(view).toEqual({
      id: expect.stringMatching(/^rp_[0-9a-z]{26}$/),
      runId,
      sprintId: sid(1),
      reportRevision: 1,
      contentHash: contentHash(MINIMAL),
      report: MINIMAL,
      submittedBy: ctx.session.id,
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    expect(runRow(ctx, runId)).toMatchObject({ state: 'awaiting_checkpoint', revision: 2 })
  })

  it('stores accepted, failed, and blocked work, changes, checks, risks, follow-ups, exit criteria, and the outcome', () => {
    const { ctx, runId } = setup()
    const view = submit(ctx, runId, FULL)
    expect(view.report).toEqual(FULL)
    expect(view.contentHash).toBe(contentHash(FULL))
    expect(getSprintReport(ctx, { runId })).toEqual(view)
  })

  it('numbers later revisions per sprint and leaves an awaiting run waiting', () => {
    const { ctx, runId } = setup()
    const first = submit(ctx, runId, { summary: 'First draft' })
    ctx.clock.advanceSeconds(60)
    const second = submit(ctx, runId, { summary: 'Second draft' })
    expect([first.reportRevision, second.reportRevision]).toEqual([1, 2])
    expect(second.createdAt).toBe('2026-01-01T00:01:00.000Z')
    expect(runRow(ctx, runId)).toMatchObject({ state: 'awaiting_checkpoint', revision: 2 })
    expect(getSprintReport(ctx, { runId })?.id).toBe(second.id)
  })

  it('records the submission event and a run-history export', () => {
    const { ctx, runId, epicId } = setup()
    submit(ctx, runId, { summary: 'Done' })
    expect(eventLog(ctx)).toEqual([
      { kind: 'report.submitted', epicId, runId, ticketId: null, payload: { sprintId: sid(1), reportRevision: 1 } }
    ])
    expect(outboxEntries(ctx)).toEqual([{ kind: 'run_history', epic_id: epicId, run_id: runId }])
  })

})

describe('submitSprintReport idempotency', () => {
  it('returns the original report for a repeated idempotency key', () => {
    const { ctx, runId } = setup()
    const input = { runId, sprintId: sid(1), report: { summary: 'Once' }, idempotencyKey: 'report-1' }
    const first = submitSprintReport(ctx, input)
    expect(submitSprintReport(ctx, input)).toEqual(first)
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sprint_reports')?.n).toBe(1)
    const reused = errorOf(() => submitSprintReport(ctx, { ...input, report: { summary: 'Twice' } }))
    expect(reused.code).toBe('idempotency_mismatch')
  })
})

interface IndexRow {
  doc_type: string
  doc_id: string
  epic_id: string
  run_id: string | null
  ticket_id: string | null
  title: string
  body: string
}

function indexRows(ctx: TestCtx): IndexRow[] {
  return ctx.db.all<IndexRow>('SELECT doc_type, doc_id, epic_id, run_id, ticket_id, title, body FROM search_index')
}

describe('submitSprintReport search indexing', () => {
  it('indexes the summary, risks, follow-ups, checks, and outcome under "Sprint N report"', () => {
    const { ctx, runId, epicId } = setup()
    const view = submit(ctx, runId, FULL)
    const body = [
      FULL.summary,
      'Keychain access on CI runners',
      'Provide a signing identity',
      'Certificate access needs a person',
      'Typecheck',
      '0 errors',
      'Package macos',
      'codesign identity missing',
      'Partially delivered'
    ].join('\n')
    expect(indexRows(ctx)).toEqual([
      { doc_type: 'report', doc_id: view.id, epic_id: epicId, run_id: runId, ticket_id: null, title: 'Sprint 1 report', body }
    ])
  })

  it('skips empty parts and keeps only the latest revision of a sprint report', () => {
    const { ctx, runId } = setup()
    submit(ctx, runId, { summary: 'Old wording' })
    const latest = submit(ctx, runId, { summary: 'Only summary', checks: [{ name: 'Lint', status: 'passed', detail: '' }] })
    expect(indexRows(ctx).map((row) => [row.doc_id, row.body])).toEqual([[latest.id, 'Only summary\nLint']])
  })

  it('titles the report with the ordinal of the active sprint', () => {
    const { ctx, runId } = setup({ activeSprint: 2 })
    submit(ctx, runId, { summary: 'Integration' }, sid(2))
    expect(indexRows(ctx).map((row) => row.title)).toEqual(['Sprint 2 report'])
  })
})

describe('submitSprintReport guards', () => {
  it('rejects a report for a sprint other than the active one and names the active sprint', () => {
    const { ctx, runId } = setup()
    const result = errorOf(() => submit(ctx, runId, { summary: 'Wrong sprint' }, sid(2)))
    expect(result.code).toBe('conflict')
    expect(result.message).toContain(`Sprint 1 (${sid(1)})`)
    expect(result.details).toEqual({ sprintId: sid(2), activeSprintId: sid(1) })
    expect(getSprintReport(ctx, { runId, sprintId: sid(2) })).toBeNull()
  })

  it('rejects a running run without an active sprint', () => {
    const { ctx, runId } = setup({ activeSprint: null })
    const result = errorOf(() => submit(ctx, runId, { summary: 'Nowhere' }))
    expect(result.code).toBe('conflict')
    expect(result.message).toBe('Run #1 has no active sprint.')
  })

  it('accepts reports only while the run is running or awaiting its checkpoint', () => {
    const ctx = createTestCtx()
    const codes = (['queued', 'paused', 'completed', 'canceled', 'failed'] as const).map((state) => {
      const run = seedRun(ctx, { state })
      return errorOf(() => submit(ctx, run.runId, { summary: 'Late' })).code
    })
    expect(codes).toEqual(['run_not_active', 'run_not_active', 'run_not_active', 'run_not_active', 'run_not_active'])
    const waiting = seedRun(ctx, { state: 'awaiting_checkpoint' })
    expect(submit(ctx, waiting.runId, { summary: 'Revised' }).reportRevision).toBe(1)
  })

  it('rejects runs owned by another machine', () => {
    const { ctx, runId } = setup({ ownerMachineId: 'mc_00000000000000000000000099' })
    const result = errorOf(() => submit(ctx, runId, { summary: 'Foreign' }))
    expect(result).toMatchObject({ code: 'run_not_owned', message: 'This run belongs to another machine; take it over first.' })
  })

  it('requires the report.submit capability and an existing run', () => {
    const { ctx, runId } = setup()
    expect(errorOf(() => submit(withRole(ctx, 'desktop'), runId, { summary: 'x' })).code).toBe('unauthorized')
    expect(errorOf(() => submit(withRole(ctx, 'worker'), runId, { summary: 'x' })).code).toBe('unauthorized')
    expect(errorOf(() => submit(ctx, 'rn_00000000000000000000000404', { summary: 'x' })).code).toBe('not_found')
    expect(runRow(ctx, runId)?.state).toBe('running')
  })
})

describe('getSprintReport', () => {
  it('returns the latest report of the active sprint or of an explicit sprint', () => {
    const { ctx, runId } = setup()
    const view = submit(ctx, runId, { summary: 'Sprint 1' })
    expect(getSprintReport(withRole(ctx, 'worker'), { runId })).toEqual(view)
    expect(getSprintReport(ctx, { runId, sprintId: sid(1) })).toEqual(view)
    expect(getSprintReport(ctx, { runId, sprintId: sid(2) })).toBeNull()
  })

  it('returns null without a report or an active sprint', () => {
    const ctx = createTestCtx()
    expect(getSprintReport(ctx, { runId: seedRun(ctx).runId })).toBeNull()
    expect(getSprintReport(ctx, { runId: seedRun(ctx, { activeSprint: null }).runId })).toBeNull()
  })

  it('requires read access and an existing run', () => {
    const { ctx, runId } = setup()
    const blind = createTestCtx({ db: ctx.db, capabilities: [] })
    expect(errorOf(() => getSprintReport(blind, { runId })).code).toBe('unauthorized')
    expect(errorOf(() => getSprintReport(ctx, { runId: 'rn_00000000000000000000000404' })).code).toBe('not_found')
  })
})
