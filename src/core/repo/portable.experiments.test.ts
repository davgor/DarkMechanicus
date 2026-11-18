/** A run history whose experiment events or restated experiments do not follow from its reports is refused as written. */
import { describe, expect, it } from 'vitest'
import type { ExperimentEvent, RetroExperiment } from '../../shared/domain/experiments'
import { delivered, portable, submit, validExperiment } from '../../test/experimentWorld'
import { flush } from '../../test/repoEnv'
import { idOf } from '../../test/repoFixtures'
import { createTestDb } from '../../test/testContext'
import { prettyJson } from '../canonical'
import { recordExperimentEvent } from '../services/experiments'
import { ownedPaths } from './paths'
import { buildObservationRecord, parseRecord, runHistoryRecord } from './portable'

interface RunJson {
  runId: string
  experimentEvents: ExperimentEvent[]
  reports: { id: string; sprintId: string; content: { retro: { experiments: RetroExperiment[] } } }[]
}

/** The exported run history of a sprint whose report holds one experiment with a status and a result event. */
function exportedRun(): RunJson {
  const w = delivered({ acceptanceNode: false })
  portable(w)
  const report = submit(w, { summary: 'Sprint 1 with one experiment.', retro: { actions: ['Keep reviews short'], experiments: [validExperiment(w)] } })
  const experiment = report.report.retro?.experiments?.[0] as RetroExperiment
  recordExperimentEvent(w.orchestrator, { experimentId: experiment.id, event: { kind: 'status', status: 'selected', note: 'Chosen' } })
  recordExperimentEvent(w.orchestrator, { experimentId: experiment.id, event: { kind: 'result', result: { value: 3_300_000, unit: 'milliseconds', evidence: [{ kind: 'run', id: w.runId }] } } })
  flush(w.env)
  return JSON.parse(w.env.fs.get(ownedPaths(w.env.layout).runHistoryFile(w.runId)) ?? '{}') as RunJson
}

/** Parses `run` as a tracked run history file, returning the refusal message or null when it is accepted. */
function refusalOf(run: RunJson): string | null {
  try {
    parseRecord(runHistoryRecord, prettyJson(run), 'run.json')
    return null
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}

function lastEvent(run: RunJson): ExperimentEvent {
  const event = run.experimentEvents.at(-1)
  if (event === undefined) throw new Error('Expected the fixture to hold experiment events')
  return event
}

describe('run history experiment events', () => {
  it('accepts the history as exported (control)', () => {
    expect(refusalOf(exportedRun())).toBeNull()
  })

  it('refuses an event of another run', () => {
    const run = exportedRun()
    const event = lastEvent(run)
    const other = idOf('run', 9)
    event.runId = other
    expect(refusalOf(run)).toContain(`Experiment event ${event.id} belongs to run ${other}`)
  })

  it('refuses an event citing another definition of its experiment', () => {
    const run = exportedRun()
    const event = lastEvent(run)
    event.source = { ...event.source, experimentHash: `sha256:${'0'.repeat(64)}` }
    expect(refusalOf(run)).toContain(`Experiment event ${event.id} cites another definition of experiment ${event.experimentId} than report ${event.source.reportId} holds`)
  })

  it('refuses a result in another unit than its baseline', () => {
    const run = exportedRun()
    const event = lastEvent(run)
    if (event.kind !== 'result') throw new Error('Expected the last event to be the result')
    event.result = { ...event.result, unit: 'tokens' }
    expect(refusalOf(run)).toContain(`Experiment event ${event.id} reports a result in tokens, not the baseline's milliseconds`)
  })
})

describe('run history experiment restatements', () => {
  it('refuses a later report revision restating an experiment under another sprint', () => {
    const run = exportedRun()
    const [first] = run.reports
    if (first === undefined) throw new Error('Expected the fixture to hold a report')
    const experiment = first.content.retro.experiments[0] as RetroExperiment
    run.reports.push({ ...first, id: idOf('report', 99), sprintId: idOf('sprint', 99) })
    expect(refusalOf(run)).toContain(`Experiment ${experiment.id} is restated with another sprint or source`)
  })
})

describe('buildObservationRecord', () => {
  it('refuses an observation this database does not hold', () => {
    const missing = 'mo_01m7gg00000000000000000042'
    expect(() => buildObservationRecord(createTestDb(), missing)).toThrow(`Metric observation ${missing} does not exist.`)
  })
})
