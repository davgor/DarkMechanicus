/**
 * A person-authorized transfer of one saved epic to a Linear project, the Linear items an agent has created
 * for it so far, and the read-back that verifies them. The packet is built and stored when the person queues
 * the transfer, so an interrupted transfer resumes from the same packet even if the plan's statuses move on
 * meanwhile. A read-back that matches the packet completes the epic.
 */
import type { WorkStatus } from '../../shared/domain/status'
import type {
  EpicTransferOutcome,
  LinearReadback,
  LinearTransferPacket,
  RecordTransferItemInput,
  StartedTransferView,
  SubmitTransferReadbackInput,
  TransferActionInput,
  TransferItemKind,
  TransferItemView,
  TransferMismatch,
  TransferReadbackResult,
  TransferStatus,
  TransferView,
  TransferWarning
} from '../../shared/domain/transfer'
import type { EpicOutcome } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { parseJson, toJson } from '../db/database'
import { fail } from '../errors'
import { epicOutcome } from '../repo/portable'
import { parseInput, READBACK_LIMITS } from '../schemas'
import { buildLinearPacket } from '../transfer/linearPacket'
import { compareReadback, mergeReadback, type ReadbackComparison, readbackCounts } from '../transfer/linearReadback'
import { addComment } from './comments'
import { activeRun, assertEpicOpen, type EpicRow, loadEpicRow } from './epics'
import { appendEvent } from './events'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { enqueueOutbox } from './outbox'
import { assertNoPendingSave, changedDraftRevision, currentSavedBundle, revisionNumberOf } from './plans'
import { hasTransferHold } from './transferGuard'

type StoredStatus = Exclude<TransferStatus, 'not_started'>

interface TransferRow {
  epic_id: string
  status: StoredStatus
  revision_id: string
  packet_hash: string
  packet_json: string
  last_mismatches_json: string | null
  /** The read-back parts sent so far, merged; null when no read-back is under way. */
  readback_json: string | null
}

interface TransferItemRow {
  ref: string
  kind: TransferItemKind
  linear_id: string
  identifier: string | null
  url: string | null
  recorded_at: string
}

const OPEN_STATUSES: readonly StoredStatus[] = ['queued', 'in_progress']

const NOT_AUTHORIZED = 'The person has not authorized a transfer of this epic.'

function loadTransferRow(ctx: Ctx, epicId: string): TransferRow | null {
  return ctx.db.get<TransferRow>('SELECT * FROM transfers WHERE epic_id = ?', epicId) ?? null
}

function itemView(row: TransferItemRow): TransferItemView {
  return {
    ref: row.ref,
    kind: row.kind,
    linearId: row.linear_id,
    identifier: row.identifier,
    url: row.url,
    recordedAt: row.recorded_at
  }
}

/** The recorded items in the order they were first recorded. */
function itemsOf(ctx: Ctx, epicId: string): TransferItemView[] {
  return ctx.db.all<TransferItemRow>('SELECT * FROM transfer_items WHERE epic_id = ? ORDER BY rowid', epicId).map(itemView)
}

/** Every packet ref with its kind, in the order an agent creates them. */
function packetRefs(packet: LinearTransferPacket): { ref: string; kind: TransferItemKind }[] {
  return [
    { ref: packet.project.ref, kind: 'project' as const },
    ...packet.milestones.map((item) => ({ ref: item.ref, kind: 'milestone' as const })),
    ...packet.issues.map((item) => ({ ref: item.ref, kind: 'issue' as const })),
    ...packet.relations.map((item) => ({ ref: item.ref, kind: 'relation' as const }))
  ]
}

function nextRefs(packet: LinearTransferPacket, recorded: TransferItemView[]): string[] {
  const done = new Set(recorded.map((item) => item.ref))
  return packetRefs(packet)
    .map((item) => item.ref)
    .filter((ref) => !done.has(ref))
}

/** The packet of the epic's current saved revision, or null when it was never saved. */
function buildCurrentPacket(ctx: Ctx, epicId: string): LinearTransferPacket | null {
  const saved = currentSavedBundle(ctx, epicId)
  if (saved === null) {
    return null
  }
  const statuses = ctx.db.all<{ ticket_id: string; status: WorkStatus }>(
    'SELECT ticket_id, status FROM ticket_status WHERE epic_id = ?',
    epicId
  )
  return buildLinearPacket({
    epic: { id: epicId },
    bundle: saved.bundle,
    revisionId: saved.revisionId,
    revisionNumber: saved.number,
    ticketStatuses: Object.fromEntries(statuses.map((row) => [row.ticket_id, row.status]))
  })
}

function requireOpenTransfer(ctx: Ctx, epicId: string): TransferRow {
  const row = loadTransferRow(ctx, epicId)
  if (row === null || !OPEN_STATUSES.includes(row.status)) {
    fail('approval_required', NOT_AUTHORIZED, { epicId, status: row?.status ?? 'not_started' })
  }
  return row
}

/** The open transfer, which must also be in progress for `action`. */
function requireStartedTransfer(ctx: Ctx, epicId: string, action: string): TransferRow {
  const row = requireOpenTransfer(ctx, epicId)
  if (row.status !== 'in_progress') {
    fail('conflict', `Start the transfer before ${action}.`, { epicId, status: row.status })
  }
  return row
}

/** The packet a new transfer of `epic` stores, after every refusal `queueTransfer` makes. */
function queueablePacket(ctx: Ctx, epic: EpicRow): LinearTransferPacket {
  assertEpicOpen(epic)
  const run = activeRun(ctx, epic.id)
  if (run) {
    fail('active_run_exists', `Run #${run.number} is active. Finish or cancel it before transferring the epic.`, {
      epicId: epic.id,
      runId: run.id
    })
  }
  const packet =
    buildCurrentPacket(ctx, epic.id) ?? fail('invalid_plan', 'Save the plan before transferring it.', { epicId: epic.id })
  const draftRevision = changedDraftRevision(ctx, epic.id)
  if (draftRevision !== null) {
    fail('conflict', 'The draft has unsaved changes. Save or discard them before transferring the plan.', {
      epicId: epic.id,
      draftRevision
    })
  }
  const existing = loadTransferRow(ctx, epic.id)
  if (existing !== null && OPEN_STATUSES.includes(existing.status)) {
    fail('conflict', 'A transfer of this epic is already open. Cancel it before queuing another.', {
      epicId: epic.id,
      status: existing.status
    })
  }
  return packet
}

/**
 * The person authorizes a transfer: builds the packet from the current saved revision and stores it with
 * its hash. Refused for a completed epic, an active run, a never-saved plan, an unsaved draft change, and
 * while a transfer is already open.
 */
export function queueTransfer(ctx: Ctx, input: TransferActionInput): TransferView {
  requireCapability(ctx.session, 'transfer.queue')
  return withIdempotency(ctx, { command: 'queueTransfer', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    const epic = loadEpicRow(ctx, input.epicId)
    const packet = queueablePacket(ctx, epic)
    const now = ctx.clock.nowIso()
    // A finished or canceled transfer's row is replaced; a canceled one already has no items.
    ctx.db.run('DELETE FROM transfer_items WHERE epic_id = ?', epic.id)
    ctx.db.run('DELETE FROM transfers WHERE epic_id = ?', epic.id)
    ctx.db.run(
      `INSERT INTO transfers (epic_id, target, status, revision_id, packet_hash, packet_json, queued_by, queued_at, updated_at)
       VALUES (?, 'linear', 'queued', ?, ?, ?, ?, ?, ?)`,
      epic.id,
      packet.revisionId,
      packet.packetHash,
      toJson(packet),
      ctx.session.id,
      now,
      now
    )
    appendEvent(ctx, {
      kind: 'transfer.queued',
      epicId: epic.id,
      payload: { target: 'linear', revisionId: packet.revisionId, packetHash: packet.packetHash }
    })
    return transferView(ctx, epic.id)
  })
}

/**
 * The person withdraws the authorization: the transfer is canceled and its recorded items and any unfinished
 * read-back cleared. The items already in Linear stay; a later transfer finds them by their markers.
 */
export function cancelTransfer(ctx: Ctx, input: TransferActionInput): TransferView {
  requireCapability(ctx.session, 'transfer.queue')
  return withIdempotency(ctx, { command: 'cancelTransfer', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    const epic = loadEpicRow(ctx, input.epicId)
    const row = loadTransferRow(ctx, epic.id)
    if (row === null || !OPEN_STATUSES.includes(row.status)) {
      fail('conflict', 'This epic has no open transfer to cancel.', { epicId: epic.id, status: row?.status ?? 'not_started' })
    }
    const cleared = ctx.db.run('DELETE FROM transfer_items WHERE epic_id = ?', epic.id).changes
    ctx.db.run(
      "UPDATE transfers SET status = 'canceled', readback_json = NULL, updated_at = ?, session_id = ? WHERE epic_id = ?",
      ctx.clock.nowIso(),
      ctx.session.id,
      epic.id
    )
    appendEvent(ctx, { kind: 'transfer.canceled', epicId: epic.id, payload: { from: row.status, clearedItems: cleared } })
    return transferView(ctx, epic.id)
  })
}

/**
 * An agent starts a queued transfer, or resumes one in progress, and receives the stored packet with what
 * is already recorded and what remains. Fails unless the person queued the transfer. A read-back an earlier
 * session left unfinished is discarded, so a resumed transfer reads Linear back afresh.
 */
export function startTransfer(ctx: Ctx, input: TransferActionInput): StartedTransferView {
  requireCapability(ctx.session, 'epic.transfer')
  return withIdempotency(ctx, { command: 'startTransfer', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    const epic = loadEpicRow(ctx, input.epicId)
    const row = requireOpenTransfer(ctx, epic.id)
    const now = ctx.clock.nowIso()
    if (row.status === 'queued') {
      ctx.db.run(
        `UPDATE transfers SET status = 'in_progress', started_at = ?, updated_at = ?, session_id = ?, readback_json = NULL
         WHERE epic_id = ?`,
        now,
        now,
        ctx.session.id,
        epic.id
      )
    } else {
      ctx.db.run(
        'UPDATE transfers SET updated_at = ?, session_id = ?, readback_json = NULL WHERE epic_id = ?',
        now,
        ctx.session.id,
        epic.id
      )
    }
    const packet = JSON.parse(row.packet_json) as LinearTransferPacket
    const recorded = itemsOf(ctx, epic.id)
    appendEvent(ctx, {
      kind: 'transfer.started',
      epicId: epic.id,
      payload: { resumed: row.status === 'in_progress', packetHash: row.packet_hash, recorded: recorded.length }
    })
    return { packet, recorded, next: nextRefs(packet, recorded) }
  })
}

/**
 * Records the Linear item an agent created (or adopted) for one packet ref, while the transfer is in
 * progress. Recording the same values again is a no-op; a different Linear id for a recorded ref is a
 * `conflict` unless `replace` is set.
 */
export function recordTransferItem(ctx: Ctx, input: RecordTransferItemInput): TransferItemView {
  requireCapability(ctx.session, 'epic.transfer')
  if (input.linearId.trim() === '') {
    fail('invalid_input', 'linearId must not be empty.', { ref: input.ref })
  }
  return withIdempotency(ctx, { command: 'recordTransferItem', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    const epic = loadEpicRow(ctx, input.epicId)
    const kind = recordableKind(ctx, epic.id, input.ref)
    const item: TransferItemView = {
      ref: input.ref,
      kind,
      linearId: input.linearId,
      identifier: input.identifier ?? null,
      url: input.url ?? null,
      recordedAt: ctx.clock.nowIso()
    }
    const existing = previousRecord(ctx, epic.id, item, input.replace === true)
    if (existing && existing.linearId === item.linearId && existing.identifier === item.identifier && existing.url === item.url) {
      return existing
    }
    writeItem(ctx, epic.id, item)
    const replaced = existing && existing.linearId !== item.linearId ? existing.linearId : null
    appendEvent(ctx, {
      kind: 'transfer.item_recorded',
      epicId: epic.id,
      payload: { ref: item.ref, kind, linearId: item.linearId, identifier: item.identifier, replaced }
    })
    return item
  })
}

/** What `item.ref` is recorded as so far; a different Linear id is a `conflict` unless `replace` is set. */
function previousRecord(ctx: Ctx, epicId: string, item: TransferItemView, replace: boolean): TransferItemView | null {
  const row = ctx.db.get<TransferItemRow>('SELECT * FROM transfer_items WHERE epic_id = ? AND ref = ?', epicId, item.ref)
  if (row && row.linear_id !== item.linearId && !replace) {
    fail('conflict', `Ref ${item.ref} is already recorded as Linear item ${row.linear_id}. Pass replace to overwrite it.`, {
      epicId,
      ref: item.ref,
      recordedLinearId: row.linear_id
    })
  }
  return row ? itemView(row) : null
}

/** The kind of a packet ref an agent may record now: the transfer must be in progress and the ref in its packet. */
function recordableKind(ctx: Ctx, epicId: string, ref: string): TransferItemKind {
  const row = requireStartedTransfer(ctx, epicId, 'recording its items')
  const packet = JSON.parse(row.packet_json) as LinearTransferPacket
  const item = packetRefs(packet).find((candidate) => candidate.ref === ref)
  return item?.kind ?? fail('invalid_input', `Ref ${ref} is not in the transfer packet.`, { epicId, ref })
}

/** Inserts or overwrites one recorded item; the project's id and URL also go on the transfer. */
function writeItem(ctx: Ctx, epicId: string, item: TransferItemView): void {
  ctx.db.run(
    `INSERT INTO transfer_items (epic_id, ref, kind, linear_id, identifier, url, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (epic_id, ref) DO UPDATE SET
       linear_id = excluded.linear_id, identifier = excluded.identifier, url = excluded.url, recorded_at = excluded.recorded_at`,
    epicId,
    item.ref,
    item.kind,
    item.linearId,
    item.identifier,
    item.url,
    item.recordedAt
  )
  if (item.kind === 'project') {
    ctx.db.run(
      'UPDATE transfers SET project_id = ?, project_url = ?, updated_at = ? WHERE epic_id = ?',
      item.linearId,
      item.url,
      item.recordedAt,
      epicId
    )
  } else {
    ctx.db.run('UPDATE transfers SET updated_at = ? WHERE epic_id = ?', item.recordedAt, epicId)
  }
}

function transferView(ctx: Ctx, epicId: string): TransferView {
  const row = loadTransferRow(ctx, epicId)
  const packet = row ? (JSON.parse(row.packet_json) as LinearTransferPacket) : buildCurrentPacket(ctx, epicId)
  const recorded = row ? itemsOf(ctx, epicId) : []
  return {
    epicId,
    status: row?.status ?? 'not_started',
    packet,
    recorded,
    lastMismatches: parseJson<TransferMismatch[]>(row?.last_mismatches_json, []),
    next: packet ? nextRefs(packet, recorded) : []
  }
}

/** Where the epic's transfer stands. Never writes. */
export function getTransfer(ctx: Ctx, input: { epicId: string }): TransferView {
  requireCapability(ctx.session, 'read')
  const epic = loadEpicRow(ctx, input.epicId)
  return transferView(ctx, epic.id)
}

/**
 * An agent sends what it read back from Linear while the transfer is in progress, in as many parts as it
 * needs. The final part ends the accumulation first, in a transaction of its own, so the parts it consumed can
 * never merge into a later read-back, whatever the comparison or the completion does next. It then compares the
 * whole read-back with the stored packet and the recorded items: any mismatch is stored and returned and the
 * epic stays open; a full match completes the epic in one transaction.
 *
 * The merged read-back holds at most `READBACK_LIMITS` milestones, issues and relations. A part that is not final
 * and would take it past one is refused before anything is written, so the parts sent before stay as they were.
 * A final part past one is refused after its clear commits, so it still ends the accumulation.
 *
 * Never call it inside a transaction (an idempotency wrapper included): the final part's clear would become a
 * savepoint that a failed completion rolls back, and the stale parts could then verify a later read-back.
 */
export function submitTransferReadback(ctx: Ctx, input: SubmitTransferReadbackInput): TransferReadbackResult {
  requireCapability(ctx.session, 'epic.transfer')
  if (ctx.db.inTransaction()) {
    fail('internal', 'submitTransferReadback must run outside a transaction, so a final part ends the accumulation for good.')
  }
  const readback = ctx.db.tx(() => acceptReadbackPart(ctx, input))
  if (!input.final) {
    return { status: 'partial', received: readbackCounts(readback), mismatches: [], warnings: [] }
  }
  assertWithinReadbackLimits(readback, true)
  return ctx.db.tx(() => {
    // Read again: another session may have changed the epic or the transfer since the part was taken.
    const epic = loadEpicRow(ctx, input.epicId)
    assertEpicOpen(epic)
    const row = requireStartedTransfer(ctx, epic.id, 'submitting its read-back')
    const packet = JSON.parse(row.packet_json) as LinearTransferPacket
    const comparison = compareReadback({ packet, recorded: itemsOf(ctx, epic.id), readback })
    if (comparison.mismatches.length > 0) {
      return rejectReadback(ctx, epic.id, readback, comparison)
    }
    return completeTransfer(ctx, { epic, row, packet, readback, comparison })
  })
}

/**
 * Merges one part into the parts sent so far. A part that is not final is stored; a final one clears what was
 * stored and hands the whole read-back back to be compared.
 */
function acceptReadbackPart(ctx: Ctx, input: SubmitTransferReadbackInput): LinearReadback {
  const epic = loadEpicRow(ctx, input.epicId)
  assertEpicOpen(epic)
  const row = requireStartedTransfer(ctx, epic.id, 'submitting its read-back')
  const readback = mergeReadback(parseJson<LinearReadback>(row.readback_json, {}), input.readback)
  if (!input.final) {
    assertWithinReadbackLimits(readback, false)
  }
  ctx.db.run(
    'UPDATE transfers SET readback_json = ?, updated_at = ?, session_id = ? WHERE epic_id = ?',
    input.final ? null : toJson(readback),
    ctx.clock.nowIso(),
    ctx.session.id,
    epic.id
  )
  if (!input.final) {
    appendEvent(ctx, { kind: 'transfer.readback_received', epicId: epic.id, payload: { ...readbackCounts(input.readback) } })
  }
  return readback
}

const READBACK_LISTS = ['milestones', 'issues', 'relations'] as const

/** Refuses a merged read-back past a `READBACK_LIMITS` list limit; `ended` when a final part already ended it. */
function assertWithinReadbackLimits(readback: LinearReadback, ended: boolean): void {
  const counts = readbackCounts(readback)
  for (const limit of READBACK_LISTS) {
    const max = READBACK_LIMITS[limit]
    const count = counts[limit]
    if (count > max) {
      const next = ended
        ? 'This final part still ended the read-back. Move the items that do not belong out of the project, then read the project back again from the start.'
        : 'Nothing from this part was stored, and the parts sent before are kept. Move the items that do not belong out of the project, call start_transfer with a fresh idempotencyKey to discard this read-back, then read the project back again from the start.'
      fail('invalid_input', `A transfer read-back holds at most ${max} ${limit}; with this part it would hold ${count}. ${next}`, { limit, max, count })
    }
  }
}

function rejectReadback(ctx: Ctx, epicId: string, readback: LinearReadback, comparison: ReadbackComparison): TransferReadbackResult {
  const { mismatches, warnings } = comparison
  ctx.db.run(
    'UPDATE transfers SET last_mismatches_json = ?, updated_at = ?, session_id = ? WHERE epic_id = ?',
    toJson(mismatches),
    ctx.clock.nowIso(),
    ctx.session.id,
    epicId
  )
  appendEvent(ctx, {
    kind: 'transfer.readback_rejected',
    epicId,
    payload: {
      mismatches: mismatches.length,
      fields: [...new Set(mismatches.map((item) => item.field))],
      warnings: warnings.length
    }
  })
  return { status: 'rejected', received: readbackCounts(readback), mismatches, warnings }
}

interface MatchedReadback {
  epic: EpicRow
  row: TransferRow
  packet: LinearTransferPacket
  readback: LinearReadback
  comparison: ReadbackComparison
}

/** What `queueTransfer` refused, checked again now that the epic is about to complete. */
function assertStillTransferable(ctx: Ctx, epic: EpicRow, row: TransferRow): void {
  const run = activeRun(ctx, epic.id)
  if (run) {
    fail('active_run_exists', `Run #${run.number} is active. Finish or cancel it before the transfer completes the epic.`, {
      epicId: epic.id,
      runId: run.id
    })
  }
  if (epic.current_revision_id !== row.revision_id) {
    fail('conflict', 'The saved plan changed after the transfer was queued. Cancel the transfer and queue it again.', {
      epicId: epic.id,
      revisionId: row.revision_id,
      currentRevisionId: epic.current_revision_id
    })
  }
  // A reconcile held back another machine's revision or run for this transfer; completing would bury them.
  if (hasTransferHold(ctx.db, epic.id)) {
    fail('conflict', 'Changes pulled from another machine are held for this epic. Cancel the transfer and reconcile before it completes.', {
      epicId: epic.id
    })
  }
  assertNoPendingSave(ctx, epic.id)
  const draftRevision = changedDraftRevision(ctx, epic.id)
  if (draftRevision !== null) {
    fail('conflict', 'The draft has unsaved changes. Discard them, or cancel the transfer, before it completes the epic.', {
      epicId: epic.id,
      draftRevision
    })
  }
}

/** The completed epic's outcome, refused unless the epic state export will accept it. */
function transferOutcome(ctx: Ctx, matched: MatchedReadback): EpicOutcome & { transfer: EpicTransferOutcome } {
  // The recorded URL, which a full match shows the read-back project has too.
  const projectUrl = matched.comparison.projectUrl ?? fail('internal', 'A matching read-back has no recorded project URL.')
  const outcome = {
    summary: `Transferred to Linear: ${projectUrl}`,
    successCriteria: [],
    recordedAt: ctx.clock.nowIso(),
    runId: null,
    transfer: {
      target: 'linear' as const,
      projectUrl,
      revisionId: matched.row.revision_id,
      packetHash: matched.row.packet_hash,
      items: matched.comparison.items
    }
  }
  parseInput(epicOutcome, outcome, 'transfer outcome')
  return outcome
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** The summary comment: the Linear project link, what was verified, and any warnings. */
function transferComment(ctx: Ctx, matched: MatchedReadback, projectUrl: string): string {
  const { packet, comparison } = matched
  const items = `${plural(packet.milestones.length, 'milestone')}, ${plural(packet.issues.length, 'issue')} and ${plural(packet.relations.length, 'relation')}`
  const revision = revisionNumberOf(ctx, matched.row.revision_id)
  const lines = [
    `Transferred to Linear: ${projectUrl}`,
    '',
    `The project, its ${items} match revision ${revision ?? '?'} of the saved plan, as read back from Linear.`
  ]
  return comparison.warnings.length === 0 ? lines.join('\n') : [...lines, '', warningSummary(comparison.warnings)].join('\n')
}

function warningSummary(warnings: TransferWarning[]): string {
  const counts = new Map<string, number>()
  for (const warning of warnings) {
    counts.set(warning.code, (counts.get(warning.code) ?? 0) + 1)
  }
  return `Warnings, which do not block: ${[...counts].map(([code, count]) => `${code} (${count})`).join(', ')}.`
}

/**
 * A full match completes the epic: the summary comment first (a completed epic refuses comments), then the
 * epic's status and outcome, the verified transfer and its event, all in the caller's transaction.
 */
function completeTransfer(ctx: Ctx, matched: MatchedReadback): TransferReadbackResult {
  const { epic } = matched
  assertStillTransferable(ctx, epic, matched.row)
  const outcome = transferOutcome(ctx, matched)
  const { transfer } = outcome
  const comment = addComment(ctx, { epicId: epic.id, body: transferComment(ctx, matched, transfer.projectUrl) })
  ctx.db.run(
    `UPDATE epics SET status = 'completed', completed_at = ?, outcome_json = ?, revision = revision + 1, updated_at = ?
     WHERE id = ?`,
    outcome.recordedAt,
    toJson(outcome),
    outcome.recordedAt,
    epic.id
  )
  ctx.db.run(
    `UPDATE transfers SET status = 'verified', readback_json = NULL, last_mismatches_json = NULL, updated_at = ?, session_id = ?
     WHERE epic_id = ?`,
    outcome.recordedAt,
    ctx.session.id,
    epic.id
  )
  appendEvent(ctx, {
    kind: 'epic.transferred',
    epicId: epic.id,
    payload: { from: epic.status, ...transfer, items: transfer.items.length, commentId: comment.id }
  })
  enqueueOutbox(ctx, { kind: 'epic_state', epicId: epic.id })
  return { status: 'verified', received: readbackCounts(matched.readback), mismatches: [], warnings: matched.comparison.warnings }
}
