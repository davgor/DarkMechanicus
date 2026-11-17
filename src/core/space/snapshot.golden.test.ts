/**
 * Golden scorecard snapshots, one per grading policy (DM-269 fix to DM-178 c3). Each fixture is a sealed scorecard as a
 * report revision froze it (`fixtures/snapshots/policy-v<N>.json`, written as its exported record). Every machine that
 * imports a scorecard regrades each stored input under the stored policy and requires the stored result back, so a
 * change to the grader that alters any result of a released policy would make every stored snapshot of that policy
 * refuse to import or read. These tests catch that in CI. Never regenerate a fixture to make them pass: grade the new
 * behaviour under a new policy version instead.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { prettyJson } from '../canonical'
import { storedScorecard } from '../services/scorecards'
import { parseScorecardSnapshot, readScorecard } from './snapshot'

const fixture = (version: number): string =>
  readFileSync(new URL(`./fixtures/snapshots/policy-v${version}.json`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

describe.each([
  { version: 1, sprint: ['97.1', 'A'], ticket2C: 100 },
  { version: 2, sprint: ['92.9', 'A'], ticket2C: 50 }
])('the golden scorecard of policy v$version', ({ version, sprint, ticket2C }) => {
  it('passes every check an import makes: schema, seal, identity, recorded parts and the regrade of each result', () => {
    expect(parseScorecardSnapshot(JSON.parse(fixture(version))).policy.version).toBe(version)
  })

  it('stores and exports byte for byte as the record it was written as', () => {
    const text = fixture(version)
    expect(prettyJson(JSON.parse(storedScorecard(parseScorecardSnapshot(JSON.parse(text)))))).toBe(text)
  })

  it('reads its grades under its own policy, with the explanations they had', () => {
    const view = readScorecard(parseScorecardSnapshot(JSON.parse(fixture(version))))
    expect([view.sprint.grade.displayScore, view.sprint.grade.letter]).toEqual(sprint)
    expect(view.sprint.grade.policy.version).toBe(version)
    expect(view.tickets[1]?.components.find((entry) => entry.component === 'C')?.score).toBe(ticket2C)
    expect(view.sprint.grade.explanation.composite).toMatch(/÷ 6 = /)
  })
})
