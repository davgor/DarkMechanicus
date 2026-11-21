/**
 * Authorized agent mail: who may act for which mailbox, on top of the repository primitives in `agentMailStore.ts`.
 *
 * An agent never names its mailbox. It is derived, inside the same transaction as the operation, from the calling
 * session's persisted `sessions.grant_id` (set only for a `dm` CLI session that redeemed a grant): that grant must be
 * usable now (not revoked, not expired, issued on this machine), bound by the desktop to an open endpoint, and bound in
 * this machine and this canonical folder. An ungranted reader, an MCP stdio session configured with a role (its
 * `grant_id` is null even when `DM_SESSION_TOKEN` is inherited) and a grant without an open binding are all refused
 * with `unauthorized`; none is given an implicit mailbox. Holding `mail.use` is necessary and never sufficient.
 *
 * Every check runs after `BEGIN IMMEDIATE` and before the store reads its clock, so a revocation, expiry or closed
 * binding that commits first is always seen: there is no window between the authority check and the write.
 *
 * Endpoint and binding management, the person's inbox view and seen cursor belong to the desktop
 * (`mail.manage`, human-only). Agents cannot register, rebind or close any mailbox, their own or a peer's.
 *
 * Nothing here logs or emits events, and no error carries a message body or a peer's name.
 */
import type {
  AcknowledgeAgentMessagesResult,
  AgentIdentityView,
  AgentInboxPage,
  AgentMailboxStatus,
  AgentMailStatusPage,
  AgentMailWindow,
  AgentMessageAcceptanceView,
  AgentPeersPage,
  HumanAgentMailStateView,
  ReadAgentInboxInput,
  SendAgentMessageInput
} from '../../shared/domain/agentMail'
import type { CommandName } from '../../shared/domain/api'
import type { GrantableRole, SessionRole } from '../../shared/domain/views'
import { type Capability, requireCapability, type SessionContext } from '../authz'
import type { Clock } from '../clock'
import type { Ctx } from '../context'
import type { Db } from '../db/database'
import { toJson } from '../db/database'
import { DomainError, fail } from '../errors'
import type { IdGenerator } from '../ids'
import {
  AGENT_MAIL_LIMITS,
  acceptMessage,
  acknowledgeMessages,
  beginEndpointDeletion,
  bindEndpoint,
  closeBinding,
  finishEndpointDeletion,
  getBinding,
  getEndpoint,
  type InboxPage,
  type MailBinding,
  type MailEndpoint,
  markHumanSeen,
  provisionEndpoint,
  readHumanMailState,
  readInbox,
  readMailStatus,
  resumeEndpoint,
  suspendEndpoint
} from './agentMailStore'
import { assertGrantUsable } from './grants'

/** The hosted roles whose grants a mailbox can be bound to. A reader observes; it has no mailbox. */
const MAILBOX_ROLES: readonly GrantableRole[] = ['planner', 'orchestrator', 'worker', 'reviewer']

/** The commands a restricted mailbox-poll session may run; anything else is refused before it is dispatched. */
export const MAIL_POLL_COMMANDS: readonly CommandName[] = ['getAgentMailStatus', 'getAgentIdentity']

/** One sentence for every reason a session has no mailbox, so probing cannot tell them apart. */
const NO_MAILBOX =
  'This session has no usable mailbox. A mailbox belongs to a dm CLI grant the desktop bound to this chat, used on this machine in this folder while the grant is current.'

/** Dedicated poll sessions pruned per step. */
const POLL_PRUNE_BATCH = 100

const POLL_SESSION_LABEL = 'dm mailbox poll'

/** What an authority check needs: the store and where this process runs. */
interface MailAuthorityDeps {
  db: Db
  clock: Clock
  machineId: string
  /** The canonical project root this session opened. */
  projectRoot: string
}

interface OwnMailbox {
  endpoint: MailEndpoint
  binding: MailBinding
}

// --- authority -----------------------------------------------------------------------------------------------------

function sessionGrantId(db: Db, sessionId: string): string | null {
  return db.get<{ grant_id: string | null }>('SELECT grant_id FROM sessions WHERE id = ?', sessionId)?.grant_id ?? null
}

/**
 * The open endpoint `grantId` is bound to here, or `unauthorized`. Call inside the transaction of the operation it
 * authorizes: the grant, binding and endpoint are all read under the same lock as the write.
 */
function requireBoundEndpoint(deps: MailAuthorityDeps, grantId: string): OwnMailbox {
  assertGrantUsable(deps, grantId)
  const binding = getBinding(deps, grantId)
  const endpoint = binding === null ? null : getEndpoint(deps, binding.endpointId)
  if (
    binding === null ||
    endpoint === null ||
    binding.closedAt !== null ||
    binding.machineId !== deps.machineId ||
    binding.canonicalFolder !== deps.projectRoot ||
    endpoint.state !== 'open' ||
    endpoint.machineId !== deps.machineId
  ) {
    fail('unauthorized', NO_MAILBOX)
  }
  return { endpoint, binding }
}

/** The caller's own mailbox, checked inside the current transaction. */
function requireMailbox(ctx: Ctx): OwnMailbox {
  requireCapability(ctx.session, 'mail.use')
  const grantId = sessionGrantId(ctx.db, ctx.session.id)
  if (grantId === null) {
    fail('unauthorized', NO_MAILBOX)
  }
  return requireBoundEndpoint(ctx, grantId)
}

/** Runs `act` for the caller's own mailbox in one transaction with its authority check. */
function asOwner<T>(ctx: Ctx, act: (mailbox: OwnMailbox) => T): T {
  return ctx.db.tx(() => act(requireMailbox(ctx)))
}

/**
 * Whether this session has a usable mailbox now, for `get_capabilities`: discovery must never promise one that is not
 * there. A probe, not an authorization: every mail operation checks again in its own transaction.
 */
export function agentMailboxStatus(ctx: Ctx): AgentMailboxStatus {
  if (!ctx.session.capabilities.has('mail.use')) {
    return { bound: false, reason: 'no_mail_capability' }
  }
  const grantId = sessionGrantId(ctx.db, ctx.session.id)
  if (grantId === null) {
    return { bound: false, reason: 'no_grant' }
  }
  try {
    return { bound: true, endpointId: requireBoundEndpoint(ctx, grantId).endpoint.id }
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === 'unauthorized') {
      return { bound: false, reason: 'unbound' }
    }
    throw error
  }
}

// --- the agent's own mailbox ---------------------------------------------------------------------------------------

function requireLimit(limit: number | undefined, max: number): number {
  const value = limit ?? max
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    fail('invalid_input', `limit must be 1 to ${max}.`, { field: 'limit', max })
  }
  return value
}

function inboxView(page: InboxPage): AgentInboxPage {
  return { messages: page.messages, snapshotHighWater: page.throughSeq, nextCursor: page.nextCursor, hasMore: page.hasMore }
}

export function getAgentIdentity(ctx: Ctx): AgentIdentityView {
  return asOwner(ctx, ({ endpoint, binding }) => ({
    endpointId: endpoint.id,
    name: endpoint.name,
    role: ctx.session.role,
    boundAt: binding.boundAt
  }))
}

/** Open mailboxes on this machine other than the caller's, in id order, a bounded page at a time. */
export function listAgentPeers(ctx: Ctx, input: { afterId?: string; limit?: number } = {}): AgentPeersPage {
  const limit = requireLimit(input.limit, AGENT_MAIL_LIMITS.endpointPageSize)
  return asOwner(ctx, ({ endpoint }) => {
    const rows = ctx.db.all<{ id: string; name: string }>(
      `SELECT id, name FROM agent_mail_endpoints
       WHERE state = 'open' AND machine_id = ? AND id <> ? AND id > ? ORDER BY id LIMIT ?`,
      ctx.machineId,
      endpoint.id,
      input.afterId ?? '',
      limit + 1
    )
    const page = rows.slice(0, limit)
    return {
      peers: page.map((row) => ({ endpointId: row.id, name: row.name })),
      nextAfterId: page.at(-1)?.id ?? null,
      hasMore: rows.length > limit
    }
  })
}

/**
 * Durably accepts a message from the caller's own mailbox. The sender is never input; a retry with the same
 * clientMessageId replays the original acceptance from the sender's own receipts (never the global idempotency table,
 * whose key has no sender), checked after this call's authority, so a revoked grant cannot replay either.
 */
export function sendAgentMessage(ctx: Ctx, input: SendAgentMessageInput): AgentMessageAcceptanceView {
  return asOwner(ctx, ({ endpoint }) =>
    acceptMessage(ctx, {
      senderEndpointId: endpoint.id,
      to: input.to,
      clientMessageId: input.clientMessageId,
      body: input.body,
      inReplyTo: input.inReplyTo ?? null
    })
  )
}

/** One ascending page of the caller's inbox with bodies, in a snapshot pinned by `throughSeq`. Never acknowledges. */
export function readAgentInbox(ctx: Ctx, input: ReadAgentInboxInput = {}): AgentInboxPage {
  return asOwner(ctx, ({ endpoint }) => inboxView(readInbox(ctx, { endpointId: endpoint.id, ...input })))
}

/** Acknowledges messages of the caller's own inbox: every id is checked as its own before anything changes. */
export function acknowledgeAgentMessages(ctx: Ctx, input: { messageIds: string[] }): AcknowledgeAgentMessagesResult {
  return asOwner(ctx, ({ endpoint }) => acknowledgeMessages(ctx, { endpointId: endpoint.id, messageIds: input.messageIds }))
}

/**
 * The pending count and one ascending page of unacknowledged metadata, without bodies. The horizon is read before the
 * page, in the same snapshot, and a later page given it as `throughSeq` never skips past an arrival it did not show.
 */
export function getAgentMailStatus(ctx: Ctx, input: AgentMailWindow = {}): AgentMailStatusPage {
  return asOwner(ctx, ({ endpoint }) => {
    const page = readMailStatus(ctx, { endpointId: endpoint.id, ...input })
    return {
      pendingCount: page.pendingCount,
      messages: page.messages,
      snapshotHighWater: page.throughSeq,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore
    }
  })
}


// --- dedicated poll sessions ---------------------------------------------------------------------------------------

interface PollSessionDeps extends MailAuthorityDeps {
  ids: IdGenerator
}

interface PollGrant {
  grantId: string
  role: SessionRole
  capabilities: readonly Capability[]
}

/** What a dedicated poll session may do: run the poll commands for its own mailbox, nothing else. */
const POLL_CAPABILITIES: readonly Capability[] = ['mail.use']

/**
 * The one dedicated session a (endpoint, grant) pair's restricted status/wake polls share, created on its first poll.
 * Mapped and re-checked under one write lock, so concurrent first polls from several processes still create one row.
 * Its `started_at` never changes; `touchMailPollSession` moves `last_seen_at` after each successful poll, and the usual
 * stale-session window decides whether it counts as active. No activity ever references it. Retired poll sessions are
 * pruned when a new one is created and on every desktop mailbox change, never on the hot path of an existing one.
 */
export function openMailPollSession(deps: PollSessionDeps, grant: PollGrant): SessionContext {
  if (!grant.capabilities.includes('mail.use')) {
    fail('unauthorized', NO_MAILBOX)
  }
  return deps.db.tx(() => {
    const { endpoint } = requireBoundEndpoint(deps, grant.grantId)
    const mapped = deps.db.get<{ session_id: string }>(
      'SELECT session_id FROM agent_mail_poll_sessions WHERE endpoint_id = ? AND grant_id = ?',
      endpoint.id,
      grant.grantId
    )
    const id = mapped?.session_id ?? createPollSession(deps, { ...grant, endpointId: endpoint.id })
    return { id, role: grant.role, label: POLL_SESSION_LABEL, capabilities: new Set(POLL_CAPABILITIES) }
  })
}

/** Retires a batch of stale poll sessions, then creates this binding's own. */
function createPollSession(deps: PollSessionDeps, grant: PollGrant & { endpointId: string }): string {
  prunePollSessionBatch(deps)
  const id = deps.ids.next('session')
  const at = deps.clock.nowIso()
  deps.db.run(
    `INSERT INTO sessions (id, role, label, capabilities_json, transport, pid, grant_id, started_at, last_seen_at)
     VALUES (?, ?, ?, ?, 'cli', NULL, ?, ?, ?)`,
    id,
    grant.role,
    POLL_SESSION_LABEL,
    toJson(POLL_CAPABILITIES),
    grant.grantId,
    at,
    at
  )
  deps.db.run('INSERT INTO agent_mail_poll_sessions (endpoint_id, grant_id, session_id) VALUES (?, ?, ?)', grant.endpointId, grant.grantId, id)
  return id
}

/** Marks a dedicated poll session seen after a successful poll. Never ends it: the next poll reuses it. */
export function touchMailPollSession(deps: { db: Db; clock: Clock }, sessionId: string): void {
  deps.db.tx(() => {
    deps.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ? AND ended_at IS NULL', deps.clock.nowIso(), sessionId)
  })
}

/** True when any record names the session as its actor; such a session is ended, never deleted. */
function referencedByActivity(db: Db, sessionId: string): boolean {
  return (
    db.get(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM events WHERE session_id = ?1)
         OR EXISTS (SELECT 1 FROM runs WHERE orchestrator_session_id = ?1)
         OR EXISTS (SELECT 1 FROM transfers WHERE session_id = ?1)
         OR EXISTS (SELECT 1 FROM grants WHERE issued_by_session = ?1)
         OR EXISTS (SELECT 1 FROM drafts WHERE updated_by = ?1)`,
      sessionId
    ) !== undefined
  )
}

/**
 * Retires one bounded batch of dedicated poll sessions whose grant is revoked, expired or foreign, whose binding is
 * closed, or whose endpoint is no longer open. Only sessions in the poll mapping are ever touched, never an ordinary
 * session; one with no activity references is deleted, any other is ended. Runs inside the caller's transaction.
 */
function prunePollSessionBatch(deps: { db: Db; clock: Clock; machineId: string }): { removed: number; ended: number } {
  const now = deps.clock.nowIso()
  const stale = deps.db.all<{ session_id: string; endpoint_id: string; grant_id: string }>(
    `SELECT p.session_id, p.endpoint_id, p.grant_id FROM agent_mail_poll_sessions p
     LEFT JOIN grants g ON g.id = p.grant_id
     LEFT JOIN agent_mail_bindings b ON b.grant_id = p.grant_id
     LEFT JOIN agent_mail_endpoints e ON e.id = p.endpoint_id
     WHERE g.id IS NULL OR g.revoked_at IS NOT NULL OR g.expires_at <= ? OR g.machine_id <> ?
        OR b.grant_id IS NULL OR b.closed_at IS NOT NULL OR b.endpoint_id <> p.endpoint_id
        OR e.id IS NULL OR e.state <> 'open'
     ORDER BY p.session_id LIMIT ?`,
    now,
    deps.machineId,
    POLL_PRUNE_BATCH
  )
  let removed = 0
  let ended = 0
  for (const row of stale) {
    deps.db.run('DELETE FROM agent_mail_poll_sessions WHERE endpoint_id = ? AND grant_id = ?', row.endpoint_id, row.grant_id)
    if (referencedByActivity(deps.db, row.session_id)) {
      deps.db.run('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL', now, row.session_id)
      ended += 1
    } else {
      deps.db.run('DELETE FROM sessions WHERE id = ?', row.session_id)
      removed += 1
    }
  }
  return { removed, ended }
}

// --- the desktop: endpoints and bindings ---------------------------------------------------------------------------

function requireManager(ctx: Ctx): void {
  requireCapability(ctx.session, 'mail.manage')
}

/** An endpoint of this machine; another machine's (or none) is `not_found`. */
function requireLocalEndpoint(ctx: Ctx, endpointId: string): MailEndpoint {
  const endpoint = getEndpoint(ctx, endpointId)
  if (endpoint === null || endpoint.machineId !== ctx.machineId) {
    fail('not_found', 'No such mail endpoint on this machine.', { endpointId })
  }
  return endpoint
}

/** Desktop: the mailbox for a trusted chat id of this machine, created on first use (`provisionEndpoint`). */
export function provisionAgentMailEndpoint(ctx: Ctx, input: { chatId: string; name: string }): MailEndpoint {
  requireManager(ctx)
  return provisionEndpoint(ctx, { machineId: ctx.machineId, chatId: input.chatId, name: input.name })
}

/** Desktop: sets an endpoint's display name (the chat's title). A deleted mailbox stays as it is. */
export function renameAgentMailEndpoint(ctx: Ctx, input: { endpointId: string; name: string }): MailEndpoint {
  requireManager(ctx)
  return ctx.db.tx(() => {
    const endpoint = requireLocalEndpoint(ctx, input.endpointId)
    return provisionEndpoint(ctx, { machineId: endpoint.machineId, chatId: endpoint.chatId, name: input.name })
  })
}

/**
 * Desktop: binds a current grant of a hosted role, issued on this machine, to an open endpoint of this machine, in
 * this folder. The endpoint's previous binding closes for good; a grant binds once and a closed binding never reopens,
 * so rebinding a chat always takes a fresh grant.
 */
export function bindAgentMailEndpoint(ctx: Ctx, input: { endpointId: string; grantId: string }): MailBinding {
  requireManager(ctx)
  return ctx.db.tx(() => {
    requireLocalEndpoint(ctx, input.endpointId)
    assertGrantUsable(ctx, input.grantId)
    const role = ctx.db.get<{ role: GrantableRole }>('SELECT role FROM grants WHERE id = ?', input.grantId)?.role
    if (role === undefined || !MAILBOX_ROLES.includes(role)) {
      fail('invalid_input', 'Only a planner, orchestrator, worker or reviewer grant can be bound to a mailbox.', { grantId: input.grantId })
    }
    const binding = bindEndpoint(ctx, {
      endpointId: input.endpointId,
      grantId: input.grantId,
      machineId: ctx.machineId,
      canonicalFolder: ctx.projectRoot
    })
    prunePollSessionBatch(ctx)
    return binding
  })
}

/** Desktop: closes a grant's binding for good (its chat ended or its grant was revoked). Unknown or closed: no-op. */
export function closeAgentMailBinding(ctx: Ctx, input: { grantId: string }): MailBinding | null {
  requireManager(ctx)
  return ctx.db.tx(() => {
    const binding = closeBinding(ctx, input.grantId)
    prunePollSessionBatch(ctx)
    return binding
  })
}

/** Desktop: reversibly stops an endpoint (an untracked folder); its binding closes for good, its mail stays. */
export function suspendAgentMailEndpoint(ctx: Ctx, input: { endpointId: string }): MailEndpoint {
  requireManager(ctx)
  return ctx.db.tx(() => {
    requireLocalEndpoint(ctx, input.endpointId)
    const endpoint = suspendEndpoint(ctx, input.endpointId)
    prunePollSessionBatch(ctx)
    return endpoint
  })
}

/** Desktop: reopens a suspended endpoint. No old binding comes back; the chat needs a fresh grant bound. */
export function resumeAgentMailEndpoint(ctx: Ctx, input: { endpointId: string }): MailEndpoint {
  requireManager(ctx)
  return ctx.db.tx(() => {
    requireLocalEndpoint(ctx, input.endpointId)
    return resumeEndpoint(ctx, input.endpointId)
  })
}

/**
 * Desktop: irreversibly deletes a chat's mailbox, one bounded purge batch per call; call until `done`. Mail it sent
 * stays with its recipients, and its send receipts stay until they expire.
 */
export function deleteAgentMailEndpoint(
  ctx: Ctx,
  input: { endpointId: string }
): { endpoint: MailEndpoint; purged: number; done: boolean } {
  requireManager(ctx)
  return ctx.db.tx(() => {
    requireLocalEndpoint(ctx, input.endpointId)
    beginEndpointDeletion(ctx, input.endpointId)
    const result = finishEndpointDeletion(ctx, input.endpointId)
    prunePollSessionBatch(ctx)
    return result
  })
}

/** Desktop maintenance: retires one batch (at most 100) of dedicated poll sessions that can no longer poll. */
export function pruneAgentMailPollSessions(ctx: Ctx): { removed: number; ended: number } {
  requireManager(ctx)
  return ctx.db.tx(() => prunePollSessionBatch(ctx))
}

// --- the desktop: the person's inbox and seen cursor ---------------------------------------------------------------

/** Desktop: one page of a mailbox with bodies, for the person. Reading neither acknowledges nor marks seen. */
export function readHumanAgentInbox(ctx: Ctx, input: { endpointId: string } & ReadAgentInboxInput): AgentInboxPage {
  requireManager(ctx)
  return ctx.db.tx(() => {
    requireLocalEndpoint(ctx, input.endpointId)
    return inboxView(readInbox(ctx, input))
  })
}

/**
 * Desktop: moves the person's seen cursor forward to a message they were shown (`throughSeq` must be a retained
 * message's sequence from an inbox page actually served, never a status head). Agent acknowledgement is unaffected.
 */
export function markHumanAgentMailSeen(ctx: Ctx, input: { endpointId: string; throughSeq: number }): { humanSeenSeq: number } {
  requireManager(ctx)
  return ctx.db.tx(() => {
    requireLocalEndpoint(ctx, input.endpointId)
    return markHumanSeen(ctx, input)
  })
}


/** Desktop: the person's retained, unseen and unacknowledged mailbox counts. */
export function getHumanAgentMailState(ctx: Ctx, input: { endpointId: string }): HumanAgentMailStateView {
  requireManager(ctx)
  return ctx.db.tx(() => {
    requireLocalEndpoint(ctx, input.endpointId)
    return { endpointId: input.endpointId, ...readHumanMailState(ctx, input.endpointId) }
  })
}

