/**
 * Real core reads for the epic and sprint-report Scorecard tests: per world, every command the renderer's score
 * loaders sent and what the core answered, recorded by src/test/scorecardWorldRecorder.ts (see it for what each world
 * holds and how to rerun it; src/test/scorecardWorldRecorder.test.ts fails when a recording no longer matches the
 * core's read models). Tests replay them, so each view is built by the renderer's own loaders from the core's own read
 * models. Every read returns a fresh copy, so no test sees another's edits.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { CommandName } from '../../../shared/domain/api'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { RunView } from '../../../shared/domain/views'
import type { CommandRunner, ScoreIdentity } from '../scorecard/scoreReads'
import { FakeDm } from './fakeDm'

export type WorldName = 'epicActive' | 'epicCompleted' | 'reportApproved' | 'reportCheckout' | 'reportLive' | 'reportEmpty'

/** The commands the score loaders and the report tab send: the only ones a recording may hold. */
const RECORDED = [
  'getEpicGrade',
  'getRun',
  'getPlan',
  'getSprintReport',
  'getReportScorecard',
  'getSprintGrade',
  'getRunTiming',
  'getRunEfficiency',
  'reassessReportScorecard',
  'getSpaceSignals',
  'getGradingPolicy'
] as const satisfies readonly CommandName[]

/**
 * A recording's envelope. Each output is checked against the core's read models by the recorder test, which records
 * the worlds afresh and compares them with these files.
 */
const RecordingSchema = z.strictObject({
  ids: z.strictObject({
    epicId: z.string(),
    runId: z.string(),
    sprintId: z.string(),
    report: z.strictObject({ reportId: z.string(), reportRevision: z.number().int() }).nullable()
  }),
  calls: z.array(z.strictObject({ name: z.enum(RECORDED), input: z.unknown(), output: z.unknown() }))
})

export type Recording = z.infer<typeof RecordingSchema>
type RecordedCall = Recording['calls'][number]

/**
 * The recorded worlds beside this module, wherever the tests run from. Not `new URL(…, import.meta.url)`: under jsdom,
 * `URL` is jsdom's, which Node's fileURLToPath refuses (as in rootTokens.ts).
 */
const WORLDS_DIR = join(import.meta.dirname, 'scorecardWorlds')

/** A fresh copy of one recorded world, its envelope checked. */
export function world(name: WorldName): Recording {
  return RecordingSchema.parse(JSON.parse(readFileSync(join(WORLDS_DIR, `${name}.json`), 'utf8')))
}

/** The recorded answer to a command with this input; throws for anything the world never read. */
function answer(calls: readonly RecordedCall[], name: string, input: unknown): unknown {
  const asked = JSON.stringify(input ?? null)
  const found = calls.find((call) => call.name === name && JSON.stringify(call.input) === asked)
  if (found === undefined) throw new Error(`The recorded world never read ${name} ${asked}`)
  return structuredClone(found.output)
}

/** The recorded world as the loaders' command runner (each answer exactly as the core gave it). */
export function replay(calls: readonly RecordedCall[]): CommandRunner {
  const run = (name: string, input: unknown): Promise<unknown> => Promise.resolve(answer(calls, name, input))
  return run as CommandRunner
}

/** A FakeDm answering every command the recorded world read, as the core answered it. */
export function worldDm(calls: readonly RecordedCall[]): FakeDm {
  const dm = new FakeDm()
  for (const name of new Set(calls.map((call) => call.name))) {
    dm.handlers[name] = (input) => answer(calls, name, input)
  }
  return dm
}

/** The report card the world read: pinned to its report revision, else (no report yet) the sprint's live grade. */
export function reportCardIdentity(recording: Recording): Extract<ScoreIdentity, { kind: 'reportCard' }> {
  const { runId, sprintId, report } = recording.ids
  return { kind: 'reportCard', runId, sprintId, report }
}

/** The run and saved plan the report tab is shown with, as the world read them. */
export async function reportContext(recording: Recording): Promise<{ run: RunView; bundle: PlanBundle }> {
  const run = replay(recording.calls)
  const view = await run('getRun', { runId: recording.ids.runId })
  if (view === null) throw new Error('The recorded world holds its run.')
  const plan = await run('getPlan', { epicId: recording.ids.epicId, view: 'saved' })
  return { run: view, bundle: plan.bundle }
}
