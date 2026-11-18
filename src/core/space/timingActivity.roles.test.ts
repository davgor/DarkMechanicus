// DM-273: whose work a span is when it names no attempt, a parent with several nested helpers, and estimated overhead.
import { describe, expect, it } from 'vitest'
import { MIN, RunBuilder } from '../../test/efficiencyRuns'
import { projectTiming } from './timing'

/** A run with ticket 1 of sprint 1 and one accepted attempt 0-60 reviewed until 70, read at 300 minutes. */
function acceptedRun(): RunBuilder {
  const run = new RunBuilder(300).start(0).ticket(1, 1, null, 0)
  run.attempt(1, 1, 1, { claim: 0, submit: 60, decided: 70 })
  return run
}

const project = (run: RunBuilder) => projectTiming(run.cohortRun().timing)

describe('DM-273: a worker span with no attempt is the work of its ticket, else of the run', () => {
  it('one actor reporting the same half hour for its ticket and for the run counts both', () => {
    const run = new RunBuilder(300).start(0).ticket(1, 1, null, 0)
    run.span({ ticket: 1 }, 0, 30, { role: 'worker', actor: 'shared-host' })
    run.span({}, 0, 30, { role: 'worker', actor: 'shared-host' })
    const timing = project(run)
    expect(timing.effort.total.ms).toBe(60 * MIN)
    expect(timing.effort.byRole.worker).toBe(60 * MIN)
  })

  it('the same actor reporting the half hour twice for the run counts it once', () => {
    const run = new RunBuilder(300).start(0)
    run.span({}, 0, 30, { role: 'worker', actor: 'shared-host' })
    run.span({}, 10, 30, { role: 'worker', actor: 'shared-host' })
    expect(project(run).effort.total.ms).toBe(30 * MIN)
  })
})

describe('DM-273: an inclusive session with several nested helpers', () => {
  it('leaves every helper’s time out of the parent, so effort counts each minute once', () => {
    const run = acceptedRun()
    run.span({ attempt: 1, ticket: 1 }, 0, 60, { usage: { coverage: 'inclusive', parentActor: null } })
    run.span({ attempt: 1, ticket: 1 }, 10, 20, { actor: 'helper-a', usage: { coverage: 'self', parentActor: 'worker-1' } })
    run.span({ attempt: 1, ticket: 1 }, 30, 40, { actor: 'helper-b', usage: { coverage: 'self', parentActor: 'worker-1' } })
    expect(project(run).tickets[0]?.effort.total.ms).toBe(60 * MIN)
  })
})

describe('DM-273: review overhead from an estimated span', () => {
  it('reads the overhead as estimated when every reviewed attempt is covered', () => {
    const run = acceptedRun()
    run.span({ attempt: 1, ticket: 1 }, 0, 60)
    const review = run.span({ attempt: 1, ticket: 1 }, 60, 70, { role: 'reviewer', actor: 'reviewer-host' })
    run.observation(review).measurement = { state: 'estimated', value: 10 * MIN, method: 'transcript gaps' }
    expect(project(run).tickets[0]?.effort.overhead).toMatchObject({ state: 'estimated', ms: 10 * MIN, coverage: { covered: 1, of: 1 } })
  })
})
