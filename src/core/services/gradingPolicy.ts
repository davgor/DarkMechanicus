/**
 * The grading policy as the desktop shows it: the one balanced policy new grades are computed under, with every rule's
 * formula written out from the policy's own numbers. It only reads `CURRENT_SPACE_POLICY`; nothing edits a policy, and a
 * frozen grade keeps the policy it names (`spacePolicyByHash`).
 */
import type { GradingPolicyComponentView, GradingPolicyView } from '../../shared/domain/scoreReads'
import type { SpaceComponent, SpacePolicy } from '../../shared/domain/space'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { CURRENT_SPACE_POLICY, policyRef } from '../space/rubric'

/** Each normalization rule's formula with the policy's numbers, as docs/space-grading.md states it. */
const RULE_FORMULAS: Readonly<Record<string, (policy: SpacePolicy) => string>> = {
  'S.rating.v1': () => '(rating − 1) × 25: a rating of 1 scores 0, 3 scores 50, 5 scores 100',
  'P.verified-less-regressions.v1': (policy) => {
    const { critical, high, medium, low } = policy.regressionPenalty
    return `verified: 100 − Σ penalty over attributed regressions (critical ${critical}, high ${high}, medium ${medium}, low ${low}); a confirmed failure scores 0`
  },
  'A.delivered-over-committed.v1': () => '100 × delivered ÷ committed, over the scope frozen before dispatch',
  'C.handoff-pass-rate.v1': (policy) => `100 × passed ÷ (passed + failed) handoff checks − ${policy.coordinationDefectPenalty} × coordination defects`,
  'C.handoff-pass-rate.v2': (policy) =>
    `100 × passed ÷ (passed + failed) handoff checks − ${policy.coordinationDefectPenalty} × coordination defects; every check of a submission the review rejected counts failed`,
  'E.corrective-share.v1': (policy) => `100 − ${policy.correctiveShareSlope} × corrective ÷ (corrective + productive) effort`,
  'T.baseline-ratio.v1': (policy) => `${policy.resourceCurve.intercept} − ${policy.resourceCurve.slope} × active time ÷ baseline, clamped to 0–100`,
  'K.baseline-ratio.v1': (policy) => `${policy.resourceCurve.intercept} − ${policy.resourceCurve.slope} × tokens ÷ baseline, clamped to 0–100`
}

/** Why a component goes unscored, in the policy's terms; a missing component is never read as 0 or as 100. */
const WHEN_MISSING: Readonly<Record<SpaceComponent, (policy: SpacePolicy) => string>> = {
  S: () => 'no rating given or shared: optional, so its weight drops out and the grade can still be final',
  P: () => 'verification pending or missing: the grade is not final',
  A: () => 'no scope frozen before dispatch, or nothing committed: the grade is not final',
  C: () => 'no handoff checked: the grade is not final',
  E: (policy) => `no effort reported, or under ${Math.round(policy.minClassificationCoverage * 100)}% of it classified: the grade is not final`,
  T: () => 'no active time reported, or no budget or cohort baseline frozen before dispatch: the grade is not final',
  K: () => 'no tokens reported, or no budget or cohort baseline frozen before dispatch: the grade is not final'
}

export function getGradingPolicy(ctx: Ctx): GradingPolicyView {
  requireCapability(ctx.session, 'read')
  const policy = CURRENT_SPACE_POLICY
  const total = policy.components.reduce((sum, entry) => sum + entry.weight, 0)
  const components = policy.components.map(
    (entry): GradingPolicyComponentView => ({
      component: entry.component,
      weight: entry.weight,
      baseShare: entry.weight / total,
      required: entry.required,
      signal: entry.signal,
      rule: entry.rule,
      formula: (RULE_FORMULAS[entry.rule] ?? fail('internal', `No formula is written for rule ${entry.rule}.`, { rule: entry.rule }))(policy),
      whenMissing: WHEN_MISSING[entry.component](policy)
    })
  )
  const { canonicalDecimals, displayDecimals } = policy.precision
  return {
    policy: policyRef(policy),
    components,
    composite: `Σ weight × score ÷ Σ weight over the scored components only (a missing component's weight drops out, never imputed); a confirmed mandatory failure caps the result at ${policy.mandatoryFailureCeiling} and the letter at F`,
    bands: policy.bands,
    minScoredComponents: policy.minScoredComponents,
    mandatoryFailureCeiling: policy.mandatoryFailureCeiling,
    precision: `kept to ${canonicalDecimals} decimals; shown to ${displayDecimals} decimal, rounded down, so a shown score never reads as a higher band than its letter`
  }
}
