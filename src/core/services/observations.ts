/**
 * The metric observation ledger: append-only SPACE measurements (`MetricObservation`, `src/shared/domain/space.ts`),
 * each with a stable `mo_` id, attributed to the project or to an epic, sprint, run, ticket or attempt, and naming
 * the source and actor that measured it. A stored observation is never changed or deleted (only deleting its whole
 * epic removes it); a correction is a new observation.
 *
 * Recording is idempotent per id: the same id with the same payload returns the stored record (with its original
 * `recordedAt`), and a different payload under that id is a `conflict`. `recordedAt` is always the server's clock.
 * Every scope id and evidence reference must name a record this project holds, and belong to the observation's epic;
 * an observation may cite another of the same call, before or after it, but the call's citations never form a cycle.
 * Work in any state stays attributable (rejected, failed, canceled, expired and superseded attempts alike), but a
 * carry-forward attempt ran nothing, so execution usage is refused on it rather than counted a second time.
 *
 * Who may report what is the calling command's decision; this module enforces what any stored observation must be.
 * Each new observation queues a `metric_observation` outbox entry in the same transaction, so the finalizer exports it
 * as an immutable record file after commit.
 */
import type { ZodError } from 'zod'
import { DEFECT_LINKS } from '../../shared/domain/performance'
import type { EvidenceKind, EvidenceRef, MetricKind, MetricObservation, MetricScope } from '../../shared/domain/space'
import type { Ctx } from '../context'
import type { Db } from '../db/database'
import { fail } from '../errors'
import { nextStableId } from '../ids'
import { metricObservationSchema } from '../space/contract'
import { EXECUTION_METRICS, evidenceKey, LEDGER_LIMITS, ledgerProblem, observationPayloadHash } from '../space/ledger'
import { enqueueOutbox } from './outbox'
import { budgetBaselineEpic } from './plannedBaselines'

/** An observation as a caller reports it: the server assigns `recordedAt`, and an id when none is given. */
export type ObservationInput = Omit<MetricObservation, 'observationId' | 'recordedAt'> & { observationId?: string }

interface RecordObservationsResult {
  /** The stored observations, in input order. */
  observations: MetricObservation[]
  /** Ids stored by this call. */
  created: string[]
  /** Ids already stored with the same payload: nothing was written for them. */
  unchanged: string[]
}

/** A saved plan revision (or every saved revision of an epic) that holds a sprint, ticket or criterion. */
interface PlanFilter {
  epicId: string | null
  revisionId: string | null
}

/** The epic of the first saved revision matching `filter` whose plan satisfies `match` (joined on `from`), or null. */
function savedPlanEpic(db: Db, filter: PlanFilter, from: string, match: string, ...params: string[]): string | null {
  const row = db.get<{ epic_id: string }>(
    `SELECT r.epic_id FROM plan_revisions r, ${from}
     WHERE r.state = 'saved' AND (? IS NULL OR r.epic_id = ?) AND (? IS NULL OR r.id = ?) AND ${match} LIMIT 1`,
    filter.epicId,
    filter.epicId,
    filter.revisionId,
    filter.revisionId,
    ...params
  )
  return row?.epic_id ?? null
}

const TICKETS = "json_each(r.bundle_json, '$.tickets') t"
const SPRINTS = "json_each(r.bundle_json, '$.sprints') s"

function ticketEpic(db: Db, filter: PlanFilter, ticketId: string): string | null {
  return savedPlanEpic(db, filter, TICKETS, "json_extract(t.value, '$.id') = ?", ticketId)
}

function sprintEpic(db: Db, filter: PlanFilter, sprintId: string): string | null {
  return savedPlanEpic(db, filter, SPRINTS, "json_extract(s.value, '$.id') = ?", sprintId)
}

function where(filter: PlanFilter): string {
  return filter.revisionId !== null ? `the plan revision ${filter.revisionId} the attempt ran under` : `any saved plan of epic ${filter.epicId}`
}

/** The scope's epic exists with a saved plan, and its run (when named) belongs to it. */
function checkEpicAndRun(db: Db, epicId: string, runId: string | null): void {
  const epic = db.get<{ current_revision_id: string | null }>('SELECT current_revision_id FROM epics WHERE id = ?', epicId)
  if (epic === undefined) {
    fail('not_found', `Epic ${epicId} does not exist.`, { epicId })
  }
  if (epic.current_revision_id === null) {
    fail('not_found', `Epic ${epicId} has no saved plan, so none of its work can be measured yet.`, { epicId })
  }
  if (runId === null) {
    return
  }
  const run = db.get<{ epic_id: string }>('SELECT epic_id FROM runs WHERE id = ?', runId)
  if (run === undefined) {
    fail('not_found', `Run ${runId} does not exist.`, { runId })
  }
  if (run.epic_id !== epicId) {
    fail('invalid_input', `Run ${runId} belongs to epic ${run.epic_id}, not ${epicId}.`, { runId })
  }
}

/** The scope's sprint and ticket are in `plan`, and the ticket is in the sprint there. */
function checkPlanMembers(db: Db, plan: PlanFilter, scope: MetricScope): void {
  const { sprintId, ticketId } = scope
  if (sprintId !== null && sprintEpic(db, plan, sprintId) === null) {
    fail('not_found', `Sprint ${sprintId} is not in ${where(plan)}.`, { sprintId })
  }
  if (ticketId === null) {
    return
  }
  if (ticketEpic(db, plan, ticketId) === null) {
    fail('not_found', `Ticket ${ticketId} is not in ${where(plan)}.`, { ticketId })
  }
  const sprintTickets = `${SPRINTS}, json_each(s.value, '$.ticketIds') m`
  if (sprintId !== null && savedPlanEpic(db, plan, sprintTickets, "json_extract(s.value, '$.id') = ? AND m.value = ?", sprintId, ticketId) === null) {
    fail('invalid_input', `Ticket ${ticketId} is not in sprint ${sprintId} in ${where(plan)}.`, { ticketId })
  }
}

interface AttemptRow {
  run_id: string
  ticket_id: string
  kind: string
  revision_id: string
}

function loadAttempt(db: Db, attemptId: string | null): AttemptRow | null {
  if (attemptId === null) {
    return null
  }
  const attempt = db.get<AttemptRow>('SELECT run_id, ticket_id, kind, revision_id FROM attempts WHERE id = ?', attemptId)
  return attempt ?? fail('not_found', `Attempt ${attemptId} does not exist.`, { attemptId })
}

/** The scope's attempt is its ticket's attempt in its run; a carry-forward attempt carries no execution usage. */
function checkAttempt(attempt: AttemptRow, scope: MetricScope, metric: MetricKind): void {
  const { attemptId } = scope
  if (attempt.run_id !== scope.runId || attempt.ticket_id !== scope.ticketId) {
    fail('invalid_input', `Attempt ${attemptId} is ticket ${attempt.ticket_id}'s attempt in run ${attempt.run_id}.`, { attemptId })
  }
  if (attempt.kind === 'carry_forward' && EXECUTION_METRICS[metric] === true) {
    fail(
      'invalid_input',
      `Attempt ${attemptId} carries forward work accepted earlier and ran nothing; ${metric} stays with the attempt that did the work.`,
      { attemptId, metric }
    )
  }
}

/**
 * The ids of the observation's scope name records of this project, nested as the scope says. Membership is checked
 * against the plan revision the attempt ran under (which adopting a newer revision never rewrites), or, without an
 * attempt, against any saved plan of the epic, so work stays attributable after a ticket is moved or removed.
 */
function checkScope(db: Db, observation: MetricObservation): void {
  const { scope } = observation
  if (scope.epicId === null) {
    return
  }
  checkEpicAndRun(db, scope.epicId, scope.runId)
  const attempt = loadAttempt(db, scope.attemptId)
  checkPlanMembers(db, { epicId: scope.epicId, revisionId: attempt?.revision_id ?? null }, scope)
  if (attempt !== null) {
    checkAttempt(attempt, scope, observation.metric)
  }
}

/** The epic a cited record belongs to (null for a project-level observation), or undefined when it does not exist. */
type CitedEpic = (db: Db, ref: EvidenceRef, batch: ReadonlyMap<string, string | null>) => string | null | undefined

const ANY_PLAN: PlanFilter = { epicId: null, revisionId: null }

function ownerBy(sql: string): CitedEpic {
  return (db, ref) => db.get<{ epic_id: string }>(sql, ref.id)?.epic_id
}

const ATTEMPT_EPIC = ownerBy('SELECT r.epic_id FROM attempts a JOIN runs r ON r.id = a.run_id WHERE a.id = ?')

const CITED_EPIC: Readonly<Record<Exclude<EvidenceKind, 'commit'>, CitedEpic>> = {
  observation: (db, ref, batch) =>
    batch.has(ref.id) ? batch.get(ref.id) : db.get<{ epic_id: string | null }>('SELECT epic_id FROM metric_observations WHERE id = ?', ref.id)?.epic_id,
  attempt: ATTEMPT_EPIC,
  check: ATTEMPT_EPIC,
  run: ownerBy('SELECT epic_id FROM runs WHERE id = ?'),
  report: ownerBy('SELECT r.epic_id FROM sprint_reports p JOIN runs r ON r.id = p.run_id WHERE p.id = ?'),
  comment: ownerBy('SELECT epic_id FROM comments WHERE id = ?'),
  ticket: (db, ref) => ticketEpic(db, ANY_PLAN, ref.id) ?? undefined,
  sprint: (db, ref) => sprintEpic(db, ANY_PLAN, ref.id) ?? undefined,
  criterion: (db, ref) =>
    savedPlanEpic(
      db,
      ANY_PLAN,
      `${TICKETS}, json_each(t.value, '$.acceptanceCriteria') c`,
      "json_extract(t.value, '$.id') = ? AND json_extract(c.value, '$.id') = ?",
      ref.id,
      ref.detail ?? ''
    ) ?? undefined,
  // A ticket budget version, derived from the saved revisions (see plannedBaselines.ts).
  baseline: (db, ref) => budgetBaselineEpic(db, ref.id)
}

/** Every evidence reference names a record this project holds, of the observation's own epic when it has one. */
function checkEvidence(db: Db, observation: MetricObservation, batch: ReadonlyMap<string, string | null>): void {
  const epicId = observation.scope.epicId
  for (const ref of observation.evidence) {
    const owner = ref.kind === 'commit' ? null : CITED_EPIC[ref.kind](db, ref, batch)
    if (owner === undefined) {
      const named = ref.kind === 'criterion' ? `${ref.id} ${ref.detail}` : ref.id
      fail('not_found', `Evidence ${ref.kind} ${named} does not exist in this project.`, { kind: ref.kind, id: ref.id })
    }
    if (epicId !== null && owner !== null && owner !== epicId) {
      fail('invalid_input', `Evidence ${ref.kind} ${ref.id} belongs to epic ${owner}, not ${epicId}.`, { kind: ref.kind, id: ref.id })
    }
  }
}

/**
 * An escaped defect blames an outcome only when it names one that exists: its origin attempt is an accepted work
 * attempt of its origin ticket. A carry-forward attempt ran nothing, and an attempt that was never accepted let
 * nothing escape.
 */
function checkDefectOrigin(db: Db, observation: MetricObservation): void {
  const origin = observation.metric === 'escaped_defect' ? observation.evidence.filter((ref) => ref.detail === DEFECT_LINKS.origin) : []
  const attemptId = origin.find((ref) => ref.kind === 'attempt')?.id
  if (attemptId === undefined) {
    return
  }
  const ticketId = origin.find((ref) => ref.kind === 'ticket')?.id ?? null
  const row = db.get<{ blames: number }>(
    "SELECT ticket_id IS ? AND state = 'accepted' AND kind = 'work' AS blames FROM attempts WHERE id = ?",
    ticketId,
    attemptId
  )
  // A missing attempt is reported by the evidence check.
  if (row?.blames === 0) {
    fail('invalid_input', `Origin attempt ${attemptId} is not an accepted work attempt of origin ticket ${ticketId ?? '(none)'}; a defect blames only the outcome that let it through.`, {
      attemptId,
      ticketId
    })
  }
}

/** A reported observation is a plain object without the server's `recordedAt`. */
function reportedObject(index: number, value: unknown): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('invalid_input', `Observation ${index} is not an object.`)
  }
  if ('recordedAt' in value) {
    fail('invalid_input', `Observation ${index}: recordedAt is the server's time and is never supplied.`)
  }
  return value
}

function describeIssue(error: ZodError): string {
  const issue = error.issues[0]
  const path = issue !== undefined && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : ''
  return `${path}: ${issue?.message ?? 'malformed input'}`
}

/** Each evidence reference once, in first-mention order. */
function uniqueEvidence(evidence: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>()
  return evidence.filter((ref) => {
    const key = evidenceKey(ref)
    const first = !seen.has(key)
    seen.add(key)
    return first
  })
}

/**
 * Server ids for one call: each greater than every id already recorded at the same server time and than the one
 * before it. Reads order by `recordedAt` and then id, and a call's observations share `recordedAt`, so the call reads
 * back in call order, here and after export and import. Only ids of the same instant are compared, so two machines
 * never step from a shared id into each other's. A caller-supplied id orders by its own value.
 */
function idAllocator(ctx: Ctx, now: string): () => string {
  let last = ctx.db.get<{ id: string | null }>('SELECT MAX(id) AS id FROM metric_observations WHERE recorded_at = ?', now)?.id ?? null
  return () => {
    const fresh = ctx.ids.next('metricObservation')
    last = last !== null && fresh <= last ? nextStableId(last) : fresh
    return last
  }
}

/**
 * Validates one reported observation against the contract and the ledger's storage rules. The id is the caller's
 * (so a retry is recognized) or a new ordered one; `recordedAt` is the server's and may not be supplied. `observedAt`
 * is normalized to UTC, so one instant in another offset is the same payload, and repeated evidence is listed once.
 */
function parseReported(nextId: () => string, index: number, value: unknown, now: string): MetricObservation {
  const reported = reportedObject(index, value)
  const given = 'observationId' in reported ? reported.observationId : undefined
  const observationId = given === undefined ? nextId() : given
  const result = metricObservationSchema.safeParse({ ...reported, observationId, recordedAt: now })
  if (!result.success) {
    fail('invalid_input', `Invalid metric observation ${index}${describeIssue(result.error)}`)
  }
  const parsed: MetricObservation = result.data
  const observation = { ...parsed, observedAt: new Date(parsed.observedAt).toISOString(), evidence: uniqueEvidence(parsed.evidence) }
  const problem = ledgerProblem(observation)
  if (problem !== null) {
    fail('invalid_input', `Invalid metric observation ${index} at ${problem.path}: ${problem.message}.`)
  }
  return observation
}

function assertRoom(db: Db, epicId: string | null, adding: number): void {
  const held = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM metric_observations WHERE epic_id IS ?', epicId)?.n ?? 0
  if (held + adding > LEDGER_LIMITS.perFolder) {
    const owner = epicId === null ? 'The project level' : `Epic ${epicId}`
    fail('capacity_exceeded', `${owner} already holds ${held} metric observations; at most ${LEDGER_LIMITS.perFolder} are kept.`, {
      epicId,
      limit: LEDGER_LIMITS.perFolder
    })
  }
}

/** Inserts one checked observation row. Shared with the importer, which inserts what another machine recorded. */
export function insertObservationRow(db: Db, observation: MetricObservation): void {
  observationsWritten(db)
  const { scope } = observation
  db.run(
    `INSERT INTO metric_observations (id, metric, scope_level, epic_id, sprint_id, run_id, ticket_id, attempt_id, source_kind,
       measurement_state, recorded_at, payload_hash, observation_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    observation.observationId,
    observation.metric,
    scope.level,
    scope.epicId,
    scope.sprintId,
    scope.runId,
    scope.ticketId,
    scope.attemptId,
    observation.source.kind,
    observation.measurement.state,
    observation.recordedAt,
    observationPayloadHash(observation),
    JSON.stringify(observation)
  )
}

/**
 * Checks that an observation's scope and evidence name records this project holds. `batch` maps the ids of other
 * observations stored together with it (by the same call or the same import) to their epic.
 */
export function checkObservationReferences(db: Db, observation: MetricObservation, batch: ReadonlyMap<string, string | null>): void {
  checkScope(db, observation)
  checkEvidence(db, observation, batch)
  checkDefectOrigin(db, observation)
}

/**
 * Observations of one call may cite each other in any order (a withdrawal may come before the report it withdraws),
 * but never in a cycle: the importer applies an observation only after those it cites, so a cycle would be refused
 * on every machine. Self-citation is refused by the ledger rules before this. One depth-first walk over one shared
 * path, so each citation is followed once.
 */
function refuseCitationCycles(fresh: readonly MetricObservation[]): void {
  const cites = new Map(fresh.map((o) => [o.observationId, o.evidence.filter((ref) => ref.kind === 'observation' && ref.id !== o.observationId).map((ref) => ref.id)]))
  const done = new Set<string>()
  const path: string[] = []
  const onPath = new Set<string>()
  const visit = (id: string): void => {
    if (onPath.has(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id]
      fail('invalid_input', `Metric observations ${cycle.join(' -> ')} cite each other in a cycle; citations in one call must not loop.`, { cycle })
    }
    const next = cites.get(id)
    if (next === undefined || done.has(id)) {
      return
    }
    path.push(id)
    onPath.add(id)
    for (const cited of next) {
      visit(cited)
    }
    path.pop()
    onPath.delete(id)
    done.add(id)
  }
  for (const observation of fresh) {
    visit(observation.observationId)
  }
}

/** Checks the references of a call's new observations, any of which may cite another of the call. */
function checkCallReferences(db: Db, fresh: readonly MetricObservation[]): void {
  refuseCitationCycles(fresh)
  const epics = new Map(fresh.map((observation) => [observation.observationId, observation.scope.epicId]))
  for (const observation of fresh) {
    checkObservationReferences(db, observation, epics)
  }
}

/**
 * Records observations atomically: all of them or, on the first refusal, none. Returns every stored record in input
 * order; repeats of stored ids with the same payload write nothing.
 */
export function recordObservations(ctx: Ctx, reported: readonly unknown[]): RecordObservationsResult {
  if (reported.length > LEDGER_LIMITS.perCall) {
    fail('invalid_input', `At most ${LEDGER_LIMITS.perCall} observations are recorded in one call; ${reported.length} were sent.`)
  }
  return ctx.db.tx(() => {
    const now = ctx.clock.nowIso()
    const nextId = idAllocator(ctx, now)
    const result: RecordObservationsResult = { observations: [], created: [], unchanged: [] }
    const batch = new Map<string, MetricObservation>()
    const fresh: MetricObservation[] = []
    reported.forEach((value, index) => {
      const observation = parseReported(nextId, index, value, now)
      const id = observation.observationId
      const known = batch.get(id) ?? storedObservation(ctx.db, id)
      if (known !== undefined) {
        if (observationPayloadHash(known) !== observationPayloadHash(observation)) {
          fail('conflict', `Metric observation ${id} is already recorded with a different payload; observations are never rewritten.`, {
            observationId: id
          })
        }
        result.observations.push(known)
        if (!batch.has(id)) {
          result.unchanged.push(id)
        }
        return
      }
      batch.set(id, observation)
      fresh.push(observation)
      result.observations.push(observation)
    })
    checkCallReferences(ctx.db, fresh)
    const perEpic = new Map<string | null, number>()
    for (const observation of fresh) {
      perEpic.set(observation.scope.epicId, (perEpic.get(observation.scope.epicId) ?? 0) + 1)
    }
    for (const [epicId, adding] of perEpic) {
      assertRoom(ctx.db, epicId, adding)
    }
    for (const observation of fresh) {
      insertObservationRow(ctx.db, observation)
      enqueueOutbox(ctx, { kind: 'metric_observation', epicId: observation.scope.epicId, entityId: observation.observationId })
      result.created.push(observation.observationId)
    }
    return result
  })
}

/** The stored observation with this id, or undefined. */
export function storedObservation(db: Db, observationId: string): MetricObservation | undefined {
  const row = db.get<{ observation_json: string }>('SELECT observation_json FROM metric_observations WHERE id = ?', observationId)
  return row === undefined ? undefined : (JSON.parse(row.observation_json) as MetricObservation)
}

/** Which observations to list. An absent field does not filter; `epicId: null` lists only project-level ones. */
interface ObservationFilter {
  epicId?: string | null
  sprintId?: string
  runId?: string
  ticketId?: string
  attemptId?: string
  metric?: MetricKind
}

/**
 * Observation lists held for the length of one read (`readingObservations`), per connection, by filter. `null` once
 * observations were written inside the read: from then on the read queries every time, so a row written, deleted (or
 * written and rolled back by a nested transaction) is never served from the hold.
 */
interface Hold {
  lists: Map<string, readonly MetricObservation[]>
  /**
   * The connection's `data_version` when the hold opened (it moves when another connection commits), or null when the
   * read runs inside a transaction: `BEGIN IMMEDIATE` holds the write lock, so no other connection commits until the
   * read is over and there is nothing to ask.
   */
  version: number | null
}

const readsHeld = new WeakMap<Db, Hold | null>()

function dataVersion(db: Db): number {
  return db.get<{ version: number }>('SELECT data_version AS version FROM pragma_data_version')?.version ?? 0
}

/**
 * Ends the holding of the read open on this connection, if any: every statement that inserts, updates or deletes
 * `metric_observations` rows on a connection a read may hold calls it first (`insertObservationRow`, epic deletion;
 * a migration rebuild writes a database it just opened). Other writes (a lease the read itself settles) keep the hold.
 */
export function observationsWritten(db: Db): void {
  if (readsHeld.has(db)) readsHeld.set(db, null)
}

/**
 * Runs `read` with every `listObservations` result held by filter until it returns, so a read model that reads the
 * same run's observations from several read models (the project metrics summary grades, projects and totals every
 * run) parses them once. `read` must be synchronous: a read that returns a promise throws, since its awaited part
 * would read after the hold is gone (or under another read's). Observations written on this connection
 * (`observationsWritten`) or a commit by another connection (outside a transaction) stop the holding for the rest of
 * the read. Nested calls share the outer hold. The lists' observations are shared: callers never mutate them.
 */
export function readingObservations<T>(db: Db, read: () => T): T {
  const outer = !readsHeld.has(db)
  if (outer) readsHeld.set(db, { lists: new Map(), version: db.inTransaction() ? null : dataVersion(db) })
  try {
    const result = read()
    if (typeof (result as { then?: unknown } | null)?.then === 'function') {
      throw new Error('readingObservations holds observations for a synchronous read only; the read returned a promise.')
    }
    return result
  } finally {
    if (outer) readsHeld.delete(db)
  }
}

/** Stored observations matching `filter`, in the order the server recorded them (then by id). */
export function listObservations(db: Db, filter: ObservationFilter = {}): MetricObservation[] {
  const held = readsHeld.get(db)
  if (held === undefined || held === null) return queryObservations(db, filter)
  if (held.version !== null && dataVersion(db) !== held.version) {
    readsHeld.set(db, null)
    return queryObservations(db, filter)
  }
  // An absent field does not filter, so `{ epicId: undefined }` is `{}`, never `{ epicId: null }` (project level).
  const set = Object.entries(filter).filter(([, value]) => value !== undefined)
  const key = JSON.stringify(set.sort(([a], [b]) => a.localeCompare(b)))
  const list = held.lists.get(key) ?? queryObservations(db, filter)
  held.lists.set(key, list)
  return [...list]
}

function queryObservations(db: Db, filter: ObservationFilter): MetricObservation[] {
  const clauses: string[] = []
  const params: (string | null)[] = []
  if (filter.epicId !== undefined) {
    clauses.push('epic_id IS ?')
    params.push(filter.epicId)
  }
  const columns = { sprintId: 'sprint_id', runId: 'run_id', ticketId: 'ticket_id', attemptId: 'attempt_id', metric: 'metric' } as const
  for (const [key, column] of Object.entries(columns) as [keyof typeof columns, string][]) {
    const value = filter[key]
    if (value !== undefined) {
      clauses.push(`${column} = ?`)
      params.push(value)
    }
  }
  const sql = `SELECT observation_json FROM metric_observations${clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY recorded_at, id`
  return db.all<{ observation_json: string }>(sql, ...params).map((row) => JSON.parse(row.observation_json) as MetricObservation)
}
