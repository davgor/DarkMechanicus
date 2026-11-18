/**
 * DM-192 c2 and c4: docs/space-grading.md states the policy the code grades with (weights, bands, states, the failure
 * cap, observation windows, anti-gaming limits), and the grading docs keep the SPACE framework apart from Dark
 * Mechanicus's own choices.
 */
import { describe, expect, it } from 'vitest'
import architecture from '../../../docs/architecture.md?raw'
import productPlan from '../../../docs/product-plan.md?raw'
import grading from '../../../docs/space-grading.md?raw'
import { markdownSection, missingPhrases } from '../../test/markdownSections'
import { retroExperimentInput } from '../schemas'
import { CURRENT_SPACE_POLICY, letterFor } from './rubric'

describe('space-grading.md states the weights and bands the rubric uses', () => {
  it('weighs seven components equally, as the doc says, and drops a missing one from the weights', () => {
    expect(CURRENT_SPACE_POLICY.components.map((entry) => [entry.component, entry.weight])).toEqual([
      ['S', 1],
      ['P', 1],
      ['A', 1],
      ['C', 1],
      ['E', 1],
      ['T', 1],
      ['K', 1]
    ])
    expect(
      missingPhrases(markdownSection(grading, 'Weights, precision and bands'), [
        'every component has integer weight 1, so each starts at **1/7**',
        "a missing component's is 0",
        'Missing components are excluded, never imputed'
      ])
    ).toEqual([])
    expect(
      missingPhrases(markdownSection(grading, 'Components and normalization (0–100)'), [
        'S | Satisfaction',
        'P | Performance',
        'A | Activity',
        'C | Collaboration',
        'E | Efficiency and flow',
        'T | Execution-time efficiency',
        'K | Token efficiency'
      ])
    ).toEqual([])
  })

  it('draws the letter bands where the doc does, 90 being the first A', () => {
    expect(CURRENT_SPACE_POLICY.bands.map((band) => `${band.letter}${band.min}`)).toEqual(['A90', 'B80', 'C70', 'D60', 'F0'])
    expect(letterFor(89.999999)).toBe('B')
    expect(letterFor(90)).toBe('A')
    expect(missingPhrases(grading, ['**A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F < 60.** 89.999999 is B; 90 is A.'])).toEqual([])
  })
})

describe('space-grading.md states the grade states and the failure cap the rubric applies', () => {
  it('needs four scored components, as the doc says, and never reads missing as zero', () => {
    expect(CURRENT_SPACE_POLICY.minScoredComponents).toBe(4)
    expect(
      missingPhrases(markdownSection(grading, 'Status and outcome'), [
        '**Missing required verification yields Ungraded.**',
        'fewer than **4** scored components is ungraded',
        '**Incomplete yields Provisional.**',
        '`required_component_missing`',
        '`estimated_input`'
      ])
    ).toEqual([])
    expect(missingPhrases(grading, ['Missing is never read as zero or as perfect', 'never 0'])).toEqual([])
  })

  it('caps a mandatory failure at 59 whatever the weights, as the doc says', () => {
    expect(CURRENT_SPACE_POLICY.mandatoryFailureCeiling).toBe(59)
    expect(
      missingPhrases(markdownSection(grading, 'Status and outcome'), [
        'capped at **59**',
        'the cap is independent of the weights, so no score on the other six components can lift it',
        'The uncapped score stays visible'
      ])
    ).toEqual([])
  })
})

describe('space-grading.md states the observation windows and anti-gaming limits', () => {
  it('accepts a window of 1 to 100, as the doc says', () => {
    const count = retroExperimentInput.shape.window.shape.count
    expect([0, 1, 100, 101].map((value) => count.safeParse(value).success)).toEqual([false, true, true, false])
    expect(
      missingPhrases(markdownSection(grading, 'Retrospective experiments and observation windows'), [
        '**observation window**: `{ basis, count }`, the next 1–100 sprints, runs or tickets',
        'after the corrective work lands',
        '**placed**',
        'insufficient evidence',
        '**observational**'
      ])
    ).toEqual([])
  })

  it('lists at least ten anti-gaming limits, the key ones by name', () => {
    const limits = markdownSection(grading, 'Anti-gaming limits')
    expect(limits.split('\n').filter((line) => line.startsWith('- **')).length).toBeGreaterThanOrEqual(10)
    expect(
      missingPhrases(limits, [
        'Verification is a reviewer',
        'Scope is frozen at the first dispatch',
        'Retries never help',
        'Baselines are frozen before dispatch',
        'Missing is never perfect',
        'Sources are fixed',
        'Letters are never averaged',
        'Reports are immutable'
      ])
    ).toEqual([])
  })
})

describe('space-grading.md states who records, checks and reviews', () => {
  it('names who records, checks and reviews, the evidence hierarchy and which hosts emit usage', () => {
    expect(
      missingPhrases(markdownSection(grading, 'Who records, checks and reviews'), [
        '| Person (desktop) |',
        '| Planner |',
        '| Worker |',
        '| Reviewer |',
        '| Orchestrator |',
        '| Sprint reporter |',
        '| Server |',
        '**Evidence hierarchy.**',
        '**Which integrations emit usage**',
        '| Cursor Agent | Unavailable',
        'Nothing promises telemetry a host does not write',
        '**Overhead attribution.**',
        '**Baseline pinning.**',
        '**Report immutability.**'
      ])
    ).toEqual([])
  })
})

/** Calling a grade an official SPACE score, metric or grade (`SPACE score or` is the doc saying what a grade is not). */
const SPACE_SCORE_CLAIM = /official SPACE (score|grade|metric)|SPACE score(?! or)/gi

describe('the grading docs keep SPACE apart from Dark Mechanicus choices', () => {
  it('space-grading.md calls the policy SPACE-informed and splits what is SPACE from what is not', () => {
    expect(
      missingPhrases(grading, [
        "This is Dark Mechanicus's SPACE-informed policy, not an official SPACE formula.",
        "| From the SPACE framework | Dark Mechanicus's own choice |",
        'are additions of this product, not SPACE dimensions',
        'Every normalization rule, threshold, cohort size and anti-gaming limit',
        'never as a SPACE score'
      ])
    ).toEqual([])
  })

  it('architecture.md and product-plan.md say the policy is informed by SPACE, not an official formula', () => {
    expect(missingPhrases(architecture, ['informed by SPACE, not an official SPACE formula'])).toEqual([])
    expect(
      missingPhrases(productPlan, [
        'informed by the SPACE framework (it is not an official SPACE formula)',
        "what is SPACE's and what is Dark Mechanicus's own choice"
      ])
    ).toEqual([])
  })

  it.each([
    ['space-grading.md', grading],
    ['architecture.md', architecture],
    ['product-plan.md', productPlan]
  ])('%s never calls a grade a SPACE score', (_name, text) => {
    expect(text.match(SPACE_SCORE_CLAIM) ?? []).toEqual([])
    expect(text).not.toMatch(/\bis a SPACE score\b/i)
  })
})

describe('the docs describe the Metrics dashboard as it ships', () => {
  it('product-plan.md places the Metrics link below the MCP indicator and names what the dashboard shows', () => {
    expect(
      missingPhrases(productPlan, [
        'A **Metrics** link with a chart icon sits directly below the MCP indicator in the sidebar footer',
        'grade distribution by status',
        'sprint trend',
        'top gaps',
        'Measurement capabilities table, which is not part of the summary',
        'Refresh, never on a timer'
      ])
    ).toEqual([])
  })

  it('space-grading.md has the Metrics dashboard section, with the capabilities table that is not from the summary', () => {
    expect(
      missingPhrases(markdownSection(grading, 'The Metrics dashboard'), [
        'directly below the MCP line in the sidebar footer',
        'The one table that is not from the summary is **Measurement capabilities**',
        '`HOST_USAGE_SUPPORT`',
        '`Read from the host` or `Not readable`',
        '`Custom agents` row that is `Not readable`'
      ])
    ).toEqual([])
  })
})
