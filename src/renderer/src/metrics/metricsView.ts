/**
 * Text for the Metrics dashboard, from the project metrics summary (`getMetricsSummary`). It only labels what the core
 * computed: counts, grades and sums are shown as they arrive, no letter or score is averaged, and a measure the core
 * left missing reads `unavailable` with its reason, never 0.
 */
import { AGENT_DEFINITIONS, AGENT_KINDS } from '../../../shared/desktop/agentKinds'
import { HOST_USAGE_SUPPORT } from '../../../shared/domain/hostUsage'
import type { GradeStatus } from '../../../shared/domain/space'
import type {
  MetricsSummaryTrendEntry,
  SummaryCoverage,
  SummaryGrade,
  SummaryGradeStatus,
  SummaryMeasure,
  TrendIncomparability
} from '../../../shared/domain/views'
import type { Tone } from '../graph/ticketStates'
import { amountText, localTime, MISSING_REASON_LABELS, percentText } from '../scorecard/scorecardFormat'

const REASON_LABELS: Readonly<Record<string, string>> = MISSING_REASON_LABELS

/** The distribution's statuses in display order, each with its pill label and tone (the scorecards' own). */
export const SUMMARY_STATUSES: readonly { status: SummaryGradeStatus; label: string; tone: Tone }[] = [
  { status: 'final', label: 'Final', tone: 'accepted' },
  { status: 'provisional', label: 'Provisional', tone: 'attention' },
  { status: 'in_progress', label: 'In progress', tone: 'running' },
  { status: 'failed', label: 'Failed', tone: 'failed' },
  { status: 'ungraded', label: 'Ungraded', tone: 'neutral' }
]

export const GRADE_STATUSES: readonly GradeStatus[] = ['final', 'provisional', 'ungraded']

/**
 * A row's status pill: the summary status, naming the grade's own status when it differs (`In progress · provisional`,
 * `Failed · provisional`), so the pill never contradicts the distribution by the grade's own status.
 */
export function statusPill(grade: Pick<SummaryGrade, 'status' | 'gradeStatus'>): { label: string; tone: Tone } {
  const entry = SUMMARY_STATUSES.find((candidate) => candidate.status === grade.status) ?? { label: grade.status, tone: 'neutral' as const }
  return { label: grade.status === grade.gradeStatus ? entry.label : `${entry.label} · ${grade.gradeStatus}`, tone: entry.tone }
}

/** A grade at a glance as the core gave it: letter and displayed score, a score without a letter, or no score. */
export function gradeText(grade: Pick<SummaryGrade, 'letter' | 'displayScore'>): string {
  if (grade.letter !== null) return `${grade.letter} ${grade.displayScore ?? '—'}`
  return grade.displayScore === null ? 'No score' : `Score ${grade.displayScore}`
}

/** Why a missing measure is missing (a known reason code in words), with the part that was reported (a lower bound), if any. */
function missingText(measure: SummaryMeasure, amount: (value: number) => string): string {
  const reason = measure.reason === null ? 'not reported' : (REASON_LABELS[measure.reason] ?? measure.reason)
  return measure.lowerBound === null ? `unavailable (${reason})` : `unavailable (${reason}; ≥ ${amount(measure.lowerBound)} reported)`
}

/** A summed measure in its unit; missing reads `unavailable (reason)`, estimated is marked. */
export function measureText(measure: SummaryMeasure, unit: 'tokens' | 'milliseconds'): string {
  const amount = (value: number): string => amountText(value, unit)
  if (measure.state === 'missing' || measure.value === null) return missingText(measure, amount)
  return measure.state === 'estimated' ? `≈ ${amount(measure.value)} (estimated)` : amount(measure.value)
}

/** A 0–1 share measure (corrective share) as a percentage; missing reads `unavailable (reason)`. */
export function shareText(measure: SummaryMeasure): string {
  if (measure.state === 'missing' || measure.value === null) return missingText(measure, percentText)
  return measure.state === 'estimated' ? `≈ ${percentText(measure.value)} (estimated)` : percentText(measure.value)
}

/** How many executed attempts reported tokens (or active time). */
export function reportedText(coverage: Pick<SummaryCoverage, 'attempts' | 'unreportedTokenAttempts' | 'unreportedTimeAttempts'>, what: 'tokens' | 'time'): string {
  if (coverage.attempts === 0) return 'no executed attempt'
  const unreported = what === 'tokens' ? coverage.unreportedTokenAttempts : coverage.unreportedTimeAttempts
  return `${coverage.attempts - unreported} of ${coverage.attempts} executed attempts reported ${what === 'tokens' ? 'tokens' : 'active time'}`
}

const INCOMPARABLE: Readonly<Record<TrendIncomparability, string>> = {
  first_entry: 'first entry',
  policy_changed: 'grading policy changed',
  cohort_changed: 'different ticket cohort',
  cohort_unknown: 'ticket cohort unknown (a sprint has no ticket, or a ticket without a size)',
  cross_epic: "another epic's sprint, and neither policy nor cohort vouches for comparing them",
  window_open: 'window still open',
  window_basis_changed: 'different window basis',
  not_scored: 'a grade has no score'
}

/** Where a trend entry's grade comes from. */
export function trendSourceText(entry: Pick<MetricsSummaryTrendEntry, 'source' | 'report'>): string {
  switch (entry.source) {
    case 'frozen_report':
      return `Frozen with report revision ${entry.report?.reportRevision ?? '?'}`
    case 'legacy_report':
      return 'Legacy report: ungraded, nothing was frozen'
    case 'live':
      return 'Live grade'
  }
}

/** The entry a trend entry is compared with, as the dashboard names it (`Search tuning · Sprint 1 · Run #2`). */
export interface ComparedEntry {
  label: string
  grade: Pick<SummaryGrade, 'displayScore'> | null
}

/**
 * The change between two scores as they are displayed (each rounded down to one decimal), so the delta always equals the
 * difference of the two scores shown; the core's own delta only when the earlier entry's score is not at hand, cut to
 * one decimal toward zero so a fall reads as large as a rise of the same size (−0.04 reads ±0.0, never −0.1).
 */
function shownDelta(current: Pick<SummaryGrade, 'displayScore'> | null, previous: ComparedEntry | null, scoreDelta: number | null): number | null {
  const [now, before] = [current?.displayScore, previous?.grade?.displayScore]
  if (now != null && before != null) return Math.round((Number(now) - Number(before)) * 10) / 10
  return scoreDelta === null ? null : Math.trunc(scoreDelta * 10 + Math.sign(scoreDelta) * 1e-9) / 10
}

/**
 * How a trend entry compares with the entry before it, naming that entry. Not comparable reads as such with its reasons;
 * a comparable entry shows its change from the two displayed scores.
 */
export function comparisonText(entry: Pick<MetricsSummaryTrendEntry, 'comparison' | 'grade'>, previous: ComparedEntry | null): string {
  const { comparison } = entry
  const against = previous === null ? (comparison.previous === null ? '' : ' with the entry before') : ` with ${previous.label}`
  const reasons = comparison.reasons.map((reason) => INCOMPARABLE[reason]).join('; ')
  if (!comparison.comparable) return `Not comparable${against}: ${reasons}`
  const delta = shownDelta(entry.grade, previous, comparison.scoreDelta)
  const name = previous?.label ?? 'the entry before'
  if (delta === null) return `Comparable with ${name}; no change given`
  return `${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${Math.abs(delta).toFixed(1)} vs ${name}`
}

/** A trend entry's window: from, to and whether it is closed. */
export function windowText(window: MetricsSummaryTrendEntry['window']): string {
  const from = window.from === null ? 'start' : localTime(window.from)
  const basis = window.basis === 'report_cutoff' ? 'ends at its report' : 'live'
  return `${from} – ${localTime(window.to)} (${basis}${window.closed ? '' : ', still open'})`
}

/** One agent's measurement capability on the dashboard: whether its host's tokens and active time are read. */
interface CapabilityRow {
  agent: string
  tokens: string
  activeTime: string
  detail: string
}

const SUPPORT_LABELS = { host: 'Read from the host', unavailable: 'Not readable' } as const

/**
 * Every built-in agent's host usage support (`HOST_USAGE_SUPPORT`), then custom agents, which are never read. What is
 * not readable is labelled so: its usage reads unavailable unless real numbers are relayed over MCP.
 */
export function capabilityRows(): CapabilityRow[] {
  const builtIn = AGENT_KINDS.map((kind) => {
    const support = HOST_USAGE_SUPPORT[kind]
    return { agent: AGENT_DEFINITIONS[kind].displayName, tokens: SUPPORT_LABELS[support.tokens], activeTime: SUPPORT_LABELS[support.activeTime], detail: support.detail }
  })
  return [...builtIn, { agent: 'Custom agents', tokens: SUPPORT_LABELS.unavailable, activeTime: SUPPORT_LABELS.unavailable, detail: 'Dark Mechanicus cannot read a custom agent’s usage.' }]
}
