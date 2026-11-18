import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Baseline, MetricObservation, SpaceGrade } from '../../shared/domain/space'
import { DomainError } from '../errors'
import { parseBaseline, parseGrade, parseObservation, parseSpacePolicy } from './contract'
import { SPACE_POLICY_V1 } from './rubric'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const readJson = <T>(name: string): T => JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as T
const observation = (metric: string): MetricObservation =>
  structuredClone(readJson<{ observations: MetricObservation[] }>('observations.json').observations.find((record) => record.metric === metric)!)
const grade = (): SpaceGrade => readJson<{ expected: SpaceGrade }>('rubric/complete.json').expected

/** The message a refused parse throws, or 'accepted' when the value parses. */
function rejection(parse: () => unknown): string {
  try {
    parse()
  } catch (error) {
    return error instanceof DomainError ? `${error.code}: ${error.message}` : String(error)
  }
  return 'accepted'
}

/** A person's rating record rewritten as minutes of another human metric. */
const humanMinutes = (metric: 'rescue_minutes' | 'human_review_minutes', extra: Partial<MetricObservation>): MetricObservation => ({
  ...observation('human_rating'),
  metric,
  unit: 'minutes',
  measurement: { state: 'observed', value: 30 },
  attributes: {},
  ...extra
})

const ROLLUP_MEMBER = { kind: 'budget', dispatchedAt: '2026-11-01T09:00:00.000Z', runId: 'rn_01m7g00000000000000000000a' } as const

/** A roll-up of two ticket budgets (100 frozen at 10:00 and 50 frozen at 11:00), consistent unless overridden. */
const rollup = (override: Record<string, unknown>): unknown => ({
  baselineId: 'bl_01m7g000000000000000000009',
  kind: 'rollup',
  metric: 'tokens',
  unit: 'tokens',
  version: 1,
  value: 150,
  frozenAt: '2026-11-01T11:00:00.000Z',
  members: [
    { ...ROLLUP_MEMBER, ticketId: 'tk_01m453gpad0000000000000001', baselineId: 'bl_01m7g000000000000000000001', value: 100, frozenAt: '2026-11-01T10:00:00.000Z' },
    { ...ROLLUP_MEMBER, ticketId: 'tk_01m453gpad0000000000000002', baselineId: 'bl_01m7g000000000000000000002', value: 50, frozenAt: '2026-11-01T11:00:00.000Z' }
  ],
  uncovered: [],
  ...override
})

describe('DM-273: an observation refusal names the broken evidence, scope or provenance rule', () => {
  it.each([
    ['a criterion reference without its criterion id', () => ({ ...observation('verification'), evidence: [{ kind: 'criterion', id: 'tk_01m453gpad0000000000000001', detail: 'first' }] }), 'evidence.0.detail: A criterion reference names its criterion id (c1)'],
    ['a criterion reference with no detail', () => ({ ...observation('verification'), evidence: [{ kind: 'criterion', id: 'tk_01m453gpad0000000000000001', detail: null }] }), 'A criterion reference names its criterion id (c1)'],
    ['a check reference that names no check', () => ({ ...observation('verification'), evidence: [{ kind: 'check', id: 'at_01m7ge55kx0000000000000002', detail: '' }] }), 'evidence.0.detail: A check reference names the check'],
    ['a ticket scope naming an attempt', () => ({ ...observation('wait_ms'), scope: { ...observation('wait_ms').scope, attemptId: 'at_01m7ge55kx0000000000000002' } }), 'scope.attemptId: A scope at ticket level cannot name a attemptId'],
    ['a wait reported as a delta', () => ({ ...observation('wait_ms'), accumulation: 'delta' }), 'accumulation: wait_ms is not reported as delta'],
    ['an agent recording an intervention', () => ({ ...observation('tokens_output'), intervention: 'rescue' }), 'intervention: Only a person or the server records a human intervention'],
    ['rescue time without its intervention', () => humanMinutes('rescue_minutes', {}), 'intervention: Rescue time names the intervention it measures'],
    ['planned review recorded as an intervention', () => humanMinutes('human_review_minutes', { attributes: { activity: 'review' }, intervention: 'rescue' }), 'intervention: Planned review or playtesting is not an intervention: rescue time records those'],
    ['planned review without its activity', () => humanMinutes('human_review_minutes', { attributes: { activity: 'pairing' } }), 'attributes.activity: Planned human time names its activity: review or playtest'],
    ['a wait carrying a usage scope', () => ({ ...observation('wait_ms'), usage: { coverage: 'self', parentActor: null } }), 'usage: wait_ms is not token or active-time usage'],
    ['a rating carrying a usage scope', () => ({ ...observation('human_rating'), usage: { coverage: 'self', parentActor: null } }), 'usage: human_rating is not token or active-time usage'],
    ['a session nested in itself', () => ({ ...observation('tokens_output'), usage: { coverage: 'self', parentActor: observation('tokens_output').source.actor } }), 'usage.parentActor: A source is not its own parent']
  ])('%s is refused', (_label, build, message) => {
    expect(rejection(() => parseObservation(build()))).toContain(message)
  })

  it('the server may record an intervention, a nested session names another parent, and planned playtesting parses', () => {
    const server = { ...observation('corrective_effort_ms'), intervention: 'retry_grant' as const }
    expect(parseObservation(server).intervention).toBe('retry_grant')
    const nested = { ...observation('tokens_output'), usage: { coverage: 'inclusive' as const, parentActor: 'orchestrator' } }
    expect(parseObservation(nested).usage).toEqual({ coverage: 'inclusive', parentActor: 'orchestrator' })
    expect(parseObservation(humanMinutes('human_review_minutes', { attributes: { activity: 'playtest' } })).attributes).toEqual({ activity: 'playtest' })
    expect(parseObservation(humanMinutes('rescue_minutes', { intervention: 'redirect' })).intervention).toBe('redirect')
  })
})

describe('DM-273: a cohort or roll-up baseline that disagrees with its members is refused', () => {
  const cohort = () => structuredClone(readJson<{ candidates: Baseline[] }>('baselines.json').candidates.find((candidate) => candidate.kind === 'cohort')!)

  it('a cohort listing more members than its sample size is refused', () => {
    expect(rejection(() => parseBaseline({ ...cohort(), sampleSize: 2 }))).toContain('memberTicketIds: A cohort lists at most sampleSize members')
  })

  it('a consistent roll-up parses with its members', () => {
    expect(parseBaseline(rollup({}))).toMatchObject({ kind: 'rollup', value: 150, frozenAt: '2026-11-01T11:00:00.000Z' })
    expect(parseBaseline(rollup({ members: [], value: 0 }))).toMatchObject({ kind: 'rollup', members: [], value: 0 })
  })

  it.each([
    ['a ticket named as member and uncovered', { uncovered: [{ runId: 'rn_01m7g00000000000000000000a', ticketId: 'tk_01m453gpad0000000000000001' }] }, 'members: A roll-up names each ticket once, as a member or as uncovered'],
    ['a value other than the members sum', { value: 160 }, 'value: A roll-up is the sum of its members'],
    ['a freeze other than the latest member freeze', { frozenAt: '2026-11-01T10:00:00.000Z' }, 'frozenAt: A roll-up is frozen at its latest member freeze']
  ])('%s is refused', (_label, override, message) => {
    expect(rejection(() => parseBaseline(rollup(override)))).toContain(message)
  })
})

describe('DM-273: a policy or grade listed out of contract order is refused', () => {
  const policy = () => structuredClone(SPACE_POLICY_V1)

  it('components listed out of S, P, A, C, E, T, K order are refused', () => {
    const swapped = policy()
    swapped.components = [swapped.components[1]!, swapped.components[0]!, ...swapped.components.slice(2)]
    expect(rejection(() => parseSpacePolicy(swapped))).toContain('components.0: Components are listed in the order')
  })

  it('bands with a rising minimum or a wrong letter are refused', () => {
    const rising = policy()
    rising.bands = rising.bands.map((band, index) => (index === 1 ? { ...band, min: 99 } : band))
    expect(rejection(() => parseSpacePolicy(rising))).toContain('bands.1: Bands run A to F with strictly falling minimums')
    const relettered = policy()
    relettered.bands = relettered.bands.map((band, index) => (index === 0 ? { ...band, letter: 'B' as const } : band))
    expect(rejection(() => parseSpacePolicy(relettered))).toContain('bands.0: Bands run A to F with strictly falling minimums')
  })

  it('an F band that starts above 0 is refused', () => {
    const raised = policy()
    raised.bands = raised.bands.map((band) => (band.letter === 'F' ? { ...band, min: 10 } : band))
    raised.mandatoryFailureCeiling = 5
    expect(rejection(() => parseSpacePolicy(raised))).toContain('bands: The F band starts at 0')
  })

  it('grade components out of order, scored while missing, or miscounted are refused', () => {
    const base = grade()
    const swapped = { ...base, components: [base.components[1]!, base.components[0]!, ...base.components.slice(2)] }
    expect(rejection(() => parseGrade(swapped))).toContain('components.0: Components are listed in the order')
    const unexplained = {
      ...base,
      scoredComponents: base.scoredComponents - 1,
      components: base.components.map((entry, index) => (index === 0 ? { ...entry, state: 'missing' as const, score: null, effectiveWeight: 0 } : entry))
    }
    expect(rejection(() => parseGrade(unexplained))).toContain('components.0: A component has a score exactly when it is not missing')
    expect(rejection(() => parseGrade({ ...base, scoredComponents: base.scoredComponents - 1 }))).toContain('score: scoredComponents counts the components that are not missing')
  })
})
