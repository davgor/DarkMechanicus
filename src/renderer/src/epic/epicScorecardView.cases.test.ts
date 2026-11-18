import { describe, expect, it } from 'vitest'
import type { RequiredOutcome, SubjectReassessment } from '../../../shared/domain/spaceGrades'
import { replay, world } from '../__mocks__/scorecardWorlds'
import { type EpicAssessment, type EpicCardView, type EpicRunRead, loadEpicCard } from '../scorecard/scoreReads'
import { localTime } from '../scorecard/scorecardFormat'
import {
  epicTicketNames,
  failureCauses,
  type GradedEpic,
  gradedEpic,
  gradedSprint,
  outcomeConclusion,
  reassessmentComparison,
  resourceComparisons,
  runLabel,
  runTimingRows,
  runUsageRows,
  runUsages,
  scopeRows,
  totalRows,
  wallRows
} from './epicScorecardView'

type Rows = ReadonlyArray<{ label: string; value: unknown }>
type RunEntry = EpicCardView['runs'][number]
type Live = Extract<EpicAssessment, { state: 'live' }>
type Frozen = Extract<EpicAssessment, { state: 'frozen' }>

const value = (rows: Rows, label: string): string => String(rows.find((row) => row.label === label)?.value)
const TOKENS = 'Tokens (every attempt and overhead)'
const RETRIES = 'Retried attempts'
const WALL = 'Wall time (union of run windows)'
const UNREAD = { code: 'not_found' as const, message: 'the run is gone', action: 'not_found' as const }
const NO_NAMES = new Map<string, { key: string; title: string }>()

async function cardOf(key: 'epicActive' | 'epicCompleted'): Promise<EpicCardView> {
  const recording = world(key)
  return loadEpicCard(replay(recording.calls), { epicId: recording.ids.epicId, completed: key === 'epicCompleted' })
}

function graded(card: EpicCardView): GradedEpic {
  const result = gradedEpic(card.assessment)
  if (result === null) throw new Error('the world epic is graded')
  return result
}

function liveOf(card: EpicCardView): Live {
  if (card.assessment.state !== 'live') throw new Error('the active epic is live')
  return card.assessment
}

function frozenOf(card: EpicCardView): Frozen {
  if (card.assessment.state !== 'frozen') throw new Error('the completed epic is frozen')
  return card.assessment
}

function runRead(card: EpicCardView, index: number): EpicRunRead {
  const read = card.runs[index]?.read
  if (read?.ok !== true) throw new Error('the world run reads')
  return read.value
}

/** A copy of one world run under another id and number, changed as given. */
function runVariant(card: EpicCardView, index: number, number: number, change: (read: EpicRunRead) => EpicRunRead): RunEntry {
  const read = runRead(card, index)
  const runId = `rn_variant_${number}`
  return { runId, read: { ok: true, value: change({ ...read, run: { ...read.run, id: runId, number } }) } }
}

const unreadRun = (runId: string): RunEntry => ({ runId, read: { ok: false, error: UNREAD } })

function outcome(ticketId: string, role: RequiredOutcome['role'], state: RequiredOutcome['state']): RequiredOutcome {
  const reason = state === 'failed' ? 'confirmed_failure' : state === 'pending' ? 'awaiting_review' : 'run_ended'
  return { runId: 'rn_1', ticketId, role, state, reason, attemptId: null, movedOut: false, counted: true }
}

describe('reading the graded epic: frozen inputs that cannot be read, sprints and live sources', () => {
  it('grades nothing when a frozen input is absent or of another component’s shape, or nothing was frozen', async () => {
    const frozen = frozenOf(await cardOf('epicCompleted'))
    const { epic } = frozen.snapshot
    if (epic === null) throw new Error('the completed epic froze its grade')
    const inputs = frozen.snapshot.inputs
    const misfiled = { ...frozen, snapshot: { ...frozen.snapshot, inputs: { ...inputs, [epic.inputs.A]: inputs[epic.inputs.C] } } }
    const lost = { ...frozen, snapshot: { ...frozen.snapshot, inputs: Object.fromEntries(Object.entries(inputs).filter(([hash]) => hash !== epic.inputs.K)) } }
    expect(gradedEpic(frozen)?.frozen).toBe(true)
    expect(gradedEpic(misfiled)).toBeNull()
    expect(gradedEpic(lost)).toBeNull()
    expect(gradedEpic({ ...frozen, snapshot: { ...frozen.snapshot, epic: null } })).toBeNull()
    expect(gradedEpic({ state: 'legacy', report: frozen.report, reason: 'The report predates scorecards.' })).toBeNull()
    expect(gradedEpic({ state: 'not_frozen', reason: 'No final report.' })).toBeNull()
  })

  it('grades an open sprint live and leaves a legacy sprint ungraded', async () => {
    const card = await cardOf('epicActive')
    const open = runRead(card, 0).sprints[1]?.assessment
    if (open?.ok !== true) throw new Error('sprint 2 reads')
    const sprint = gradedSprint(open.value)
    expect(sprint?.frozen).toBe(false)
    expect(sprint?.grade.subject.level).toBe('sprint')
    expect(sprint?.scope).not.toBeNull()
    expect(gradedSprint({ state: 'legacy', report: frozenOf(await cardOf('epicCompleted')).report, reason: 'legacy' })).toBeNull()
  })

  it('keeps a live source without a measured run id and counts no rejection when none was recorded', async () => {
    const live = liveOf(await cardOf('epicActive'))
    const { components } = live.view.input
    const view = { ...live.view, measuredRunIds: [], input: { ...live.view.input, components: { ...components, C: { ...components.C, rejected: undefined } } } }
    const epic = gradedEpic({ state: 'live', view })
    expect(epic?.measures.map((measure) => measure.runId)).toEqual([''])
    expect(epic?.rejectedSubmissions).toBe(0)
    expect(failureCauses(epic ?? graded(await cardOf('epicActive')), NO_NAMES).map((cause) => cause.text).join(' ')).not.toContain('rejected by review')
  })
})

describe('naming tickets and runs', () => {
  it('names a ticket only the shown plan holds, and a run that could not be read by its id', async () => {
    const card = await cardOf('epicActive')
    const { bundle } = runRead(card, 0)
    const ticket = bundle.tickets[0]
    if (ticket === undefined) throw new Error('the plan holds tickets')
    const bare = { ...card, runs: [unreadRun('rn_gone')] }
    expect(epicTicketNames(bare, null).get(ticket.id)).toBeUndefined()
    expect(epicTicketNames(bare, bundle).get(ticket.id)).toEqual({ key: ticket.key, title: ticket.title })
    expect(runLabel(bare, 'rn_gone')).toBe('Run rn_gone')
    expect(runLabel(card, card.runs[0]?.runId ?? '')).toBe('Run #1')
  })
})

describe('original scope and the outcome in words', () => {
  it('reads the committed scope as unavailable when none was frozen before dispatch', async () => {
    const epic = graded(await cardOf('epicActive'))
    const rows = scopeRows({ ...epic, delivery: { ...epic.delivery, committed: null } })
    expect(value(rows, 'Committed before dispatch')).toBe('unavailable (no scope frozen before dispatch)')
    expect(value(rows, 'Delivered of that scope')).toBe('unavailable')
  })

  it('falls back to the failed mandatory check when no counted outcome failed', async () => {
    const epic = graded(await cardOf('epicActive'))
    const outcomes = [outcome('tk_a', 'work', 'verified'), outcome('tk_b', 'integrated', 'verified')]
    expect(outcomeConclusion({ ...epic, outcomes }, NO_NAMES)).toBe(
      '1 of 1 feature ticket(s) and 1 of 1 integrated outcome(s) are verified, yet the epic failed: a mandatory check failed. A confirmed failure of a required or integrated outcome caps the grade at F, so completed tickets alone do not make the epic a success.'
    )
  })

  it('names the open outcomes of an unverified epic, and says so when none is open', async () => {
    const epic = graded(await cardOf('epicActive'))
    const unverified = { ...epic, grade: { ...epic.grade, outcome: 'unverified' as const } }
    const open = [outcome('tk_a', 'work', 'verified'), outcome('tk_b', 'work', 'pending'), outcome('tk_c', 'integrated', 'missing')]
    expect(outcomeConclusion({ ...unverified, outcomes: open }, NO_NAMES)).toBe(
      '1 of 2 feature ticket(s) and 0 of 1 integrated outcome(s) are verified, but the epic is not verified: 2 counted outcome(s) are pending or lack reviewed evidence (tk_b, tk_c). Completed tickets alone do not prove it succeeded.'
    )
    expect(outcomeConclusion({ ...unverified, outcomes: [] }, NO_NAMES)).toBe(
      '0 of 0 feature ticket(s) and 0 of 0 integrated outcome(s) are verified, but the epic is not verified: 0 counted outcome(s) are pending or lack reviewed evidence. Completed tickets alone do not prove it succeeded.'
    )
  })

  it('says every counted outcome is verified for a verified epic', async () => {
    const epic = graded(await cardOf('epicActive'))
    const verified = { ...epic, grade: { ...epic.grade, outcome: 'verified' as const }, outcomes: [outcome('tk_a', 'integrated', 'verified')] }
    expect(outcomeConclusion(verified, NO_NAMES)).toBe('0 of 0 feature ticket(s) and 1 of 1 integrated outcome(s) are verified: every counted outcome, integrated ones included, is verified.')
  })
})

describe('usage over every run the card covers', () => {
  it('reads an unmeasured run’s own usage, and names a run whose read or usage read failed', async () => {
    const card = await cardOf('epicActive')
    const scope = liveOf(card).view.sources.efficiency[0]
    if (scope === undefined) throw new Error('the live grade measured its run')
    const idle = runVariant(card, 0, 2, (read) => ({ ...read, usage: { ok: true, value: scope } }))
    const busy = runVariant(card, 0, 3, (read) => ({ ...read, usage: { ok: false, error: { code: 'unexpected', message: 'the app was busy', action: 'retry' } } }))
    const wide = { ...card, runs: [...card.runs, idle, busy, unreadRun('rn_gone')] }
    const usages = runUsages(wide, graded(card))
    expect(usages.map((usage) => (usage.measure === null ? usage.reason : usage.measure.runId))).toEqual([card.runs[0]?.runId, 'rn_variant_2', 'its usage read failed (the app was busy)', 'its read failed'])
    const rows = totalRows(wide, graded(card))
    expect(value(rows, TOKENS)).toBe('≥ 226,000 tokens (a lower bound: Run #3: its usage read failed (the app was busy); Run rn_gone: its read failed)')
    expect(value(rows, RETRIES)).toBe('≥ 4 (a diagnostic, never scored as waste; Run #3 unavailable; Run rn_gone unavailable)')
  })

  it('counts what a run reported toward a missing total, and marks an estimated total without a lower bound', async () => {
    const card = await cardOf('epicActive')
    const epic = graded(card)
    const [measure] = epic.measures
    if (measure === undefined) throw new Error('the live grade measured its run')
    const partial = { ...measure, tokens: { state: 'missing' as const, reason: 'partial_coverage' as const }, reported: { ...measure.reported, tokens: 90_000 } }
    expect(value(totalRows(card, { ...epic, measures: [partial] }), TOKENS)).toBe('≥ 90,000 tokens (a lower bound: Run #1: only partly reported, 90,000 tokens of it reported and counted)')
    const estimated = { ...measure, tokens: { state: 'estimated' as const, value: 113_000, method: 'host estimate' } }
    expect(value(totalRows(card, { ...epic, measures: [estimated] }), TOKENS)).toBe('≈ 113,000 tokens (estimated in part)')
  })

  it('reads totals and wall time as unavailable when the card covers no run', async () => {
    const card = await cardOf('epicActive')
    const rows = totalRows({ ...card, runs: [] }, graded(card))
    expect(value(rows, TOKENS)).toBe('unavailable (no run)')
    expect(value(rows, RETRIES)).toBe('unavailable')
    expect(value(rows, 'Runs counted')).toBe('none')
    expect(wallRows({ ...card, runs: [] })).toEqual([{ label: 'Wall time', value: 'unavailable (no run)' }])
  })

  it('names a run that ran no attempt beside the retries, and reads one run’s missing figures as such', async () => {
    const card = await cardOf('epicActive')
    const epic = graded(card)
    const [measure] = epic.measures
    if (measure === undefined) throw new Error('the live grade measured its run')
    const idle = { ...measure, retries: null, effortMs: null }
    expect(value(totalRows(card, { ...epic, measures: [idle] }), RETRIES)).toBe('0 (a diagnostic, never scored as waste; Run #1 ran no attempt)')
    const rows = runUsageRows({ runId: measure.runId, measure: idle })
    expect(value(rows, 'Effort')).toBe('unavailable (no effort reported)')
    expect(value(rows, RETRIES)).toBe('unavailable')
    expect(runUsageRows({ runId: 'rn_gone', measure: null, reason: 'its read failed' })).toEqual([{ label: 'Usage', value: 'unavailable (its read failed)' }])
  })
})

describe('wall time when no run window can be read', () => {
  it('names why each run has no window: never started, not ended, unread, timing unread, never started by its timing', async () => {
    const card = await cardOf('epicCompleted')
    const timingFailed = runVariant(card, 1, 4, (read) => ({ ...read, timing: { ok: false, error: UNREAD } }))
    const frozen = runRead(card, 1).timing
    if (!frozen.ok || frozen.value.state !== 'frozen') throw new Error('Run #2 froze its timing')
    const { timing } = frozen.value
    const unstarted = { ...frozen.value, timing: { ...timing, run: { ...timing.run, startedAt: null } } }
    const runs = [
      runVariant(card, 0, 1, (read) => ({ ...read, run: { ...read.run, startedAt: null } })),
      runVariant(card, 0, 2, (read) => ({ ...read, run: { ...read.run, endedAt: null } })),
      unreadRun('rn_gone'),
      timingFailed,
      runVariant(card, 1, 5, (read) => ({ ...read, timing: { ok: true, value: unstarted } }))
    ]
    expect(wallRows({ ...card, runs })).toEqual([
      {
        label: WALL,
        value: 'unavailable (Run #1: it never started; Run #2: it has not ended and no timing was frozen for it; Run rn_gone: its read failed; Run #4: its timing read failed; Run #5: it never started)'
      }
    ])
  })
})

describe('one run’s timing block', () => {
  it('reads the lifecycle of a run that never ended and froze no timing as unavailable', async () => {
    const card = await cardOf('epicCompleted')
    const rows = runTimingRows({ ...runRead(card, 0).run, endedAt: null }, { state: 'none' })
    expect(value(rows, 'Run lifecycle (server start → end)')).toBe('unavailable (it has not both started and ended)')
    expect(value(rows, 'Measured activity')).toBe('unavailable (no report of this run froze its timing)')
  })

  it('keeps an estimated quantity open at the last report estimated as well as a lower bound', async () => {
    const card = await cardOf('epicCompleted')
    const frozen = runRead(card, 1).timing
    if (!frozen.ok || frozen.value.state !== 'frozen') throw new Error('Run #2 froze its timing')
    const { timing } = frozen.value
    const estimated = { ...frozen.value, timing: { ...timing, run: { ...timing.run, elapsed: { ...timing.run.elapsed, state: 'estimated' as const } } } }
    expect(value(runTimingRows(runRead(card, 1).run, estimated), 'Window (start → end)')).toBe(`≥ 32 min (estimated; open at its last report, ${localTime(timing.asOf)}; a lower bound)`)
  })

  it('says no attempt has ended yet, and names attempts that reported nothing in their bucket', async () => {
    const card = await cardOf('epicActive')
    const live = runRead(card, 0).timing
    if (!live.ok || live.value.state !== 'live') throw new Error('Run #1 is live')
    const { timing } = live.value
    const run = runRead(card, 0).run
    const BY_OUTCOME = 'Effort by how attempts ended'
    expect(value(runTimingRows(run, { state: 'live', timing: { ...timing, effortByOutcome: {} } }), BY_OUTCOME)).toBe('none yet')
    const unreported = { accepted: { attempts: 2, elapsedMs: 1_920_000, effortMs: 1_800_000, unreported: 1, unknownMs: 0 } }
    expect(value(runTimingRows(run, { state: 'live', timing: { ...timing, effortByOutcome: unreported } }), BY_OUTCOME)).toBe('accepted: 2 attempt(s), 30 min, 1 reported nothing')
  })
})

describe('failure causes in order', () => {
  it('lists failed outcomes integrated first, then open ones integrated first, then corrective effort largest cause first', async () => {
    const epic = graded(await cardOf('epicActive'))
    const outcomes = [outcome('tk_a', 'work', 'failed'), outcome('tk_b', 'integrated', 'failed'), outcome('tk_c', 'work', 'pending'), outcome('tk_d', 'integrated', 'missing')]
    const measures = epic.measures.flatMap((measure) => [
      { ...measure, correctiveByCause: { implementation: 60_000 } },
      { ...measure, runId: 'rn_other', correctiveByCause: { implementation: 30_000, tooling: 120_000 } }
    ])
    const causes = failureCauses({ ...epic, outcomes, measures, rejectedSubmissions: 0 }, NO_NAMES)
    expect(causes.map((cause) => cause.ticketId)).toEqual(['tk_b', 'tk_a', 'tk_d', 'tk_c', null, null])
    expect(causes[0]?.text).toBe('tk_b — integrated (acceptance or administrative) · failed: confirmed failure (a criterion or check failed, or every try was used); caps the grade at F')
    expect(causes.slice(4).map((cause) => cause.text)).toEqual(['Corrective effort, cause tooling: 2 min', 'Corrective effort, cause implementation: 1 min 30 s'])
  })

  it('lists no corrective cause when one measured run keeps none (a frozen snapshot keeps totals only)', async () => {
    const epic = graded(await cardOf('epicActive'))
    const measures = epic.measures.flatMap((measure) => [
      { ...measure, correctiveByCause: { implementation: 60_000 } },
      { ...measure, runId: 'rn_frozen', correctiveByCause: null }
    ])
    const texts = failureCauses({ ...epic, outcomes: [], measures, rejectedSubmissions: 0 }, NO_NAMES).map((cause) => cause.text)
    expect(texts).toEqual([])
  })
})

describe('T and K against their roll-up', () => {
  it('says why each pair is not compared: no actual, a partial roll-up, no baseline, a refused baseline', async () => {
    const epic = graded(await cardOf('epicCompleted'))
    const baseline = (component: 'T' | 'K', change: Record<string, unknown> | null): GradedEpic['grade']['components'] =>
      epic.grade.components.map((result) => (result.component === component && result.explanation.baseline !== null ? { ...result, explanation: { ...result.explanation, baseline: change === null ? null : { ...result.explanation.baseline, ...change } } } : result))
    const texts = (variant: GradedEpic): string[] => resourceComparisons(variant, NO_NAMES).map((comparison) => `${String(comparison.comparable)} ${comparison.text}`)
    expect(texts({ ...epic, resources: { ...epic.resources, T: { state: 'missing', reason: 'not_reported' } }, rollups: { ...epic.rollups, K: { partial: true, uncovered: null } } })).toEqual([
      'false Not compared: the actual is unavailable (not reported).',
      'false Not compared: insufficient: executed work ticket(s) without a baseline of their own leave the roll-up partial.'
    ])
    expect(texts({ ...epic, grade: { ...epic.grade, components: baseline('T', null).filter((result) => result.component !== 'K') } })).toEqual([
      'false Not compared: insufficient: no executed ticket’s grade accepted a budget or cohort baseline to roll up.',
      'false Not compared: insufficient: no executed ticket’s grade accepted a budget or cohort baseline to roll up.'
    ])
    expect(texts({ ...epic, grade: { ...epic.grade, components: baseline('T', { refusedReason: 'metric_mismatch' }) } })[0]).toBe('false Not compared: the grader refused the roll-up (metric mismatch).')
  })

  it('compares against a zero roll-up without a share and with no sample size as 0 baselines', async () => {
    const epic = graded(await cardOf('epicCompleted'))
    const components = epic.grade.components.map((result) => (result.component === 'K' && result.explanation.baseline !== null ? { ...result, explanation: { ...result.explanation, baseline: { ...result.explanation.baseline, value: 0, sampleSize: null } } } : result))
    const [time, tokens] = resourceComparisons({ ...epic, grade: { ...epic.grade, components } }, NO_NAMES)
    expect(tokens).toEqual({ label: 'Tokens (K) against the roll-up', comparable: true, text: '55,000 tokens against a roll-up of 0 ticket baseline(s), 0 tokens.' })
    expect(time?.text).toContain('against a roll-up of 2 ticket baseline(s), 1 h 00 min (')
  })
})

describe('the frozen epic grade against its reassessment', () => {
  async function subjectOf(): Promise<SubjectReassessment> {
    const read = (await cardOf('epicCompleted')).reassessment
    if (read?.ok !== true || read.value.subject === null) throw new Error('the completed epic is reassessed')
    return read.value.subject
  }

  it('compares nothing when nothing was frozen or the epic is no longer graded', async () => {
    const subject = await subjectOf()
    expect(reassessmentComparison({ ...subject, approved: null }).text).toBe('Not compared: nothing was frozen for the epic.')
    expect(reassessmentComparison({ ...subject, current: null })).toEqual({ label: 'Frozen epic grade against the records now', comparable: false, text: 'Not compared: the epic is no longer graded.' })
  })

  it('compares nothing across windows from different dispatches or a changed policy', async () => {
    const subject = await subjectOf()
    const { windows } = subject
    const moved = { ...windows, comparable: false, approved: { ...windows.approved, from: null } }
    expect(reassessmentComparison({ ...subject, windows: moved }).text).toBe(
      `Not compared: the observation windows start at different dispatches (frozen window no dispatch → ${localTime(windows.approved.to)}; current window ${localTime(windows.current.from ?? '')} → ${localTime(windows.current.to)}).`
    )
    const current = subject.current === null ? null : { ...subject.current, policyHash: 'sha256:other' }
    expect(reassessmentComparison({ ...subject, current }).text).toBe('Not compared: the policy changed since the grade was frozen; the same-window regrade shows the policy’s effect.')
    expect(reassessmentComparison(subject).comparable).toBe(true)
  })
})
