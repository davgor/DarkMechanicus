/**
 * Petitions a cult run raises for the person (more acolytes, permission to save, access to a tracked folder) and the
 * run's pipeline events. Each change is one transaction with its event. An approved acolytes petition raises the
 * run's cap by what was granted, never past the ceiling of 24.
 */
import { fail } from '../../core/errors'
import {
  type CultEventInput,
  type CultEventPage,
  type CultEventPageRequest,
  type CultEventView,
  type CultPetitionView,
  eventInputSchema,
  eventPageSchema,
  type PetitionDecisionInput,
  petitionDecisionSchema,
  type PetitionInput,
  petitionInputSchema
} from '../../shared/cults/cult'
import { MAX_CAP } from '../../shared/cults/runState'
import {
  insertEvent,
  newCultId,
  parseInput,
  type PetitionRow,
  requireActiveRun,
  requireRun,
  type StoreContext,
  toPetitionView
} from './cultRecords'

function requirePetition(ctx: StoreContext, petitionId: string): PetitionRow {
  return (
    ctx.db.get<PetitionRow>('SELECT * FROM cult_petitions WHERE id = ?', petitionId) ??
    fail('not_found', `No cult petition ${petitionId}.`)
  )
}

/** Records a pending petition with its `petition_created` event; refused once the run has ended. */
export function createPetition(ctx: StoreContext, runId: string, input: PetitionInput, memberName: string | null = null): CultPetitionView {
  const petition = parseInput(petitionInputSchema, input)
  const id = newCultId('cp')
  return ctx.db.tx(() => {
    requireActiveRun(ctx.db, runId)
    const payload = petition.kind === 'acolytes' ? String(petition.additional) : petition.kind === 'folder_access' ? petition.folderPath : null
    const at = ctx.now()
    ctx.db.run(
      `INSERT INTO cult_petitions (id, run_id, kind, payload, reason, state, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      id,
      runId,
      petition.kind,
      payload,
      petition.reason,
      at
    )
    insertEvent(ctx.db, { runId, kind: 'petition_created', memberName, summary: `Petition (${petition.kind}): ${petition.reason}`, at })
    return toPetitionView(requirePetition(ctx, id))
  })
}

/** Grants an acolytes petition up to what was asked and what the cap ceiling leaves, raising the run's cap. */
function grantAcolytes(ctx: StoreContext, row: PetitionRow, requested: number | undefined): number {
  const run = requireRun(ctx.db, row.run_id)
  const granted = Math.min(requested ?? Number(row.payload), Number(row.payload), MAX_CAP - run.cap)
  if (granted < 1) fail('capacity_exceeded', `The run is already at the ${MAX_CAP}-acolyte ceiling.`)
  ctx.db.run('UPDATE cult_runs SET cap = ? WHERE id = ?', run.cap + granted, run.id)
  return granted
}

/** Approves or denies a pending petition with its event; a decided petition is never decided again. */
export function decidePetition(ctx: StoreContext, petitionId: string, input: PetitionDecisionInput): CultPetitionView {
  const decision = parseInput(petitionDecisionSchema, input)
  return ctx.db.tx(() => {
    const row = requirePetition(ctx, petitionId)
    if (row.state !== 'pending') fail('invalid_state', `Petition ${petitionId} is already ${row.state}.`)
    requireActiveRun(ctx.db, row.run_id)
    const granted = decision.approve && row.kind === 'acolytes' ? grantAcolytes(ctx, row, decision.granted) : null
    const state = decision.approve ? 'approved' : 'denied'
    const at = ctx.now()
    ctx.db.run('UPDATE cult_petitions SET state = ?, granted = ?, decided_at = ? WHERE id = ?', state, granted, at, petitionId)
    const summary = granted === null ? `Petition ${petitionId} ${state}.` : `Petition ${petitionId} approved: ${granted} more acolytes.`
    insertEvent(ctx.db, { runId: row.run_id, kind: `petition_${state}`, memberName: null, summary, at })
    return toPetitionView(requirePetition(ctx, petitionId))
  })
}

/** A run's petitions, oldest first. */
export function listPetitions(ctx: StoreContext, runId: string): CultPetitionView[] {
  return ctx.db
    .all<PetitionRow>('SELECT * FROM cult_petitions WHERE run_id = ? ORDER BY created_at, rowid', runId)
    .map((row) => toPetitionView(row))
}

/** Appends one inert pipeline event at the run's next sequence number. */
export function appendEvent(ctx: StoreContext, runId: string, input: CultEventInput): CultEventView {
  const event = parseInput(eventInputSchema, input)
  return ctx.db.tx(() => {
    requireRun(ctx.db, runId)
    return insertEvent(ctx.db, { runId, ...event, at: ctx.now() })
  })
}

/** One page of a run's events after `afterSeq`, in sequence order. */
export function pageEvents(ctx: StoreContext, runId: string, request: CultEventPageRequest = {}): CultEventPage {
  const { afterSeq, limit } = parseInput(eventPageSchema, request)
  const rows = ctx.db.all<{ run_id: string; seq: number; at: string; member_name: string | null; kind: CultEventView['kind']; summary: string }>(
    'SELECT * FROM cult_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    runId,
    afterSeq,
    limit + 1
  )
  const events = rows.slice(0, limit).map((row) => ({
    runId: row.run_id,
    seq: row.seq,
    at: row.at,
    memberName: row.member_name,
    kind: row.kind,
    summary: row.summary
  }))
  return { events, nextAfterSeq: rows.length > limit ? events[events.length - 1].seq : null }
}
