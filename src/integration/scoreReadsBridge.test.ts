/**
 * The renderer's score reader and edit buffers (`src/renderer/src/scorecard/scoreReads.ts`) over the real desktop
 * `dm:command` handler and real workspaces: the typed states a Scorecard view shows (DM-179 c3) and refresh, stale
 * edits, navigation and refusals through the bridge (DM-179 c4).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { deferred } from '../renderer/src/__mocks__/deferred'
import {
  createScoreReader,
  type EditBuffer,
  editBuffer,
  loadScore,
  rebaseEdit,
  type ScoreIdentity,
  scoreKey,
  type ScoreReader,
  scoreReadError,
  type ScoreReadState,
  type ScoreViewOf,
  settleEdit
} from '../renderer/src/scorecard/scoreReads'
import type { CommandInput, CommandOutput } from '../shared/desktop/api'
import type { CommandName } from '../shared/domain/api'
import type { SpaceGrade } from '../shared/domain/space'
import { type Bridge, desktopBridge, type ScoreProject, scoreProject, submitReport } from '../test/scoreWorld'

type View = ScoreViewOf<ScoreIdentity>

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** The grade a ready view shows: a grade read's own, or the grade read a ticket card holds. */
function gradeOf(data: View): SpaceGrade | null {
  if (!('grade' in data)) return null
  return 'grade' in data.grade ? data.grade.grade : data.grade
}

/** One line per state a view is shown: `loading`, `ready(<subject>)` with a failed refresh's action, `error:<action>`. */
function described(state: ScoreReadState<View>): string {
  if (state.status === 'idle' || state.status === 'loading') return state.status
  if (state.status === 'error') return `error:${state.error.code}/${state.error.action}`
  const grade = gradeOf(state.data)
  const report = 'report' in state.data && 'reportRevision' in state.data.report ? state.data.report.reportRevision : null
  const what = grade !== null ? `${grade.subject.level}:${grade.subject.id}:${grade.status}` : `report:r${report}`
  return `ready(${what}${state.refreshError === null ? '' : `, refresh failed: ${state.refreshError.action}`})`
}

/** A reader over the bridge whose loads are counted, with a gate a test sets to hold an answer or fail a call. */
interface Session {
  p: ScoreProject
  bridge: Bridge
  reader: ScoreReader<View>
  log: string[]
  loads: number
  gate: ((name: string) => Promise<void>) | null
  show(identity: ScoreIdentity): Promise<void>
}

async function session(): Promise<Session> {
  const p = await scoreProject('Score reader')
  cleanups.push(() => p.harness.cleanup())
  const bridge = desktopBridge([p])
  const log: string[] = []
  const s: Session = {
    p,
    bridge,
    log,
    loads: 0,
    gate: null,
    reader: createScoreReader<View>({ onChange: (state) => log.push(described(state)), now: () => p.harness.clock.nowMs() }),
    show: (identity) => s.reader.select(scoreKey(p.folder, identity), () => loadScore(run, identity))
  }
  async function run<K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandOutput<K>> {
    s.loads += 1
    const answer = await bridge.call(p.folder, name, input)
    if (s.gate !== null) await s.gate(name)
    return answer
  }
  return s
}

const ticket = (s: Session, ticketId: string): ScoreIdentity => ({ kind: 'ticket', runId: s.p.runId, ticketId })

function ratings(state: ScoreReadState<View>): (number | null)[] {
  if (state.status !== 'ready' || !('sources' in state.data) || !('signals' in state.data.sources)) return []
  return state.data.sources.signals.S.ratings.map((entry) => entry.value)
}

const rate = (s: Session, value: number) =>
  s.bridge.call(s.p.folder, 'recordHumanFeedback', { target: { epicId: s.p.epicId, ticketId: s.p.apiTicket }, feedback: { kind: 'rating', value } })

/** The error a call failed with, as the view shows it; null when it succeeded. */
function failureOf(attempt: Promise<unknown>) {
  return attempt.then(
    () => null,
    (error: unknown) => scoreReadError(error)
  )
}

describe('typed score read states over the bridge (DM-179 c3)', () => {
  it('shows a ticket with no usage reported as the core’s ungraded grade, its unmeasured components null with a reason', async () => {
    const s = await session()
    await s.show(ticket(s, s.p.guideTicket))
    const state = s.reader.state()
    const grade = state.status === 'ready' ? gradeOf(state.data) : null
    if (grade === null) throw new Error(`not a grade: ${described(state)}`)
    expect({ status: grade.status, score: grade.score, letter: grade.letter }).toEqual({ status: 'ungraded', score: null, letter: null })
    const missing = grade.components.filter((component) => component.state === 'missing')
    expect(missing.length).toBeGreaterThan(0)
    expect(missing.filter((component) => component.score !== null || component.missingReason === null)).toEqual([])
    const usage = await s.bridge.call(s.p.folder, 'getRunMetrics', { runId: s.p.runId })
    expect(usage.attempts.find((attempt) => attempt.attemptId === s.p.guideAttempt)?.usage.every((cell) => cell.coverage === 'unreported' && cell.value === null)).toBe(true)
  })

  it('goes loading, ready, loading, error for an unknown run, never an empty successful score', async () => {
    const s = await session()
    await s.show(ticket(s, s.p.guideTicket))
    await s.show({ kind: 'run', runId: `${s.p.runId.slice(0, -4)}zzzz` })
    expect(s.log).toEqual(['loading', `ready(ticket:${s.p.guideTicket}:ungraded)`, 'loading', 'error:not_found/not_found'])
  })

  it('maps each failure through the bridge to a typed error with what to do about it', async () => {
    const s = await session()
    const { p, bridge } = s
    const cases: [string, () => Promise<unknown>, string, string][] = [
      ['an unknown ticket of the run', () => bridge.call(p.folder, 'getTicketGrade', { runId: p.runId, ticketId: `${p.apiTicket.slice(0, -4)}zzzz` }), 'not_found', 'not_found'],
      ['a ticket read without its run', () => bridge.call(p.folder, 'getSpaceSignals', { level: 'ticket', id: p.apiTicket }), 'invalid_input', 'fix_input'],
      ['a cutoff that is not a time', () => bridge.call(p.folder, 'getRunGrade', { runId: p.runId, cutoff: 'yesterday' }), 'invalid_input', 'fix_input'],
      ['a cutoff without an offset', () => bridge.call(p.folder, 'getRunGrade', { runId: p.runId, cutoff: '2026-03-01T10:00:00' }), 'invalid_input', 'fix_input'],
      ['a command the desktop may not call', () => bridge.call(p.folder, 'startRun' as never, { epicId: p.epicId } as never), 'unauthorized', 'not_permitted'],
      ['a stale draft revision', () => bridge.call(p.folder, 'setTicketBudget', { epicId: p.epicId, ticketId: p.guideTicket, budget: null, expectedDraftRevision: 7 }), 'conflict', 'reload']
    ]
    for (const [label, attempt, code, action] of cases) {
      expect({ label, failure: await failureOf(attempt()) }).toMatchObject({ label, failure: { code, action } })
    }
    expect(scoreReadError(new Error('socket closed'))).toEqual({ code: 'unexpected', message: 'socket closed', action: 'retry' })
  })

  it('reads a report stored without a scorecard as legacy, with its pinned identity and no grade anywhere', async () => {
    const s = await session()
    const revision = await submitReport(s.p, 'A report as an older build stored it.')
    // As a report imported from before scorecards existed: its row carries no scorecard.
    s.p.desktop.ctx().db.run('UPDATE sprint_reports SET scorecard_json = NULL WHERE id = ?', revision.id)
    await s.show({ kind: 'report', reportId: revision.id, reportRevision: revision.reportRevision })
    const state = s.reader.state()
    expect(state).toMatchObject({ status: 'ready', data: { state: 'legacy', report: { reportId: revision.id, reportRevision: 1 }, reason: expect.any(String) } })
    expect(state.status === 'ready' && 'scorecard' in state.data).toBe(false)
    const reassessed = await s.bridge.call(s.p.folder, 'reassessReportScorecard', { reportId: revision.id })
    expect({ legacy: reassessed.legacy, approved: reassessed.approved, approvedSubjects: reassessed.subjects.filter((subject) => subject.approved !== null) }).toEqual({ legacy: true, approved: null, approvedSubjects: [] })
  })
})

describe('refresh through the bridge (DM-179 c4)', () => {
  it('drops a late answer for the ticket the person already left', async () => {
    const s = await session()
    const held = deferred()
    let holds = 0
    // The first grade read (the API ticket's) has its answer but is held back until the person has moved on.
    s.gate = (name) => (name === 'getTicketGrade' && holds === 0 ? ((holds += 1), held.promise) : Promise.resolve())
    let slowSettled = false
    const slow = s.show(ticket(s, s.p.apiTicket)).then(() => {
      slowSettled = true
    })
    await s.show(ticket(s, s.p.guideTicket))
    expect({ holds, slowSettled, shown: described(s.reader.state()) }).toEqual({ holds: 1, slowSettled: false, shown: `ready(ticket:${s.p.guideTicket}:ungraded)` })
    held.resolve()
    await slow
    expect(described(s.reader.state())).toBe(`ready(ticket:${s.p.guideTicket}:ungraded)`)
    expect(s.log.filter((line) => line.includes(s.p.apiTicket))).toEqual([])
  })

  it('shows new records in place: overlapping refreshes make one read and one follow-up, a failed refresh keeps the grade', async () => {
    const s = await session()
    await s.show(ticket(s, s.p.apiTicket))
    s.log.length = 0
    await rate(s, 4)
    const before = s.loads
    await Promise.all([s.reader.refresh(), s.reader.refresh(), s.reader.refresh()])
    expect(s.loads - before).toBe(2)
    expect(s.log.includes('loading')).toBe(false)
    expect(ratings(s.reader.state())).toEqual([4])
    s.gate = () => Promise.reject(Object.assign(new Error('The desktop is busy.'), { code: 'busy' }))
    await s.reader.refresh()
    expect(described(s.reader.state())).toBe(`ready(ticket:${s.p.apiTicket}:final, refresh failed: retry)`)
    expect(ratings(s.reader.state())).toEqual([4])
  })

  it('does not lose a refresh asked for while a read is in flight', async () => {
    const s = await session()
    await s.show(ticket(s, s.p.apiTicket))
    const held = deferred()
    let first = true
    s.gate = () => (first ? ((first = false), held.promise) : Promise.resolve())
    // The polled read has its answer (before the rating) but has not delivered it when the write asks for a refresh.
    const polled = s.reader.refresh()
    s.p.harness.clock.advanceSeconds(10)
    await rate(s, 3)
    const prompted = s.reader.refresh()
    held.resolve()
    await Promise.all([polled, prompted])
    expect(ratings(s.reader.state())).toEqual([3])
  })
})

describe('stale edits beside a refreshing view (DM-179 c4)', () => {
  it('never lets a refresh overwrite the person’s unsaved rating, and flags the change under it', async () => {
    const s = await session()
    await s.show(ticket(s, s.p.apiTicket))
    let form: EditBuffer<number | null> = { ...editBuffer<number | null>(null), edit: { value: 2 } }
    await rate(s, 5)
    await s.reader.refresh()
    form = rebaseEdit(form, ratings(s.reader.state()).at(-1) ?? null, (x, y) => x === y)
    expect(form).toEqual({ base: 5, edit: { value: 2 }, baseMoved: true })
    const saved = await rate(s, form.edit?.value ?? 0)
    form = settleEdit(form, saved.measurement.state === 'observed' ? saved.measurement.value : null)
    await s.reader.refresh()
    expect({ form, latest: ratings(s.reader.state()).at(-1) }).toEqual({ form: { base: 2, edit: null, baseMoved: false }, latest: 2 })
  })

  it('refuses a clearing budget edit on an older draft as a conflict to reload, keeps it in the form, and applies it reapplied', async () => {
    const s = await session()
    const { p, bridge } = s
    const opened = (await bridge.call(p.folder, 'openDraft', { epicId: p.epicId })).draftRevision ?? 0
    const firstWindow = await bridge.call(p.folder, 'setTicketBudget', { epicId: p.epicId, ticketId: p.guideTicket, budget: { tokens: 40_000 }, expectedDraftRevision: opened })
    // The second window clears the budget: `null` is the edit, not "no edit".
    let form: EditBuffer<{ tokens: number } | null> = { ...editBuffer<{ tokens: number } | null>(null), edit: { value: null } }
    const stale = await failureOf(bridge.call(p.folder, 'setTicketBudget', { epicId: p.epicId, ticketId: p.guideTicket, budget: null, expectedDraftRevision: opened }))
    expect(stale).toMatchObject({ code: 'conflict', action: 'reload' })
    const draft = await bridge.call(p.folder, 'getPlan', { epicId: p.epicId, view: 'draft' })
    const reloaded = draft.bundle.tickets.find((entry) => entry.id === p.guideTicket)?.budget?.tokens ?? null
    form = rebaseEdit(form, reloaded === null ? null : { tokens: reloaded }, (x, y) => x?.tokens === y?.tokens)
    expect(form).toEqual({ base: { tokens: 40_000 }, edit: { value: null }, baseMoved: true })
    const reapplied = await bridge.call(p.folder, 'setTicketBudget', { epicId: p.epicId, ticketId: p.guideTicket, budget: form.edit?.value ?? null, expectedDraftRevision: firstWindow.draftRevision })
    const after = await bridge.call(p.folder, 'getPlan', { epicId: p.epicId, view: 'draft' })
    expect({ moved: reapplied.draftRevision > firstWindow.draftRevision, budget: after.bundle.tickets.find((entry) => entry.id === p.guideTicket)?.budget }).toEqual({ moved: true, budget: undefined })
  })
})

describe('navigation and refusals through the bridge (DM-179 c4)', () => {
  it('shows revision 1 when the person moves back while revision 2 loads, and each revision its own snapshot', async () => {
    const s = await session()
    const rev1 = await submitReport(s.p, 'Sprint 1 is over.')
    s.p.harness.clock.advanceSeconds(60)
    const rev2 = await submitReport(s.p, 'Sprint 1 is over (revised).')
    const held = deferred()
    let holding = true
    s.gate = (name) => (name === 'getReportScorecard' && holding ? ((holding = false), held.promise) : Promise.resolve())
    const lateRev2 = s.show({ kind: 'report', reportId: rev2.id, reportRevision: 2 })
    await s.show({ kind: 'report', reportId: rev1.id, reportRevision: 1 })
    held.resolve()
    await lateRev2
    s.gate = null
    const atRev1 = s.reader.state()
    expect(described(atRev1)).toBe('ready(report:r1)')
    await s.show({ kind: 'report', reportId: rev2.id, reportRevision: 2 })
    const atRev2 = s.reader.state()
    const snapshot = (state: ScoreReadState<View>) => (state.status === 'ready' && 'state' in state.data && state.data.state === 'frozen' ? state.data.scorecard.snapshot : null)
    expect({ one: snapshot(atRev1)?.cutoff, two: snapshot(atRev2)?.cutoff }).toEqual({ one: rev1.createdAt, two: rev2.createdAt })
  })

  it('keeps two runs of one epic apart as separate selections with their own grades', async () => {
    const s = await session()
    await s.p.orchestrator.cancelRun({ runId: s.p.runId, reason: 'Start over in a new run.' })
    const second = await s.p.orchestrator.startRun({ epicId: s.p.epicId })
    await s.show({ kind: 'run', runId: s.p.runId })
    const first = described(s.reader.state())
    await s.show({ kind: 'run', runId: second.id })
    expect([first.startsWith(`ready(run:${s.p.runId}:`), described(s.reader.state()).startsWith(`ready(run:${second.id}:`)]).toEqual([true, true])
  })

  it('shows capability refusals as typed, non-retryable errors and a refused selection as an error, never an empty grade', async () => {
    const s = await session()
    const { p, bridge } = s
    const elsewhere = `${p.folder}-elsewhere`
    const refusals = await Promise.all([
      failureOf(bridge.call(p.folder, 'recordRunMetrics' as never, { runId: p.runId, overhead: 'review', reports: [] } as never)),
      failureOf(bridge.call(elsewhere, 'getRunGrade', { runId: p.runId })),
      failureOf(p.orchestrator.recordHumanFeedback({ target: { epicId: p.epicId, ticketId: p.apiTicket }, feedback: { kind: 'rating', value: 5 } })),
      failureOf(p.harness.open('reader').setTicketBudget({ epicId: p.epicId, ticketId: p.apiTicket, budget: null, expectedDraftRevision: 1 }))
    ])
    expect(refusals.map((failure) => failure?.action)).toEqual(['not_permitted', 'not_permitted', 'not_permitted', 'not_permitted'])
    await s.reader.select(scoreKey(elsewhere, { kind: 'run', runId: p.runId }), () => bridge.call(elsewhere, 'getRunGrade', { runId: p.runId }))
    expect(s.log.slice(-2)).toEqual(['loading', 'error:unauthorized/not_permitted'])
  })
})
