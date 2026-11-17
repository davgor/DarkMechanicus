import { describe, expect, it } from 'vitest'
import { deferred } from '../__mocks__/deferred'
import { CUTOFF } from '../__mocks__/ticketScorecardFixtures'
import { type CommandRunner, createScoreReader, loadEpicCard, loadScore, scoreReadError } from './scoreReads'

type Answer = (input: Record<string, unknown>) => unknown
type Answers = Record<string, Answer>

/** A command runner over canned answers that records every call; a missing answer is a failed command. */
function runner(answers: Answers): { run: CommandRunner; calls: { name: string; input: Record<string, unknown> }[] } {
  const calls: { name: string; input: Record<string, unknown> }[] = []
  const run = (async (name: string, input: Record<string, unknown>) => {
    calls.push({ name, input })
    const answer = answers[name]
    if (answer === undefined) throw new Error(`unexpected ${name}`)
    return answer(input)
  }) as unknown as CommandRunner
  return { run, calls }
}

const EPIC = 'ep_1'
const runView = (id: string, number: number) => ({ id, number, epicId: EPIC, revisionId: `rv_${id}` })
const reportOf = (runId: string, revision: number) => ({ reportId: `rp_${runId}`, reportRevision: revision, runId })

/** A two-sprint plan whose sprints arrive out of order, and one run `rn_1` (Run #3) that executed it. */
function epicWorld(patch: Answers = {}): Answers {
  return {
    getRun: (input) => (input.epicId === EPIC || input.runId === 'rn_1' ? runView('rn_1', 3) : null),
    getPlan: () => ({ bundle: { sprints: [{ id: 'sp_2', ordinal: 2, goal: 'Ship' }, { id: 'sp_1', ordinal: 1, goal: 'Build' }] } }),
    getSprintReport: (input) => ({ id: `rp_${String(input.runId)}`, reportRevision: 2 }),
    ...patch
  }
}

const legacyScorecard = (input: Record<string, unknown>) => ({ state: 'legacy', report: reportOf('rn_1', Number(input.reportRevision)), reason: 'submitted before scorecards' })

function frozenScorecard(epic: unknown): Answer {
  return (input) => ({
    state: 'frozen',
    report: reportOf('rn_1', Number(input.reportRevision)),
    scorecard: { snapshot: { epic, timing: { wall: 1 } }, sprint: { level: 'sprint' }, epic }
  })
}

describe('a completed epic with nothing frozen reads why, never a stand-in grade', () => {
  it('an epic no run executed has no frozen grade and covers no run', async () => {
    const { run } = runner(epicWorld({ getRun: () => null }))
    const card = await loadEpicCard(run, { epicId: EPIC, completed: true })
    expect(card.assessment).toEqual({ state: 'not_frozen', reason: 'No run executed this epic, so no grade was ever frozen for it.' })
    expect(card.runs).toEqual([])
    expect(card.reassessment).toBeNull()
  })

  it('a run whose plan has no sprint has no final report, and its latest run is still shown', async () => {
    const { run, calls } = runner(epicWorld({ getPlan: () => ({ bundle: { sprints: [] } }) }))
    const card = await loadEpicCard(run, { epicId: EPIC, completed: true })
    expect(card.assessment).toEqual({ state: 'not_frozen', reason: 'Run #3 has no report for its final sprint, so no epic grade was frozen.' })
    expect(card.runs.map((entry) => entry.runId)).toEqual(['rn_1'])
    expect(card.runs[0]?.read.ok && card.runs[0].read.value.timing).toEqual({ ok: true, value: { state: 'none' } })
    expect(calls.map((call) => call.name)).not.toContain('getSprintReport')
  })

  it('a final report that froze no epic grade says which revision it was', async () => {
    const { run } = runner(epicWorld({ getSprintReport: () => ({ id: 'rp_x', reportRevision: 5 }), getReportScorecard: frozenScorecard(null) }))
    const card = await loadEpicCard(run, { epicId: EPIC, completed: true })
    expect(card.assessment).toEqual({ state: 'not_frozen', reason: "The final sprint's report (revision 5) froze no epic grade." })
    expect(card.reassessment).toBeNull()
  })
})

describe('a completed epic reads only what its reports froze', () => {
  it('a legacy final report leaves the epic and every sprint ungraded and compares nothing', async () => {
    const { run } = runner(epicWorld({ getReportScorecard: legacyScorecard }))
    const card = await loadEpicCard(run, { epicId: EPIC, completed: true })
    expect(card.assessment).toEqual({ state: 'legacy', report: reportOf('rn_1', 2), reason: 'submitted before scorecards' })
    const read = card.runs[0]?.read
    expect(read?.ok && read.value.sprints.map((sprint) => [sprint.goal, sprint.assessment.ok && sprint.assessment.value.state])).toEqual([
      ['Build', 'legacy'],
      ['Ship', 'legacy']
    ])
    expect(card.reassessment).toBeNull()
  })

  it('a frozen epic grade is reassessed by the core with no cutoff of the renderer\'s own; no epic subject reads as none', async () => {
    const epic = { level: 'epic', detail: { runIds: ['rn_1'] } }
    const { run, calls } = runner(epicWorld({ getReportScorecard: frozenScorecard(epic), reassessReportScorecard: () => ({ subjects: [{ subject: { level: 'sprint', id: 'sp_2' } }] }) }))
    const card = await loadEpicCard(run, { epicId: EPIC, completed: true })
    expect(card.assessment.state).toBe('frozen')
    expect(calls.find((call) => call.name === 'reassessReportScorecard')?.input).toEqual({ reportId: 'rp_rn_1', reportRevision: 2 })
    expect(card.reassessment?.ok && card.reassessment.value.subject).toBeNull()
  })
})

describe('an open epic reads each run it covers on its own', () => {
  function liveWorld(): Answers {
    return epicWorld({
      getEpicGrade: () => ({ cutoff: CUTOFF, runIds: ['rn_1', 'rn_2', 'rn_gone'], measuredRunIds: ['rn_1'] }),
      getRun: (input) => (input.runId === 'rn_gone' ? null : runView(String(input.runId), input.runId === 'rn_1' ? 1 : 2)),
      getSprintReport: () => null,
      getSprintGrade: (input) => ({ sprintId: input.sprintId }),
      getRunTiming: (input) => ({ runId: input.runId }),
      getRunEfficiency: (input) => ({ run: { runId: input.runId, cutoff: input.cutoff } })
    })
  }

  it('reads usage only for a run the grade did not measure, at the grade\'s cutoff', async () => {
    const { run, calls } = runner(liveWorld())
    const card = await loadEpicCard(run, { epicId: EPIC, completed: false })
    const usage = card.runs.map((entry) => (entry.read.ok ? entry.read.value.usage : 'failed'))
    expect(usage).toEqual([null, { ok: true, value: { runId: 'rn_2', cutoff: CUTOFF } }, 'failed'])
    expect(calls.filter((call) => call.name === 'getRunEfficiency').map((call) => call.input.runId)).toEqual(['rn_2'])
  })

  it('a run that no longer exists fails on its own as not found, and nothing is compared', async () => {
    const { run } = runner(liveWorld())
    const card = await loadEpicCard(run, { epicId: EPIC, completed: false })
    expect(card.runs[2]).toEqual({ runId: 'rn_gone', read: { ok: false, error: { code: 'not_found', message: 'Run rn_gone was not found.', action: 'not_found' } } })
    expect(card.runs[1]?.read.ok).toBe(true)
    expect(card.reassessment).toBeNull()
  })

  it('an epic grade frozen with its last run\'s final report is reassessed at the live grade\'s cutoff', async () => {
    const epic = { level: 'epic', detail: { runIds: ['rn_1'] } }
    const { run, calls } = runner({
      ...liveWorld(),
      getEpicGrade: () => ({ cutoff: CUTOFF, runIds: ['rn_1'], measuredRunIds: ['rn_1'] }),
      getSprintReport: () => ({ id: 'rp_rn_1', reportRevision: 2 }),
      getReportScorecard: frozenScorecard(epic),
      reassessReportScorecard: () => ({ subjects: [{ subject: { level: 'epic', id: EPIC } }] })
    })
    const card = await loadEpicCard(run, { epicId: EPIC, completed: false })
    expect(calls.find((call) => call.name === 'reassessReportScorecard')?.input).toEqual({ reportId: 'rp_rn_1', reportRevision: 2, cutoff: CUTOFF })
    expect(card.reassessment?.ok && card.reassessment.value.subject).toEqual({ subject: { level: 'epic', id: EPIC } })
  })
})

describe('single grade reads and read errors', () => {
  it('a sprint identity reads that sprint\'s grade and an epic identity the epic\'s', async () => {
    const { run, calls } = runner({ getSprintGrade: () => ({ level: 'sprint' }), getEpicGrade: () => ({ level: 'epic' }) })
    expect(await loadScore(run, { kind: 'sprint', runId: 'rn_1', sprintId: 'sp_1' })).toEqual({ level: 'sprint' })
    expect(await loadScore(run, { kind: 'epic', epicId: EPIC })).toEqual({ level: 'epic' })
    expect(calls).toEqual([
      { name: 'getSprintGrade', input: { runId: 'rn_1', sprintId: 'sp_1' } },
      { name: 'getEpicGrade', input: { epicId: EPIC } }
    ])
  })

  it('a coded failure that is not an Error reads its code as the message; anything else is unexpected', () => {
    expect(scoreReadError({ code: 'busy' })).toEqual({ code: 'busy', message: 'busy', action: 'retry' })
    expect(scoreReadError('socket closed')).toEqual({ code: 'unexpected', message: 'socket closed', action: 'retry' })
  })
})

describe('the reader keeps one selection and never stacks reads', () => {
  it('selecting the same key keeps what is shown and refreshes through the newer loader', async () => {
    const reader = createScoreReader<string>({ onChange: () => undefined, now: () => 1 })
    await reader.select('a', () => Promise.resolve('first'))
    await reader.select('a', () => Promise.resolve('second'))
    expect(reader.state()).toMatchObject({ status: 'ready', data: 'first' })
    await reader.refresh()
    expect(reader.state()).toMatchObject({ status: 'ready', data: 'second' })
  })

  it('a refresh with nothing selected reads nothing', async () => {
    let reads = 0
    const reader = createScoreReader<string>({ onChange: () => undefined, now: () => 1 })
    await reader.select(null, () => Promise.resolve(String((reads += 1))))
    await reader.refresh()
    expect(reads).toBe(0)
    expect(reader.state()).toEqual({ status: 'idle' })
  })

  it('a refresh queued behind a read is dropped when another key is selected before it starts', async () => {
    const reads: string[] = []
    const reader = createScoreReader<string>({ onChange: () => undefined, now: () => 1 })
    const slow = deferred()
    const first = reader.select('a', () => slow.promise.then(() => reads.push('a')).then(() => 'a data'))
    const queued = reader.refresh()
    await reader.select('b', () => Promise.resolve(reads.push('b')).then(() => 'b data'))
    slow.resolve()
    await Promise.all([first, queued])
    expect(reads).toEqual(['b', 'a'])
    expect(reader.state()).toMatchObject({ status: 'ready', key: 'b', data: 'b data' })
  })
})
