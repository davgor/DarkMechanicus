/**
 * Text for scorecard read models, shared by every scorecard view. It only labels what the core computed: grades,
 * scores, weights and states come from the read model as they are, and a value the core left missing reads
 * "unavailable" with its reason, never 0.
 */
import type { UsageCellView } from '../../../shared/domain/metrics'
import type {
  BaselineComparison,
  ComponentMissingReason,
  EvidenceRef,
  GradeStatusReason,
  Measurement,
  SpaceComponent,
  SpaceGrade
} from '../../../shared/domain/space'
import type { FeedbackProvenance } from '../../../shared/domain/spaceSignals'
import type { GradeSummary, SubjectReassessment } from '../../../shared/domain/spaceGrades'
import type { TimingQuantity } from '../../../shared/domain/timing'
import type { Tone } from '../graph/ticketStates'

export const MISSING_REASON_LABELS: Readonly<Record<ComponentMissingReason | Extract<Measurement, { state: 'missing' }>['reason'], string>> = {
  no_rating: 'no rating given or shared',
  verification_pending: 'verification pending',
  verification_missing: 'no reviewed verification',
  scope_not_frozen: 'scope not frozen before dispatch',
  zero_scope: 'nothing committed',
  not_reported: 'not reported',
  host_unavailable: 'the host cannot report it',
  partial_coverage: 'only partly reported',
  no_handoffs: 'no handoff checked yet',
  zero_observation: 'nothing observed',
  insufficient_classification: 'too little effort classified',
  partial_telemetry: 'some attempts reported nothing',
  no_eligible_baseline: 'no eligible baseline'
}

export const STATUS_REASON_LABELS: Readonly<Record<GradeStatusReason, string>> = {
  mandatory_failure: 'a mandatory check or criterion failed',
  verification_missing: 'no reviewed verification',
  verification_pending: 'awaiting an outcome',
  insufficient_coverage: 'too few components scored',
  required_component_missing: 'a required component is missing',
  estimated_input: 'an input is estimated'
}

/** The state a grade reads as: the core's status, with a confirmed failure and a pending outcome named as such. */
type GradeState = 'final' | 'provisional' | 'ungraded' | 'in_progress' | 'failed'

const GRADE_STATES: Readonly<Record<GradeState, { label: string; tone: Tone }>> = {
  final: { label: 'Final', tone: 'accepted' },
  provisional: { label: 'Provisional', tone: 'attention' },
  ungraded: { label: 'Ungraded', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'running' },
  failed: { label: 'Failed', tone: 'failed' }
}

/**
 * The grade's state and its pill label. A failed or in-progress grade also names the core's status (`Failed ·
 * provisional`, `In progress · ungraded`), so the pill never contradicts the status line below it.
 */
export function gradeState(grade: Pick<SpaceGrade, 'status' | 'outcome' | 'statusReasons'>): { state: GradeState; label: string; tone: Tone } {
  const state: GradeState =
    grade.outcome === 'failed' ? 'failed' : grade.statusReasons.includes('verification_pending') ? 'in_progress' : grade.status
  const { label, tone } = GRADE_STATES[state]
  return { state, label: state === grade.status ? label : `${label} · ${grade.status}`, tone }
}

/** A canonical score as the policy displays it: rounded down to one decimal, so it never reads as a higher band. */
export function scoreText(score: number | null): string {
  return score === null ? '—' : (Math.floor(score * 10 + 1e-9) / 10).toFixed(1)
}

/** A 0–1 share as a percentage, rounded down to one decimal (coverage never reads higher than it is). */
export function percentText(share: number): string {
  return `${(Math.floor(share * 1000 + 1e-9) / 10).toFixed(1)}%`
}

/** A component's effective weight as a percentage, to the nearest tenth (1/7 reads 14.3%). */
export function weightText(share: number): string {
  return `${(Math.round(share * 1000) / 10).toFixed(1)}%`
}

/**
 * Each scored component's points (effective weight × score) to one decimal, rounded so that together they make the
 * displayed composite before any cap (`uncappedScore` rounded down like every displayed score): each is rounded down,
 * then the tenths still missing go to the largest remainders. Display only; the core's numbers are unchanged.
 */
export function displayedPoints(grade: Pick<SpaceGrade, 'components' | 'uncappedScore'>): Map<SpaceComponent, string> {
  const scored = grade.components.flatMap((result) => (result.score === null ? [] : [{ component: result.component, tenths: result.effectiveWeight * result.score * 10 + 1e-9 }]))
  const floors = scored.map((entry) => ({ ...entry, floor: Math.floor(entry.tenths), remainder: entry.tenths - Math.floor(entry.tenths) }))
  const target = grade.uncappedScore === null ? 0 : Math.floor(grade.uncappedScore * 10 + 1e-9)
  const missing = Math.max(0, Math.min(floors.length, target - floors.reduce((sum, entry) => sum + entry.floor, 0)))
  const raised = new Set([...floors].sort((a, b) => b.remainder - a.remainder).slice(0, missing).map((entry) => entry.component))
  return new Map(floors.map((entry) => [entry.component, ((entry.floor + (raised.has(entry.component) ? 1 : 0)) / 10).toFixed(1)]))
}

/** A server or local time as the person's local date and time, the one format every scorecard time uses. */
export function localTime(at: number | string): string {
  return new Date(at).toLocaleString()
}

/** Milliseconds as a duration: `45 s`, `12 min 30 s`, `2 h 05 min`. */
export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes} min` : `${minutes} min ${seconds % 60} s`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

/** A value in its unit: tokens, or milliseconds as a duration. */
export function amountText(value: number, unit: 'tokens' | 'milliseconds'): string {
  return unit === 'tokens' ? `${value.toLocaleString('en-US')} tokens` : durationText(value)
}

/** A measurement in its unit; missing reads `unavailable (reason)` and estimated is marked with its method. */
export function measurementText(measurement: Measurement, unit: 'tokens' | 'milliseconds'): string {
  switch (measurement.state) {
    case 'observed':
      return amountText(measurement.value, unit)
    case 'estimated':
      return `≈ ${amountText(measurement.value, unit)} (estimated: ${measurement.method})`
    case 'missing':
      return `unavailable (${MISSING_REASON_LABELS[measurement.reason]})`
  }
}

/** A timing quantity: its duration with its state, or `unavailable`; an open interval is a lower bound. */
export function quantityText(quantity: TimingQuantity): string {
  if (quantity.ms === null || quantity.state === 'missing') return 'unavailable'
  const notes = [quantity.state === 'observed' ? '' : quantity.state, quantity.open ? 'still running, a lower bound' : ''].filter((note) => note !== '')
  return notes.length === 0 ? durationText(quantity.ms) : `${durationText(quantity.ms)} (${notes.join('; ')})`
}

/** One usage cell of the run's usage table: unreported and unavailable cells have no number and read as such. */
export function usageCellText(cell: UsageCellView): string {
  const unit = cell.unit === 'tokens' ? 'tokens' : 'milliseconds'
  if (cell.value === null) return cell.coverage === 'unavailable' ? 'unavailable (the host cannot report it)' : `unavailable (${cell.coverage})`
  const amount = amountText(cell.value, unit)
  if (cell.coverage === 'partial') return `≥ ${amount} (partial)`
  return cell.coverage === 'estimated' ? `≈ ${amount} (estimated)` : amount
}

/** The baseline T or K was offered: kind, version, value and freeze time, and why the grader refused it if it did. */
export function baselineText(baseline: BaselineComparison, unit: 'tokens' | 'milliseconds'): string {
  const sample = baseline.sampleSize === null ? '' : `, ${baseline.sampleSize} in sample`
  const head = `${baseline.kind} v${baseline.version}: ${amountText(baseline.value, unit)}${sample}, frozen ${localTime(baseline.frozenAt)}`
  return baseline.refusedReason === null ? head : `${head}; refused (${baseline.refusedReason.replaceAll('_', ' ')})`
}

/** A grade at a glance: letter and score, or ungraded. */
export function summaryText(summary: Pick<GradeSummary, 'letter' | 'displayScore' | 'status'> | null): string {
  if (summary === null) return 'not graded'
  return summary.letter === null ? summary.status : `${summary.letter} ${summary.displayScore ?? '—'} (${summary.status})`
}

/**
 * The approved and current observation windows of a reassessment, with every time in local time like the rest of the
 * scorecard (the core's own `note` carries raw server timestamps).
 */
export function windowsText(windows: Pick<SubjectReassessment['windows'], 'approved' | 'current' | 'comparable'>): string {
  const start = (from: string | null, none: string): string => (from === null ? none : localTime(from))
  if (!windows.comparable) {
    return `not comparable: the approved window starts at ${start(windows.approved.from, 'no dispatch')}, the current one at ${start(windows.current.from, 'no dispatch')}`
  }
  return `both windows start at the first dispatch (${start(windows.current.from, 'none')}); the current one runs ${localTime(windows.approved.to)} → ${localTime(windows.current.to)} longer`
}

/** A short id for display: the first 12 characters of a hash, the whole of anything shorter. */
export function shortHash(hash: string): string {
  const value = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash
  return value.length > 12 ? value.slice(0, 12) : value
}

export function evidenceText(ref: EvidenceRef): string {
  const detail = ref.detail === null ? '' : ` · ${ref.detail}`
  return `${ref.kind} ${ref.id}${detail}`
}

/**
 * Where a person's rating or rescue entry was recorded. `this_machine` is a label the core checks against this machine's
 * own desktop sessions, not a signature, so it is shown as provenance, never as verified.
 */
export function provenanceText(recordedBy: FeedbackProvenance): string {
  const where = [recordedBy.desktopSession === null ? '' : `desktop session ${recordedBy.desktopSession}`, recordedBy.machine === null ? '' : `machine ${recordedBy.machine}`]
    .filter((part) => part !== '')
    .join(', ')
  const origin = {
    this_machine: 'labelled as recorded on this machine (a label, not a signature)',
    other_machine: 'recorded on another machine (imported, not checkable here)',
    unattested: 'unattested: names no recording desktop session on this machine'
  }[recordedBy.origin]
  return where === '' ? origin : `${origin}; ${where}`
}
