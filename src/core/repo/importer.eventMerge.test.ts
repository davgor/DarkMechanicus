/** An event this machine recorded survives a pulled run history that holds no event of its experiment yet. */
import { describe, expect, it } from 'vitest'
import { sid } from '../../test/bundles'
import { dmSourceEpic, machine, MACHINE_B, type Machine, planCorrection, record, requestCorrection, runCorrection, sprintResult, submit } from '../../test/outcomeWorld'
import { copyTracked, createStubGit, flush, importerDeps } from '../../test/repoEnv'
import { restatementOf } from '../plan/experiments'
import { reconcileRepository } from './importer'
import { ownedPaths } from './paths'
import { parseRecord, runHistoryRecord } from './portable'

const reconcile = (m: Machine) => reconcileRepository(importerDeps(m.env, createStubGit(), m.machineId))
const storedEvents = (m: Machine) => m.ctx.db.all<{ id: string; number: number }>('SELECT id, number FROM experiment_events ORDER BY number')

/** The experiment events of the run's tracked history in `m`'s checkout, as id and number. */
function trackedEvents(m: Machine, runId: string): [string, number][] {
  const file = ownedPaths(m.env.layout).runHistoryFile(runId)
  const history = parseRecord(runHistoryRecord, m.env.fs.get(file) ?? '', file)
  return (history.experimentEvents ?? []).map((event) => [event.id, event.number])
}

describe('merging a pulled run history into events recorded here', () => {
  it('keeps a result recorded here first in line when the pulled history restates the experiment without events', () => {
    const a = machine()
    const source = dmSourceEpic(a)
    const plan = planCorrection(a, requestCorrection(a, a, source).epicId)
    flush(a.env)
    const b = machine({ machineId: MACHINE_B, idStart: 100_000, at: '2026-11-16T09:00:00.000Z' })
    copyTracked(a.env, b.env)
    expect(reconcile(b).rejected).toEqual([])
    const run = runCorrection(b, plan, 14)
    flush(b.env)
    copyTracked(b.env, a.env)
    expect(reconcile(a).rejected).toEqual([])
    const result = record(b, source.experiment.id, sprintResult(run.cards[1], 'milliseconds', 'correction Sprint 2'))
    expect(flush(b.env).failed).toBe(0)
    submit(a, source.runId, sid(1), { summary: 'Sprint 1, the experiment restated.', retro: { wentWell: ['Tickets 1-3 landed'], experiments: [restatementOf(source.experiment)] } })
    expect(flush(a.env).failed).toBe(0)
    copyTracked(a.env, b.env)
    expect(trackedEvents(b, source.runId)).toEqual([])
    expect(reconcile(b).rejected).toEqual([])
    expect(storedEvents(b)).toEqual([{ id: result.id, number: 1 }])
    expect(flush(b.env).failed).toBe(0)
    expect(trackedEvents(b, source.runId)).toEqual([[result.id, 1]])
  })
})
