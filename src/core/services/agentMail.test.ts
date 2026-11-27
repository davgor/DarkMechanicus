/**
 * Authorized agent mail over the real store and SQLite: a mailbox is always the one the calling session's own
 * desktop-bound grant speaks for, checked in the same transaction as the operation.
 */
import { describe, expect, it } from 'vitest'
import type { GrantableRole } from '../../shared/domain/views'
import { domainErrorOf } from '../../test/repoFixtures'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import type { Ctx } from '../context'
import { isStableId } from '../ids'
import {
  acknowledgeAgentMessages,
  agentMailboxStatus,
  bindAgentMailEndpoint,
  closeAgentMailBinding,
  deleteAgentMailEndpoint,
  getAgentIdentity,
  getAgentMailStatus,
  getHumanAgentMailState,
  listAgentPeers,
  markHumanAgentMailSeen,
  openMailPollSession,
  provisionAgentMailEndpoint,
  pruneAgentMailPollSessions,
  readAgentInbox,
  readHumanAgentConversation,
  readHumanAgentInbox,
  renameAgentMailEndpoint,
  resumeAgentMailEndpoint,
  sendAgentMessage,
  suspendAgentMailEndpoint
} from './agentMail'
import { AGENT_MAIL_LIMITS, type MailEndpoint } from './agentMailStore'
import { grantedCapabilities, issueGrant, revokeGrant } from './grants'
import { registerSession } from './sessions'

interface Chat {
  ctx: Ctx
  endpoint: MailEndpoint
  grantId: string
}

function desktopCtx(): TestCtx {
  return createTestCtx({ role: 'desktop', sessionId: 'ss_desktop00000000000000000000' })
}

/** A `dm` CLI session on a fresh grant of `role`, as the workspace registers one after redeeming its token. */
function grantedSession(desktop: TestCtx, role: GrantableRole = 'worker', minutes?: number): { ctx: Ctx; grantId: string } {
  const { grant } = issueGrant(desktop, { role, label: `${role} chat`, ...(minutes === undefined ? {} : { minutes }) })
  const session = registerSession(desktop, {
    role,
    label: 'dm CLI',
    transport: 'cli',
    pid: null,
    capabilities: grantedCapabilities(role, false),
    grantId: grant.id
  })
  return { ctx: { ...desktop, session }, grantId: grant.id }
}

/** A chat the desktop provisioned and bound: its mailbox, and a CLI session on its grant. */
function boundChat(desktop: TestCtx, chatId: string, role: GrantableRole = 'worker'): Chat {
  const endpoint = provisionAgentMailEndpoint(desktop, { chatId, name: `Chat ${chatId}` })
  const { ctx, grantId } = grantedSession(desktop, role)
  bindAgentMailEndpoint(desktop, { endpointId: endpoint.id, grantId })
  return { ctx, endpoint, grantId }
}

function world(): { desktop: TestCtx; a: Chat; b: Chat; c: Chat } {
  const desktop = desktopCtx()
  return { desktop, a: boundChat(desktop, 'chat-a'), b: boundChat(desktop, 'chat-b', 'reviewer'), c: boundChat(desktop, 'chat-c', 'planner') }
}

function send(from: Chat, to: Chat, clientMessageId: string, body = 'hello') {
  return sendAgentMessage(from.ctx, { to: to.endpoint.id, clientMessageId, body })
}

/** Replies `answer` to `inReplyTo`. */
function reply(from: Chat, to: Chat, clientMessageId: string, inReplyTo: string) {
  return sendAgentMessage(from.ctx, { to: to.endpoint.id, clientMessageId, body: 'answer', inReplyTo })
}

function pending(chat: Chat): number {
  return getAgentMailStatus(chat.ctx).pendingCount
}

describe('two bound chats exchange mail', () => {
  it('sends, reads with bodies, acknowledges explicitly, and reading never acknowledges', () => {
    const { a, b } = world()
    const accepted = send(a, b, 'first', 'Can you review DM-1?')
    expect(accepted).toMatchObject({ to: b.endpoint.id, clientMessageId: 'first', inReplyTo: null, duplicate: false })
    expect(isStableId(accepted.messageId, 'mailMessage')).toBe(true)

    const inbox = readAgentInbox(b.ctx)
    expect(inbox).toMatchObject({ snapshotHighWater: 1, nextCursor: 1, hasMore: false })
    expect(inbox.messages).toEqual([
      expect.objectContaining({
        id: accepted.messageId,
        seq: 1,
        body: 'Can you review DM-1?',
        from: { endpointId: a.endpoint.id, name: 'Chat chat-a', deleted: false },
        acceptedAt: accepted.acceptedAt,
        acknowledgedAt: null
      })
    ])
    readAgentInbox(b.ctx)
    expect(pending(b)).toBe(1)

    const acked = acknowledgeAgentMessages(b.ctx, { messageIds: [accepted.messageId] })
    expect(acked.acknowledged).toEqual([{ messageId: accepted.messageId, acknowledgedAt: expect.any(String), expiresAt: expect.any(String) }])
    expect(pending(b)).toBe(0)
    expect(acknowledgeAgentMessages(b.ctx, { messageIds: [accepted.messageId] })).toEqual(acked)
    expect(readAgentInbox(b.ctx).messages[0]?.acknowledgedAt).toBe(acked.acknowledged[0]?.acknowledgedAt)
  })

  it('derives identity from the session grant, and lists peers by id, title and trusted metadata, never itself', () => {
    const { a, b, c } = world()
    expect(getAgentIdentity(a.ctx)).toEqual({ endpointId: a.endpoint.id, name: 'Chat chat-a', role: 'worker', boundAt: expect.any(String) })
    expect(getAgentIdentity(b.ctx)).toMatchObject({ endpointId: b.endpoint.id, role: 'reviewer' })
    const peers = listAgentPeers(a.ctx)
    expect(peers).toEqual({
      peers: [
        { endpointId: b.endpoint.id, name: 'Chat chat-b', epicId: null, role: null },
        { endpointId: c.endpoint.id, name: 'Chat chat-c', epicId: null, role: null }
      ],
      nextAfterId: c.endpoint.id,
      hasMore: false
    })
    const first = listAgentPeers(a.ctx, { limit: 1 })
    expect(first).toEqual({ peers: [{ endpointId: b.endpoint.id, name: 'Chat chat-b', epicId: null, role: null }], nextAfterId: b.endpoint.id, hasMore: true })
    expect(listAgentPeers(a.ctx, { afterId: b.endpoint.id, limit: 1 }).peers).toEqual([
      { endpointId: c.endpoint.id, name: 'Chat chat-c', epicId: null, role: null }
    ])
  })
})

const E = 'ep_epic0000000000000000000000e'
const F = 'ep_epic0000000000000000000000f'

/** A chat the desktop provisioned with its chat record's epic and role, bound to a grant of `role`. */
function epicChat(desktop: TestCtx, chatId: string, role: 'planner' | 'orchestrator' | 'worker', epicId: string | null): Chat {
  const endpoint = provisionAgentMailEndpoint(desktop, { chatId, name: `Chat ${chatId}`, epicId, chatRole: role })
  const { ctx, grantId } = grantedSession(desktop, role)
  bindAgentMailEndpoint(desktop, { endpointId: endpoint.id, grantId })
  return { ctx, endpoint, grantId }
}

/** Epic E's Lexmechanic and Magos, a planner bound to no epic, and epic F's planner. */
function epicWorld() {
  const desktop = desktopCtx()
  return {
    desktop,
    planner: epicChat(desktop, 'lexmechanic', 'planner', E),
    magos: epicChat(desktop, 'magos', 'orchestrator', E),
    unbound: epicChat(desktop, 'loose', 'planner', null),
    otherPlanner: epicChat(desktop, 'other-lexmechanic', 'planner', F)
  }
}

describe('trusted epic and role of peers: listing and filters', () => {
  it("lists the epic's planner for {epicId: E, role: 'planner'}, and nothing else", () => {
    const { magos, planner } = epicWorld()
    expect(listAgentPeers(magos.ctx, { epicId: E, role: 'planner' })).toEqual({
      peers: [{ endpointId: planner.endpoint.id, name: 'Chat lexmechanic', epicId: E, role: 'planner' }],
      nextAfterId: planner.endpoint.id,
      hasMore: false
    })
  })

  it('filters by epic alone and by role alone; a peer with no recorded value never matches', () => {
    const { magos, planner, unbound, otherPlanner } = epicWorld()
    expect(listAgentPeers(planner.ctx, { epicId: E }).peers).toEqual([
      { endpointId: magos.endpoint.id, name: 'Chat magos', epicId: E, role: 'orchestrator' }
    ])
    const planners = listAgentPeers(magos.ctx, { role: 'planner' }).peers.map((peer) => peer.endpointId)
    expect(planners.sort()).toEqual([planner.endpoint.id, unbound.endpoint.id, otherPlanner.endpoint.id].sort())
    expect(listAgentPeers(magos.ctx, { epicId: F, role: 'orchestrator' }).peers).toEqual([])
    expect(listAgentPeers(magos.ctx, { epicId: 'ep_missing00000000000000000000' }).peers).toEqual([])
  })

  it('pages through filtered peers with afterId', () => {
    const { magos, planner, unbound, otherPlanner } = epicWorld()
    const ids = [planner.endpoint.id, unbound.endpoint.id, otherPlanner.endpoint.id].sort()
    const first = listAgentPeers(magos.ctx, { role: 'planner', limit: 2 })
    expect(first.peers.map((peer) => peer.endpointId)).toEqual(ids.slice(0, 2))
    expect(first.hasMore).toBe(true)
    const second = listAgentPeers(magos.ctx, { role: 'planner', limit: 2, afterId: first.nextAfterId ?? '' })
    expect(second.peers.map((peer) => peer.endpointId)).toEqual(ids.slice(2))
    expect(second.hasMore).toBe(false)
  })
})

describe('trusted epic and role of peers: only main sets them', () => {
  it('a rename changes the name, never the epic or role; only main refreshes them, from the chat record', () => {
    const { desktop, magos, planner } = epicWorld()
    expect(renameAgentMailEndpoint(desktop, { endpointId: planner.endpoint.id, name: 'Renamed' })).toMatchObject({
      name: 'Renamed',
      epicId: E,
      chatRole: 'planner'
    })
    expect(listAgentPeers(magos.ctx, { epicId: E, role: 'planner' }).peers).toEqual([
      { endpointId: planner.endpoint.id, name: 'Renamed', epicId: E, role: 'planner' }
    ])
    // Provisioning the same chat again (a binding or a listing) records the chat record's values.
    expect(provisionAgentMailEndpoint(desktop, { chatId: 'lexmechanic', name: 'Renamed', epicId: F, chatRole: 'planner' })).toMatchObject({
      id: planner.endpoint.id,
      epicId: F
    })
    expect(listAgentPeers(magos.ctx, { epicId: E, role: 'planner' }).peers).toEqual([])
  })

  it('the caller cannot set them: only the desktop provisions or renames, and a grant role never becomes the chat role', () => {
    const { desktop, magos, planner } = epicWorld()
    expect(domainErrorOf(() => provisionAgentMailEndpoint(magos.ctx, { chatId: 'magos', name: 'x', epicId: F, chatRole: 'planner' })).code).toBe('unauthorized')
    expect(domainErrorOf(() => renameAgentMailEndpoint(magos.ctx, { endpointId: magos.endpoint.id, name: 'x', epicId: F, chatRole: 'planner' })).code).toBe(
      'unauthorized'
    )
    expect(listAgentPeers(planner.ctx, { epicId: E }).peers).toEqual([
      { endpointId: magos.endpoint.id, name: 'Chat magos', epicId: E, role: 'orchestrator' }
    ])
    // A chat provisioned without a record's role lists none, whatever role its grant carries.
    const bare = boundChat(desktop, 'bare', 'orchestrator')
    expect(listAgentPeers(magos.ctx).peers).toContainEqual({ endpointId: bare.endpoint.id, name: 'Chat bare', epicId: null, role: null })
    expect(domainErrorOf(() => provisionAgentMailEndpoint(desktop, { chatId: 'odd', name: 'x', chatRole: 'desktop' as never })).code).toBe('invalid_input')
  })
})

describe('every hosted role', () => {
  it('serves every hosted role its own mailbox', () => {
    const desktop = desktopCtx()
    for (const role of ['planner', 'orchestrator', 'worker', 'reviewer'] as const) {
      const chat = boundChat(desktop, `chat-${role}`, role)
      expect(getAgentIdentity(chat.ctx)).toMatchObject({ endpointId: chat.endpoint.id, role })
    }
  })
})

describe('the sender is never input', () => {
  it('scopes client message ids by sender: the same id from two senders is two messages', () => {
    const { a, b, c } = world()
    const fromA = send(a, b, 'same-id', 'from a')
    const fromC = send(c, b, 'same-id', 'from c')
    expect(fromC.messageId).not.toBe(fromA.messageId)
    expect(fromC.duplicate).toBe(false)
    expect(readAgentInbox(b.ctx).messages.map((message) => [message.from.endpointId, message.body])).toEqual([
      [a.endpoint.id, 'from a'],
      [c.endpoint.id, 'from c']
    ])
    expect(send(a, b, 'same-id', 'from a')).toEqual({ ...fromA, duplicate: true })
    expect(domainErrorOf(() => send(a, b, 'same-id', 'changed')).code).toBe('idempotency_mismatch')
  })

  it('ignores a spoofed sender smuggled past the types: the message is still from the caller', () => {
    const { a, b, c } = world()
    const spoof = { to: b.endpoint.id, clientMessageId: 'spoof', body: 'trust me', senderEndpointId: c.endpoint.id, from: c.endpoint.id }
    sendAgentMessage(a.ctx, spoof as never)
    expect(readAgentInbox(b.ctx).messages[0]?.from.endpointId).toBe(a.endpoint.id)
  })
})

describe('nobody reads or changes another mailbox', () => {
  it('reads only the caller’s own inbox', () => {
    const { a, b, c } = world()
    send(a, b, 'private', 'for b only')
    expect(readAgentInbox(c.ctx).messages).toEqual([])
    expect(getAgentMailStatus(c.ctx)).toMatchObject({ pendingCount: 0, messages: [] })
  })

  it('refuses a foreign or mixed acknowledgement as a whole, changing nothing', () => {
    const { a, b, c } = world()
    const toB = send(a, b, 'to-b')
    const toC = send(a, c, 'to-c')
    const mixed = domainErrorOf(() => acknowledgeAgentMessages(b.ctx, { messageIds: [toB.messageId, toC.messageId] }))
    expect(mixed.code).toBe('not_found')
    expect(pending(b)).toBe(1)
    expect(pending(c)).toBe(1)
    expect(domainErrorOf(() => acknowledgeAgentMessages(c.ctx, { messageIds: [toB.messageId] })).code).toBe('not_found')
    expect(pending(b)).toBe(1)
    // Positive control: each acknowledges its own.
    acknowledgeAgentMessages(b.ctx, { messageIds: [toB.messageId] })
    expect(pending(b)).toBe(0)
  })
})

describe('correlated replies', () => {
  it('answers a message the recipient sent, and refuses unrelated replies without revealing other mail', () => {
    const { a, b, c } = world()
    const question = send(a, b, 'q')
    const toC = send(a, c, 'c-only')
    const answer = reply(b, a, 'r', question.messageId)
    expect(answer.inReplyTo).toBe(question.messageId)
    expect(readAgentInbox(a.ctx).messages[0]).toMatchObject({ inReplyTo: question.messageId, body: 'answer' })

    // Same parent, wrong peer: a reply goes back to the parent's sender.
    expect(domainErrorOf(() => reply(b, c, 'r2', question.messageId)).code).toBe('invalid_input')
    // A message in someone else's inbox, a message the caller sent, and an id that never existed all look the same.
    const foreign = domainErrorOf(() => reply(b, a, 'r3', toC.messageId))
    const own = domainErrorOf(() => reply(a, b, 'r4', question.messageId))
    const unknown = domainErrorOf(() => reply(b, a, 'r5', 'mm_0000000000000000000000zzzz'))
    expect([foreign.code, own.code, unknown.code]).toEqual(['reply_unavailable', 'reply_unavailable', 'reply_unavailable'])
    expect(foreign.message).toBe(unknown.message)
  })
})

describe('authority is the current bound grant', () => {
  it('refuses a session without a grant, a reader, and a grant the desktop never bound', () => {
    const desktop = desktopCtx()
    const peer = boundChat(desktop, 'peer')
    const ungranted = { ...desktop, session: registerSession(desktop, { role: 'worker', label: 'stdio', transport: 'stdio', pid: null, capabilities: grantedCapabilities('worker', false) }) }
    const reader = grantedSession(desktop, 'reader')
    const unbound = grantedSession(desktop, 'orchestrator')
    for (const ctx of [ungranted, reader.ctx, unbound.ctx]) {
      expect(domainErrorOf(() => getAgentIdentity(ctx)).code).toBe('unauthorized')
      expect(domainErrorOf(() => sendAgentMessage(ctx, { to: peer.endpoint.id, clientMessageId: 'x', body: 'x' })).code).toBe('unauthorized')
      expect(domainErrorOf(() => readAgentInbox(ctx)).code).toBe('unauthorized')
    }
    expect(agentMailboxStatus(ungranted)).toEqual({ bound: false, reason: 'no_grant' })
    expect(agentMailboxStatus(reader.ctx)).toEqual({ bound: false, reason: 'no_mail_capability' })
    expect(agentMailboxStatus(unbound.ctx)).toEqual({ bound: false, reason: 'unbound' })
    expect(agentMailboxStatus(peer.ctx)).toEqual({ bound: true, endpointId: peer.endpoint.id })
    expect(agentMailboxStatus(desktop)).toEqual({ bound: false, reason: 'no_mail_capability' })
  })

  it('refuses a binding used from another folder or another machine', () => {
    const { a, b } = world()
    expect(send(a, b, 'here').duplicate).toBe(false)
    const otherFolder = { ...a.ctx, projectRoot: '/projects/copy-of-test' }
    const otherMachine = { ...a.ctx, machineId: 'mc_0000000000000000000000other' }
    for (const ctx of [otherFolder, otherMachine]) {
      expect(domainErrorOf(() => sendAgentMessage(ctx, { to: b.endpoint.id, clientMessageId: 'away', body: 'x' })).code).toBe('unauthorized')
      expect(domainErrorOf(() => getAgentMailStatus(ctx)).code).toBe('unauthorized')
    }
  })
})

describe('authority ends with the grant or its binding', () => {
  it('stops at once on revocation, expiry and a closed binding, and a resumed mailbox needs a fresh grant', () => {
    const desktop = desktopCtx()
    const b = boundChat(desktop, 'chat-b')
    const revoked = boundChat(desktop, 'chat-r')
    expect(send(revoked, b, 'before').duplicate).toBe(false)
    revokeGrant(desktop, revoked.grantId)
    expect(domainErrorOf(() => send(revoked, b, 'before')).code).toBe('unauthorized')

    const endpoint = provisionAgentMailEndpoint(desktop, { chatId: 'chat-e', name: 'Expiring' })
    const expiring = grantedSession(desktop, 'worker', 5)
    bindAgentMailEndpoint(desktop, { endpointId: endpoint.id, grantId: expiring.grantId })
    expect(getAgentIdentity(expiring.ctx).endpointId).toBe(endpoint.id)
    desktop.clock.advanceSeconds(6 * 60)
    expect(domainErrorOf(() => getAgentIdentity(expiring.ctx)).code).toBe('unauthorized')

    const closing = boundChat(desktop, 'chat-x')
    closeAgentMailBinding(desktop, { grantId: closing.grantId })
    expect(domainErrorOf(() => send(closing, b, 'after-close')).code).toBe('unauthorized')

    const suspended = boundChat(desktop, 'chat-s')
    suspendAgentMailEndpoint(desktop, { endpointId: suspended.endpoint.id })
    expect(domainErrorOf(() => getAgentIdentity(suspended.ctx)).code).toBe('unauthorized')
    resumeAgentMailEndpoint(desktop, { endpointId: suspended.endpoint.id })
    expect(domainErrorOf(() => getAgentIdentity(suspended.ctx)).code).toBe('unauthorized')
    const fresh = grantedSession(desktop, 'worker')
    bindAgentMailEndpoint(desktop, { endpointId: suspended.endpoint.id, grantId: fresh.grantId })
    expect(getAgentIdentity(fresh.ctx).endpointId).toBe(suspended.endpoint.id)
    expect(domainErrorOf(() => bindAgentMailEndpoint(desktop, { endpointId: suspended.endpoint.id, grantId: suspended.grantId })).code).toBe('conflict')
  })
})

describe('only the desktop manages mailboxes', () => {
  it('binds only a current hosted-role grant of this machine to a mailbox of this machine', () => {
    const desktop = desktopCtx()
    const endpoint = provisionAgentMailEndpoint(desktop, { chatId: 'chat', name: 'Chat' })
    const reader = grantedSession(desktop, 'reader')
    expect(domainErrorOf(() => bindAgentMailEndpoint(desktop, { endpointId: endpoint.id, grantId: reader.grantId })).code).toBe('invalid_input')
    const revoked = grantedSession(desktop, 'worker')
    revokeGrant(desktop, revoked.grantId)
    expect(domainErrorOf(() => bindAgentMailEndpoint(desktop, { endpointId: endpoint.id, grantId: revoked.grantId })).code).toBe('unauthorized')
    const elsewhere = { ...desktop, machineId: 'mc_0000000000000000000000other' }
    const worker = grantedSession(desktop, 'worker')
    expect(domainErrorOf(() => bindAgentMailEndpoint(elsewhere, { endpointId: endpoint.id, grantId: worker.grantId })).code).toBe('not_found')
    expect(bindAgentMailEndpoint(desktop, { endpointId: endpoint.id, grantId: worker.grantId })).toMatchObject({
      endpointId: endpoint.id,
      canonicalFolder: desktop.projectRoot,
      machineId: desktop.machineId
    })
  })

  it('keeps every management and human-inbox operation from agents', () => {
    const { desktop, a, b } = world()
    const own = { endpointId: a.endpoint.id }
    const attempts: (() => unknown)[] = [
      () => provisionAgentMailEndpoint(a.ctx, { chatId: 'self', name: 'Self' }),
      () => bindAgentMailEndpoint(a.ctx, { endpointId: b.endpoint.id, grantId: a.grantId }),
      () => renameAgentMailEndpoint(a.ctx, { ...own, name: 'Renamed' }),
      () => closeAgentMailBinding(a.ctx, { grantId: b.grantId }),
      () => suspendAgentMailEndpoint(a.ctx, { endpointId: b.endpoint.id }),
      () => resumeAgentMailEndpoint(a.ctx, own),
      () => deleteAgentMailEndpoint(a.ctx, { endpointId: b.endpoint.id }),
      () => readHumanAgentInbox(a.ctx, { endpointId: b.endpoint.id }),
      () => readHumanAgentConversation(a.ctx, { endpointId: b.endpoint.id }),
      () => markHumanAgentMailSeen(a.ctx, { ...own, throughSeq: 0 }),
      () => getHumanAgentMailState(a.ctx, own),
      () => pruneAgentMailPollSessions(a.ctx)
    ]
    for (const attempt of attempts) {
      expect(domainErrorOf(attempt).code).toBe('unauthorized')
    }
    expect(getAgentIdentity(b.ctx).endpointId).toBe(b.endpoint.id)
    // Positive control: the desktop holds the authority.
    expect(renameAgentMailEndpoint(desktop, { ...own, name: 'Renamed' }).name).toBe('Renamed')
  })
})

describe('quotas, at their exact edges', () => {
  it('accepts the 1024th pending message, refuses the next, and admits one again after an acknowledgement', () => {
    const { a, b } = world()
    const ids: string[] = []
    for (let index = 1; index <= AGENT_MAIL_LIMITS.pendingPerRecipient; index += 1) {
      ids.push(send(a, b, `m-${index}`).messageId)
    }
    expect(pending(b)).toBe(AGENT_MAIL_LIMITS.pendingPerRecipient)
    const full = domainErrorOf(() => send(a, b, 'overflow', 'secret overflow body'))
    expect(full.code).toBe('mailbox_full')
    expect(JSON.stringify(full)).not.toContain('secret overflow body')
    expect(JSON.stringify(full)).not.toContain('Chat chat-')
    acknowledgeAgentMessages(b.ctx, { messageIds: [ids[0] ?? ''] })
    expect(send(a, b, 'overflow', 'secret overflow body').duplicate).toBe(false)
  })

  it('holds 8192 receipts per sender: the last is accepted, the next refused, and an old retry still replays', () => {
    const { desktop, a, b, c } = world()
    const first = send(a, b, 'kept')
    const filler = AGENT_MAIL_LIMITS.receiptsPerSender - 2
    desktop.db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO agent_mail_receipts (sender_endpoint_id, client_message_id, payload_hash, result_json, accepted_at, expires_at)
       SELECT ?, 'filler-' || i, 'h', '{}', ?, ? FROM n`,
      filler,
      a.endpoint.id,
      first.acceptedAt,
      '2999-01-01T00:00:00.000Z'
    )
    expect(send(a, c, 'last').duplicate).toBe(false)
    expect(domainErrorOf(() => send(a, c, 'one-too-many')).code).toBe('receipt_quota_full')
    expect(send(a, b, 'kept')).toEqual({ ...first, duplicate: true })
    // Another sender's quota is its own.
    expect(send(c, b, 'one-too-many').duplicate).toBe(false)
  })
})

describe('receipts and cursors recover', () => {
  it('replays a receipt after its recipient was deleted, and accepts nothing new for it', () => {
    const { desktop, a, b } = world()
    const accepted = send(a, b, 'before-delete')
    let done = false
    while (!done) {
      done = deleteAgentMailEndpoint(desktop, { endpointId: b.endpoint.id }).done
    }
    expect(send(a, b, 'before-delete')).toEqual({ ...accepted, duplicate: true })
    expect(domainErrorOf(() => send(a, b, 'after-delete')).code).toBe('not_found')
    expect(domainErrorOf(() => getAgentIdentity(b.ctx)).code).toBe('unauthorized')
  })
})

describe('cursors page on a pinned horizon', () => {
  it('pages past more than 50 old unacknowledged messages on a pinned horizon, so later mail is never starved', () => {
    const { a, b } = world()
    for (let index = 1; index <= 60; index += 1) {
      send(a, b, `old-${index}`)
    }
    const first = getAgentMailStatus(b.ctx)
    expect(first).toMatchObject({ pendingCount: 60, snapshotHighWater: 60, nextCursor: 50, hasMore: true })
    expect(first.messages).toHaveLength(50)
    expect(first.messages[0]).not.toHaveProperty('body')
    const second = getAgentMailStatus(b.ctx, { afterSeq: first.nextCursor, throughSeq: first.snapshotHighWater })
    expect(second.messages.map((message) => message.seq)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60])
    expect(second.hasMore).toBe(false)
    const inbox = readAgentInbox(b.ctx, { afterSeq: 50, throughSeq: 60 })
    expect(inbox.messages.map((message) => message.seq)).toEqual(second.messages.map((message) => message.seq))
  })

  it('keeps arrivals above the pinned horizon for the next sweep, never skipping one', () => {
    const { a, b } = world()
    for (let index = 1; index <= 55; index += 1) {
      send(a, b, `m-${index}`)
    }
    const first = readAgentInbox(b.ctx)
    expect(first).toMatchObject({ snapshotHighWater: 55, nextCursor: 50, hasMore: true })
    send(a, b, 'late-1')
    send(a, b, 'late-2')
    const second = readAgentInbox(b.ctx, { afterSeq: first.nextCursor, throughSeq: first.snapshotHighWater })
    expect(second.messages.map((message) => message.seq)).toEqual([51, 52, 53, 54, 55])
    expect(second).toMatchObject({ snapshotHighWater: 55, nextCursor: 55, hasMore: false })
    const sweep = getAgentMailStatus(b.ctx, { afterSeq: second.nextCursor })
    expect(sweep).toMatchObject({ snapshotHighWater: 57, hasMore: false, pendingCount: 57 })
    expect(sweep.messages.map((message) => message.seq)).toEqual([56, 57])
  })
})

describe('windows and bodies', () => {
  it('rejects invalid windows', () => {
    const { a, b } = world()
    send(a, b, 'one')
    expect(domainErrorOf(() => readAgentInbox(b.ctx, { throughSeq: 2 })).code).toBe('invalid_input')
    expect(domainErrorOf(() => getAgentMailStatus(b.ctx, { afterSeq: 1, throughSeq: 0 })).code).toBe('invalid_input')
    expect(domainErrorOf(() => getAgentMailStatus(b.ctx, { limit: 51 })).code).toBe('invalid_input')
    expect(domainErrorOf(() => listAgentPeers(b.ctx, { limit: 0 })).code).toBe('invalid_input')
  })

  it('keeps bodies out of every other table', () => {
    const { desktop, a, b } = world()
    send(a, b, 'secret', 'the launch codes')
    const tables = desktop.db
      .all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'agent_mail_%' AND name NOT LIKE 'search_index%'")
      .map((row) => row.name)
    const text = JSON.stringify(tables.map((name) => desktop.db.all(`SELECT * FROM "${name}"`)))
    expect(text).not.toContain('the launch codes')
  })
})

describe('the person’s inbox and seen cursor', () => {
  it('serves the person a body snapshot and moves the seen cursor only to a message it served', () => {
    const { desktop, a, b } = world()
    send(a, b, 'one')
    send(a, b, 'two')
    const page = readHumanAgentInbox(desktop, { endpointId: b.endpoint.id })
    expect(page.messages.map((message) => message.body)).toEqual(['hello', 'hello'])
    expect(markHumanAgentMailSeen(desktop, { endpointId: b.endpoint.id, throughSeq: page.snapshotHighWater })).toEqual({ humanSeenSeq: 2 })
    expect(domainErrorOf(() => markHumanAgentMailSeen(desktop, { endpointId: b.endpoint.id, throughSeq: 3 })).code).toBe('invalid_input')
    expect(getHumanAgentMailState(desktop, { endpointId: b.endpoint.id })).toMatchObject({ humanSeenSeq: 2, unseenCount: 0, pendingCount: 2 })
    // The person seeing mail acknowledges nothing for the agent.
    expect(pending(b)).toBe(2)
  })
})

describe('the person’s view of a mailbox’s conversation', () => {
  it('serves a mailbox its own received and sent mail in time order, never another chat’s, acknowledging and marking nothing', () => {
    const { desktop, a, b, c } = world()
    const asked = send(a, b, 'ask', 'Lexmechanic asks')
    desktop.clock.advanceSeconds(1)
    const answered = reply(b, a, 'answer', asked.messageId)
    desktop.clock.advanceSeconds(1)
    send(c, b, 'elsewhere', 'between other chats')
    send(b, c, 'other-way', 'also between other chats')
    desktop.clock.advanceSeconds(1)
    const again = send(a, b, 'again', 'Lexmechanic again')

    const conversation = readHumanAgentConversation(desktop, { endpointId: a.endpoint.id })
    expect(conversation).toEqual({
      hasEarlier: false,
      messages: [
        { id: asked.messageId, direction: 'sent', seq: null, peer: { endpointId: b.endpoint.id, name: 'Chat chat-b', deleted: false },
          inReplyTo: null, acceptedAt: asked.acceptedAt, body: 'Lexmechanic asks' },
        { id: answered.messageId, direction: 'received', seq: 1, peer: { endpointId: b.endpoint.id, name: 'Chat chat-b', deleted: false },
          inReplyTo: asked.messageId, acceptedAt: answered.acceptedAt, body: 'answer' },
        { id: again.messageId, direction: 'sent', seq: null, peer: { endpointId: b.endpoint.id, name: 'Chat chat-b', deleted: false },
          inReplyTo: null, acceptedAt: again.acceptedAt, body: 'Lexmechanic again' }
      ]
    })
    // The newest of both directions, and the person's cursor and the agent's acknowledgements as they were.
    expect(readHumanAgentConversation(desktop, { endpointId: a.endpoint.id, limit: 2 })).toMatchObject({
      hasEarlier: true, messages: [{ id: answered.messageId }, { id: again.messageId }]
    })
    expect(getHumanAgentMailState(desktop, { endpointId: a.endpoint.id })).toMatchObject({ humanSeenSeq: 0, unseenCount: 1, pendingCount: 1 })
    expect(domainErrorOf(() => readHumanAgentConversation(desktop, { endpointId: a.endpoint.id, limit: AGENT_MAIL_LIMITS.conversationSize + 1 })).code)
      .toBe('invalid_input')
  })

  it('keeps sent mail under the received mail’s retention: gone once its recipient acknowledged it seven days ago', () => {
    const { desktop, a, b } = world()
    const sent = send(a, b, 'kept-a-while')
    acknowledgeAgentMessages(b.ctx, { messageIds: [sent.messageId] })
    expect(readHumanAgentConversation(desktop, { endpointId: a.endpoint.id }).messages.map((message) => message.id)).toEqual([sent.messageId])
    desktop.clock.advanceSeconds(AGENT_MAIL_LIMITS.retentionMs / 1000 + 1)
    expect(readHumanAgentConversation(desktop, { endpointId: a.endpoint.id }).messages).toEqual([])
  })
})


describe('probing for a mailbox', () => {
  it('surfaces a storage failure instead of reporting the session unbound', () => {
    const { a } = world()
    const failure = new Error('disk I/O error')
    const real = a.ctx.db
    const db: Ctx['db'] = {
      path: real.path,
      get: (sql, ...params) => {
        if (sql.includes('FROM grants')) {
          throw failure
        }
        return real.get(sql, ...params)
      },
      all: (sql, ...params) => real.all(sql, ...params),
      run: (sql, ...params) => real.run(sql, ...params),
      exec: (sql) => real.exec(sql),
      tx: (fn) => real.tx(fn),
      inTransaction: () => real.inTransaction(),
      close: () => real.close()
    }
    expect(() => agentMailboxStatus({ ...a.ctx, db })).toThrow(failure)
    expect(agentMailboxStatus(a.ctx)).toEqual({ bound: true, endpointId: a.endpoint.id })
  })
})

describe('dedicated poll sessions', () => {
  function sessionCount(ctx: TestCtx): number {
    return ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')?.n ?? 0
  }

  it('reuses one session per binding, and retires only poll sessions whose binding ended', () => {
    const { desktop, a, b } = world()
    const grant = { grantId: b.grantId, role: 'reviewer' as const, capabilities: grantedCapabilities('reviewer', false) }
    const deps = { db: desktop.db, clock: desktop.clock, ids: desktop.ids, machineId: desktop.machineId, projectRoot: desktop.projectRoot }
    const first = openMailPollSession(deps, grant)
    const before = sessionCount(desktop)
    for (let index = 0; index < 20; index += 1) {
      expect(openMailPollSession(deps, grant).id).toBe(first.id)
    }
    expect(sessionCount(desktop)).toBe(before)
    expect([...first.capabilities]).toEqual(['mail.use'])

    const aPoll = openMailPollSession(deps, { grantId: a.grantId, role: 'worker', capabilities: grantedCapabilities('worker', false) })
    // An activity reference keeps a retired poll session's row, ended.
    desktop.db.run("INSERT INTO events (at, kind, session_id, payload_json) VALUES ('t', 'probe', ?, '{}')", aPoll.id)
    revokeGrant(desktop, b.grantId)
    revokeGrant(desktop, a.grantId)
    expect(pruneAgentMailPollSessions(desktop)).toEqual({ removed: 1, ended: 1 })
    expect(desktop.db.get('SELECT 1 FROM sessions WHERE id = ?', first.id)).toBeUndefined()
    expect(desktop.db.get<{ ended_at: string | null }>('SELECT ended_at FROM sessions WHERE id = ?', aPoll.id)?.ended_at).not.toBeNull()
    // Ordinary sessions, the agents' own included, are never touched.
    expect(desktop.db.get<{ ended_at: string | null }>('SELECT ended_at FROM sessions WHERE id = ?', a.ctx.session.id)).toEqual({ ended_at: null })
    expect(domainErrorOf(() => openMailPollSession(deps, grant)).code).toBe('unauthorized')
  })

  it('refuses a grant without a mailbox capability or binding', () => {
    const desktop = desktopCtx()
    const deps = { db: desktop.db, clock: desktop.clock, ids: desktop.ids, machineId: desktop.machineId, projectRoot: desktop.projectRoot }
    const reader = grantedSession(desktop, 'reader')
    const unbound = grantedSession(desktop, 'worker')
    expect(domainErrorOf(() => openMailPollSession(deps, { grantId: reader.grantId, role: 'reader', capabilities: ['read'] })).code).toBe('unauthorized')
    expect(domainErrorOf(() => openMailPollSession(deps, { grantId: unbound.grantId, role: 'worker', capabilities: grantedCapabilities('worker', false) })).code).toBe('unauthorized')
  })
})
