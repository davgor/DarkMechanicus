import { describe, expect, it } from 'vitest'
import { approveCheckpoint, getCheckpoint } from './checkpoints'
import { getExperiment, recordExperimentEvent } from './experiments'
import { getSprintReport } from './reports'
import type { ExperimentEventInput, RetroExperiment } from '../../shared/domain/experiments'
import { tid } from '../../test/bundles'
import { delivered, frozenSnapshot, MIN, outcome, submit, validExperiment } from '../../test/experimentWorld'

/** One submission carrying an experiment and the scorecard it cites, approved by the person. */
function approved() {
  const w = delivered({ acceptanceNode: false })
  const report = submit(w, {
    summary: 'Sprint 1 with one experiment.',
    retro: { actions: ['Keep reviews short'], experiments: [validExperiment(w)] },
    epicOutcome: { summary: 'Done', successCriteria: [{ criterionId: 's1', met: true, note: 'ok' }] }
  })
  approveCheckpoint(w.desktop, { runId: w.runId, reportId: report.id })
  const experiment = report.report.retro?.experiments?.[0] as RetroExperiment
  const record = (event: ExperimentEventInput, on = w.orchestrator) => recordExperimentEvent(on, { experimentId: experiment.id, event })
  const row = () => w.ctx.db.get<{ content_json: string; content_hash: string; scorecard_json: string }>('SELECT content_json, content_hash, scorecard_json FROM sprint_reports WHERE id = ?', report.id)
  return { w, report, experiment, record, row }
}

describe('DM-184 c3: later events never change the approved source', () => {
  it('records numbered events citing the exact definition, and leaves the report bytes, hash, scorecard and approval as approved', () => {
    const { w, report, experiment, record, row } = approved()
    const before = row()
    const card = frozenSnapshot(w, report.id)
    const sealed = { reportId: report.id, assessmentId: card.sprint.assessmentId }
    const events = [
      record({ kind: 'status', status: 'selected', note: 'Chosen at the checkpoint' }),
      record({ kind: 'result', result: { assessment: sealed, unit: 'milliseconds', evidence: [{ kind: 'run', id: w.runId }] } }),
      record({ kind: 'result', result: { value: 3_300_000, unit: 'milliseconds', evidence: [{ kind: 'attempt', id: w.attempts[0] ?? '', detail: 'host span' }] } })
    ]
    const definedIn = getExperiment(w.ctx, { experimentId: experiment.id }).definedIn
    expect(events.map((event) => [event.number, event.source.reportId, event.source.experimentHash])).toEqual([
      [1, report.id, definedIn.experimentHash],
      [2, report.id, definedIn.experimentHash],
      [3, report.id, definedIn.experimentHash]
    ])
    expect(events[1]?.kind === 'result' ? [events[1].result.value, events[1].result.assessment?.snapshotHash] : null).toEqual([4_200_000, card.snapshotHash])
    expect(row()).toEqual(before)
    expect(getCheckpoint(w.ctx, { runId: w.runId }).approval).not.toBeNull()
    expect(getSprintReport(w.ctx, { runId: w.runId })?.report).toEqual(report.report)
    expect(getExperiment(w.ctx, { experimentId: experiment.id })).toMatchObject({ experiment, status: 'selected', withdrawn: false })
  })

  it('refuses event text holding a credential or a machine-local path, and stated values without evidence, in another unit or below zero', () => {
    const { w, record, row } = approved()
    const before = row()
    const refused = (event: ExperimentEventInput) => outcome(() => record(event))
    expect(refused({ kind: 'status', status: 'in_progress', note: '/home/dav/.aws/credentials AKIAIOSFODNN7EXAMPLE' }).message).toBe(
      'Invalid experiment event at note: The text holds what looks like a credential'
    )
    expect(refused({ kind: 'result', result: { value: 1, unit: 'milliseconds', evidence: [{ kind: 'run', id: w.runId, detail: 'see C:\\Users\\davgo\\notes\\run.txt' }] } }).message).toBe(
      'Invalid event.result.evidence[0] at detail: The detail holds a machine-local path'
    )
    expect(refused({ kind: 'result', result: { value: 10, unit: 'milliseconds' } }).message).toContain('a stated value cites at least one piece of evidence')
    expect(refused({ kind: 'result', result: { value: 10, unit: 'tokens', evidence: [{ kind: 'run', id: w.runId }] } }).message).toContain('measures T.actual_ms in milliseconds, not tokens')
    expect(refused({ kind: 'result', result: { value: -5, unit: 'milliseconds', evidence: [{ kind: 'run', id: w.runId }] } }).code).toBe('invalid_input')
    expect(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM experiment_events')?.n).toBe(0)
    expect(row()).toEqual(before)
  })
})

describe('DM-184 c3: who may record events, and when', () => {
  it('refuses events from a session without report.submit and from a machine that does not own the run', () => {
    const { w, record } = approved()
    expect(outcome(() => record({ kind: 'status', status: 'selected' }, w.reviewer)).code).toBe('unauthorized')
    expect(outcome(() => record({ kind: 'status', status: 'selected' }, { ...w.orchestrator, machineId: 'mc_00000000000000000000000099' })).code).toBe('run_not_owned')
  })

  it('refuses a status after a final one, and any event for an experiment a later revision withdrew', () => {
    const { experiment, record } = approved()
    record({ kind: 'status', status: 'abandoned', note: 'Not worth it' })
    expect(outcome(() => record({ kind: 'status', status: 'selected' }))).toEqual({ code: 'conflict', message: `Experiment ${experiment.id} is abandoned; its status no longer changes.` })
    const v = delivered()
    const kept = submit(v, { summary: 'One experiment.', retro: { experiments: [validExperiment(v)] } }).report.retro?.experiments?.[0] as RetroExperiment
    submit(v, { summary: 'The experiment is dropped.', retro: { actions: ['Keep reviews short'] } })
    const withdrawn = outcome(() => recordExperimentEvent(v.orchestrator, { experimentId: kept.id, event: { kind: 'status', status: 'selected' } }))
    expect(withdrawn).toEqual({ code: 'conflict', message: `Experiment ${kept.id} was left out of a later revision of its sprint's report, so it is withdrawn and takes no events.` })
    expect(getExperiment(v.ctx, { experimentId: kept.id }).withdrawn).toBe(true)
  })
})

describe('DM-185 c3: vague or unsized work cannot be silently scheduled', () => {
  /** An experiment whose one work item is unsized and vague, selected at the checkpoint. */
  function vague() {
    const w = delivered()
    const valid = validExperiment(w)
    const written = submit(w, { summary: 'With an experiment.', retro: { experiments: [{ ...valid, proposedWork: [{ title: 'Fix the budgets' }] }] } }).report.retro?.experiments?.[0] as RetroExperiment
    const record = (event: ExperimentEventInput) => outcome(() => recordExperimentEvent(w.orchestrator, { experimentId: written.id, event }))
    expect(record({ kind: 'status', status: 'selected', note: 'Chosen at the checkpoint' }).code).toBe('ok')
    const restate = (proposedWork: unknown[]) =>
      submit(w, { summary: 'Restated.', retro: { experiments: [{ ...valid, id: written.id, source: { reportId: written.source.reportId, assessmentId: written.source.assessmentId }, proposedWork }] } })
    return { w, written, record, restate }
  }

  it('refuses to schedule, start or complete it with conflict, naming every problem, and keeps it selected', () => {
    const { w, written, record } = vague()
    const problems = [
      'proposedWork[0] "Fix the budgets" has no size',
      'proposedWork[0] "Fix the budgets" is vague: it does not say what changes (its body is under 40 characters)'
    ]
    expect(record({ kind: 'status', status: 'scheduled', note: 'Planned in sprint 2' })).toEqual({
      code: 'conflict',
      message: `Experiment ${written.id} cannot be scheduled: ${problems.join('; ')}. Restate it in a new revision of its sprint's report (by its id, from its original { reportId, assessmentId }) with sized, specific work first.`
    })
    expect(record({ kind: 'status', status: 'in_progress' }).message).toContain('cannot be started')
    expect(record({ kind: 'status', status: 'completed' }).message).toContain('cannot be completed')
    expect(getExperiment(w.ctx, { experimentId: written.id })).toMatchObject({ status: 'selected', executionProblems: problems })
  })

  it('still refuses sized work that is vague', () => {
    const { written, record, restate } = vague()
    restate([{ title: 'Fix the budgets', body: 'Improve the quality of the code and the tests in the whole project soon.', size: 'small' }])
    const refused = record({ kind: 'status', status: 'scheduled', note: 'Planned in sprint 2' })
    expect(refused.code).toBe('conflict')
    expect(refused.message).toContain(`Experiment ${written.id} cannot be scheduled: proposedWork[0] "Fix the budgets" is vague`)
    expect(refused.message).not.toContain('has no size')
  })

  it('schedules it once restated with sized, specific work, and only with a note saying where the work was planned', () => {
    const { w, written, record, restate } = vague()
    restate([{ title: 'Re-budget importer tickets', body: 'Raise the planned active time of importer tickets to the measured median and record why in the plan.', size: 'small' }])
    expect(getExperiment(w.ctx, { experimentId: written.id }).executionProblems).toEqual([])
    expect(record({ kind: 'status', status: 'scheduled' })).toEqual({
      code: 'invalid_input',
      message: 'Invalid event at event.note: say where the corrective work was planned (the tickets, sprint or Kanban card) when scheduling.'
    })
    expect(record({ kind: 'status', status: 'scheduled', note: 'Planned as DM-7 in sprint 2' }).code).toBe('ok')
    expect(getExperiment(w.ctx, { experimentId: written.id })).toMatchObject({ status: 'scheduled', events: [{ number: 1 }, { number: 2 }] })
  })
})

/** An experiment drawn from ticket 1's grade; its report also grades the acceptance node (ticket 4), which reported no time. */
function ticketExperiment(baseline: Record<string, unknown> = {}) {
  const w = delivered()
  const valid = validExperiment(w)
  const report = submit(w, { summary: 'With a ticket experiment.', retro: { experiments: [{ ...valid, source: { subject: { level: 'ticket', id: tid(1) } }, ...baseline }] } })
  const experiment = report.report.retro?.experiments?.[0] as RetroExperiment
  const card = frozenSnapshot(w, report.id)
  const cite = (n: number | 'sprint') => ({ reportId: report.id, assessmentId: n === 'sprint' ? card.sprint.assessmentId : (card.tickets.find((grade) => grade.subject.id === tid(n))?.assessmentId ?? '') })
  const record = (event: ExperimentEventInput) => outcome(() => recordExperimentEvent(w.orchestrator, { experimentId: experiment.id, event }))
  return { w, experiment, cite, record }
}

describe('DM-273: a result read from a cited assessment', () => {
  it('reads a missing value from a grade at the baseline level that did not measure it, and refuses a value stated beside it', () => {
    const { w, experiment, cite, record } = ticketExperiment()
    expect(record({ kind: 'result', result: { assessment: cite(4), unit: 'milliseconds', value: 60_000 } })).toEqual({
      code: 'invalid_input',
      message: `Invalid result at event.result.value: assessment ${cite(4).assessmentId} has no T.actual_ms (not_reported).`
    })
    expect(record({ kind: 'result', result: { assessment: cite(4), unit: 'milliseconds' } }).code).toBe('ok')
    const [event] = getExperiment(w.ctx, { experimentId: experiment.id }).events
    expect(event?.kind === 'result' ? [event.result.value, event.result.state, event.result.assessment?.assessmentId] : null).toEqual([null, 'missing', cite(4).assessmentId])
  })

  it('refuses a grade of another level and a stated value the grade does not hold', () => {
    const { cite, record } = ticketExperiment()
    expect(record({ kind: 'result', result: { assessment: cite('sprint'), unit: 'milliseconds' } }).message).toBe(
      'Invalid result at event.result.assessment: the baseline is a ticket grade, so the result is read from a ticket grade, not a sprint one.'
    )
    expect(record({ kind: 'result', result: { assessment: cite(2), unit: 'milliseconds', value: 1 } }).message).toBe(
      `Invalid result at event.result.value: assessment ${cite(2).assessmentId} reads T.actual_ms ${30 * MIN}, not 1.`
    )
    expect(record({ kind: 'result', result: { assessment: cite(2), unit: 'milliseconds', value: 30 * MIN } }).code).toBe('ok')
  })
})

describe('DM-273: a stated result', () => {
  it('refuses a result that neither cites an assessment nor states a value', () => {
    const { w, record } = ticketExperiment()
    expect(record({ kind: 'result', result: { unit: 'milliseconds', evidence: [{ kind: 'run', id: w.runId }] } })).toEqual({
      code: 'invalid_input',
      message: 'Invalid result at event.result: cite the frozen assessment it was read from, or state its value with evidence.'
    })
  })

  it('refuses a stated score past 100 points and records one at 100', () => {
    const { w, record } = ticketExperiment({ baseline: { measure: 'A.score', unit: 'points' }, expectedChange: { direction: 'decrease', amount: 5, unit: 'points' } })
    const stated = (value: number): ExperimentEventInput => ({ kind: 'result', result: { value, unit: 'points', evidence: [{ kind: 'run', id: w.runId }] } })
    expect(record(stated(101))).toEqual({ code: 'invalid_input', message: 'Invalid result at event.result.value: points run from 0 to 100.' })
    expect(record(stated(100)).code).toBe('ok')
  })
})
