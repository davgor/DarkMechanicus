import { describe, expect, it } from 'vitest'
import { deferred } from '../__mocks__/deferred'
import { CUTOFF, RUN_1, SPRINT, TICKET_A, TICKET_B, attemptUsage, subjectReassessment, ticketGrade, ticketTiming, tokenCell } from '../__mocks__/ticketScorecardFixtures'
import { type CommandRunner, createScoreReader, loadTicketCard, type ScoreReadState, shownState } from './scoreReads'

type Answers = Record<string, (input: Record<string, unknown>) => unknown>

/** A command runner over canned answers that records every call; a throwing answer is a failed command. */
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

const ids = { runId: RUN_1, ticketId: TICKET_A }

describe('DM-180 c2: the ticket card reads every part at the grade cutoff, keeping only this ticket', () => {
  it('reads timing at the cutoff, keeps only this ticket\'s usage and reassesses its sprint report', async () => {
    const { run, calls } = runner({
      getTicketGrade: () => ticketGrade(),
      getRunTiming: () => ({ tickets: [ticketTiming(TICKET_B, []), ticketTiming(TICKET_A, [])] }),
      getRunMetrics: () => ({ attempts: [attemptUsage('at_1', TICKET_A, tokenCell(10)), attemptUsage('at_9', TICKET_B, tokenCell(99))] }),
      getSprintReport: () => ({ id: 'rp_1', reportRevision: 2 }),
      reassessReportScorecard: () => ({ legacy: false, assessedAt: CUTOFF, subjects: [subjectReassessment({ subject: { level: 'ticket', id: TICKET_B } as never }), subjectReassessment()] })
    })
    const card = await loadTicketCard(run, ids)
    expect(card.timing.ok && card.timing.value.ticketId).toBe(TICKET_A)
    expect(card.usage.ok && card.usage.value.map((attempt) => attempt.attemptId)).toEqual(['at_1'])
    expect(card.report.ok && card.report.value.state === 'reassessed' && card.report.value.subject?.subject.id).toBe(TICKET_A)
    expect(calls.find((call) => call.name === 'getRunTiming')?.input).toEqual({ ...ids, cutoff: CUTOFF })
    expect(calls.find((call) => call.name === 'getSprintReport')?.input).toEqual({ runId: RUN_1, sprintId: SPRINT })
    expect(calls.find((call) => call.name === 'reassessReportScorecard')?.input).toEqual({ reportId: 'rp_1', reportRevision: 2, cutoff: CUTOFF })
  })

  it('turns a failed part into its own error and a ticket missing from the timing into a failure, never zeros', async () => {
    const { run } = runner({
      getTicketGrade: () => ticketGrade(),
      getRunTiming: () => ({ tickets: [ticketTiming(TICKET_B, [])] }),
      getRunMetrics: () => {
        throw Object.assign(new Error('metrics offline'), { code: 'conflict' })
      },
      getSprintReport: () => null
    })
    const card = await loadTicketCard(run, ids)
    expect(card.timing).toEqual({ ok: false, error: { code: 'unexpected', message: `The run's timing holds no entry for ticket ${TICKET_A}.`, action: 'retry' } })
    expect(card.usage).toEqual({ ok: false, error: { code: 'conflict', message: 'metrics offline', action: 'reload' } })
    expect(card.report).toEqual({ ok: true, value: { state: 'none' } })
  })

  it('reads no report for a ticket outside any sprint', async () => {
    const { run, calls } = runner({
      getTicketGrade: () => ticketGrade({ sprintId: null }),
      getRunTiming: () => ({ tickets: [ticketTiming(TICKET_A, [])] }),
      getRunMetrics: () => ({ attempts: [] })
    })
    expect((await loadTicketCard(run, ids)).report).toEqual({ ok: true, value: { state: 'none' } })
    expect(calls.map((call) => call.name)).not.toContain('getSprintReport')
  })
})

describe('DM-180 c3: switching selection never shows the previous selection', () => {
  it('shows loading for a new key while the reader still holds the old key\'s data', () => {
    const ready: ScoreReadState<string> = { status: 'ready', key: 'old', data: 'old data', loadedAt: 1, refreshError: null }
    expect(shownState(ready, 'new')).toEqual({ status: 'loading', key: 'new' })
    expect(shownState(ready, 'old')).toBe(ready)
    expect(shownState(ready, null)).toEqual({ status: 'idle' })
  })

  it('drops a late answer for a selection that is no longer current', async () => {
    const states: ScoreReadState<string>[] = []
    const reader = createScoreReader<string>({ onChange: (state) => states.push(state), now: () => 7 })
    const slow = deferred()
    const first = reader.select('a', () => slow.promise.then(() => 'a data'))
    await reader.select('b', () => Promise.resolve('b data'))
    slow.resolve()
    await first
    expect(reader.state()).toEqual({ status: 'ready', key: 'b', data: 'b data', loadedAt: 7, refreshError: null })
    expect(states.some((state) => state.status === 'ready' && state.key === 'a')).toBe(false)
  })

  it('keeps the data it showed beside a failed refresh', async () => {
    const reader = createScoreReader<string>({ onChange: () => undefined, now: () => 3 })
    let fail = false
    const load = (): Promise<string> => (fail ? Promise.reject(Object.assign(new Error('gone'), { code: 'not_found' })) : Promise.resolve('kept'))
    await reader.select('a', load)
    fail = true
    await reader.refresh()
    expect(reader.state()).toEqual({ status: 'ready', key: 'a', data: 'kept', loadedAt: 3, refreshError: { code: 'not_found', message: 'gone', action: 'not_found' } })
  })
})
