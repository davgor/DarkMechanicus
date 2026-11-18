/** Carried evidence of another project's correction epic is only read for the very report its scorecard holds. */
import { describe, expect, it } from 'vitest'
import type { ExperimentEvent } from '../../shared/domain/experiments'
import { bringBack, dmSourceEpic, machine, MACHINE_B, type Machine, record, requestCorrection, sprintResult, workCorrection } from '../../test/outcomeWorld'
import { copyTracked, createStubGit, flush, importerDeps } from '../../test/repoEnv'
import { idOf } from '../../test/repoFixtures'
import { prettyJson } from '../canonical'
import { reconcileRepository } from './importer'
import { ownedPaths } from './paths'

/** A fresh machine whose checkout holds `from`'s tracked records with `runId`'s event `eventId` replaced by `edit` of it. */
function cloneWithEditedEvent(from: Machine, runId: string, eventId: string, edit: (event: ExperimentEvent) => ExperimentEvent): Machine {
  flush(from.env)
  const clone = machine({ machineId: 'mc_000000000000000000000000cc', idStart: 200_000, at: '2026-11-17T09:00:00.000Z' })
  copyTracked(from.env, clone.env)
  const file = ownedPaths(clone.env.layout).runHistoryFile(runId)
  const history = JSON.parse(clone.env.fs.get(file) ?? '{}') as { experimentEvents: ExperimentEvent[] }
  clone.env.fs.put(file, prettyJson({ ...history, experimentEvents: history.experimentEvents.map((item) => (item.id === eventId ? edit(item) : item)) }))
  return clone
}

describe('importing a result carrying another project’s grade', () => {
  it('refuses a result whose assessment names another report than the carried scorecard', () => {
    const m = machine()
    const source = dmSourceEpic(m)
    const target = machine({ machineId: MACHINE_B, idStart: 100_000, projectId: 'pj_000000000000000000000000qq' })
    const requested = requestCorrection(m, target, source)
    const run = workCorrection(target, requested.epicId, 14)
    bringBack(m, target, requested, source.experiment.id)
    const event = record(m, source.experiment.id, sprintResult(run.cards[1], 'milliseconds', 'correction Sprint 2 in the source'))
    if (event.kind !== 'result' || event.result.assessment === null || event.result.crossRepo === undefined) throw new Error('Expected a result carrying an assessment')
    const { epicId } = event.result.assessment
    const carried = event.result.crossRepo.scorecard.report.reportId
    const other = idOf('report', 4242)
    const clone = cloneWithEditedEvent(m, source.runId, event.id, (item) =>
      item.kind === 'result' && item.result.assessment !== null ? { ...item, result: { ...item.result, assessment: { ...item.result.assessment, reportId: other } } } : item
    )
    const result = reconcileRepository(importerDeps(clone.env, createStubGit(), clone.machineId))
    expect(result.rejected.map((item) => item.message)).toContain(
      `Experiment event ${event.id} cites epic ${epicId} (report ${other}) but carries scorecard ${carried} of epic ${epicId}.`
    )
    expect(result.imported).not.toContain(source.runId)
  })
})
