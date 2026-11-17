/**
 * DM-178 c3 across machines, and the DM-269 fixes to it: a report's scorecard is exported as its own record beside the
 * run history, imported byte for byte, and refused when tampered with or re-sealed with parts that do not follow from
 * its grades. Export checks the scorecard on both sides (the file already there and the one it writes), and an import
 * never silently drops another scorecard for a report that already has one.
 */
import { describe, expect, it } from 'vitest'
import type { ScorecardSnapshot } from '../../shared/domain/spaceGrades'
import { tid } from '../../test/bundles'
import { copyTracked, createRepoEnv, createStubGit, flush, importerDeps, type RepoEnv } from '../../test/repoEnv'
import { deliver, overhead, portable, reject, report, spaceWorld, type SpaceWorld, work } from '../../test/spaceWorld'
import { canonicalJson, contentHash, prettyJson } from '../canonical'
import { enqueueOutbox } from '../services/outbox'
import { storedScorecard } from '../services/scorecards'
import { underPolicyV1 } from '../../test/policyV1'
import { frozenInput, parseScorecardSnapshot, snapshotHashOf } from '../space/snapshot'
import { reconcileRepository } from './importer'
import { ownedPaths } from './paths'
import { buildRunHistoryRecord, parseRecord, runHistoryRecord } from './portable'

interface Exported {
  w: SpaceWorld
  reportId: string
  bytes: string
  runFile: string
  cardFile: string
}

/** Tickets 1-3 delivered (ticket 2 after one rejected try), sprint orchestration, the sprint reported and exported. */
function exported(): Exported {
  const w = spaceWorld({ overhead: false, retryLimit: 3 })
  portable(w)
  deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 18, corrective: 2 })
  reject(w, work(w, 2, { minutes: 10, tokens: 10_000, productive: 8, corrective: 2 }), 'not yet')
  deliver(w, 2, { minutes: 20, tokens: 30_000, productive: 18, corrective: 2 })
  deliver(w, 3, { minutes: 20, tokens: 30_000, productive: 18, corrective: 2 })
  overhead(w, 10, 20_000)
  const reportId = report(w).id
  const outcome = flush(w.env)
  expect(outcome.failed).toBe(0)
  const paths = ownedPaths(w.env.layout)
  return {
    w,
    reportId,
    bytes: storedOf(w.env, reportId) ?? '',
    runFile: w.env.fs.get(paths.runHistoryFile(w.runId)) ?? '',
    cardFile: w.env.fs.get(paths.scorecardFile(w.runId, reportId)) ?? ''
  }
}

const storedOf = (env: RepoEnv, reportId: string): string | null =>
  env.db.get<{ scorecard_json: string | null }>('SELECT scorecard_json FROM sprint_reports WHERE id = ?', reportId)?.scorecard_json ?? null

const reconcile = (env: RepoEnv) => reconcileRepository(importerDeps(env, createStubGit()))

/** Drops pooled inputs and details no grade names any more (as an editor re-sealing a consistent-looking file would). */
function prune(card: ScorecardSnapshot): void {
  const grades = [card.sprint, card.run, ...(card.epic === null ? [] : [card.epic]), ...card.tickets]
  const inputs = new Set(grades.flatMap((grade) => Object.values(grade.inputs)))
  const details = new Set([card.sprint, card.run, ...(card.epic === null ? [] : [card.epic])].map((grade) => grade.detail))
  card.inputs = Object.fromEntries(Object.entries(card.inputs).filter(([key]) => inputs.has(key)))
  card.details = Object.fromEntries(Object.entries(card.details).filter(([key]) => details.has(key)))
}

/** Edits the sprint grade's detail and stores it under its new hash. */
function editSprintDetail(card: ScorecardSnapshot, edit: (detail: ScorecardSnapshot['details'][string]) => void): void {
  const detail = structuredClone(card.details[card.sprint.detail])
  if (detail === undefined) throw new Error('no sprint detail')
  edit(detail)
  const key = contentHash(detail)
  card.details[key] = detail
  card.sprint = { ...card.sprint, detail: key }
  prune(card)
}

interface EditedImport {
  rejected: number
  runImported: boolean
  message: string
}

/**
 * Machine B with the exported records, the scorecard file edited by `edit`; with `reseal`, sealed again and the run
 * history's pointer renamed to the new seal, so only the snapshot's own checks stand between the edit and an import.
 */
function importEdited(source: Exported, edit: (card: ScorecardSnapshot) => void, reseal: boolean): EditedImport {
  const target = createRepoEnv()
  copyTracked(source.w.env, target)
  const paths = ownedPaths(target.layout)
  const original = parseScorecardSnapshot(JSON.parse(source.cardFile))
  const card = structuredClone(original)
  edit(card)
  const sealed = reseal ? { ...card, snapshotHash: snapshotHashOf(card) } : card
  target.fs.put(paths.scorecardFile(source.w.runId, source.reportId), prettyJson(sealed))
  if (reseal) target.fs.put(paths.runHistoryFile(source.w.runId), source.runFile.replace(original.snapshotHash, sealed.snapshotHash))
  const result = reconcile(target)
  return {
    rejected: result.rejected.length,
    runImported: target.db.get('SELECT id FROM runs WHERE id = ?', source.w.runId) !== undefined,
    message: result.rejected.map((entry) => entry.message).join(' | ')
  }
}

describe('DM-178 c3: a scorecard survives export and import byte for byte', () => {
  it('exports the scorecard as its own record, which the run history names by id and seal', () => {
    const { bytes, runFile, cardFile } = exported()
    const snapshot = parseScorecardSnapshot(JSON.parse(bytes))
    const named = parseRecord(runHistoryRecord, runFile, 'run.json').reports[0]?.scorecard
    expect(named).toEqual({ snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash })
    expect(runFile).not.toContain('"inputs"')
    expect(cardFile).toBe(prettyJson(JSON.parse(bytes)))
  })

  it('imports on another machine with the same stored bytes and re-exports the same run history', () => {
    const source = exported()
    const machineB = createRepoEnv()
    copyTracked(source.w.env, machineB)
    const result = reconcile(machineB)
    expect(result.rejected).toEqual([])
    expect(result.imported).toContain(source.w.runId)
    expect(storedOf(machineB, source.reportId)).toBe(source.bytes)
    expect(prettyJson(buildRunHistoryRecord(machineB.db, source.w.runId))).toBe(source.runFile)
  })

  it('imports the scorecard of a sprint with a partial roll-up and an attempt that reported no tokens', () => {
    const w = spaceWorld({ overhead: false, unbudgeted: [3] })
    portable(w)
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
    deliver(w, 2, { minutes: 20, tokens: null, productive: 20 })
    deliver(w, 3, { minutes: 20, tokens: 30_000, productive: 20 })
    const reportId = report(w).id
    expect(flush(w.env).failed).toBe(0)
    const snapshot = parseScorecardSnapshot(JSON.parse(storedOf(w.env, reportId) ?? 'null'))
    expect(snapshot.details[snapshot.sprint.detail]?.rollups.T.partial).toBe(true)
    expect(frozenInput(snapshot, snapshot.sprint).components.K.unreportedAttempts).toBe(1)
    const machineB = createRepoEnv()
    copyTracked(w.env, machineB)
    expect(reconcile(machineB).rejected).toEqual([])
    expect(storedOf(machineB, reportId)).toBe(storedOf(w.env, reportId))
  })
})

describe('DM-178 c3: an import refuses a tampered or foreign scorecard', () => {
  const bump = (card: ScorecardSnapshot): void => {
    card.sprint = { ...card.sprint, result: { ...card.sprint.result, score: 99 } }
  }

  it('refuses a hand-edited score whose seal no longer matches', () => {
    const outcome = importEdited(exported(), bump, false)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining('The snapshot hash does not match its content') })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses a re-sealed edited score that no longer follows from its input', () => {
    const outcome = importEdited(exported(), bump, true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining('does not follow from its stored input') })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses a re-sealed snapshot claiming another report revision', () => {
    const outcome = importEdited(exported(), (card) => void (card.report = { ...card.report, reportRevision: 7 }), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining('belongs to another report revision') })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses a re-sealed snapshot claiming a plan revision of no revision of this epic', () => {
    const outcome = importEdited(exported(), (card) => void (card.planRevisionId = 'rv_01m65yene3p1dwngx9apevkpn4'), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining('which is not a revision of epic') })
    expect(outcome.rejected).toBeGreaterThan(0)
  })
})

/** An attempt id of no attempt here, in the stable id format. */
const FOREIGN_ATTEMPT = 'at_0000000000000000000000zzzz'
const OTHER_RUN = 'rn_01m7gdve7pw5ey7eqtyrkvn9fm'

/** The refusal for exactly this one problem: every other check of the snapshot still passes on the edit. */
const only = (problem: string): string => `Invalid scorecard snapshot: ${problem}; a snapshot's recorded parts`

describe('DM-269 fix: re-sealed edits to the ticket list and outcomes are refused on import', () => {
  it('refuses a ticket list with a ticket grade dropped', () => {
    const outcome = importEdited(exported(), (card) => {
      card.tickets = card.tickets.slice(0, -1)
      prune(card)
    }, true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining("the ticket grades are not the sprint's tickets") })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses a ticket list in another order than the sprint’s tickets', () => {
    const outcome = importEdited(exported(), (card) => void (card.tickets = [...card.tickets].reverse()), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only("the ticket grades are not the sprint's tickets")) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses an outcome no longer counted though the sprint’s P input cites it', () => {
    const outcome = importEdited(exported(), (card) => editSprintDetail(card, (detail) => {
      const first = detail.outcomes[0]
      if (first !== undefined) first.counted = false
    }), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only("the sprint grade's counted outcomes are not the ones its P input cites")) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses a sprint outcome moved to another run', () => {
    const outcome = importEdited(exported(), (card) => editSprintDetail(card, (detail) => {
      const first = detail.outcomes[0]
      if (first !== undefined) first.runId = OTHER_RUN
    }), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only('a sprint outcome belongs to another run')) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses an outcome standing on an attempt the sources do not hold', () => {
    const outcome = importEdited(exported(), (card) => editSprintDetail(card, (detail) => {
      const first = detail.outcomes[0]
      if (first !== undefined) first.attemptId = FOREIGN_ATTEMPT
    }), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only('an outcome stands on an attempt not among the sources')) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })
})

describe('DM-269 fix: re-sealed edits to the source ids are refused on import', () => {
  it('refuses source ids with an attempt no outcome names dropped', () => {
    const outcome = importEdited(exported(), (card) => {
      const named = new Set(Object.values(card.details).flatMap((detail) => detail.outcomes.map((entry) => entry.attemptId)))
      const dropped = card.sources.attemptIds.find((id) => !named.has(id))
      card.sources = { ...card.sources, attemptIds: card.sources.attemptIds.filter((id) => id !== dropped) }
    }, true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only("the source attempts repeat or are fewer than the run's work attempts")) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses source ids with a ticket of the run dropped', () => {
    const outcome = importEdited(exported(), (card) => void (card.sources = { ...card.sources, ticketIds: card.sources.ticketIds.slice(1) }), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only('a ticket of the run is not among the source tickets')) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses source ids naming a ticket with no outcome in the run', () => {
    const outcome = importEdited(exported(), (card) => void (card.sources = { ...card.sources, ticketIds: [...card.sources.ticketIds, tid(9)] }), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only('a source ticket has no outcome in the run')) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses source runs that are not the graded runs', () => {
    const outcome = importEdited(exported(), (card) => void (card.sources = { ...card.sources, runIds: [...card.sources.runIds, OTHER_RUN] }), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only('the source runs are not the graded runs')) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses a sprint grade naming other runs', () => {
    const outcome = importEdited(exported(), (card) => editSprintDetail(card, (detail) => void detail.runIds.push(OTHER_RUN)), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only('the sprint or run grade names other runs')) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })
})

describe('DM-269 fix: re-sealed edits to the frozen efficiency are refused on import', () => {
  it('refuses an efficiency T actual that is not the sprint grade’s', () => {
    const outcome = importEdited(exported(), (card) => editSprintDetail(card, (detail) => {
      const scope = detail.efficiency[0]
      if (scope !== undefined && scope.time.actual.state !== 'missing') scope.time.actual = { ...scope.time.actual, value: scope.time.actual.value + 60_000 }
    }), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only("the sprint grade's T actual is not its efficiency's")) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses efficiency unreported attempts the sprint grade did not count', () => {
    const outcome = importEdited(exported(), (card) => editSprintDetail(card, (detail) => {
      const scope = detail.efficiency[0]
      if (scope !== undefined) scope.time.unreportedAttemptIds = [card.sources.attemptIds[0] ?? '']
    }), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only("the sprint grade's T unreported attempts are not its efficiency's")) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses efficiency naming an open attempt the sources do not hold', () => {
    const outcome = importEdited(exported(), (card) => editSprintDetail(card, (detail) => {
      const scope = detail.efficiency[0]
      if (scope !== undefined) scope.time.openAttemptIds = [FOREIGN_ATTEMPT]
    }), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only('the efficiency names an attempt not among the sources')) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses a roll-up marked partial though the baseline it was offered covers every ticket', () => {
    const outcome = importEdited(exported(), (card) => editSprintDetail(card, (detail) => void (detail.rollups.T.partial = true)), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only("the sprint grade's T roll-up is marked otherwise than the baseline it was offered")) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses efficiency of runs the sprint grade did not measure', () => {
    const outcome = importEdited(exported(), (card) => editSprintDetail(card, (detail) => void (detail.measuredRunIds = [])), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only("the sprint grade's efficiency is not its measured runs'")) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })
})

describe('DM-269 fix: re-sealed edits to the frozen timing are refused on import', () => {
  it('refuses timing read at another time than the cutoff', () => {
    const outcome = importEdited(exported(), (card) => void (card.timing = { ...card.timing, asOf: '2026-11-15T08:00:00.000Z' }), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only("the timing is not the run's at the cutoff")) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses sprint timing holding other tickets than the graded ones', () => {
    const outcome = importEdited(exported(), (card) => {
      const sprint = card.timing.sprint
      if (sprint !== null) card.timing = { ...card.timing, sprint: { ...sprint, ticketIds: sprint.ticketIds.slice(1) } }
    }, true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only("the sprint timing is not the graded sprint's")) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses ticket timing for a ticket that was not graded', () => {
    const outcome = importEdited(exported(), (card) => {
      const first = card.timing.tickets[0]
      if (first !== undefined) card.timing = { ...card.timing, tickets: [...card.timing.tickets, { ...first, ticketId: tid(9) }] }
    }, true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only("the ticket timing is not the graded tickets'")) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses timing whose ticket effort is not the ticket’s T actual', () => {
    const outcome = importEdited(exported(), (card) => {
      const ticket = card.timing.tickets.find((entry) => entry.ticketId === tid(1))
      if (ticket !== undefined) ticket.effort = { ...ticket.effort, ms: (ticket.effort.ms ?? 0) - 60_000 }
    }, true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only("a ticket's timing effort is not its T actual")) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses timing whose sprint effort is not the sprint grade’s', () => {
    const outcome = importEdited(exported(), (card) => {
      const sprint = card.timing.sprint
      if (sprint !== null) card.timing = { ...card.timing, sprint: { ...sprint, effort: { ...sprint.effort, ms: 1 } } }
    }, true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only("the sprint timing's effort is not the sprint grade's")) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })

  it('refuses timing whose run effort is not the run grade’s', () => {
    const outcome = importEdited(exported(), (card) => void (card.timing = { ...card.timing, run: { ...card.timing.run, effort: { ...card.timing.run.effort, ms: 1 } } }), true)
    expect(outcome).toMatchObject({ runImported: false, message: expect.stringContaining(only("the run timing's effort is not the run grade's")) })
    expect(outcome.rejected).toBeGreaterThan(0)
  })
})

describe('DM-269 fix: an import reports another scorecard for a report that already has one', () => {
  it('refuses the run and keeps the scorecard frozen here', () => {
    const source = exported()
    const machineB = createRepoEnv()
    copyTracked(source.w.env, machineB)
    expect(reconcile(machineB).rejected).toEqual([])
    const paths = ownedPaths(machineB.layout)
    const frozen = parseScorecardSnapshot(JSON.parse(source.bytes))
    const other = underPolicyV1(frozen)
    machineB.fs.put(paths.scorecardFile(source.w.runId, source.reportId), prettyJson(other))
    machineB.fs.put(paths.runHistoryFile(source.w.runId), source.runFile.replace(frozen.snapshotHash, other.snapshotHash))
    const result = reconcile(machineB)
    expect(result.imported).not.toContain(source.w.runId)
    expect(result.rejected.map((entry) => entry.message).join(' ')).toContain(`names scorecard ${other.snapshotHash}, not the one frozen here`)
    expect(storedOf(machineB, source.reportId)).toBe(source.bytes)
  })
})

/** Queues the run history again (as any run change does) and flushes. */
function exportAgain(w: SpaceWorld) {
  enqueueOutbox(w.ctx, { kind: 'run_history', epicId: w.epicId, runId: w.runId })
  return flush(w.env)
}

describe('DM-269 fix: export checks the scorecard file already there', () => {
  it('fails with a conflict over a truncated scorecard file and leaves it for a person to restore', () => {
    const source = exported()
    const file = ownedPaths(source.w.env.layout).scorecardFile(source.w.runId, source.reportId)
    const truncated = source.cardFile.slice(0, 200)
    source.w.env.fs.put(file, truncated)
    const outcome = exportAgain(source.w)
    expect(outcome.failed).toBe(1)
    expect(outcome.errors.join(' ')).toContain('already exists with different content; scorecards are never rewritten')
    expect(source.w.env.fs.get(file)).toBe(truncated)
  })

  it('fails with a conflict over an edited scorecard file', () => {
    const source = exported()
    const file = ownedPaths(source.w.env.layout).scorecardFile(source.w.runId, source.reportId)
    source.w.env.fs.put(file, source.cardFile.replace(/"score": \d+(\.\d+)?/, '"score": 12'))
    const outcome = exportAgain(source.w)
    expect(outcome.failed).toBe(1)
    expect(outcome.errors.join(' ')).toContain('already exists with different content')
  })

  it('accepts the same scorecard written with other line endings', () => {
    const source = exported()
    const file = ownedPaths(source.w.env.layout).scorecardFile(source.w.runId, source.reportId)
    source.w.env.fs.put(file, source.cardFile.replace(/\n/g, '\r\n'))
    expect(exportAgain(source.w)).toMatchObject({ failed: 0, errors: [] })
  })
})

describe('DM-269 fix: export checks the scorecard it writes', () => {
  it('fails with a conflict instead of writing a stored scorecard that does not reproduce', () => {
    const source = exported()
    const paths = ownedPaths(source.w.env.layout)
    const file = paths.scorecardFile(source.w.runId, source.reportId)
    source.w.env.fs.remove(file)
    const snapshot = structuredClone(parseScorecardSnapshot(JSON.parse(source.bytes)))
    snapshot.sprint = { ...snapshot.sprint, result: { ...snapshot.sprint.result, score: 99 } }
    source.w.ctx.db.run('UPDATE sprint_reports SET scorecard_json = ? WHERE id = ?', storedScorecard({ ...snapshot, snapshotHash: snapshotHashOf(snapshot) }), source.reportId)
    const outcome = exportAgain(source.w)
    expect(outcome.failed).toBe(1)
    expect(outcome.errors.join(' ')).toContain(`The stored scorecard of report ${source.reportId} is not exported`)
    expect(source.w.env.fs.get(file)).toBeUndefined()
    expect(source.w.env.fs.get(paths.runHistoryFile(source.w.runId))).toBe(source.runFile)
  })

  it('writes a missing scorecard file again from the stored snapshot', () => {
    const source = exported()
    const file = ownedPaths(source.w.env.layout).scorecardFile(source.w.runId, source.reportId)
    source.w.env.fs.remove(file)
    expect(exportAgain(source.w).failed).toBe(0)
    expect(source.w.env.fs.get(file)).toBe(source.cardFile)
    expect(canonicalJson(JSON.parse(source.w.env.fs.get(file) ?? 'null'))).toBe(source.bytes)
  })
})
