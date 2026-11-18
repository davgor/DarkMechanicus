/**
 * DM-171 c2: usage ingestion. Delta and cumulative reports carry their source event or sequence identity and an
 * explicit unit; redelivery never double counts, nested inclusive usage counts once, and unknown usage stays unknown.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MetricReport, RunMetricsView, UsageCellView, UsageTotalView } from '../../shared/domain/metrics'
import { metricsWorld, type MetricsWorld, usage } from '../../test/metricsWorld'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import type { Workspace } from '../workspace'

let harness: Harness
let w: MetricsWorld
let worker: Workspace
let alpha: { id: string; token: string }

beforeEach(async () => {
  harness = createHarness()
  w = await metricsWorld(harness, { alpha: { title: 'Alpha' }, beta: { title: 'Beta' } }, ['alpha', 'beta'])
  alpha = w.attempt.alpha ?? { id: '', token: '' }
  worker = harness.open('worker')
})

afterEach(() => {
  harness.cleanup()
})

function record(reports: MetricReport[]) {
  return worker.recordAttemptMetrics({
    attemptId: alpha.id,
    claimToken: alpha.token,
    reports
  })
}

async function read(): Promise<RunMetricsView> {
  return w.orchestrator.getRunMetrics({ runId: w.runId })
}

async function cell(metric: string, attemptId = alpha.id): Promise<UsageCellView | undefined> {
  return (await read()).attempts.find((row) => row.attemptId === attemptId)?.usage.find((item) => item.metric === metric)
}

async function total(metric: string): Promise<UsageTotalView | undefined> {
  return (await read()).totals.find((item) => item.metric === metric)
}

const observed = (value: number) => ({ state: 'observed', value })

function cumulative(sequence: number, value: number): MetricReport {
  return usage({
    metric: 'tokens_output',
    source: { kind: 'host', actor: 'external-host:stream-out' },
    accumulation: 'cumulative',
    eventId: undefined,
    sequence,
    measurement: observed(value)
  })
}

describe('DM-171 c2: delta reports are identified by their source event', () => {
  const pair = () => [usage({ eventId: 'call-1', measurement: observed(1_200) }), usage({ eventId: 'call-2', measurement: observed(800) })]

  it('resending the same deliveries writes nothing and returns the stored ids', async () => {
    const first = await record(pair())
    const resent = await record(pair())
    expect(first.created).toHaveLength(2)
    expect(resent.created).toEqual([])
    expect(resent.unchanged).toEqual(first.created)
  })

  it('the delta stream totals 2,000 tokens after redelivery, not 4,000', async () => {
    await record(pair())
    await record(pair())
    expect(await cell('tokens_input')).toEqual({
      metric: 'tokens_input',
      unit: 'tokens',
      coverage: 'observed',
      value: 2_000
    })
  })

  it('the event id is kept as server-set provenance', async () => {
    const first = await record(pair())
    expect(first.observations.map((item) => item.attributes.sourceEvent)).toEqual(['call-1', 'call-2'])
  })

  it('the same event id with another value is a conflict, never a second count', async () => {
    await record(pair())
    await expect(record([usage({ eventId: 'call-1', measurement: observed(9_999) })])).rejects.toMatchObject({ code: 'conflict' })
    expect((await cell('tokens_input'))?.value).toBe(2_000)
  })
})

describe('DM-171 c2: cumulative reports are identified by their sequence in the stream', () => {
  it('a cumulative stream counts its latest total, 400, not the sum of its sequences', async () => {
    await record([cumulative(1, 100), cumulative(2, 250)])
    const again = await record([cumulative(2, 250)])
    await record([cumulative(4, 400)])
    await record([cumulative(3, 300)])
    expect([again.created.length, again.unchanged.length]).toEqual([0, 1])
    expect(await cell('tokens_output')).toEqual({
      metric: 'tokens_output',
      unit: 'tokens',
      coverage: 'observed',
      value: 400
    })
  })

  it('a later sequence reporting less, or an earlier one reporting more, is refused as invalid_input', async () => {
    await record([cumulative(2, 250), cumulative(4, 400)])
    await expect(record([cumulative(5, 350)])).rejects.toMatchObject({
      code: 'invalid_input'
    })
    await expect(record([cumulative(0, 500)])).rejects.toMatchObject({
      code: 'invalid_input'
    })
    await expect(record([cumulative(3, 200)])).rejects.toMatchObject({
      code: 'invalid_input'
    })
    expect((await cell('tokens_output'))?.value).toBe(400)
  })

  it('an equal value at a later sequence is accepted (a total that did not grow)', async () => {
    await record([cumulative(1, 250)])
    const same = await record([cumulative(2, 250)])
    expect(same.created).toHaveLength(1)
    expect((await cell('tokens_output'))?.value).toBe(250)
  })

  it('a delta in a cumulative stream is refused as invalid_input (it would count twice)', async () => {
    await record([cumulative(1, 100)])
    const delta = usage({
      metric: 'tokens_output',
      source: { kind: 'host', actor: 'external-host:stream-out' },
      eventId: 'x-1'
    })
    await expect(record([delta])).rejects.toMatchObject({
      code: 'invalid_input',
      details: { index: 0, metric: 'tokens_output' }
    })
  })
})

describe('DM-171 c2: identity and units are explicit', () => {
  it('a delta without an event id is refused as invalid_input', async () => {
    await expect(record([usage({ eventId: undefined })])).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('a cumulative report without a sequence, or naming an event id, is refused as invalid_input', async () => {
    await expect(record([usage({ accumulation: 'cumulative', eventId: undefined })])).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(record([usage({ accumulation: 'cumulative', sequence: 1 })])).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('tokens stated in milliseconds, or active time in tokens, are refused as invalid_input', async () => {
    await expect(record([usage({ unit: 'milliseconds', eventId: 'u-1' })])).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(record([usage({ metric: 'active_ms', unit: 'tokens', eventId: 'u-2' })])).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('a report setting a server-owned attribute is refused as invalid_input', async () => {
    await expect(record([usage({ eventId: 'u-3', attributes: { sourceEvent: 'forged' } })])).rejects.toMatchObject({
      code: 'invalid_input',
      details: { index: 0, attribute: 'sourceEvent' }
    })
    await expect(record([usage({ eventId: 'u-4', attributes: { overhead: 'review' } })])).rejects.toMatchObject({
      code: 'invalid_input',
      details: { index: 0, attribute: 'overhead' }
    })
  })

  it('a refused batch stores nothing (atomic)', async () => {
    await record([usage({ eventId: 'call-1', measurement: observed(2_000) })])
    await expect(record([usage({ eventId: 'atomic-1' }), usage({ eventId: 'atomic-2', unit: 'minutes' })])).rejects.toMatchObject({ code: 'invalid_input' })
    expect((await cell('tokens_input'))?.value).toBe(2_000)
    expect((await read()).observationCount).toBe(1)
  })
})

describe('DM-171 c2: nested inclusive usage is counted once', () => {
  const parent = { kind: 'host', actor: 'external-host:parent' }
  const child = { kind: 'host', actor: 'external-host:child' }

  it('a child inside an inclusive parent of the same attempt adds nothing: 5,000, not 7,000', async () => {
    await record([
      usage({
        metric: 'tokens_reasoning',
        source: parent,
        eventId: 'p-1',
        usage: { coverage: 'inclusive', parentActor: null },
        measurement: observed(5_000)
      }),
      usage({
        metric: 'tokens_reasoning',
        source: child,
        eventId: 'c-1',
        usage: { coverage: 'self', parentActor: parent.actor },
        measurement: observed(2_000)
      })
    ])
    expect((await cell('tokens_reasoning'))?.value).toBe(5_000)
  })

  it('a child whose parent reports only its own share is added: 7,000', async () => {
    await record([
      usage({
        metric: 'tokens_reasoning',
        source: parent,
        eventId: 'p-1',
        usage: { coverage: 'self', parentActor: null },
        measurement: observed(5_000)
      }),
      usage({
        metric: 'tokens_reasoning',
        source: child,
        eventId: 'c-1',
        usage: { coverage: 'self', parentActor: parent.actor },
        measurement: observed(2_000)
      })
    ])
    expect((await cell('tokens_reasoning'))?.value).toBe(7_000)
  })
})

describe('DM-171 c2: nested inclusive usage across buckets is counted once', () => {
  it('an inclusive run-level report over two attempts counts once in the run total: 10,000, not 16,000', async () => {
    const beta = w.attempt.beta?.id ?? ''
    const tokens = (actor: string, eventId: string, value: number, nesting: { coverage: 'inclusive' | 'self'; parentActor: string | null }) =>
      usage({
        metric: 'tokens_total',
        source: { kind: 'host', actor },
        eventId,
        measurement: observed(value),
        usage: nesting
      })
    await w.orchestrator.recordRunMetrics({
      runId: w.runId,
      overhead: 'orchestration',
      reports: [
        tokens('orch', 'o-1', 10_000, {
          coverage: 'inclusive',
          parentActor: null
        })
      ]
    })
    await w.orchestrator.recordAttemptMetrics({
      attemptId: alpha.id,
      reports: [
        tokens('child-a', 'a-1', 3_000, {
          coverage: 'self',
          parentActor: 'orch'
        })
      ]
    })
    await w.orchestrator.recordAttemptMetrics({
      attemptId: beta,
      reports: [
        tokens('child-b', 'b-1', 3_000, {
          coverage: 'self',
          parentActor: 'orch'
        })
      ]
    })
    const run = await total('tokens_total')
    expect([run?.measurement, run?.reportedValue]).toEqual([{ state: 'observed', value: 10_000 }, 10_000])
    expect((await cell('tokens_total', beta))?.value).toBe(3_000)
  })
})

describe('DM-171 c2: one delivery reported by agent and host counts once', () => {
  it('the host’s telemetry wins over the agent’s own account: 1,000, not 1,900', async () => {
    const beta = w.attempt.beta?.id ?? ''
    await w.orchestrator.recordAttemptMetrics({
      attemptId: beta,
      reports: [
        usage({
          metric: 'tokens_output',
          source: { kind: 'agent', actor: 'w-b' },
          eventId: 'e-1',
          measurement: observed(900)
        }),
        usage({
          metric: 'tokens_output',
          source: { kind: 'host', actor: 'w-b' },
          eventId: 'e-1',
          measurement: observed(1_000)
        })
      ]
    })
    expect((await cell('tokens_output', beta))?.value).toBe(1_000)
  })
})

describe('DM-171 c2: the overhead kind separates run-level deliveries', () => {
  it('the overhead kind is part of the delivery identity and the stream', async () => {
    const overhead = (kind: 'orchestration' | 'review', report: MetricReport) =>
      w.orchestrator.recordRunMetrics({
        runId: w.runId,
        overhead: kind,
        reports: [report]
      })
    const active = usage({
      metric: 'active_ms',
      unit: 'milliseconds',
      source: { kind: 'agent', actor: 'orch-agent' },
      eventId: 'x-1',
      measurement: observed(5_000)
    })
    await overhead('orchestration', active)
    expect((await overhead('review', active)).created).toHaveLength(1)
    const tokens = (sequence: number, value: number) =>
      usage({
        metric: 'tokens_input',
        source: { kind: 'agent', actor: 'orch-agent' },
        accumulation: 'cumulative',
        eventId: undefined,
        sequence,
        measurement: observed(value)
      })
    await overhead('orchestration', tokens(2, 500))
    expect((await overhead('review', tokens(3, 100))).created).toHaveLength(1)
    const byKind = (await read()).overheadByKind.map((entry) => [entry.overhead, entry.usage.find((item) => item.metric === 'tokens_input')?.value])
    expect(byKind).toEqual([
      ['orchestration', 500],
      ['review', 100]
    ])
  })
})

describe('DM-171 c2: unknown usage stays unknown', () => {
  it('an attempt that reported nothing has no value (never 0) and the run total is missing as not_reported', async () => {
    expect(await cell('tokens_input')).toEqual({
      metric: 'tokens_input',
      unit: 'tokens',
      coverage: 'unreported',
      value: null
    })
    const run = await total('tokens_input')
    expect([run?.measurement, run?.reportedValue, run?.overhead, run?.overheadCoverage]).toEqual([
      { state: 'missing', reason: 'not_reported' },
      null,
      null,
      'unreported'
    ])
  })

  it('a host that cannot report leaves the cell unavailable with no value', async () => {
    await record([usage({ measurement: { state: 'missing', reason: 'host_unavailable' } })])
    expect(await cell('tokens_input')).toEqual({
      metric: 'tokens_input',
      unit: 'tokens',
      coverage: 'unavailable',
      value: null
    })
  })
})

describe('DM-171 c2: a known gap keeps the run total unknown', () => {
  it('a known gap inside one attempt keeps its cell partial and the run total missing, with the reported part a lower bound', async () => {
    const beta = w.attempt.beta?.id ?? ''
    await w.orchestrator.recordAttemptMetrics({
      attemptId: alpha.id,
      reports: [
        usage({
          source: { kind: 'host', actor: 'main' },
          eventId: 'm-1',
          measurement: observed(100)
        }),
        usage({
          source: { kind: 'host', actor: 'child' },
          eventId: 'c-1',
          measurement: { state: 'missing', reason: 'host_unavailable' }
        })
      ]
    })
    await w.orchestrator.recordAttemptMetrics({
      attemptId: beta,
      reports: [
        usage({
          source: { kind: 'host', actor: 'main-b' },
          eventId: 'mb-1',
          measurement: observed(50)
        })
      ]
    })
    expect(await cell('tokens_input')).toEqual({
      metric: 'tokens_input',
      unit: 'tokens',
      coverage: 'partial',
      value: 100
    })
    const run = await total('tokens_input')
    expect([run?.measurement, run?.reportedValue, run?.overheadCoverage]).toEqual([{ state: 'missing', reason: 'partial_coverage' }, 150, 'unreported'])
  })
})

describe('DM-171 c2: a run total is complete only with every attempt reported', () => {
  it('a run total is observed only when every executing attempt reported fully', async () => {
    const beta = w.attempt.beta?.id ?? ''
    await record([usage({ measurement: observed(300) })])
    expect((await total('tokens_input'))?.measurement).toEqual({
      state: 'missing',
      reason: 'partial_coverage'
    })
    await w.orchestrator.recordAttemptMetrics({
      attemptId: beta,
      reports: [usage({ measurement: observed(200) })]
    })
    expect((await total('tokens_input'))?.measurement).toEqual({
      state: 'observed',
      value: 500
    })
  })
})

describe('DM-171 c2: an agent account sent before the host’s', () => {
  it('is replaced by the host’s telemetry of the same delivery: 1,000, not 900', async () => {
    const delivery = (kind: string, value: number) => usage({ metric: 'tokens_output', source: { kind, actor: 'w-a' }, eventId: 'e-1', measurement: observed(value) })
    await w.orchestrator.recordAttemptMetrics({ attemptId: alpha.id, reports: [delivery('agent', 900)] })
    harness.clock.advanceSeconds(1)
    await w.orchestrator.recordAttemptMetrics({ attemptId: alpha.id, reports: [delivery('host', 1_000)] })
    expect((await cell('tokens_output'))?.value).toBe(1_000)
  })
})

describe('DM-171 c2: a gap that is neither partial nor a host that cannot report', () => {
  it('a delta reported as not reported leaves the cell unreported, with no value', async () => {
    await record([usage({ measurement: { state: 'missing', reason: 'not_reported' } })])
    expect(await cell('tokens_input')).toEqual({ metric: 'tokens_input', unit: 'tokens', coverage: 'unreported', value: null })
  })
})

describe('DM-171 c2: one attempt’s usage read', () => {
  it('lists only the asked attempt’s observations, and refuses an attempt the run does not hold', async () => {
    const beta = w.attempt.beta?.id ?? ''
    await record([usage({ eventId: 'a-1' }), usage({ eventId: 'a-2' })])
    await w.orchestrator.recordAttemptMetrics({ attemptId: beta, reports: [usage({ eventId: 'b-1' })] })
    const view = await w.orchestrator.getRunMetrics({ runId: w.runId, attemptId: beta, includeObservations: true })
    expect(view.observationCount).toBe(1)
    expect(view.observations?.map((item) => item.scope.attemptId)).toEqual([beta])
    expect(view.totals.find((item) => item.metric === 'tokens_input')?.reportedValue).toBe(3_000)
    await expect(w.orchestrator.getRunMetrics({ runId: w.runId, attemptId: 'at_01m7gg00000000000000000099' })).rejects.toMatchObject({
      code: 'not_found',
      details: { attemptId: 'at_01m7gg00000000000000000099' }
    })
  })
})

describe('DM-175: escaped defect records an agent sends', () => {
  const defectReport = usage({
    metric: 'escaped_defect',
    unit: 'count',
    source: { kind: 'agent', actor: 'orchestrator-session' },
    accumulation: 'event',
    eventId: 'defect-1',
    measurement: observed(1),
    attributes: { defectEvent: 'report', severity: 'high', attribution: 'unassigned', discoveryPhase: 'after_epic' },
    evidence: [{ kind: 'commit', id: 'abcdef1', detail: 'source build' }]
  })
  const withdrawal = (defectId: string) =>
    usage({
      metric: 'escaped_defect',
      unit: 'count',
      source: { kind: 'agent', actor: 'orchestrator-session' },
      accumulation: 'event',
      eventId: 'defect-1-withdrawn',
      measurement: observed(0),
      attributes: { defectEvent: 'withdrawal' },
      evidence: [{ kind: 'observation', id: defectId, detail: 'defect' }]
    })

  it('a worker’s record that changes charging is refused as unauthorized, naming the record', async () => {
    await expect(record([withdrawal('mo_01m7gg00000000000000000001')])).rejects.toMatchObject({ code: 'unauthorized', details: { index: 0 } })
    expect((await read()).observationCount).toBe(0)
  })

  it('an orchestrator’s record that changes charging is stamped with the review authority; a report blaming no one is not', async () => {
    const [stored] = (await w.orchestrator.recordRunMetrics({ runId: w.runId, overhead: 'review', reports: [defectReport] })).observations
    const [withdrawn] = (await w.orchestrator.recordRunMetrics({ runId: w.runId, overhead: 'review', reports: [withdrawal(stored?.observationId ?? '')] })).observations
    expect(stored?.attributes.authority).toBeUndefined()
    expect(withdrawn?.attributes).toMatchObject({ defectEvent: 'withdrawal', authority: 'review' })
  })
})
