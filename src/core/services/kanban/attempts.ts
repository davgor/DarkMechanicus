/**
 * A Kanban card's lifecycle. Desktop Play or an authorized external launch queues the card; an orchestrator claims it,
 * with a lease and a secret like a plan attempt (`<attemptId>.<secret>` token, checked by `verifyClaimToken`); its agent heartbeats and
 * submits or fails with the token (an orchestrator can release and requeue a lost live claim without it);
 * and a person approves the card to Done or kicks it back with a comment. Nothing
 * here touches an epic, a sprint, a plan revision or a run.
 */
import type {
  ClaimKanbanCardInput,
  FailKanbanCardInput,
  HeartbeatKanbanCardInput,
  KickBackKanbanCardInput,
  LaunchKanbanCardsInput,
  SubmitKanbanCardInput
} from '../../../shared/domain/api'
import { DEFAULT_POLICIES } from '../../../shared/domain/bundle'
import {
  KANBAN_LANE_LABELS,
  type KanbanAttemptView,
  type KanbanCardView,
  type KanbanDoneSummary,
  type KanbanPacket
} from '../../../shared/domain/kanban'
import type { AttemptOutputs } from '../../../shared/domain/views'
import { requireCapability } from '../../authz'
import { CLAIM_TOKEN_MASK, maskWholeClaimTokens } from '../../claimTokenMask'
import { addSeconds, isBefore } from '../../clock'
import type { Ctx } from '../../context'
import { parseJson, toJson } from '../../db/database'
import { DomainError, fail } from '../../errors'
import { LIMITS } from '../../schemas'
import { claimEvidenceAttachments } from '../attachments'
import { heartbeatIntervalSeconds, maskNote, normalizeEvidence, normalizeOutputs, verifyClaimToken } from '../attempts'
import { appendEvent } from '../events'
import { guardUnique } from '../execution'
import { requestWithoutKey, withIdempotency } from '../idempotency'
import { type AttemptRow, cardView, loadSummaryRow, recordCardEvent, type SummaryRow, toAttemptView } from './cards'

/** An attempt row with its claim secret, which only the claim checks read and no view carries. */
interface ClaimRow extends AttemptRow {
  claim_secret: string
}

/** Columns SQLite reports when `kanban_attempts_one_open_per_card` refuses a second open attempt. */
const OPEN_ATTEMPT_COLUMNS = 'kanban_attempts.card_id'

/** Characters in a Done card's outcome line. */
const OUTCOME_LIMIT = 280

const EXPIRED_CLAIM = 'The claim lease expired. The card stays In progress, where a person can press Play again.'

const REPORTING: KanbanPacket['reporting'] = {
  heartbeatTool: 'heartbeat_kanban_card',
  submitTool: 'submit_kanban_card',
  failTool: 'fail_kanban_card',
  instructions: [
    'Work only on this card and stay within its acceptance criteria.',
    'Call heartbeat_kanban_card with the claim token at least every heartbeatIntervalSeconds, or the lease expires.',
    'When finished, call submit_kanban_card with outputs (summary, artifacts, commits, changed files, branch) and evidence for each acceptance criterion.',
    'If you cannot finish, call fail_kanban_card with the reason.',
    'Submitting moves the card to Ready for review; only a person approves it or kicks it back.'
  ].join(' ')
}

/** The packet's reporting text: where to work, the kick-backs to address and the Definition of Done to report. */
function reportingOf(branch: string | null, kickedBack: boolean, definitionOfDone: boolean): KanbanPacket['reporting'] {
  const lines = [
    branch === null ? 'Work on the checked-out branch.' : `Work on the checked-out branch ${branch}; cards get no branch of their own.`,
    REPORTING.instructions
  ]
  if (kickedBack) {
    lines.push('A person kicked this card back before: address every comment in reviewComments, the latest last.')
  }
  if (definitionOfDone) {
    lines.push('Run every check in definitionOfDone and report each one in evidence.checks under its exact name, with status passed, failed or skipped.')
  }
  return { ...REPORTING, instructions: lines.join(' ') }
}

function loadClaim(ctx: Ctx, attemptId: string): ClaimRow {
  return (
    ctx.db.get<ClaimRow>('SELECT * FROM kanban_attempts WHERE id = ?', attemptId) ??
    fail('not_found', `Kanban attempt ${attemptId} does not exist.`, { attemptId })
  )
}

/** A card's claim is superseded when the card has a later attempt. */
function verifyCardClaim(ctx: Ctx, row: ClaimRow, token: string): void {
  const latest = ctx.db.get<{ number: number }>('SELECT MAX(number) AS number FROM kanban_attempts WHERE card_id = ?', row.card_id)
  const superseded = row.number < (latest?.number ?? row.number)
  verifyClaimToken({ id: row.id, claimSecret: row.claim_secret, state: row.state, superseded }, token, EXPIRED_CLAIM)
}

/**
 * Only the computer that claimed an attempt reports on it. An attempt imported from another computer's records keeps
 * that computer's id (and no usable secret), so a report here is refused before its token is even checked.
 */
function requireOwnedAttempt(ctx: Ctx, row: ClaimRow): void {
  if (row.machine_id !== null && row.machine_id !== ctx.machineId) {
    fail('card_not_owned', `Attempt ${row.id} was claimed on another computer; only that computer reports on it.`, {
      attemptId: row.id,
      machineId: row.machine_id
    })
  }
}

/**
 * What an attempt reports as it ends (outputs, evidence, a failure reason), masked in every string: the token the
 * report proved and its bare secret, wherever the agent pasted them, and any other whole claim token. A report is
 * stored as given, never cut, so an attempt id in a path such as `docs/at_<id>.json` is kept (`maskWholeClaimTokens`).
 */
function maskedReport<T>(value: T, claim: { token: string; secret: string }): T {
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) =>
    typeof item === 'string'
      ? maskWholeClaimTokens(item.split(claim.token).join(CLAIM_TOKEN_MASK).split(claim.secret).join(CLAIM_TOKEN_MASK))
      : item
  ) as T
}

interface LeaseRow {
  id: string
  card_id: string
  key: string
  number: number
  lease_expires_at: string | null
}

/**
 * Lazily expires overdue card leases (optionally only one card's), as `expireLeases` does a run's: a `claimed` or
 * `running` attempt whose lease ended before now becomes `lease_expired`. The card stays In progress with no open
 * attempt and no pending play, so a person can press Play again. Only this computer's attempts expire here: one
 * imported from another computer's records may still be heartbeating there, extending a lease this database never sees.
 */
export function expireKanbanLeases(ctx: Ctx, cardId?: string): string[] {
  return ctx.db.tx(() => {
    const now = ctx.clock.nowIso()
    const leased = ctx.db.all<LeaseRow>(
      `SELECT a.id, a.card_id, c.key, a.number, a.lease_expires_at FROM kanban_attempts a JOIN kanban_cards c ON c.id = a.card_id
       WHERE a.state IN ('claimed', 'running') AND (? IS NULL OR a.card_id = ?) AND IFNULL(a.machine_id, ?) = ?
       ORDER BY a.rowid`,
      cardId ?? null,
      cardId ?? null,
      ctx.machineId,
      ctx.machineId
    )
    const expired = leased.filter((row) => row.lease_expires_at !== null && isBefore(row.lease_expires_at, now))
    for (const row of expired) {
      ctx.db.run("UPDATE kanban_attempts SET state = 'lease_expired' WHERE id = ?", row.id)
      ctx.db.run('UPDATE kanban_cards SET updated_at = ? WHERE id = ?', now, row.card_id)
      const payload = { number: row.number, leaseExpiresAt: row.lease_expires_at }
      recordCardEvent(ctx, { id: row.card_id, key: row.key }, { kind: 'lease_expired', payload, attemptId: row.id, at: now })
    }
    return expired.map((row) => row.id)
  })
}

/**
 * Expires the attempt's card's overdue leases in their own transaction, so an expiry is recorded even when the
 * report that noticed it then fails with `expired_claim`.
 */
function settleLeases(ctx: Ctx, attemptId: string): void {
  const row = ctx.db.get<{ card_id: string }>('SELECT card_id FROM kanban_attempts WHERE id = ?', attemptId)
  if (row) {
    expireKanbanLeases(ctx, row.card_id)
  }
}

function assertPlayable(row: SummaryRow): void {
  if (row.lane === 'ready_for_review' || row.lane === 'done') {
    fail('invalid_state', `${row.key} is in ${KANBAN_LANE_LABELS[row.lane]}; Play works only in Backlog or In progress.`, {
      cardId: row.id,
      lane: row.lane
    })
  }
  if (row.open_state !== null) {
    fail('invalid_state', `${row.key} already has an open attempt (#${row.open_number}, ${row.open_state}).`, {
      cardId: row.id,
      attempt: { number: row.open_number, state: row.open_state }
    })
  }
}

/** Shared queued/claimable transition; never creates a desktop chat or an attempt. */
function queueCard(ctx: Ctx, row: SummaryRow): KanbanCardView {
  if (row.play_requested_at === null) {
    const now = ctx.clock.nowIso()
    ctx.db.run(
      'UPDATE kanban_cards SET play_requested_at = ?, play_requested_by = ?, updated_at = ? WHERE id = ?',
      now,
      ctx.session.label.slice(0, LIMITS.label),
      now,
      row.id
    )
    recordCardEvent(ctx, row, { kind: 'played', payload: {}, at: now })
  }
  return cardView(ctx, row.id)
}

/** A local overdue lease will expire during launch, but preflight itself must write nothing. */
function launchableRow(ctx: Ctx, cardId: string): SummaryRow {
  const row = loadSummaryRow(ctx, cardId)
  if (row.open_state === 'claimed' || row.open_state === 'running') {
    const attempt = ctx.db.get<{ lease_expires_at: string | null; machine_id: string | null }>(
      'SELECT lease_expires_at, machine_id FROM kanban_attempts WHERE card_id = ? AND number = ?',
      cardId,
      row.open_number
    )
    if (attempt?.lease_expires_at != null && (attempt.machine_id === null || attempt.machine_id === ctx.machineId) &&
      isBefore(attempt.lease_expires_at, ctx.clock.nowIso())) {
      return { ...row, open_state: null, open_number: null }
    }
  }
  return row
}

/**
 * External orchestrator launch: one explicit nonempty batch, deduplicated and checked atomically.
 * No replay cache is used: a retry checks the current state, never requeues claimed or submitted work.
 */
export function launchKanbanCards(ctx: Ctx, input: LaunchKanbanCardsInput): KanbanCardView[] {
  requireCapability(ctx.session, 'kanban.launch')
  ctx.assertBranch()
  return ctx.db.tx(() => {
    const rows: SummaryRow[] = []
    const errors: { cardId: string; code: string; message: string }[] = []
    for (const cardId of new Set(input.cardIds)) {
      try {
        const row = launchableRow(ctx, cardId)
        assertPlayable(row)
        rows.push(row)
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== 'not_found' && error.code !== 'invalid_state')) throw error
        errors.push({ cardId, code: error.code, message: error.message })
      }
    }
    if (errors.length > 0) {
      fail('invalid_state', 'No cards launched. Resolve each card error, then retry the explicit batch.', { cards: errors })
    }
    return rows.map((row) => {
      expireKanbanLeases(ctx, row.id)
      return queueCard(ctx, row)
    })
  })
}

/**
 * The person presses Play: marks a pending play that an orchestrator's claim consumes. Allowed in Backlog, or In
 * progress with no open attempt; a card whose play is already pending is returned unchanged.
 */
export function playKanbanCard(ctx: Ctx, input: { cardId: string }): KanbanCardView {
  requireCapability(ctx.session, 'kanban.play')
  ctx.assertBranch()
  return ctx.db.tx(() => {
    expireKanbanLeases(ctx, input.cardId)
    const row = loadSummaryRow(ctx, input.cardId)
    assertPlayable(row)
    return queueCard(ctx, row)
  })
}

function assertClaimable(row: SummaryRow): void {
  if (row.open_state !== null) {
    fail('already_claimed', `${row.key} already has an open attempt (#${row.open_number}, ${row.open_state}).`, {
      cardId: row.id,
      attempt: { number: row.open_number, state: row.open_state }
    })
  }
  if (row.lane === 'done') {
    fail('invalid_state', `${row.key} is Done.`, { cardId: row.id, lane: row.lane })
  }
  if (row.play_requested_at === null) {
    fail('play_required', `${row.key} has no pending Play. Press Play in the desktop app or ask an authorized orchestrator to call launch_kanban_cards with explicit cardIds.`, {
      cardId: row.id
    })
  }
}

interface NewClaim {
  attemptId: string
  secret: string
  leaseSeconds: number
  leaseExpiresAt: string
}

function packetOf(ctx: Ctx, cardId: string, claim: NewClaim): KanbanPacket {
  const card = cardView(ctx, cardId)
  const reviewComments = card.attempts.flatMap((attempt) =>
    attempt.state === 'rejected' && attempt.reviewComment !== null ? [attempt.reviewComment] : []
  )
  const branch = ctx.checkout().branch
  const definitionOfDone = ctx.definitionOfDone()
  return {
    cardId: card.id,
    key: card.key,
    attemptId: claim.attemptId,
    claimToken: `${claim.attemptId}.${claim.secret}`,
    leaseExpiresAt: claim.leaseExpiresAt,
    heartbeatIntervalSeconds: heartbeatIntervalSeconds(claim.leaseSeconds),
    card: {
      title: card.title,
      body: card.body,
      acceptanceCriteria: card.acceptanceCriteria,
      expectedArtifacts: card.expectedArtifacts,
      references: card.references,
      priority: card.priority,
      size: card.size,
      ...(card.attachments === undefined ? {} : { attachments: card.attachments })
    },
    branch,
    reviewComments,
    reporting: reportingOf(branch, reviewComments.length > 0, definitionOfDone.length > 0),
    definitionOfDone
  }
}

/** Consumes the pending play: attempt n+1, leased and recorded with this machine's id, and the card In progress. */
function claimCard(ctx: Ctx, row: SummaryRow, leaseSeconds: number): KanbanPacket {
  const attemptId = ctx.ids.next('kanbanAttempt')
  const secret = ctx.ids.secret()
  const now = ctx.clock.nowIso()
  const leaseExpiresAt = addSeconds(now, leaseSeconds)
  const last = ctx.db.get<{ number: number | null }>('SELECT MAX(number) AS number FROM kanban_attempts WHERE card_id = ?', row.id)
  const number = (last?.number ?? 0) + 1
  guardUnique(
    () =>
      ctx.db.run(
        `INSERT INTO kanban_attempts (id, card_id, number, state, claim_secret, machine_id, lease_expires_at, created_at)
         VALUES (?, ?, ?, 'claimed', ?, ?, ?, ?)`,
        attemptId,
        row.id,
        number,
        secret,
        ctx.machineId,
        leaseExpiresAt,
        now
      ),
    OPEN_ATTEMPT_COLUMNS,
    () => fail('already_claimed', `${row.key} already has an open attempt.`, { cardId: row.id })
  )
  ctx.db.run(
    "UPDATE kanban_cards SET lane = 'in_progress', play_requested_at = NULL, play_requested_by = NULL, updated_at = ? WHERE id = ?",
    now,
    row.id
  )
  recordCardEvent(ctx, row, { kind: 'claimed', payload: { number, machineId: ctx.machineId, leaseExpiresAt }, attemptId, at: now })
  return packetOf(ctx, row.id, { attemptId, secret, leaseSeconds, leaseExpiresAt })
}

/**
 * Claims a card queued by desktop Play or an authorized launch, in one transaction after expiring its overdue lease. The packet carries
 * the claim token once: an idempotent replay returns it as null, since no copy is kept.
 */
export function claimKanbanCard(ctx: Ctx, input: ClaimKanbanCardInput): KanbanPacket {
  requireCapability(ctx.session, 'kanban.claim')
  ctx.assertBranch()
  const scope = { command: 'claimKanbanCard', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => {
    expireKanbanLeases(ctx, input.cardId)
    const row = loadSummaryRow(ctx, input.cardId)
    assertClaimable(row)
    return claimCard(ctx, row, input.leaseSeconds ?? DEFAULT_POLICIES.leaseSeconds)
  })
}

/** The length of the lease the claim holds: what its claim or its last heartbeat granted. */
function heldLeaseSeconds(row: ClaimRow): number {
  const grantedAt = row.heartbeat_at ?? row.created_at
  const seconds = row.lease_expires_at === null ? 0 : Math.round((Date.parse(row.lease_expires_at) - Date.parse(grantedAt)) / 1000)
  return seconds > 0 ? seconds : DEFAULT_POLICIES.leaseSeconds
}

/**
 * Extends the claim's lease from now by the length it holds and stores the progress note, masked. The first
 * heartbeat moves the attempt from claimed to running.
 */
export function heartbeatKanbanCard(ctx: Ctx, input: HeartbeatKanbanCardInput): KanbanAttemptView {
  requireCapability(ctx.session, 'kanban.report')
  settleLeases(ctx, input.attemptId)
  return ctx.db.tx(() => {
    const row = loadClaim(ctx, input.attemptId)
    requireOwnedAttempt(ctx, row)
    verifyCardClaim(ctx, row, input.claimToken)
    const now = ctx.clock.nowIso()
    // Masked as a plan attempt's note is, cut-short tokens included, and the bare secret too: the claim stays live.
    const note =
      input.progressNote === undefined ? null : maskNote(input.progressNote, input.claimToken).split(row.claim_secret).join(CLAIM_TOKEN_MASK)
    ctx.db.run(
      "UPDATE kanban_attempts SET state = 'running', lease_expires_at = ?, heartbeat_at = ?, progress_note = COALESCE(?, progress_note) WHERE id = ?",
      addSeconds(now, heldLeaseSeconds(row)),
      now,
      note,
      row.id
    )
    const card = loadSummaryRow(ctx, row.card_id)
    if (row.state === 'claimed') {
      ctx.db.run('UPDATE kanban_cards SET updated_at = ? WHERE id = ?', now, card.id)
      recordCardEvent(ctx, card, { kind: 'running', payload: { number: row.number }, attemptId: row.id, at: now })
    } else if (note !== null) {
      // A note is working data, not a transition: the desktop refreshes, and no kanban event is kept.
      appendEvent(ctx, { kind: 'kanban.progress', payload: { cardId: card.id, key: card.key, attemptId: row.id } })
    }
    return toAttemptView(loadClaim(ctx, row.id))
  })
}

/** Stores the attempt's outputs and evidence, masked, and moves the card to Ready for review. */
export function submitKanbanCard(ctx: Ctx, input: SubmitKanbanCardInput): KanbanAttemptView {
  requireCapability(ctx.session, 'kanban.report')
  settleLeases(ctx, input.attemptId)
  const scope = { command: 'submitKanbanCard', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => {
    const row = loadClaim(ctx, input.attemptId)
    requireOwnedAttempt(ctx, row)
    verifyCardClaim(ctx, row, input.claimToken)
    const claim = { token: input.claimToken, secret: row.claim_secret }
    const outputs = maskedReport(normalizeOutputs(input.outputs), claim)
    // Claimed in this transaction: a refused image refuses the whole submission.
    const evidence = maskedReport(normalizeEvidence(claimEvidenceAttachments(ctx, input.evidence, { kind: 'kanban_attempt', id: row.id })), claim)
    const now = ctx.clock.nowIso()
    ctx.db.run(
      `UPDATE kanban_attempts SET state = 'submitted', outputs_json = ?, evidence_json = ?, submitted_at = ?,
         lease_expires_at = NULL WHERE id = ?`,
      toJson(outputs),
      toJson(evidence),
      now,
      row.id
    )
    ctx.db.run("UPDATE kanban_cards SET lane = 'ready_for_review', updated_at = ? WHERE id = ?", now, row.card_id)
    const payload = { number: row.number, outputs, evidence }
    recordCardEvent(ctx, loadSummaryRow(ctx, row.card_id), { kind: 'submitted', payload, attemptId: row.id, at: now })
    return toAttemptView(loadClaim(ctx, row.id))
  })
}

/** A normal failure needs Play again; an orchestrator's tokenless recovery requeues the lost claim. */
export function failKanbanCard(ctx: Ctx, input: FailKanbanCardInput): KanbanAttemptView {
  requireCapability(ctx.session, 'kanban.report')
  if (input.claimToken === undefined) {
    requireCapability(ctx.session, 'kanban.claim')
  }
  settleLeases(ctx, input.attemptId)
  const scope = { command: 'failKanbanCard', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => {
    const row = loadClaim(ctx, input.attemptId)
    requireOwnedAttempt(ctx, row)
    // Recovery has orchestrator authority, but must still obey the same lease and supersession fences.
    const claimToken = input.claimToken ?? `${row.id}.${row.claim_secret}`
    verifyCardClaim(ctx, row, claimToken)
    const reason = maskedReport(input.reason, { token: claimToken, secret: row.claim_secret })
    const now = ctx.clock.nowIso()
    ctx.db.run("UPDATE kanban_attempts SET state = 'failed', lease_expires_at = NULL WHERE id = ?", row.id)
    ctx.db.run('UPDATE kanban_cards SET updated_at = ? WHERE id = ?', now, row.card_id)
    const payload = { number: row.number, reason }
    recordCardEvent(ctx, loadSummaryRow(ctx, row.card_id), { kind: 'failed', payload, attemptId: row.id, at: now })
    if (input.claimToken === undefined) {
      queueCard(ctx, loadSummaryRow(ctx, row.card_id))
    }
    return toAttemptView(loadClaim(ctx, row.id))
  })
}

/** A card in Ready for review and its submitted attempt. */
function reviewable(ctx: Ctx, cardId: string): { row: SummaryRow; attempt: AttemptRow } {
  const row = loadSummaryRow(ctx, cardId)
  if (row.lane !== 'ready_for_review') {
    fail('invalid_state', `${row.key} is in ${KANBAN_LANE_LABELS[row.lane]}; only a card in Ready for review can be approved or kicked back.`, {
      cardId: row.id,
      lane: row.lane
    })
  }
  const attempt =
    ctx.db.get<AttemptRow>("SELECT * FROM kanban_attempts WHERE card_id = ? AND state = 'submitted'", row.id) ??
    fail('invalid_state', `${row.key} has no submission to review.`, { cardId: row.id })
  return { row, attempt }
}

/** The submission summary as one line, cut to `OUTCOME_LIMIT` characters with an ellipsis when it is longer. */
function outcomeLine(summary: string): string {
  const line = summary.replace(/\s+/g, ' ').trim()
  if (line.length <= OUTCOME_LIMIT) {
    return line
  }
  const cut = line.slice(0, OUTCOME_LIMIT - 1)
  // A cut between the two halves of a surrogate pair would leave half a character.
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`
}

/**
 * The person approves the submission: the attempt is accepted, and the card moves to Done compacted into its summary
 * (the outcome line, the commits, when and by whom).
 */
export function approveKanbanCard(ctx: Ctx, input: { cardId: string; idempotencyKey?: string }): KanbanCardView {
  requireCapability(ctx.session, 'kanban.review')
  ctx.assertBranch()
  const scope = { command: 'approveKanbanCard', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => {
    const { row, attempt } = reviewable(ctx, input.cardId)
    const now = ctx.clock.nowIso()
    const outputs = parseJson<AttemptOutputs | null>(attempt.outputs_json, null)
    const summary: KanbanDoneSummary = {
      outcome: outcomeLine(outputs?.summary ?? ''),
      commits: outputs?.commits ?? [],
      completedAt: now,
      approvedBy: ctx.session.label.slice(0, LIMITS.label)
    }
    ctx.db.run("UPDATE kanban_attempts SET state = 'accepted', decided_at = ? WHERE id = ?", now, attempt.id)
    ctx.db.run(
      `UPDATE kanban_cards SET lane = 'done', completed_at = ?, summary_json = ?, compacted_at = ?, updated_at = ?
       WHERE id = ?`,
      now,
      toJson(summary),
      now,
      now,
      row.id
    )
    recordCardEvent(ctx, row, { kind: 'approved', payload: { number: attempt.number, summary }, attemptId: attempt.id, at: now })
    return cardView(ctx, row.id)
  })
}

/** A kick-back comment: required, not blank, and at most `LIMITS.comment` characters. */
function kickBackComment(comment: string): string {
  if (comment.trim() === '') {
    fail('invalid_input', 'A kick-back needs a comment that tells the agent what to change.')
  }
  if (comment.length > LIMITS.comment) {
    fail('invalid_input', `A kick-back comment is at most ${LIMITS.comment} characters.`, { length: comment.length })
  }
  return comment
}

/**
 * The person kicks the submission back with a comment: the attempt is rejected with it, and the card returns to In
 * progress with a pending play, so the same chat can claim it again. Every later claim lists the comment.
 */
export function kickBackKanbanCard(ctx: Ctx, input: KickBackKanbanCardInput): KanbanCardView {
  requireCapability(ctx.session, 'kanban.review')
  ctx.assertBranch()
  const comment = kickBackComment(input.comment)
  const scope = { command: 'kickBackKanbanCard', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => {
    const { row, attempt } = reviewable(ctx, input.cardId)
    const now = ctx.clock.nowIso()
    ctx.db.run("UPDATE kanban_attempts SET state = 'rejected', review_comment = ?, decided_at = ? WHERE id = ?", comment, now, attempt.id)
    ctx.db.run(
      "UPDATE kanban_cards SET lane = 'in_progress', play_requested_at = ?, play_requested_by = ?, updated_at = ? WHERE id = ?",
      now,
      ctx.session.label.slice(0, LIMITS.label),
      now,
      row.id
    )
    recordCardEvent(ctx, row, { kind: 'kicked_back', payload: { number: attempt.number, comment }, attemptId: attempt.id, at: now })
    return cardView(ctx, row.id)
  })
}
