// DM-176 (pinned by DM-269): a run's efficiency read projects the run once, and once more per dispatch instant only
// when a record that can change a cohort member's sample arrived at or after that dispatch. Counted structurally:
// `projectTiming` is the real projection, wrapped to count its calls.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { efficiency, KEY, MIN, RunBuilder, ticketOf, tk } from '../../test/efficiencyRuns'
import type * as Timing from './timing'
import { projectTiming } from './timing'

vi.mock('./timing', async (original) => {
  const actual = await original<typeof Timing>()
  return { ...actual, projectTiming: vi.fn(actual.projectTiming) }
})

const projections = vi.mocked(projectTiming)

beforeEach(() => {
  projections.mockClear()
})

/** `tickets` tickets dispatched one after another, each accepted with `spans` worker spans and 10,000 tokens. */
function sequential(tickets: number, spans: number, perTicket: (run: RunBuilder, t: number, start: number) => void = () => undefined): RunBuilder {
  const run = new RunBuilder(1_000_000).start(0)
  for (let t = 1; t <= tickets; t += 1) {
    run.ticket(t, 1, KEY, 0)
    const start = t * 300
    run.attempt(t, t, 1, { claim: start, submit: start + 200, decided: start + 210 })
    for (let i = 0; i < spans; i += 1) run.span({ attempt: t, ticket: t }, start + i * 10, start + i * 10 + 5)
    perTicket(run, t, start)
    run.tokens({ attempt: t, ticket: t }, 10_000, start + 200)
  }
  return run
}

describe('cohort reprojection', () => {
  it('projects the run once when only run-level spans of other identities keep arriving', () => {
    const run = sequential(40, 10, (r, _t, start) => r.span({}, start, start + 210, { delta: true, source: 'host', actor: 'claude_code:s1' }))
    const view = efficiency(run.input())
    expect(projections).toHaveBeenCalledTimes(1)
    expect(view.tickets).toHaveLength(40)
    expect(ticketOf(view, 40).cohorts.T.baseline).toMatchObject({ value: 50 * MIN, sampleSize: 39 })
  })

  it('projects the run once for run-level agent orchestrator spans of another actor', () => {
    const run = sequential(20, 5, (r, _t, start) => r.span({}, start, start + 210, { role: 'orchestrator', source: 'agent', actor: 'orch' }))
    efficiency(run.input())
    expect(projections).toHaveBeenCalledTimes(1)
  })

  it('projects again only for dispatches before a host span that claims a member\'s agent identity', () => {
    const run = sequential(6, 2)
    run.span({ ticket: 1 }, 400, 410, { source: 'agent', actor: 'reviewer-bot' })
    // The host reports the same time, stored later: the agent span keeps only time the host reported nothing for.
    run.span({}, 400, 410, { source: 'host', actor: 'reviewer-bot', recorded: 1240 })
    const view = efficiency(run.input())
    // The run at the cutoff, then once each for the dispatches at 600, 900 and 1200 (ticket 1 a candidate, the host span stored later).
    expect(projections).toHaveBeenCalledTimes(4)
    const memberOne = (n: number) => ticketOf(view, n).cohorts.T.members.find((member) => member.ticketId === tk(1))?.value
    expect(memberOne(2)).toBe(20 * MIN)
    expect(memberOne(4)).toBe(20 * MIN)
    expect(memberOne(5)).toBe(10 * MIN)
  })

  it('projects again for a dispatch before which a member span was stored but after which it ends', () => {
    const run = sequential(3, 1)
    run.span({ ticket: 1 }, 100, 700, { source: 'agent', actor: 'rev', role: 'reviewer', recorded: 550 })
    efficiency(run.input())
    expect(projections).toHaveBeenCalledTimes(2)
  })
})
