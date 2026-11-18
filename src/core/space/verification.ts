/**
 * The P input of one ticket in one run, as of a cutoff (pure; `src/core/services/performance.ts` feeds it a run's
 * records). Types are in `src/shared/domain/performance.ts`.
 *
 * Verification rests on independent review: only a review decision (taken by a session holding `attempt.review`,
 * which no worker holds) turns evidence into verification. A criterion is reviewer-checked when the reviewer stated
 * its result when accepting; one only the worker reported stays a worker claim, and a worker claim is never
 * verification. A reported check is covered by the accepted decision (checks have no per-check review channel). Only
 * the Definition of Done an acceptance node was accepted against (frozen on its decision) and the criteria are
 * required: a failed one is a confirmed failure, while any other failed check is a diagnostic.
 *
 * Every time read is one the server writes once, so the same cutoff always gives the same input (see
 * `PerformanceAssessmentInput`). Escaped defects whose origin is the ticket are listed as regressions; only an
 * attributed one that escaped the accepted outcome being assessed is charged.
 */
import type { EscapedDefect, PerformanceAssessmentInput, RegressionCharge, RegressionView, VerificationItem, VerificationReason, VerificationRecord } from '../../shared/domain/performance'
import type { EvidenceRef, RegressionInput, VerificationState } from '../../shared/domain/space'
import type { AttemptKind, AttemptState, RunState } from '../../shared/domain/status'
import type { AttemptDecision, AttemptEvidence, CheckResult } from '../../shared/domain/views'
import { checkNameKey } from '../definitionOfDone'

/** One attempt of the ticket in the run, with the criterion ids of the plan revision it ran under. */
export interface VerificationAttempt {
  attemptId: string
  number: number
  kind: AttemptKind
  /** The attempt's state now; `verificationOf` rewinds it to the cutoff. */
  state: AttemptState
  createdAt: string
  submittedAt: string | null
  decidedAt: string | null
  supersededAt: string | null
  reconciledAt: string | null
  /**
   * When a failure, cancellation or lease expiry ended it (its logged time, the run's end, or the lease deadline),
   * for an attempt in one of those states now; for one still held (claimed or running), its lease deadline, at which
   * it expires whether or not a read has settled the lease yet (null while a sign-in pause keeps the lease); for an
   * expired attempt resubmitted on reconciliation (now submitted or decided), its lease end; null otherwise.
   */
  endedAt: string | null
  evidence: AttemptEvidence | null
  decision: AttemptDecision | null
  /** The ticket's criterion ids in the plan revision the attempt ran under. */
  criteria: readonly string[]
  /** The retry limit of that revision. */
  retryLimit: number
}

export interface VerificationFacts {
  runId: string
  ticketId: string
  /** Every attempt of the ticket in the run, in number order. */
  attempts: readonly VerificationAttempt[]
  /** When each extra try for the ticket was granted in the run (null: a grant this machine logged no time for). */
  retryGrants: readonly (string | null)[]
  /**
   * Whether `retryGrants` is taken as every grant, so that using every try is a confirmed failure. Grants are
   * machine-local and the tracked run record never carries them: the reader holds this for a run this machine owns
   * (a taken-over run's earlier grants stay on the machine that made them) or one ended failed by `fail_run` on this
   * ticket; a machine reading any other run from Git cannot tell the ticket used every try.
   */
  grantsKnown: boolean
  /** When the run ended and how, or null while it has not. */
  runEnded: { at: string; state: RunState } | null
  cutoff: string
}

/**
 * What `endedAt` ends an attempt as, by its state now: its own failure, cancellation or lease expiry, or, for one
 * still held, the lease expiry its deadline brings (so a read before the lazy lease settle and one after it agree).
 */
const ENDS_AS: Partial<Record<AttemptState, AttemptState>> = {
  failed: 'failed',
  canceled: 'canceled',
  lease_expired: 'lease_expired',
  claimed: 'lease_expired',
  running: 'lease_expired'
}

/** Whether a lifecycle time is set and at or before the cutoff. */
function by(time: string | null, cutoff: string): time is string {
  return time !== null && time <= cutoff
}

/**
 * The attempt's state at `cutoff`, or null when it did not exist yet or was superseded by then. Each state is placed
 * by its own time: a decision by its decision time, a failure, cancellation or lease expiry by `endedAt`. An expired
 * attempt resubmitted on reconciliation was expired until `reconciledAt`, so a late resubmit leaves earlier reads as
 * they were.
 */
function stateAt(attempt: VerificationAttempt, cutoff: string): AttemptState | null {
  if (!by(attempt.createdAt, cutoff) || by(attempt.supersededAt, cutoff)) {
    return null
  }
  if (attempt.kind === 'carry_forward') {
    return 'accepted'
  }
  if (by(attempt.decidedAt, cutoff)) {
    return attempt.state
  }
  const reconciling = attempt.reconciledAt !== null && !by(attempt.reconciledAt, cutoff)
  const endsAs = reconciling ? 'lease_expired' : ENDS_AS[attempt.state]
  if (endsAs !== undefined && by(attempt.endedAt, cutoff)) {
    return endsAs
  }
  return by(attempt.submittedAt, cutoff) ? 'submitted' : 'running'
}

/**
 * Criteria items. On an acceptance the reviewer's own results (`decision.criteria`) are reviewer-checked and the rest
 * worker claims; an acceptance recorded before reviewers' results were kept (no `criteria` key) cannot tell them
 * apart, so its results read `review_unknown`. Before any acceptance every reported result is a worker claim.
 */
function criterionItems(ticketId: string, attempt: VerificationAttempt, accepted: boolean): VerificationItem[] {
  const stated = accepted ? attempt.decision?.criteria : []
  const legacy = stated === undefined
  const reviewed = new Map((stated ?? []).map((item) => [item.criterionId, item]))
  // On an accepted attempt the evidence also holds the reviewer's results (merged in); `reviewed` wins for those.
  const claimed = new Map((attempt.evidence?.criteria ?? []).map((item) => [item.criterionId, item]))
  return attempt.criteria.map((id): VerificationItem => {
    const review = reviewed.get(id)
    const entry = review ?? claimed.get(id)
    const basis = review !== undefined ? 'reviewer_checked' : entry === undefined ? 'missing' : legacy ? 'review_unknown' : 'worker_claim'
    return {
      kind: 'criterion',
      id,
      required: true,
      basis,
      result: entry === undefined ? null : entry.met ? 'passed' : 'failed',
      note: entry?.note ?? '',
      evidence: [{ kind: 'criterion', id: ticketId, detail: id }]
    }
  })
}

/** One check's item from its reported entries, read as reviewer-checked once the attempt was accepted. */
function checkItem(name: string, required: boolean, entries: readonly CheckResult[], attempt: { attemptId: string; accepted: boolean }): VerificationItem {
  const evidence: EvidenceRef[] = entries.length === 0 ? [] : [{ kind: 'check', id: attempt.attemptId, detail: name }]
  const note = entries.map((entry) => entry.detail).filter((detail) => detail !== '').join('; ')
  const ran = attempt.accepted ? 'reviewer_checked' : 'worker_claim'
  if (entries.length === 0) {
    return { kind: 'check', id: name, required, basis: 'missing', result: null, note, evidence }
  }
  if (entries.some((entry) => entry.status === 'failed')) {
    return { kind: 'check', id: name, required, basis: ran, result: 'failed', note, evidence }
  }
  if (entries.some((entry) => entry.status === 'skipped')) {
    return { kind: 'check', id: name, required, basis: 'skipped', result: null, note, evidence }
  }
  return { kind: 'check', id: name, required, basis: ran, result: 'passed', note, evidence }
}

/**
 * The required checks first (the Definition of Done frozen on an acceptance node's decision, in its order), then
 * every other reported check by name as a diagnostic.
 */
function checkItems(attempt: VerificationAttempt, accepted: boolean): VerificationItem[] {
  const reported = new Map<string, CheckResult[]>()
  for (const entry of attempt.evidence?.checks ?? []) {
    const key = checkNameKey(entry.name)
    reported.set(key, [...(reported.get(key) ?? []), entry])
  }
  const requiredChecks = accepted ? (attempt.decision?.requiredChecks ?? []) : []
  const of = { attemptId: attempt.attemptId, accepted }
  const requiredKeys = new Set(requiredChecks.map(checkNameKey))
  const required = requiredChecks.map((name) => checkItem(name, true, reported.get(checkNameKey(name)) ?? [], of))
  const others = [...reported].filter(([key]) => !requiredKeys.has(key)).map(([, entries]) => checkItem(entries[0]?.name ?? '', false, entries, of))
  return [...required, ...others]
}

/** The state of an accepted work attempt's verification from its items. */
function acceptedState(items: readonly VerificationItem[], legacy: boolean): [VerificationState, VerificationReason] {
  const required = items.filter((item) => item.required)
  if (required.some((item) => item.basis === 'reviewer_checked' && item.result === 'failed')) {
    return ['failed', 'confirmed_failure']
  }
  if (legacy) {
    return ['missing', 'legacy_review_basis_unknown']
  }
  if (required.some((item) => item.kind === 'criterion' && item.basis !== 'reviewer_checked')) {
    return ['missing', 'worker_claims_only']
  }
  if (required.some((item) => item.kind === 'check' && (item.basis === 'skipped' || item.basis === 'missing'))) {
    return ['missing', 'required_evidence_missing']
  }
  return ['verified', 'reviewed']
}

interface Standing {
  attempt: VerificationAttempt
  state: AttemptState
}

/**
 * Whether the ticket had used every try by the cutoff, counted as readiness counts them: failed and rejected attempts
 * and expired leases reconciled by then, against the retry limit plus the grants made by then.
 */
function exhausted(facts: VerificationFacts, current: readonly Standing[], latest: Standing): boolean {
  const used = current.filter(
    ({ attempt, state }) => state === 'failed' || state === 'rejected' || (state === 'lease_expired' && by(attempt.reconciledAt, facts.cutoff))
  ).length
  const granted = facts.retryGrants.filter((at) => at === null || at <= facts.cutoff).length
  return used >= latest.attempt.retryLimit + granted
}

/** Whether the latest attempt was still under way at the cutoff: held, or expired and not yet reconciled. */
function underWay({ state, attempt }: Standing, cutoff: string): boolean {
  return state === 'claimed' || state === 'running' || (state === 'lease_expired' && !by(attempt.reconciledAt, cutoff))
}

/**
 * The state when no accepted attempt stands: the outcome is still to come, the ticket used every try (a confirmed
 * failure only where the run's retry grants are known; elsewhere unconfirmed, `retry_grants_unknown`), or the run
 * ended without an outcome for it.
 */
function openState(facts: VerificationFacts, current: readonly Standing[], latest: Standing): [VerificationState, VerificationReason] {
  const runEnded = facts.runEnded !== null && facts.runEnded.at <= facts.cutoff
  if (!runEnded && latest.state === 'submitted') {
    return ['pending', 'awaiting_review']
  }
  if (!runEnded && underWay(latest, facts.cutoff)) {
    return ['pending', 'in_progress']
  }
  if (exhausted(facts, current, latest)) {
    return facts.grantsKnown ? ['failed', 'confirmed_failure'] : ['missing', 'retry_grants_unknown']
  }
  return runEnded ? ['missing', 'run_ended'] : ['pending', 'awaiting_retry']
}

/** The items and the verdict of the attempt that stands at the cutoff. */
function assess(facts: VerificationFacts, current: readonly Standing[], chosen: Standing): { items: VerificationItem[]; verdict: [VerificationState, VerificationReason] } {
  const { attempt, state } = chosen
  if (attempt.kind === 'carry_forward') {
    return { items: [], verdict: ['missing', 'carried_forward'] }
  }
  const accepted = state === 'accepted'
  const items = [...criterionItems(facts.ticketId, attempt, accepted), ...checkItems(attempt, accepted)]
  const legacy = accepted && attempt.decision?.criteria === undefined
  return { items, verdict: accepted ? acceptedState(items, legacy) : openState(facts, current, chosen) }
}

/**
 * The ticket's verification at the cutoff. An accepted attempt (not superseded) stands; without one, the latest
 * attempt says whether the outcome is still to come. Items are listed in both cases, as worker claims until an
 * acceptance makes them reviewed; evidence submitted after the cutoff (a late resubmit's) is not read.
 */
function verificationOf(facts: VerificationFacts): VerificationRecord {
  const current = facts.attempts.flatMap((attempt): Standing[] => {
    const state = stateAt(attempt, facts.cutoff)
    const seen = by(attempt.submittedAt, facts.cutoff) ? attempt : { ...attempt, evidence: null }
    return state === null ? [] : [{ attempt: seen, state }]
  })
  const chosen = current.filter((entry) => entry.state === 'accepted').at(-1) ?? current.at(-1)
  const record = { runId: facts.runId, ticketId: facts.ticketId }
  if (chosen === undefined) {
    const none = { attemptId: null, attemptKind: null, attemptState: null, decidedAt: null, decidedBy: null, items: [], evidence: [] }
    const ended = facts.runEnded !== null && facts.runEnded.at <= facts.cutoff
    return { ...record, state: 'missing', reason: ended ? 'run_ended' : 'no_attempt', ...none }
  }
  const { attempt, state } = chosen
  const { items, verdict } = assess(facts, current, chosen)
  const decided = state === 'accepted' || state === 'rejected'
  const cited = items.filter((item) => item.basis !== 'missing').flatMap((item) => item.evidence)
  return {
    ...record,
    state: verdict[0],
    reason: verdict[1],
    attemptId: attempt.attemptId,
    attemptKind: attempt.kind,
    attemptState: state,
    decidedAt: decided ? attempt.decidedAt : null,
    decidedBy: decided ? (attempt.decision?.decidedBy ?? null) : null,
    items,
    evidence: [{ kind: 'attempt', id: attempt.attemptId, detail: state }, ...cited]
  }
}

/** Whether a defect is charged to the assessed outcome: attributed to it and stored (server time) after its acceptance. */
function chargeOf(defect: EscapedDefect, verification: VerificationRecord): RegressionCharge {
  if (defect.attribution !== 'attributed') {
    return defect.attribution
  }
  if (verification.attemptState !== 'accepted' || defect.origin?.attemptId !== verification.attemptId) {
    return 'other_outcome'
  }
  return verification.decidedAt !== null && defect.recordedAt < verification.decidedAt ? 'before_acceptance' : 'charged'
}

/**
 * The ticket's P input at `facts.cutoff`: its verification and the counted escaped defects whose origin is the
 * ticket (`defects` resolved at the same cutoff). Charged defects are `attributed` in the grade input; every other
 * one is passed as `unassigned`, which the grader shows and never charges.
 */
export function ticketPerformance(facts: VerificationFacts, defects: readonly EscapedDefect[]): PerformanceAssessmentInput {
  const verification = verificationOf(facts)
  const linked = defects.filter((defect) => defect.counted && defect.origin?.ticketId === facts.ticketId)
  const regressions = linked.map(
    (defect): RegressionView => ({
      defectId: defect.defectId,
      severity: defect.severity,
      attribution: defect.attribution,
      status: defect.status,
      charge: chargeOf(defect, verification)
    })
  )
  const graded = regressions.map(
    (item): RegressionInput => ({ observationId: item.defectId, severity: item.severity, attribution: item.charge === 'charged' ? 'attributed' : 'unassigned' })
  )
  const attempt = facts.attempts.find((item) => item.attemptId === verification.attemptId)
  const attemptTimes = attempt === undefined ? [] : [attempt.createdAt, attempt.submittedAt, attempt.decidedAt, attempt.endedAt]
  const basisTimes = [...attemptTimes, ...linked.map((defect) => defect.updatedAt)]
    .filter((time): time is string => time !== null && time <= facts.cutoff)
    .sort()
  return {
    subject: { level: 'ticket', id: facts.ticketId },
    runId: facts.runId,
    cutoff: facts.cutoff,
    basisAt: basisTimes.at(-1) ?? null,
    performance: { verification: { state: verification.state, evidence: verification.evidence }, regressions: graded },
    verification,
    regressions
  }
}
