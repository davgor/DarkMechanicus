/**
 * Records the epic and sprint-report Scorecard worlds the renderer tests replay (DM-272). Each world is a measured
 * workspace built on `spaceWorld` (real services over an in-memory repository, ids from the test sequence, times from
 * the test clock), read through the real command specs (`COMMANDS`, input schemas included) exactly as the renderer's
 * score loaders read it: every command they send and what the core answers, nothing else.
 *
 * Worlds:
 * - `epicActive`: two sprints, live. Ticket 1 accepted; ticket 2 (no budget) rejected once, then accepted; the
 *   Fireguard ticket 5 (an integrated outcome) rejected twice, so it used every try and failed; orchestration
 *   overhead; ticket 3 (never dispatched) removed and ticket 7 added by an adopted plan; sprint 1 reported (frozen),
 *   sprint 2 live.
 * - `epicCompleted`: one sprint, two runs. Run #1's attempt at ticket 1 was abandoned when the run was cancelled;
 *   Run #2 delivered tickets 1 and 2, reported its final sprint (the epic grade froze), was approved and advanced.
 * - `reportApproved`: sprint 1 of two delivered (ticket 2 retried once), reported and approved; then a person rated
 *   ticket 1 two of five (a late record), and the report was reassessed.
 * - `reportCheckout`: the checkpoint's report awaiting approval: ticket 1 accepted, the Fireguard ticket failed
 *   (its first attempt reported no usage), the acceptance node never ran.
 * - `reportLive`: no report yet: ticket 1 accepted, ticket 2 claimed and still running, nothing budgeted.
 * - `reportEmpty`: no report and nothing dispatched.
 *
 * Rerun after a change to the read models or the loaders (the recorder test fails until you do):
 *   npx tsx src/test/recordScorecardWorlds.ts
 * It rewrites src/renderer/src/__mocks__/scorecardWorlds/<world>.json. Not shipped.
 */
import { COMMANDS } from '../core/commands'
import type { WorkspaceCore } from '../core/commands/types'
import type { Ctx } from '../core/context'
import { advanceSprint, approveCheckpoint } from '../core/services/checkpoints'
import { recordHumanFeedback } from '../core/services/humanFeedback'
import { type CommandRunner, loadEpicCard, loadScore, type ScoreIdentity } from '../renderer/src/scorecard/scoreReads'
import type { CommandName } from '../shared/domain/api'
import { makeTicket, sid, tid } from './bundles'
import { claim } from './execution'
import { adopt, deliver, nextRun, overhead, reject, report, spaceWorld, type SpaceWorld, work } from './spaceWorld'

interface RecordedCall {
  name: CommandName
  input: unknown
  output: unknown
}

/** What a world's tests read it by, and every command the loaders sent with the core's answer. */
interface Recording {
  ids: { epicId: string; runId: string; sprintId: string; report: { reportId: string; reportRevision: number } | null }
  calls: RecordedCall[]
}

export const WORLD_NAMES = ['epicActive', 'epicCompleted', 'reportApproved', 'reportCheckout', 'reportLive', 'reportEmpty'] as const
type WorldName = (typeof WORLD_NAMES)[number]

type Run = (core: Pick<WorkspaceCore, 'ctx'>, input: unknown) => unknown

/** The command channel over the world's desktop session: the spec's input schema, its run, the answer as JSON. */
function recordingRunner(ctx: Ctx, calls: RecordedCall[]): CommandRunner {
  const core = { ctx: () => ctx }
  const run = async (name: CommandName, input: unknown): Promise<unknown> => {
    const spec = COMMANDS[name]
    const parsed = spec.schema === undefined ? undefined : spec.schema.parse(input ?? {})
    // Every command the score loaders send reads only `core.ctx()`.
    const output: unknown = JSON.parse(JSON.stringify((await (spec.run as Run)(core, parsed)) ?? null))
    // A read repeated with the same input answers the same: the replay answers it from the first recording.
    const asked = JSON.stringify(input ?? null)
    if (!calls.some((call) => call.name === name && JSON.stringify(call.input) === asked)) calls.push({ name, input: input ?? null, output })
    return output
  }
  return run as CommandRunner
}

function identityOf(w: SpaceWorld, reported: { id: string; reportRevision: number } | null): Recording['ids'] {
  return { epicId: w.epicId, runId: w.runId, sprintId: w.sprintId, report: reported === null ? null : { reportId: reported.id, reportRevision: reported.reportRevision } }
}

async function epicRecording(w: SpaceWorld, completed: boolean): Promise<Recording> {
  const calls: RecordedCall[] = []
  await loadEpicCard(recordingRunner(w.desktop, calls), { epicId: w.epicId, completed })
  return { ids: identityOf(w, null), calls }
}

/** The report tab's reads: the card, the sprint's signals and the grading policy, and the run and plan it is shown in. */
async function reportRecording(w: SpaceWorld, reported: { id: string; reportRevision: number } | null, reassess: boolean): Promise<Recording> {
  const calls: RecordedCall[] = []
  const run = recordingRunner(w.desktop, calls)
  const ids = identityOf(w, reported)
  const card: ScoreIdentity = { kind: 'reportCard', runId: w.runId, sprintId: w.sprintId, report: ids.report }
  await loadScore(run, card)
  await loadScore(run, { kind: 'sprintSignals', runId: w.runId, sprintId: w.sprintId })
  await run('getGradingPolicy', undefined)
  await run('getRun', { runId: w.runId })
  await run('getPlan', { epicId: w.epicId, view: 'saved' })
  if (reassess && ids.report !== null) await loadScore(run, { kind: 'reassessment', ...ids.report, request: 1 })
  return { ids, calls }
}

function epicActive(): Promise<Recording> {
  const w = spaceWorld({ secondSprint: true, unbudgeted: [2] })
  deliver(w, 1, { minutes: 20, tokens: 40_000 })
  reject(w, work(w, 2, { minutes: 15, tokens: 25_000 }), 'The form loses the card on reload.')
  deliver(w, 2, { minutes: 10, tokens: 20_000 })
  for (const round of [1, 2]) reject(w, work(w, 5, { minutes: 5, tokens: 8_000 }), `Fireguard round ${round} failed.`)
  overhead(w, 6, 12_000)
  adopt(w, (plan) => ({
    ...plan,
    tickets: [...plan.tickets.filter((ticket) => ticket.id !== tid(3)), makeTicket(7, { size: 'medium', budget: { activeMs: 30 * 60_000, tokens: 50_000 } })],
    sprints: plan.sprints.map((sprint) => (sprint.id === sid(1) ? { ...sprint, ticketIds: [...sprint.ticketIds.filter((id) => id !== tid(3)), tid(7)] } : sprint))
  }))
  report(w)
  return epicRecording(w, false)
}

function epicCompleted(): Promise<Recording> {
  const w = spaceWorld({ size: 2 })
  work(w, 1, { minutes: 12, tokens: 18_000 })
  nextRun(w)
  deliver(w, 1, { minutes: 15, tokens: 22_000 })
  deliver(w, 2, { minutes: 10, tokens: 15_000 })
  const final = report(w)
  approveCheckpoint(w.desktop, { runId: w.runId, reportId: final.id })
  w.ctx.clock.advanceSeconds(120)
  advanceSprint(w.orchestrator, { runId: w.runId })
  return epicRecording(w, true)
}

function reportApproved(): Promise<Recording> {
  const w = spaceWorld({ secondSprint: true, overhead: false })
  deliver(w, 1, { minutes: 20, tokens: 40_000 })
  reject(w, work(w, 2, { minutes: 15, tokens: 25_000 }), 'Rows are out of order.')
  deliver(w, 2, { minutes: 10, tokens: 20_000 })
  deliver(w, 3, { minutes: 10, tokens: 15_000 })
  const reported = report(w)
  approveCheckpoint(w.desktop, { runId: w.runId, reportId: reported.id })
  w.ctx.clock.advanceSeconds(3600)
  recordHumanFeedback(w.desktop, { target: { epicId: w.epicId, ticketId: tid(1), runId: w.runId }, feedback: { kind: 'rating', value: 2 }, person: 'Dana' })
  return reportRecording(w, reported, true)
}

function reportCheckout(): Promise<Recording> {
  const w = spaceWorld()
  deliver(w, 1, { minutes: 20, tokens: 40_000 })
  reject(w, work(w, 5, { minutes: null, tokens: null }), 'Fireguard found no tests.')
  reject(w, work(w, 5, { minutes: 5, tokens: 8_000 }), 'Fireguard graded the tests too weak.')
  return reportRecording(w, report(w), false)
}

function reportLive(): Promise<Recording> {
  const w = spaceWorld({ overhead: false, unbudgeted: [1, 2, 3] })
  deliver(w, 1, { minutes: 10, tokens: 12_000 })
  claim(w.ctx, w.runId, 2)
  w.ctx.clock.advanceSeconds(300)
  return reportRecording(w, null, false)
}

function reportEmpty(): Promise<Recording> {
  return reportRecording(spaceWorld({ size: 1 }), null, false)
}

/** Every world, freshly built and read. */
export async function recordScorecardWorlds(): Promise<Record<WorldName, Recording>> {
  return {
    epicActive: await epicActive(),
    epicCompleted: await epicCompleted(),
    reportApproved: await reportApproved(),
    reportCheckout: await reportCheckout(),
    reportLive: await reportLive(),
    reportEmpty: await reportEmpty()
  }
}
