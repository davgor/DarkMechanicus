/**
 * Baseline eligibility and selection for the token (K) and execution-time (T) components.
 *
 * A resource score compares what the work used with a baseline that existed before the work began: a frozen
 * pre-dispatch budget for the ticket, or the median of a frozen cohort of comparable prior tickets (same work
 * type, size and risk, with enough samples). Every rule here is in docs/space-grading.md under "Baselines".
 *
 * `frozenAt` and `dispatchedAt` must come from server-side lifecycle records (the revision save and the ticket's
 * first claim in the run), never from a caller. With that, a budget edited after dispatch is a new version frozen
 * after dispatch, so it can never apply to the assessment already executing. A time that does not parse proves
 * nothing, so it fails closed (`invalid_time`).
 */
import type {
  Baseline,
  BaselineMetric,
  BaselineRejection,
  BaselineSelection,
  BaselineSubject,
  CohortBaseline,
  RollupBaseline,
  SpacePolicy
} from '../../shared/domain/space'
import { isIsoTime } from './contract'

type BaselinePolicy = Pick<SpacePolicy, 'minCohortSampleSize'>

/** A baseline below one token or one millisecond cannot be compared against, so it counts as zero. */
const MIN_BASELINE_VALUE = 1

/** What a baseline is used for: the measured resource, the ticket it may budget (null above ticket level), and the dispatch time. */
interface BaselineUse {
  metric: BaselineMetric
  ticketId: string | null
  dispatchedAt: string | null
}

/** The instant of an ISO 8601 time, or NaN for anything else (`Date.parse` alone accepts forms such as '9999'). */
function instantOf(time: string | null): number {
  return isIsoTime(time) ? Date.parse(time) : Number.NaN
}

/** Whether the baseline was provably frozen strictly before dispatch. Unparseable or absent times fail closed. */
function freezeDefect(frozenAt: string, dispatchedAt: string | null): BaselineRejection | null {
  const frozen = instantOf(frozenAt)
  const dispatched = instantOf(dispatchedAt)
  if (!Number.isFinite(frozen) || !Number.isFinite(dispatched)) {
    return 'invalid_time'
  }
  return frozen >= dispatched ? 'frozen_after_dispatch' : null
}

/**
 * A roll-up's own checks: each member at least one unit and frozen strictly before its own ticket's dispatch, which is
 * no earlier than the scope's first dispatch. Whether a roll-up with uncovered tickets may be used depends on the
 * actual it is compared with, so the grader checks that (`incomplete_rollup`).
 */
function rollupDefect(candidate: RollupBaseline, dispatchedAt: string | null): BaselineRejection | null {
  const scopeDispatch = instantOf(dispatchedAt)
  if (!Number.isFinite(scopeDispatch)) {
    return 'invalid_time'
  }
  for (const member of candidate.members) {
    const frozen = freezeDefect(member.frozenAt, member.dispatchedAt)
    if (frozen !== null) {
      return frozen
    }
    if (instantOf(member.dispatchedAt) < scopeDispatch) {
      return 'invalid_time'
    }
    if (!(member.value >= MIN_BASELINE_VALUE)) {
      return 'zero_value'
    }
  }
  return candidate.members.length === 0 || !(candidate.value >= MIN_BASELINE_VALUE) ? 'zero_value' : null
}

/**
 * The checks every baseline must pass wherever it is used, in order: the same metric; the level (a budget or cohort
 * only for a ticket grade, a roll-up only for a run, sprint or epic grade); a budget for this very ticket; frozen
 * strictly before a valid dispatch time (a roll-up: each member before its own ticket's dispatch); a value of at least
 * one unit; for a cohort, the policy's minimum sample. Selection runs these first, and the grader runs them again on
 * whatever it is given.
 */
export function baselineDefect(candidate: Baseline, use: BaselineUse, policy: BaselinePolicy): BaselineRejection | null {
  if (candidate.metric !== use.metric) {
    return 'metric_mismatch'
  }
  if ((candidate.kind === 'rollup') !== (use.ticketId === null)) {
    return 'level_mismatch'
  }
  if (candidate.kind === 'rollup') {
    return rollupDefect(candidate, use.dispatchedAt)
  }
  if (candidate.kind === 'budget' && candidate.ticketId !== use.ticketId) {
    return 'other_ticket'
  }
  const frozen = freezeDefect(candidate.frozenAt, use.dispatchedAt)
  if (frozen !== null) {
    return frozen
  }
  if (!(candidate.value >= MIN_BASELINE_VALUE)) {
    return 'zero_value'
  }
  return candidate.kind === 'cohort' && candidate.sampleSize < policy.minCohortSampleSize ? 'sample_too_small' : null
}

/** Why a cohort is not comparable to the subject: another work type, size or risk, or it contains the subject. */
function cohortRejection(candidate: CohortBaseline, subject: BaselineSubject): BaselineRejection | null {
  const { workType, size, risk } = subject.cohort
  if (candidate.cohort.workType !== workType || candidate.cohort.size !== size || candidate.cohort.risk !== risk) {
    return 'cohort_mismatch'
  }
  return candidate.memberTicketIds.includes(subject.ticketId) ? 'contains_subject' : null
}

/** Why a candidate cannot serve the subject, checked in a fixed order, or null when it is eligible. */
function baselineRejection(candidate: Baseline, subject: BaselineSubject, policy: BaselinePolicy): BaselineRejection | null {
  const defect = baselineDefect(candidate, subject, policy)
  if (defect !== null) {
    return defect
  }
  return candidate.kind === 'cohort' ? cohortRejection(candidate, subject) : null
}

/**
 * Orders eligible candidates, best first: (1) a budget before a cohort; (2) the latest `frozenAt`; (3) the higher
 * version; (4) for cohorts, the larger sample; (5) the lower `baselineId`, so the choice is total and stable.
 */
export function compareCandidates(a: Baseline, b: Baseline): number {
  if (a.kind !== b.kind) {
    return a.kind === 'budget' ? -1 : 1
  }
  const frozen = Date.parse(b.frozenAt) - Date.parse(a.frozenAt)
  if (frozen !== 0) {
    return frozen
  }
  if (a.version !== b.version) {
    return b.version - a.version
  }
  if (a.kind === 'cohort' && b.kind === 'cohort' && a.sampleSize !== b.sampleSize) {
    return b.sampleSize - a.sampleSize
  }
  return a.baselineId < b.baselineId ? -1 : a.baselineId > b.baselineId ? 1 : 0
}

/**
 * Chooses the baseline for one subject. Every candidate not chosen is listed with its reason (an eligible one
 * that lost the ordering is `superseded`); with no eligible candidate the baseline is missing, never zero.
 */
export function selectBaseline(candidates: readonly Baseline[], subject: BaselineSubject, policy: BaselinePolicy): BaselineSelection {
  const rejected: { baselineId: string; reason: BaselineRejection }[] = []
  const eligible: Baseline[] = []
  for (const candidate of candidates) {
    const reason = baselineRejection(candidate, subject, policy)
    if (reason === null) {
      eligible.push(candidate)
    } else {
      rejected.push({ baselineId: candidate.baselineId, reason })
    }
  }
  const [chosen, ...rest] = [...eligible].sort(compareCandidates)
  for (const other of rest) {
    rejected.push({ baselineId: other.baselineId, reason: 'superseded' })
  }
  rejected.sort((a, b) => (a.baselineId < b.baselineId ? -1 : a.baselineId > b.baselineId ? 1 : 0))
  return chosen === undefined
    ? { state: 'missing', reason: 'no_eligible_baseline', rejected }
    : { state: 'selected', baseline: chosen, rejected }
}
