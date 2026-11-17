import { describe, expect, it } from 'vitest'
import { unfinished } from '../../test/correctionWorld'
import { correctiveItems, experimentContext, experimentGoal } from './corrections'

describe('DM-273: corrective work of an experiment written before concerns were recorded', () => {
  it('tags its tickets corrective only and names no concern in their context', () => {
    const { xp } = unfinished()
    const { concern: _concern, ...legacy } = xp.ready
    const { items, problems } = correctiveItems(legacy, [])
    expect(problems).toEqual([])
    expect(items.map((item) => item.tags)).toEqual([['corrective'], ['corrective']])
    expect(experimentContext(legacy).split('\n')[0]).toBe(`## Corrective experiment \`${xp.ready.id}\``)
    expect(correctiveItems(xp.ready, []).items[0]?.tags).toEqual(['corrective', 'plan_context'])
    expect(experimentContext(xp.ready).split('\n')[0]).toBe(`## Corrective experiment \`${xp.ready.id}\` (concern: plan_context)`)
  })

  it('states its change and the guardrails that hold it as the follow-up criterion', () => {
    const { xp } = unfinished()
    const guardrails = 'A.delivered at least 3 count; P.regressions at most 0 count'
    expect(experimentGoal(xp.ready)).toBe(`Experiment ${xp.ready.id}: T.actual_ms (baseline ${xp.ready.baseline.value} milliseconds) moves decrease by 20 percent over the next 1 sprints, holding ${guardrails}.`)
    expect(experimentContext(xp.ready)).toContain(`- Guardrails: ${guardrails}\n`)
  })
})
