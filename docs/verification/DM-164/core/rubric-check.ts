// DM-164 c1/c10: regrades every checked-in rubric reference case with the shipped grader, prints all seven components
// and the policy version, and recalculates each composite, cap, letter, display text, status and coverage independently
// from the policy text (equal base weights, 6-decimal half-up canonical value, 1-decimal floor display, bands 90/80/70/60,
// mandatory-failure ceiling 59, at least 4 scored components). Exits 1 on any disagreement.
// Run from the worktree: npx tsx docs/verification/DM-164/core/rubric-check.ts
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { contentHash } from '../../../../src/core/canonical'
import { gradeSpace, SPACE_POLICY_V1, SPACE_POLICY_V2 } from '../../../../src/core/space/rubric'
import type { SpaceGrade, SpaceGradeInput } from '../../../../src/shared/domain/space'
const dir = resolve(import.meta.dirname, '..', '..', '..', '..', 'src', 'core', 'space', 'fixtures', 'rubric')
const policies = { 'dm-space v1': SPACE_POLICY_V1, 'dm-space v2': SPACE_POLICY_V2 } as const
let failures = 0
const check = (label: string, ok: boolean, detail: string) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`)
}

/** Independent arithmetic from the policy's published numbers, not the grader's code. */
function independent(grade: SpaceGrade, policyName: keyof typeof policies, input: SpaceGradeInput) {
  const inputP: { verification?: { state?: string } } = input.components.P
  const policy = policies[policyName]
  const weights = new Map(policy.components.map((c) => [c.component, c.weight]))
  const total = [...weights.values()].reduce((a, b) => a + b, 0)
  const scored = grade.components.filter((c) => typeof c.score === 'number')
  const w = scored.reduce((a, c) => a + (weights.get(c.component) ?? 0), 0)
  const raw = scored.reduce((a, c) => a + (c.score as number) * (weights.get(c.component) ?? 0), 0) / w
  const canon = (x: number) => Math.round(x * 1e6 + 1e-9) / 1e6
  const uncapped = canon(raw)
  const failed = inputP.verification?.state === 'failed'
  const score = failed ? Math.min(uncapped, 59) : uncapped
  const letter = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F'
  const display = (Math.floor(score * 10 + 1e-9) / 10).toFixed(1)
  const coverage = w / total
  return { uncapped, score, letter, display, coverage, scoredCount: scored.length }
}

const report = (name: string, policyName: keyof typeof policies, input: SpaceGradeInput, expected: Record<string, unknown>) => {
  const policy = policies[policyName]
  const grade = gradeSpace(input, policy)
  check(`${name} regrade`, JSON.stringify(grade) === JSON.stringify(expected), 'byte-for-byte equal to the checked-in expected grade')
  console.log(
    `     policy ${grade.policy.policyId} v${grade.policy.version} ${grade.policy.hash} (policy text hash ${contentHash(policy)}); status ${grade.status}; letter ${grade.letter}; score ${grade.score} (uncapped ${grade.uncappedScore}); display ${grade.displayScore}; coverage ${grade.coverage}; caps ${grade.caps.map((c) => `${c.kind}<=${c.ceiling}`).join(',') || 'none'}`
  )
  console.log(`     components: ${grade.components.map((c) => `${c.component}=${c.score ?? `missing(${c.missingReason})`}[${c.state},w ${Number(c.effectiveWeight).toFixed(4)}]`).join(' ')}`)
  check(`${name} seven components`, grade.components.length === 7 && grade.components.map((c) => c.component).join('') === 'SPACETK', grade.components.map((c) => c.component).join(''))
  if (grade.status === 'ungraded') {
    const i = independent(grade, policyName, input)
    check(`${name} independent status`, grade.score === null && grade.letter === null, `ungraded (scored ${i.scoredCount}, minimum ${policy.minScoredComponents} or verification not reviewed)`)
    return
  }
  const i = independent(grade, policyName, input)
  check(
    `${name} independent recalculation`,
    i.uncapped === grade.uncappedScore && i.score === grade.score && i.letter === grade.letter && i.display === grade.displayScore && i.coverage === grade.coverage,
    `uncapped ${i.uncapped} score ${i.score} letter ${i.letter} display ${i.display} coverage ${i.coverage}`
  )
}

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const fixture = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  const policyName = fixture.policy as keyof typeof policies
  if (Array.isArray(fixture.cases)) for (const c of fixture.cases) report(`${fixture.name}/${c.name}`, policyName, c.input, c.expected)
  else report(fixture.name, policyName, fixture.input, fixture.expected)
}
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
