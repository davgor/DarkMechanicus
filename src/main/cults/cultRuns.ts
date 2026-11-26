/**
 * Cult definitions and runs: founding, editing and deleting a cult (its roster materialized from the archetype),
 * starting a run (at most one active per cult), and persisting each lifecycle transition with its pipeline event,
 * atomically. When a run ends, its pending petitions are denied in the same transaction.
 */
import { DomainError, fail } from '../../core/errors'
import { materializeRoster, validateRoster } from '../../shared/cults/archetypes'
import {
  type CultDefinition,
  type CultEventKind,
  type CultInput,
  cultInputSchema,
  type CultRunView,
  type CultView,
  type RunStartInput,
  runStartSchema
} from '../../shared/cults/cult'
import { denyPendingPetitions, type RunEvent, RunTransitionError, transition } from '../../shared/cults/runState'
import {
  findCult,
  insertEvent,
  newCultId,
  parseInput,
  type PetitionRow,
  requireCult,
  requireRun,
  type RunRow,
  type StoreContext,
  toClock,
  toRunView
} from './cultRecords'

/** The roster a cult keeps: the input's slots for an editable archetype, else the preset; refused if invalid. */
function rosterOf(cult: CultDefinition) {
  const slots = materializeRoster(cult.archetype, { slots: cult.slots })
  const issues = validateRoster({ archetype: cult.archetype, slots, cap: cult.defaultCap })
  if (issues.length > 0) fail('invalid_input', issues.map((issue) => issue.message).join(' '), { issues })
  return slots
}

function writeSlots(ctx: StoreContext, cultId: string, cult: CultDefinition): void {
  ctx.db.run('DELETE FROM cult_role_slots WHERE cult_id = ?', cultId)
  rosterOf(cult).forEach((slot, ordinal) => {
    ctx.db.run(
      `INSERT INTO cult_role_slots (cult_id, slot_id, worker_type, label, mission, required, ordinal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      cultId,
      slot.id,
      slot.workerType,
      slot.label,
      slot.mission,
      slot.required ? 1 : 0,
      ordinal
    )
  })
}

const CULT_COLUMNS = `name, charter, scope, folder_path, archetype, target_epic_id, magos_name, magos_model_id,
  default_time_limit_ms, default_cap, acolyte_grace_ms, magos_window_ms, updated_at`

function cultValues(cult: CultDefinition, stamp: string) {
  return [
    cult.name,
    cult.charter,
    cult.scope,
    cult.folderPath,
    cult.archetype,
    cult.targetEpicId,
    cult.magosName,
    cult.magosModelId,
    cult.defaultTimeLimitMs,
    cult.defaultCap,
    cult.acolyteGraceMs,
    cult.magosWindowMs,
    stamp
  ] as const
}

export function createCult(ctx: StoreContext, input: CultInput): CultView {
  const cult = parseInput(cultInputSchema, input)
  const id = newCultId('ct')
  return ctx.db.tx(() => {
    const stamp = ctx.now()
    ctx.db.run(
      `INSERT INTO cults (id, created_at, ${CULT_COLUMNS}) VALUES (?, ?, ${CULT_COLUMNS.replace(/[a-z_]+/g, '?')})`,
      id,
      stamp,
      ...cultValues(cult, stamp)
    )
    writeSlots(ctx, id, cult)
    return requireCult(ctx.db, id)
  })
}

/** Replaces a cult's definition; omitted `slots` keep the materialized roster while the archetype is unchanged. */
export function updateCult(ctx: StoreContext, cultId: string, input: CultInput): CultView {
  const cult = parseInput(cultInputSchema, input)
  return ctx.db.tx(() => {
    const before = requireCult(ctx.db, cultId)
    const kept = cult.slots ?? (before.archetype === cult.archetype ? before.slots : undefined)
    const sets = CULT_COLUMNS.replace(/[a-z_]+/g, (column) => `${column} = ?`)
    ctx.db.run(`UPDATE cults SET ${sets} WHERE id = ?`, ...cultValues(cult, ctx.now()), cultId)
    writeSlots(ctx, cultId, { ...cult, slots: kept })
    return requireCult(ctx.db, cultId)
  })
}

/** Deletes a cult with its slots, runs, members, petitions, events, reports and run worker types. */
export function deleteCult(ctx: StoreContext, cultId: string): void {
  ctx.db.tx(() => {
    requireCult(ctx.db, cultId)
    if (activeRunOf(ctx, cultId)) fail('active_run_exists', 'End the cult run before deleting the cult.')
    ctx.db.run('DELETE FROM cults WHERE id = ?', cultId)
  })
}

export function listCults(ctx: StoreContext): CultView[] {
  return ctx.db
    .all<{ id: string }>('SELECT id FROM cults ORDER BY created_at, id')
    .flatMap((row) => findCult(ctx.db, row.id) ?? [])
}

function activeRunOf(ctx: StoreContext, cultId: string): RunRow | undefined {
  return ctx.db.get<RunRow>("SELECT * FROM cult_runs WHERE cult_id = ? AND state <> 'ended'", cultId)
}

/** Starts a run in `starting`, taking the cult's defaults for what is not given; refused while one is active. */
export function startRun(ctx: StoreContext, cultId: string, input: RunStartInput): CultRunView {
  const start = parseInput(runStartSchema, input)
  const id = newCultId('cr')
  return ctx.db.tx(() => {
    const cult = requireCult(ctx.db, cultId)
    if (activeRunOf(ctx, cultId)) fail('active_run_exists', `Cult ${cult.name} already has an active run.`)
    const cap = start.cap ?? cult.defaultCap
    const issues = validateRoster({ archetype: cult.archetype, slots: cult.slots, cap })
    if (issues.length > 0) fail('invalid_input', issues.map((issue) => issue.message).join(' '), { issues })
    ctx.db.run(
      `INSERT INTO cult_runs (id, cult_id, state, time_limit_ms, grace_ms, magos_window_ms, cap, work_dir, started_at)
       VALUES (?, ?, 'starting', ?, ?, ?, ?, ?, ?)`,
      id,
      cultId,
      start.timeLimitMs === undefined ? cult.defaultTimeLimitMs : start.timeLimitMs,
      start.acolyteGraceMs ?? cult.acolyteGraceMs,
      start.magosWindowMs ?? cult.magosWindowMs,
      cap,
      start.workDir,
      ctx.now()
    )
    return toRunView(requireRun(ctx.db, id))
  })
}

const EVENT_OF: Readonly<Record<RunEvent['type'], CultEventKind | null>> = {
  started: null,
  pause: 'paused',
  resume: 'resumed',
  shutdown: 'shutdown_started',
  finish: 'ended',
  abort: 'ended'
}

/** Denies the run's pending petitions as it ends, one `petition_denied` event each. */
function denyOnEnd(ctx: StoreContext, runId: string, at: string): void {
  const pending = ctx.db.all<PetitionRow & { decidedAt: string | null }>(
    "SELECT *, decided_at AS decidedAt FROM cult_petitions WHERE run_id = ? AND state = 'pending' ORDER BY created_at, id",
    runId
  )
  for (const petition of denyPendingPetitions(pending, at)) {
    ctx.db.run('UPDATE cult_petitions SET state = ?, decided_at = ? WHERE id = ?', petition.state, petition.decidedAt, petition.id)
    insertEvent(ctx.db, { runId, kind: 'petition_denied', memberName: null, summary: `Petition ${petition.id} denied: the run ended.`, at })
  }
}

function applyTransition(run: RunRow, event: RunEvent, at: string) {
  try {
    return transition(toClock(run), event, at)
  } catch (error: unknown) {
    if (!(error instanceof RunTransitionError)) throw error
    throw new DomainError('invalid_state', error.message, { from: error.from, event: error.event })
  }
}

/**
 * Applies one lifecycle event and persists it with its pipeline event in one transaction; an illegal move is
 * refused with `invalid_state`. Ending the run denies its pending petitions in the same transaction.
 */
export function transitionRun(ctx: StoreContext, runId: string, event: RunEvent, summary?: string): CultRunView {
  return ctx.db.tx(() => {
    const at = ctx.now()
    const moved = applyTransition(requireRun(ctx.db, runId), event, at)
    ctx.db.run(
      `UPDATE cult_runs SET state = ?, end_reason = ?, accumulated_running_ms = ?, running_since = ?, ended_at = ?
       WHERE id = ?`,
      moved.state,
      moved.endReason,
      moved.accumulatedRunningMs,
      moved.runningSince,
      moved.endedAt,
      runId
    )
    if (moved.state === 'ended') denyOnEnd(ctx, runId, at)
    const kind = EVENT_OF[event.type]
    if (kind !== null) insertEvent(ctx.db, { runId, kind, memberName: null, summary: summary ?? defaultSummary(event), at })
    return toRunView(requireRun(ctx.db, runId))
  })
}

function defaultSummary(event: RunEvent): string {
  if (event.type === 'shutdown') return `Shutdown started (${event.reason}).`
  if (event.type === 'abort') return `Run ended (${event.reason}).`
  return event.type === 'finish' ? 'Run ended.' : `Run ${EVENT_OF[event.type]}.`
}

/** Records the run's chronicle text (inert). */
export function setChronicle(ctx: StoreContext, runId: string, chronicle: string): CultRunView {
  return ctx.db.tx(() => {
    requireRun(ctx.db, runId)
    ctx.db.run('UPDATE cult_runs SET chronicle = ? WHERE id = ?', chronicle, runId)
    return toRunView(requireRun(ctx.db, runId))
  })
}

/** Records where the run's Shrine was published, with its `shrine_published` event. */
export function recordShrine(ctx: StoreContext, runId: string, shrine: { path: string; revision: string }): CultRunView {
  return ctx.db.tx(() => {
    requireRun(ctx.db, runId)
    ctx.db.run('UPDATE cult_runs SET shrine_path = ?, shrine_revision = ? WHERE id = ?', shrine.path, shrine.revision, runId)
    const summary = `Shrine published at revision ${shrine.revision}.`
    insertEvent(ctx.db, { runId, kind: 'shrine_published', memberName: null, summary, at: ctx.now() })
    return toRunView(requireRun(ctx.db, runId))
  })
}

export function getRun(ctx: StoreContext, runId: string): CultRunView | null {
  const row = ctx.db.get<RunRow>('SELECT * FROM cult_runs WHERE id = ?', runId)
  return row === undefined ? null : toRunView(row)
}

/** Runs newest first, of one cult or of every cult. */
export function listRuns(ctx: StoreContext, cultId?: string): CultRunView[] {
  const rows =
    cultId === undefined
      ? ctx.db.all<RunRow>('SELECT * FROM cult_runs ORDER BY started_at DESC, rowid DESC')
      : ctx.db.all<RunRow>('SELECT * FROM cult_runs WHERE cult_id = ? ORDER BY started_at DESC, rowid DESC', cultId)
  return rows.map((row) => toRunView(row))
}

/** Every run not yet ended: what restart reconciliation must settle, oldest first. */
export function activeRunsOnStartup(ctx: StoreContext): CultRunView[] {
  return ctx.db
    .all<RunRow>("SELECT * FROM cult_runs WHERE state <> 'ended' ORDER BY started_at, rowid")
    .map((row) => toRunView(row))
}
