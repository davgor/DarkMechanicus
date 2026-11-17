import type {
  MetricsSummaryEpicRow,
  MetricsSummaryTrendEntry,
  MetricsSummaryView,
  SummaryTicketRef,
  SummaryCoverage,
  SummaryGrade,
  SummaryMeasure,
  SummaryTime,
  SummaryTokens
} from '../../../shared/domain/views'

/** Fixed builders for the Metrics dashboard's tests: a project metrics summary and the runs and plans it names. */

const POLICY = { policyId: 'space', version: 3, hash: 'abcdef0123456789' }
const CUTOFF = '2026-03-04T12:00:00.000Z'

export const observed = (value: number): SummaryMeasure => ({ state: 'observed', value, reason: null, lowerBound: null })
export const estimated = (value: number): SummaryMeasure => ({ state: 'estimated', value, reason: null, lowerBound: null })
export const missing = (reason: string | null = null, lowerBound: number | null = null): SummaryMeasure => ({ state: 'missing', value: null, reason, lowerBound })

export function summaryGrade(patch: Partial<SummaryGrade> = {}): SummaryGrade {
  return {
    status: 'final',
    gradeStatus: 'final',
    outcome: 'verified',
    statusReasons: [],
    score: 3.47,
    displayScore: '3.4',
    letter: 'B',
    coverage: 0.875,
    inputHash: 'in_hash',
    policy: POLICY,
    ...patch
  }
}

export function summaryCoverage(patch: Partial<SummaryCoverage> = {}): SummaryCoverage {
  return { attempts: 4, unreportedTokenAttempts: 1, unreportedTimeAttempts: 0, classificationCoverage: 0.5, unavailable: [], ...patch }
}

export function summaryTokens(patch: Partial<SummaryTokens> = {}): SummaryTokens {
  return { input: observed(1000), cachedInput: observed(400), output: observed(300), reasoning: observed(100), total: observed(1300), ...patch }
}

export function summaryTime(patch: Partial<SummaryTime> = {}): SummaryTime {
  return { elapsedMs: observed(7_200_000), activeMs: observed(1_800_000), waitingMs: observed(60_000), effortMs: observed(2_400_000), ...patch }
}

export function epicRow(patch: Partial<MetricsSummaryEpicRow> = {}): MetricsSummaryEpicRow {
  return {
    epicId: 'ep_1',
    title: 'Search tuning',
    status: 'in_progress',
    runIds: ['rn_1'],
    measuredRunIds: ['rn_1'],
    sprintCount: 2,
    grade: summaryGrade(),
    tokens: summaryTokens(),
    time: summaryTime(),
    correctiveShare: observed(0.25),
    coverage: summaryCoverage(),
    ...patch
  }
}

export function trendEntry(patch: Partial<MetricsSummaryTrendEntry> = {}): MetricsSummaryTrendEntry {
  return {
    epicId: 'ep_1',
    runId: 'rn_1',
    runNumber: 1,
    sprintId: 'sp_1',
    ordinal: 1,
    source: 'live',
    report: null,
    grade: summaryGrade(),
    cohort: ['feature/s/low'],
    cohortTickets: [{ key: 'feature/s/low', tickets: 2 }],
    window: { from: '2026-03-01T09:00:00.000Z', to: CUTOFF, closed: true, basis: 'live_cutoff' },
    comparison: { previous: null, comparable: false, reasons: ['first_entry'], scoreDelta: null },
    ...patch
  }
}

export function metricsSummary(patch: Partial<MetricsSummaryView> = {}): MetricsSummaryView {
  const rows = patch.epics ?? [epicRow()]
  return {
    policy: POLICY,
    window: { since: null, cutoff: CUTOFF },
    epics: rows,
    totals: {
      epics: rows.length,
      measuredEpicIds: rows.map((row) => row.epicId),
      tokens: summaryTokens(),
      time: summaryTime(),
      correctiveShare: observed(0.25),
      coverage: summaryCoverage()
    },
    distribution: {
      byStatus: { final: 1, provisional: 0, in_progress: 0, failed: 0, ungraded: 0 },
      byGradeStatus: { final: 1, provisional: 0, ungraded: 0 }
    },
    trend: [],
    gaps: { lowestComponents: [], failures: [], rework: [] },
    coverage: { epics: rows.length, gradedEpics: rows.length, ungradedEpics: 0, unavailable: [] },
    ...patch
  }
}

/** A ticket as the summary names it: held by the plan saved last unless `removedAfterRevision` is given. */
export function ticketRef(ticketId: string, key: string | null, title: string | null, removedAfterRevision: number | null = null): SummaryTicketRef {
  return { ticketId, key, title, removedAfterRevision }
}
