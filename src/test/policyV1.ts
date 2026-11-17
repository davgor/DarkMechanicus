/** A frozen scorecard as an app on SPACE policy v1 froze it, for tests of policy changes. Not shipped. */
import { gradeSpace, policyRef, SPACE_POLICY_V1 } from '../core/space/rubric'
import { frozenInput, snapshotHashOf } from '../core/space/snapshot'
import type { ScorecardSnapshot } from '../shared/domain/spaceGrades'

/** The snapshot re-frozen under policy v1 (each result regraded under v1) and re-sealed: another valid scorecard for the same report revision. */
export function underPolicyV1(snapshot: ScorecardSnapshot): ScorecardSnapshot {
  const v1 = structuredClone(snapshot)
  v1.policy = policyRef(SPACE_POLICY_V1)
  for (const grade of [v1.sprint, v1.run, ...(v1.epic === null ? [] : [v1.epic]), ...v1.tickets]) {
    const g = gradeSpace(frozenInput(v1, grade), SPACE_POLICY_V1)
    const components = g.components.map(({ component, state, score, missingReason }) => ({ component, state, score, missingReason }))
    grade.result = { inputHash: g.inputHash, status: g.status, outcome: g.outcome, statusReasons: g.statusReasons, score: g.score, uncappedScore: g.uncappedScore, displayScore: g.displayScore, letter: g.letter, coverage: g.coverage, components }
  }
  return { ...v1, snapshotHash: snapshotHashOf(v1) }
}
