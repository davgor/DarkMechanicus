/**
 * Local agent mail: the durable store behind direct messages between Skitarii chats (schema v15).
 *
 * Everything here lives in the core `state.sqlite` in both storage modes and nowhere else: no outbox entry, portable
 * record, event body, history index or JSONL file ever carries a message, so in `repo` mode too the local database is
 * the only copy (see `mismatchAdvice` in `workspace.ts`).
 *
 * These are repository primitives. They take explicit endpoint ids and infer nothing from the calling session: who may
 * act for which endpoint (grant, machine, folder, role) is the service layer's decision. Each mutating primitive is one
 * transaction (a savepoint when the caller already holds one), and reads the clock only after taking the write lock,
 * so a caller that checks authority inside its own `db.tx` gets one atomic step.
 */
import type { Clock } from '../clock'
import { canonicalJson, contentHash } from '../canonical'
import type { Db } from '../db/database'
import { fail } from '../errors'
import type { IdGenerator } from '../ids'

const DAY_MS = 24 * 60 * 60 * 1000

export const AGENT_MAIL_LIMITS = {
  /** A message body, in UTF-8 bytes. */
  bodyBytes: 16 * 1024,
  /** Messages per inbox or status page. */
  pageSize: 50,
  /** Message ids per acknowledgement. */
  ackBatch: 100,
  /** Unacknowledged messages one recipient may hold. */
  pendingPerRecipient: 1024,
  /** Retained (unacknowledged, or acknowledged and not yet expired) messages one recipient may hold. */
  retainedPerRecipient: 4096,
  /** Unexpired send receipts one sender may hold. */
  receiptsPerSender: 8192,
  /** How long an acknowledged message, and a send receipt, is kept: seven days. */
  retentionMs: 7 * DAY_MS,
  /** Rows one cleanup step deletes, per table. */
  cleanupBatch: 100,
  /** Endpoints per peer listing page. */
  endpointPageSize: 50,
  nameChars: 120,
  chatIdChars: 200,
  clientMessageIdChars: 128,
  folderChars: 4096
} as const

export interface AgentMailDeps {
  db: Db
  clock: Clock
  ids: IdGenerator
}

/**
 * `open` endpoints send and receive. `suspended` is reversible (an untracked folder); resuming it never revives an old
 * binding. `deleting` and `deleted` are a durable tombstone: provisioning and binding never reopen them.
 */
type MailEndpointState = 'open' | 'suspended' | 'deleting' | 'deleted'

type MailBindingCloseReason = 'replaced' | 'suspended' | 'deleted' | 'grant_ended'

export interface MailEndpoint {
  id: string
  machineId: string
  chatId: string
  /** Trusted desktop metadata, shown as plain text and never interpreted. */
  name: string
  state: MailEndpointState
  /** The highest recipient sequence ever handed out; never reused, even after every message is gone. */
  lastSeq: number
  /** The person's own read cursor, independent of agent acknowledgement. */
  humanSeenSeq: number
  createdAt: string
  updatedAt: string
  deletingAt: string | null
  deletedAt: string | null
}

export interface MailBinding {
  grantId: string
  endpointId: string
  machineId: string
  canonicalFolder: string
  boundAt: string
  closedAt: string | null
  closeReason: MailBindingCloseReason | null
}

/** A received message without its body: what a status page or notification may carry. */
interface MailMessageMeta {
  id: string
  seq: number
  from: { endpointId: string; name: string; deleted: boolean }
  inReplyTo: string | null
  bodyBytes: number
  acceptedAt: string
  acknowledgedAt: string | null
  /** Seven days after acknowledgement; null while unacknowledged, which never expires. */
  expiresAt: string | null
}

interface MailMessage extends MailMessageMeta {
  body: string
}

/** The sender's own acceptance receipt: what a send returns, and what a retry of it replays. */
interface MailAcceptance {
  messageId: string
  to: string
  clientMessageId: string
  inReplyTo: string | null
  acceptedAt: string
  /** True when this call replayed an earlier acceptance of the same client message id and payload. */
  duplicate: boolean
}

interface Page {
  /** The snapshot horizon: the page covers sequences up to here, and later pages should pass it back. */
  throughSeq: number
  /** The sequence to continue after. */
  nextCursor: number
  hasMore: boolean
}

export interface InboxPage extends Page {
  messages: MailMessage[]
}

interface MailStatusPage extends Page {
  /** Unacknowledged messages the mailbox holds now. */
  pendingCount: number
  /** Unacknowledged messages, ascending, without bodies. */
  messages: MailMessageMeta[]
}

interface HumanMailState {
  humanSeenSeq: number
  /** Retained messages above the person's cursor; expired and purged rows never count. */
  unseenCount: number
  pendingCount: number
  retainedCount: number
  retentionDays: number
}

interface EndpointRow {
  id: string
  machine_id: string
  chat_id: string
  name: string
  state: MailEndpointState
  last_seq: number
  human_seen_seq: number
  created_at: string
  updated_at: string
  deleting_at: string | null
  deleted_at: string | null
}

interface BindingRow {
  grant_id: string
  endpoint_id: string
  machine_id: string
  canonical_folder: string
  bound_at: string
  closed_at: string | null
  close_reason: MailBindingCloseReason | null
}

interface MessageRow {
  id: string
  recipient_seq: number
  sender_endpoint_id: string
  sender_name: string
  sender_state: MailEndpointState
  in_reply_to: string | null
  body_bytes: number
  accepted_at: string
  acked_at: string | null
  expires_at: string | null
}

interface ReceiptRow {
  payload_hash: string
  result_json: string
  expires_at: string
}

const ENDPOINT_COLUMNS =
  'id, machine_id, chat_id, name, state, last_seq, human_seen_seq, created_at, updated_at, deleting_at, deleted_at'
const BINDING_COLUMNS = 'grant_id, endpoint_id, machine_id, canonical_folder, bound_at, closed_at, close_reason'
/** A message is retained while unacknowledged (no expiry) or until its expiry passes. */
const RETAINED = '(m.expires_at IS NULL OR m.expires_at > ?)'
const MESSAGE_META_COLUMNS = `m.id, m.recipient_seq, m.sender_endpoint_id, s.name AS sender_name, s.state AS sender_state,
  m.in_reply_to, m.body_bytes, m.accepted_at, m.acked_at, m.expires_at`

// --- validation ----------------------------------------------------------------------------------------------------

/** Control characters and bidirectional overrides: a name must render as the plain text it is. */
const UNSAFE_NAME = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u
const LONE_SURROGATE = /\p{Cs}/u
const CLIENT_MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

function requireText(value: string, field: string, maxChars: number): string {
  if (value.length === 0 || value.length > maxChars || UNSAFE_NAME.test(value) || LONE_SURROGATE.test(value)) {
    fail('invalid_input', `${field} must be 1 to ${maxChars} characters of plain text.`, { field })
  }
  return value
}

function requireClientMessageId(value: string): void {
  if (value.length > AGENT_MAIL_LIMITS.clientMessageIdChars || !CLIENT_MESSAGE_ID.test(value)) {
    fail(
      'invalid_input',
      `clientMessageId must be 1 to ${AGENT_MAIL_LIMITS.clientMessageIdChars} letters, digits, '.', '_', ':' or '-', starting with a letter or digit.`,
      { field: 'clientMessageId' }
    )
  }
}

/** The body's size in UTF-8 bytes, refusing an empty, oversized or not well-formed body. */
function mailBodyBytes(body: string): number {
  if (LONE_SURROGATE.test(body)) {
    fail('invalid_input', 'The message body is not well-formed Unicode text.', { field: 'body' })
  }
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes === 0 || bytes > AGENT_MAIL_LIMITS.bodyBytes) {
    fail('invalid_input', `The message body must be 1 to ${AGENT_MAIL_LIMITS.bodyBytes} bytes of UTF-8.`, {
      field: 'body',
      bytes,
      limit: AGENT_MAIL_LIMITS.bodyBytes
    })
  }
  return bytes
}

function requireSeq(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('invalid_input', `${field} must be a non-negative integer.`, { field })
  }
  return value
}

function pageLimit(limit: number | undefined, max: number): number {
  const value = limit ?? max
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    fail('invalid_input', `limit must be 1 to ${max}.`, { field: 'limit', max })
  }
  return value
}

// --- rows and views ------------------------------------------------------------------------------------------------

function endpointView(row: EndpointRow): MailEndpoint {
  return {
    id: row.id,
    machineId: row.machine_id,
    chatId: row.chat_id,
    name: row.name,
    state: row.state,
    lastSeq: row.last_seq,
    humanSeenSeq: row.human_seen_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletingAt: row.deleting_at,
    deletedAt: row.deleted_at
  }
}

function bindingView(row: BindingRow): MailBinding {
  return {
    grantId: row.grant_id,
    endpointId: row.endpoint_id,
    machineId: row.machine_id,
    canonicalFolder: row.canonical_folder,
    boundAt: row.bound_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason
  }
}

function metaView(row: MessageRow): MailMessageMeta {
  return {
    id: row.id,
    seq: row.recipient_seq,
    from: { endpointId: row.sender_endpoint_id, name: row.sender_name, deleted: row.sender_state === 'deleted' || row.sender_state === 'deleting' },
    inReplyTo: row.in_reply_to,
    bodyBytes: row.body_bytes,
    acceptedAt: row.accepted_at,
    acknowledgedAt: row.acked_at,
    expiresAt: row.expires_at
  }
}

function endpointRow(db: Db, endpointId: string): EndpointRow | undefined {
  return db.get<EndpointRow>(`SELECT ${ENDPOINT_COLUMNS} FROM agent_mail_endpoints WHERE id = ?`, endpointId)
}

function requireEndpoint(db: Db, endpointId: string): EndpointRow {
  const row = endpointRow(db, endpointId)
  if (!row) {
    fail('not_found', 'No such mail endpoint.', { endpointId })
  }
  return row
}

function expiryAfter(nowMs: number): string {
  return new Date(nowMs + AGENT_MAIL_LIMITS.retentionMs).toISOString()
}

/** Reads the clock; call only inside the transaction, after the write lock is held. */
function now(deps: AgentMailDeps): { ms: number; iso: string } {
  const ms = deps.clock.nowMs()
  return { ms, iso: new Date(ms).toISOString() }
}

function closeOpenBindings(db: Db, endpointId: string, at: string, reason: MailBindingCloseReason): void {
  db.run(
    'UPDATE agent_mail_bindings SET closed_at = ?, close_reason = ? WHERE endpoint_id = ? AND closed_at IS NULL',
    at,
    reason,
    endpointId
  )
}

// --- endpoints -----------------------------------------------------------------------------------------------------

/**
 * The endpoint for (machine, trusted chat id) in this project's database, created on first use. The same pair always
 * yields the same opaque id; a later call only refreshes the display name. A deleting or deleted endpoint is never
 * reopened: a deleted chat's identity stays a tombstone.
 */
export function provisionEndpoint(deps: AgentMailDeps, input: { machineId: string; chatId: string; name: string }): MailEndpoint {
  const machineId = requireText(input.machineId, 'machineId', AGENT_MAIL_LIMITS.chatIdChars)
  const chatId = requireText(input.chatId, 'chatId', AGENT_MAIL_LIMITS.chatIdChars)
  const name = requireText(input.name.trim(), 'name', AGENT_MAIL_LIMITS.nameChars)
  return deps.db.tx(() => {
    const at = now(deps).iso
    const existing = deps.db.get<EndpointRow>(
      `SELECT ${ENDPOINT_COLUMNS} FROM agent_mail_endpoints WHERE machine_id = ? AND chat_id = ?`,
      machineId,
      chatId
    )
    if (existing) {
      if (existing.state === 'deleting' || existing.state === 'deleted') {
        fail('invalid_state', 'This chat’s mailbox was deleted and cannot be reopened.', { endpointId: existing.id, state: existing.state })
      }
      if (existing.name !== name) {
        deps.db.run('UPDATE agent_mail_endpoints SET name = ?, updated_at = ? WHERE id = ?', name, at, existing.id)
      }
      return endpointView(requireEndpoint(deps.db, existing.id))
    }
    const id = deps.ids.next('mailEndpoint')
    deps.db.run(
      `INSERT INTO agent_mail_endpoints (id, machine_id, chat_id, name, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      id,
      machineId,
      chatId,
      name,
      at,
      at
    )
    return endpointView(requireEndpoint(deps.db, id))
  })
}

export function getEndpoint(deps: Pick<AgentMailDeps, 'db'>, endpointId: string): MailEndpoint | null {
  const row = endpointRow(deps.db, endpointId)
  return row ? endpointView(row) : null
}

export function findEndpointByChat(deps: Pick<AgentMailDeps, 'db'>, input: { machineId: string; chatId: string }): MailEndpoint | null {
  const row = deps.db.get<EndpointRow>(
    `SELECT ${ENDPOINT_COLUMNS} FROM agent_mail_endpoints WHERE machine_id = ? AND chat_id = ?`,
    input.machineId,
    input.chatId
  )
  return row ? endpointView(row) : null
}

/** Open endpoints in id order, a bounded page at a time. */
export function listOpenEndpoints(
  deps: Pick<AgentMailDeps, 'db'>,
  input: { afterId?: string; limit?: number } = {}
): { endpoints: MailEndpoint[]; nextAfterId: string | null; hasMore: boolean } {
  const limit = pageLimit(input.limit, AGENT_MAIL_LIMITS.endpointPageSize)
  const rows = deps.db.all<EndpointRow>(
    `SELECT ${ENDPOINT_COLUMNS} FROM agent_mail_endpoints WHERE state = 'open' AND id > ? ORDER BY id LIMIT ?`,
    input.afterId ?? '',
    limit + 1
  )
  const page = rows.slice(0, limit)
  return { endpoints: page.map(endpointView), nextAfterId: page.at(-1)?.id ?? null, hasMore: rows.length > limit }
}

/** Reversibly stops an open endpoint and closes its binding for good; its mail is kept. */
export function suspendEndpoint(deps: AgentMailDeps, endpointId: string): MailEndpoint {
  return deps.db.tx(() => {
    const row = requireEndpoint(deps.db, endpointId)
    if (row.state === 'suspended') {
      return endpointView(row)
    }
    if (row.state !== 'open') {
      fail('invalid_state', 'Only an open mailbox can be suspended.', { endpointId, state: row.state })
    }
    const at = now(deps).iso
    closeOpenBindings(deps.db, endpointId, at, 'suspended')
    deps.db.run("UPDATE agent_mail_endpoints SET state = 'suspended', updated_at = ? WHERE id = ?", at, endpointId)
    return endpointView(requireEndpoint(deps.db, endpointId))
  })
}

/** Reopens a suspended endpoint. No earlier binding comes back: it needs a fresh grant bound. */
export function resumeEndpoint(deps: AgentMailDeps, endpointId: string): MailEndpoint {
  return deps.db.tx(() => {
    const row = requireEndpoint(deps.db, endpointId)
    if (row.state === 'open') {
      return endpointView(row)
    }
    if (row.state !== 'suspended') {
      fail('invalid_state', 'A deleted mailbox cannot be reopened.', { endpointId, state: row.state })
    }
    deps.db.run("UPDATE agent_mail_endpoints SET state = 'open', updated_at = ? WHERE id = ?", now(deps).iso, endpointId)
    return endpointView(requireEndpoint(deps.db, endpointId))
  })
}

/**
 * Durably records the irreversible decision to delete an endpoint, before anything else of the chat is removed, and
 * closes its binding. From here on nothing provisions, binds, sends to or sends from it. Idempotent.
 */
export function beginEndpointDeletion(deps: AgentMailDeps, endpointId: string): MailEndpoint {
  return deps.db.tx(() => {
    const row = requireEndpoint(deps.db, endpointId)
    if (row.state === 'deleting' || row.state === 'deleted') {
      return endpointView(row)
    }
    const at = now(deps).iso
    closeOpenBindings(deps.db, endpointId, at, 'deleted')
    deps.db.run(
      "UPDATE agent_mail_endpoints SET state = 'deleting', deleting_at = ?, updated_at = ? WHERE id = ?",
      at,
      at,
      endpointId
    )
    return endpointView(requireEndpoint(deps.db, endpointId))
  })
}

/**
 * Purges one bounded batch of a deleting endpoint's received mail, and marks it `deleted` once its inbox is empty. Call
 * until `done`. Copies it sent to other mailboxes stay there, showing a deleted sender; its send receipts stay until
 * they expire; its row stays as the tombstone that keeps its sequence high-water.
 */
export function finishEndpointDeletion(
  deps: AgentMailDeps,
  endpointId: string,
  input: { limit?: number } = {}
): { endpoint: MailEndpoint; purged: number; done: boolean } {
  const limit = pageLimit(input.limit, AGENT_MAIL_LIMITS.cleanupBatch)
  return deps.db.tx(() => {
    const row = requireEndpoint(deps.db, endpointId)
    if (row.state === 'deleted') {
      return { endpoint: endpointView(row), purged: 0, done: true }
    }
    if (row.state !== 'deleting') {
      fail('invalid_state', 'Begin deleting the mailbox before purging it.', { endpointId, state: row.state })
    }
    const purged = deps.db.run(
      `DELETE FROM agent_mail_messages WHERE rowid IN (
         SELECT rowid FROM agent_mail_messages WHERE recipient_endpoint_id = ? ORDER BY recipient_seq LIMIT ?)`,
      endpointId,
      limit
    ).changes
    const left = deps.db.get('SELECT 1 FROM agent_mail_messages WHERE recipient_endpoint_id = ? LIMIT 1', endpointId)
    if (left !== undefined) {
      return { endpoint: endpointView(requireEndpoint(deps.db, endpointId)), purged, done: false }
    }
    const at = now(deps).iso
    deps.db.run("UPDATE agent_mail_endpoints SET state = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?", at, at, endpointId)
    return { endpoint: endpointView(requireEndpoint(deps.db, endpointId)), purged, done: true }
  })
}

// --- bindings ------------------------------------------------------------------------------------------------------

/**
 * Binds a grant to an open endpoint, with the trusted canonical folder and logical machine id it was bound in (a
 * project id alone would match a copied checkout). The endpoint's previous binding closes for good. A grant binds at
 * most once: binding it again to the same endpoint, folder and machine while still open is a no-op, anything else a
 * conflict, and a closed binding is never reopened.
 */
export function bindEndpoint(
  deps: AgentMailDeps,
  input: { endpointId: string; grantId: string; machineId: string; canonicalFolder: string }
): MailBinding {
  const grantId = requireText(input.grantId, 'grantId', AGENT_MAIL_LIMITS.chatIdChars)
  const machineId = requireText(input.machineId, 'machineId', AGENT_MAIL_LIMITS.chatIdChars)
  const canonicalFolder = requireText(input.canonicalFolder, 'canonicalFolder', AGENT_MAIL_LIMITS.folderChars)
  return deps.db.tx(() => {
    const endpoint = requireEndpoint(deps.db, input.endpointId)
    if (endpoint.state !== 'open') {
      fail('invalid_state', 'Only an open mailbox can be bound.', { endpointId: endpoint.id, state: endpoint.state })
    }
    const existing = deps.db.get<BindingRow>(`SELECT ${BINDING_COLUMNS} FROM agent_mail_bindings WHERE grant_id = ?`, grantId)
    if (existing) {
      const same =
        existing.closed_at === null &&
        existing.endpoint_id === endpoint.id &&
        existing.machine_id === machineId &&
        existing.canonical_folder === canonicalFolder
      if (!same) {
        fail('conflict', 'This grant is already bound, or its binding has been closed for good.', { grantId })
      }
      return bindingView(existing)
    }
    const at = now(deps).iso
    closeOpenBindings(deps.db, endpoint.id, at, 'replaced')
    deps.db.run(
      `INSERT INTO agent_mail_bindings (grant_id, endpoint_id, machine_id, canonical_folder, bound_at) VALUES (?, ?, ?, ?, ?)`,
      grantId,
      endpoint.id,
      machineId,
      canonicalFolder,
      at
    )
    return { grantId, endpointId: endpoint.id, machineId, canonicalFolder, boundAt: at, closedAt: null, closeReason: null }
  })
}

/** The binding a grant made, open or closed, or null. Authority checks on it are the caller's. */
export function getBinding(deps: Pick<AgentMailDeps, 'db'>, grantId: string): MailBinding | null {
  const row = deps.db.get<BindingRow>(`SELECT ${BINDING_COLUMNS} FROM agent_mail_bindings WHERE grant_id = ?`, grantId)
  return row ? bindingView(row) : null
}

/** Closes a grant's binding for good (its grant was revoked or expired). Already closed or unknown is a no-op. */
export function closeBinding(deps: AgentMailDeps, grantId: string): MailBinding | null {
  return deps.db.tx(() => {
    deps.db.run(
      "UPDATE agent_mail_bindings SET closed_at = ?, close_reason = 'grant_ended' WHERE grant_id = ? AND closed_at IS NULL",
      now(deps).iso,
      grantId
    )
    return getBinding(deps, grantId)
  })
}

// --- sending -------------------------------------------------------------------------------------------------------

interface SendMailInput {
  senderEndpointId: string
  to: string
  clientMessageId: string
  body: string
  inReplyTo?: string | null
}

/** One validated send, inside its transaction: `at` was read after the write lock was taken. */
interface PendingSend {
  input: SendMailInput
  inReplyTo: string | null
  bodyBytes: number
  payloadHash: string
  at: { ms: number; iso: string }
}

/**
 * Accepts one direct message or reply, in this order: the sender must be open; its receipt for `clientMessageId` is
 * consulted next, so a retry replays the original acceptance (or conflicts on a changed payload) whatever has become of
 * the recipient since; then the sender's receipt quota, the recipient, the replied-to message and the recipient's
 * quotas. A full mailbox refuses with `mailbox_full`; nothing pending is ever evicted to make room.
 */
export function acceptMessage(deps: AgentMailDeps, input: SendMailInput): MailAcceptance {
  requireClientMessageId(input.clientMessageId)
  const bodyBytes = mailBodyBytes(input.body)
  const inReplyTo = input.inReplyTo ?? null
  const payloadHash = contentHash({ to: input.to, body: input.body, inReplyTo })
  return deps.db.tx(() => {
    const send: PendingSend = { input, inReplyTo, bodyBytes, payloadHash, at: now(deps) }
    pruneBatch(deps.db, send.at.iso, AGENT_MAIL_LIMITS.cleanupBatch)
    const sender = requireEndpoint(deps.db, input.senderEndpointId)
    if (sender.state !== 'open') {
      fail('invalid_state', 'This mailbox is not open, so it cannot send.', { state: sender.state })
    }
    const replay = consultReceipt(deps.db, sender.id, send)
    if (replay) {
      return replay
    }
    const recipient = admitRecipient(deps.db, sender.id, send)
    return storeMessage(deps, { sender: sender.id, recipient }, send)
  })
}

/**
 * The sender's unexpired receipt for this client message id, replayed, or null when there is none and the sender may
 * hold another. An expired receipt is dropped here so the id can be used again.
 */
function consultReceipt(db: Db, sender: string, send: PendingSend): MailAcceptance | null {
  const { clientMessageId } = send.input
  const receipt = db.get<ReceiptRow>(
    'SELECT payload_hash, result_json, expires_at FROM agent_mail_receipts WHERE sender_endpoint_id = ? AND client_message_id = ?',
    sender,
    clientMessageId
  )
  if (receipt && receipt.expires_at > send.at.iso) {
    if (receipt.payload_hash !== send.payloadHash) {
      fail('idempotency_mismatch', 'This clientMessageId was already used for a different message.', { clientMessageId })
    }
    return { ...(JSON.parse(receipt.result_json) as Omit<MailAcceptance, 'duplicate'>), duplicate: true }
  }
  if (receipt) {
    db.run('DELETE FROM agent_mail_receipts WHERE sender_endpoint_id = ? AND client_message_id = ?', sender, clientMessageId)
  }
  // An aggregate without GROUP BY always yields exactly one row.
  const held = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_mail_receipts WHERE sender_endpoint_id = ? AND expires_at > ?', sender, send.at.iso)!.n
  if (held >= AGENT_MAIL_LIMITS.receiptsPerSender) {
    fail('receipt_quota_full', 'This mailbox has sent as many messages as it may within seven days; try again later.', {
      limit: AGENT_MAIL_LIMITS.receiptsPerSender
    })
  }
  return null
}

/** The open recipient, once the reply target and the recipient's pending and retained quotas allow one more message. */
function admitRecipient(db: Db, sender: string, send: PendingSend): EndpointRow {
  const { to } = send.input
  if (to === sender) {
    fail('invalid_input', 'A message goes to another mailbox, not to its sender.', { field: 'to' })
  }
  const recipient = endpointRow(db, to)
  if (!recipient || recipient.state !== 'open') {
    fail('not_found', 'No open mailbox has that id.', { to })
  }
  if (send.inReplyTo !== null) {
    requireReplyParent(db, { inReplyTo: send.inReplyTo, sender, to: recipient.id, now: send.at.iso })
  }
  const counts = db.get<{ pending: number; retained: number }>(
    `SELECT COALESCE(SUM(m.acked_at IS NULL), 0) AS pending, COUNT(*) AS retained
     FROM agent_mail_messages m WHERE m.recipient_endpoint_id = ? AND ${RETAINED}`,
    recipient.id,
    send.at.iso
  )!
  if (counts.pending >= AGENT_MAIL_LIMITS.pendingPerRecipient || counts.retained >= AGENT_MAIL_LIMITS.retainedPerRecipient) {
    fail('mailbox_full', 'The recipient’s mailbox is full; try again after it reads its mail.', {
      to: recipient.id,
      pendingLimit: AGENT_MAIL_LIMITS.pendingPerRecipient,
      retainedLimit: AGENT_MAIL_LIMITS.retainedPerRecipient
    })
  }
  return recipient
}

/** Stores the message under the recipient's next sequence, and the sender's body-free receipt for it. */
function storeMessage(deps: AgentMailDeps, parties: { sender: string; recipient: EndpointRow }, send: PendingSend): MailAcceptance {
  const { input, at } = send
  const seq = parties.recipient.last_seq + 1
  const messageId = deps.ids.next('mailMessage')
  deps.db.run('UPDATE agent_mail_endpoints SET last_seq = ? WHERE id = ?', seq, parties.recipient.id)
  deps.db.run(
    `INSERT INTO agent_mail_messages
       (id, recipient_endpoint_id, recipient_seq, sender_endpoint_id, client_message_id, in_reply_to, body, body_bytes, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    messageId,
    parties.recipient.id,
    seq,
    parties.sender,
    input.clientMessageId,
    send.inReplyTo,
    input.body,
    send.bodyBytes,
    at.iso
  )
  const result: Omit<MailAcceptance, 'duplicate'> = {
    messageId,
    to: parties.recipient.id,
    clientMessageId: input.clientMessageId,
    inReplyTo: send.inReplyTo,
    acceptedAt: at.iso
  }
  deps.db.run(
    `INSERT INTO agent_mail_receipts (sender_endpoint_id, client_message_id, payload_hash, result_json, accepted_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    parties.sender,
    input.clientMessageId,
    send.payloadHash,
    canonicalJson(result),
    at.iso,
    expiryAfter(at.ms)
  )
  return { ...result, duplicate: false }
}

/**
 * A reply answers a retained message in the replier's own inbox and goes back to that message's sender. A parent that
 * is not (or no longer) in the replier's inbox is `reply_unavailable`, whether it expired, was purged or never was
 * the replier's: the answer never reveals another mailbox's contents.
 */
function requireReplyParent(db: Db, input: { inReplyTo: string; sender: string; to: string; now: string }): void {
  const parent = db.get<{ sender_endpoint_id: string }>(
    `SELECT m.sender_endpoint_id FROM agent_mail_messages m WHERE m.id = ? AND m.recipient_endpoint_id = ? AND ${RETAINED}`,
    input.inReplyTo,
    input.sender,
    input.now
  )
  if (!parent) {
    fail('reply_unavailable', 'The message being replied to is no longer in this inbox.', { inReplyTo: input.inReplyTo })
  }
  if (parent.sender_endpoint_id !== input.to) {
    fail('invalid_input', 'A reply goes to the sender of the message it answers.', { field: 'to' })
  }
}

// --- receiving -----------------------------------------------------------------------------------------------------

interface WindowInput {
  endpointId: string
  afterSeq?: number
  throughSeq?: number
  limit?: number
}

/** Validates a paging window against the mailbox's high-water, pinning the horizon on the first page. */
function window(row: EndpointRow, input: WindowInput): { afterSeq: number; throughSeq: number; limit: number } {
  const afterSeq = requireSeq(input.afterSeq ?? 0, 'afterSeq')
  const throughSeq = requireSeq(input.throughSeq ?? row.last_seq, 'throughSeq')
  if (throughSeq > row.last_seq) {
    fail('invalid_input', 'throughSeq is beyond the newest message this mailbox has received.', { field: 'throughSeq' })
  }
  if (afterSeq > throughSeq) {
    fail('invalid_input', 'afterSeq must not be beyond throughSeq.', { field: 'afterSeq' })
  }
  return { afterSeq, throughSeq, limit: pageLimit(input.limit, AGENT_MAIL_LIMITS.pageSize) }
}

function pageOf<T extends { seq: number }>(rows: T[], limit: number, afterSeq: number, throughSeq: number): Page & { items: T[] } {
  const items = rows.slice(0, limit)
  return { items, throughSeq, nextCursor: items.at(-1)?.seq ?? afterSeq, hasMore: rows.length > limit }
}

/**
 * One ascending page of retained mail with bodies, for sequences in (afterSeq, throughSeq]. The horizon defaults to the
 * current high-water, read in the same snapshot; pass the returned `throughSeq` back to page without skipping arrivals.
 * Reading never acknowledges.
 */
export function readInbox(deps: AgentMailDeps, input: WindowInput & { unacknowledgedOnly?: boolean }): InboxPage {
  return deps.db.tx(() => {
    const row = requireEndpoint(deps.db, input.endpointId)
    const bounds = window(row, input)
    const rows = deps.db.all<MessageRow & { body: string }>(
      `SELECT ${MESSAGE_META_COLUMNS}, m.body
       FROM agent_mail_messages m JOIN agent_mail_endpoints s ON s.id = m.sender_endpoint_id
       WHERE m.recipient_endpoint_id = ? AND m.recipient_seq > ? AND m.recipient_seq <= ? AND ${RETAINED}
         AND (? = 0 OR m.acked_at IS NULL)
       ORDER BY m.recipient_seq LIMIT ?`,
      row.id,
      bounds.afterSeq,
      bounds.throughSeq,
      now(deps).iso,
      input.unacknowledgedOnly === true ? 1 : 0,
      bounds.limit + 1
    )
    const page = pageOf(rows.map((message) => ({ ...metaView(message), body: message.body })), bounds.limit, bounds.afterSeq, bounds.throughSeq)
    return { messages: page.items, throughSeq: page.throughSeq, nextCursor: page.nextCursor, hasMore: page.hasMore }
  })
}

/** The pending count and one ascending page of unacknowledged message metadata, without bodies. */
export function readMailStatus(deps: AgentMailDeps, input: WindowInput): MailStatusPage {
  return deps.db.tx(() => {
    const row = requireEndpoint(deps.db, input.endpointId)
    const bounds = window(row, input)
    const pendingCount = deps.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM agent_mail_messages WHERE recipient_endpoint_id = ? AND acked_at IS NULL',
      row.id
    )!.n
    const rows = deps.db.all<MessageRow>(
      `SELECT ${MESSAGE_META_COLUMNS}
       FROM agent_mail_messages m JOIN agent_mail_endpoints s ON s.id = m.sender_endpoint_id
       WHERE m.recipient_endpoint_id = ? AND m.acked_at IS NULL AND m.recipient_seq > ? AND m.recipient_seq <= ?
       ORDER BY m.recipient_seq LIMIT ?`,
      row.id,
      bounds.afterSeq,
      bounds.throughSeq,
      bounds.limit + 1
    )
    const page = pageOf(rows.map(metaView), bounds.limit, bounds.afterSeq, bounds.throughSeq)
    return { pendingCount, messages: page.items, throughSeq: page.throughSeq, nextCursor: page.nextCursor, hasMore: page.hasMore }
  })
}

/**
 * Acknowledges up to 100 messages of one inbox. Every id must be a retained message of that inbox, checked before
 * anything changes, so one foreign or unknown id changes nothing. Acknowledging again keeps the first acknowledgement.
 * An acknowledged message expires seven days later.
 */
export function acknowledgeMessages(
  deps: AgentMailDeps,
  input: { endpointId: string; messageIds: string[] }
): { acknowledged: { messageId: string; acknowledgedAt: string; expiresAt: string }[] } {
  const ids = [...new Set(input.messageIds)]
  if (ids.length === 0 || ids.length > AGENT_MAIL_LIMITS.ackBatch) {
    fail('invalid_input', `Acknowledge 1 to ${AGENT_MAIL_LIMITS.ackBatch} messages at a time.`, { field: 'messageIds' })
  }
  return deps.db.tx(() => {
    requireEndpoint(deps.db, input.endpointId)
    const at = now(deps)
    const idsJson = JSON.stringify(ids)
    const owned = deps.db.all<{ id: string }>(
      `SELECT m.id FROM agent_mail_messages m JOIN json_each(?) j ON j.value = m.id
       WHERE m.recipient_endpoint_id = ? AND ${RETAINED}`,
      idsJson,
      input.endpointId,
      at.iso
    )
    if (owned.length !== ids.length) {
      fail('not_found', 'Some of those messages are not in this inbox; none was acknowledged.', { field: 'messageIds' })
    }
    deps.db.run(
      `UPDATE agent_mail_messages SET acked_at = ?, expires_at = ?
       WHERE acked_at IS NULL AND recipient_endpoint_id = ? AND id IN (SELECT value FROM json_each(?))`,
      at.iso,
      expiryAfter(at.ms),
      input.endpointId,
      idsJson
    )
    const rows = deps.db.all<{ id: string; acked_at: string; expires_at: string }>(
      `SELECT m.id, m.acked_at, m.expires_at FROM agent_mail_messages m JOIN json_each(?) j ON j.value = m.id ORDER BY j.key`,
      idsJson
    )
    return { acknowledged: rows.map((row) => ({ messageId: row.id, acknowledgedAt: row.acked_at, expiresAt: row.expires_at })) }
  })
}

// --- the person's cursor -------------------------------------------------------------------------------------------

/**
 * Moves the person's seen cursor up to `throughSeq`, which must be the sequence of a retained message of this inbox
 * (one that was actually displayed), never an arbitrary future head. It only moves forward: an older value is a no-op.
 */
export function markHumanSeen(deps: AgentMailDeps, input: { endpointId: string; throughSeq: number }): { humanSeenSeq: number } {
  const throughSeq = requireSeq(input.throughSeq, 'throughSeq')
  return deps.db.tx(() => {
    const row = requireEndpoint(deps.db, input.endpointId)
    if (throughSeq <= row.human_seen_seq) {
      return { humanSeenSeq: row.human_seen_seq }
    }
    const displayed = deps.db.get(
      `SELECT 1 FROM agent_mail_messages m WHERE m.recipient_endpoint_id = ? AND m.recipient_seq = ? AND ${RETAINED}`,
      row.id,
      throughSeq,
      now(deps).iso
    )
    if (displayed === undefined) {
      fail('invalid_input', 'throughSeq must be a message this inbox still holds.', { field: 'throughSeq' })
    }
    deps.db.run('UPDATE agent_mail_endpoints SET human_seen_seq = ? WHERE id = ?', throughSeq, row.id)
    return { humanSeenSeq: throughSeq }
  })
}

/** What the person's inbox view counts. Only retained rows count; expired and purged ones never do. */
export function readHumanMailState(deps: AgentMailDeps, endpointId: string): HumanMailState {
  return deps.db.tx(() => {
    const row = requireEndpoint(deps.db, endpointId)
    const counts = deps.db.get<{ unseen: number; pending: number; retained: number }>(
      `SELECT COALESCE(SUM(m.recipient_seq > ?), 0) AS unseen, COALESCE(SUM(m.acked_at IS NULL), 0) AS pending, COUNT(*) AS retained
       FROM agent_mail_messages m WHERE m.recipient_endpoint_id = ? AND ${RETAINED}`,
      row.human_seen_seq,
      row.id,
      now(deps).iso
    )!
    return {
      humanSeenSeq: row.human_seen_seq,
      unseenCount: counts.unseen,
      pendingCount: counts.pending,
      retainedCount: counts.retained,
      retentionDays: AGENT_MAIL_LIMITS.retentionMs / DAY_MS
    }
  })
}

// --- retention -----------------------------------------------------------------------------------------------------

function pruneBatch(db: Db, at: string, limit: number): { messages: number; receipts: number } {
  const messages = db.run(
    `DELETE FROM agent_mail_messages WHERE rowid IN (
       SELECT rowid FROM agent_mail_messages WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?)`,
    at,
    limit
  ).changes
  const receipts = db.run(
    `DELETE FROM agent_mail_receipts WHERE rowid IN (
       SELECT rowid FROM agent_mail_receipts WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`,
    at,
    limit
  ).changes
  return { messages, receipts }
}

/**
 * Deletes one bounded batch of expired rows: acknowledged messages seven days after acknowledgement and send receipts
 * seven days after acceptance. Unacknowledged messages have no expiry and are never touched. Every send runs one batch;
 * expired rows that are still present are already invisible to reads and quotas.
 */
export function pruneAgentMail(deps: AgentMailDeps, input: { limit?: number } = {}): { messages: number; receipts: number } {
  const limit = pageLimit(input.limit, AGENT_MAIL_LIMITS.cleanupBatch)
  return deps.db.tx(() => pruneBatch(deps.db, now(deps).iso, limit))
}
