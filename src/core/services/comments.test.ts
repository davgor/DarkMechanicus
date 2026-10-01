import { describe, expect, it } from 'vitest'
import { captureError, createSavedEpic, eventKinds } from '../../test/authoring'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { DomainError } from '../errors'
import { LIMITS } from '../schemas'
import { addComment, enqueueUnexportedComments, listComments } from './comments'
import { updatePlanDraft } from './drafts'
import { createEpic } from './epics'

interface Planned {
  ctx: TestCtx
  epicId: string
  alpha: string
  beta: string
}

/** A saved epic with tickets Alpha and Beta (Beta requires Alpha). */
function planned(): Planned {
  const ctx = createTestCtx()
  const saved = createSavedEpic(ctx)
  return { ctx, epicId: saved.epicId, alpha: saved.refMap['a'] ?? '', beta: saved.refMap['b'] ?? '' }
}

function rowCount(ctx: TestCtx): number {
  return ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM comments')?.n ?? -1
}

function outboxOf(ctx: TestCtx): { kind: string; epic_id: string | null; entity_id: string | null; state: string }[] {
  return ctx.db.all("SELECT kind, epic_id, entity_id, state FROM outbox WHERE kind = 'comment' ORDER BY id")
}

describe('addComment', () => {
  it('stores a ticket comment authored by the calling session and returns its view', () => {
    const { ctx, epicId, alpha } = planned()
    ctx.clock.set('2026-05-06T07:08:09.010Z')
    const comment = addComment(ctx, { epicId, ticketId: alpha, body: 'Blocked on **DM-2**' })
    expect(comment).toEqual({
      id: comment.id,
      epicId,
      ticketId: alpha,
      body: 'Blocked on **DM-2**',
      author: { role: 'orchestrator', label: 'test orchestrator' },
      createdAt: '2026-05-06T07:08:09.010Z'
    })
    expect(comment.id).toMatch(/^cm_[0-9a-hjkmnp-tv-z]{26}$/)
    expect(ctx.db.all('SELECT * FROM comments')).toEqual([
      {
        id: comment.id,
        epic_id: epicId,
        ticket_id: alpha,
        body: 'Blocked on **DM-2**',
        author_role: 'orchestrator',
        author_label: 'test orchestrator',
        created_at: '2026-05-06T07:08:09.010Z'
      }
    ])
  })

  it('stores an epic-level comment without a ticket', () => {
    const { ctx, epicId } = planned()
    const comment = addComment(ctx, { epicId, body: 'Decision: ship behind a flag.' })
    expect([comment.ticketId, comment.body]).toEqual([null, 'Decision: ship behind a flag.'])
    expect(ctx.db.get('SELECT ticket_id FROM comments WHERE id = ?', comment.id)).toEqual({ ticket_id: null })
  })

  it('accepts a ticket that exists only in the draft, or only in the saved plan', () => {
    const { ctx, epicId, beta } = planned()
    const update = updatePlanDraft(ctx, {
      epicId,
      ops: [
        { op: 'add_ticket', ref: 'c', sprint: '1', ticket: { title: 'Gamma' } },
        { op: 'remove_ticket', ticket: beta }
      ]
    })
    const gamma = update.refMap['c'] ?? ''
    expect(addComment(ctx, { epicId, ticketId: gamma, body: 'draft only' }).ticketId).toBe(gamma)
    expect(addComment(ctx, { epicId, ticketId: beta, body: 'saved only' }).ticketId).toBe(beta)
  })

})

describe('addComment authors', () => {
  it('records the author from the session of any role that may comment', () => {
    const { ctx, epicId, alpha } = planned()
    const worker = addComment(withRole(ctx, 'worker'), { epicId, ticketId: alpha, body: 'w' })
    const reviewer = addComment(withRole(ctx, 'reviewer'), { epicId, ticketId: alpha, body: 'r' })
    const desktop = addComment(withRole(ctx, 'desktop'), { epicId, body: 'd' })
    expect([worker.author, reviewer.author, desktop.author]).toEqual([
      { role: 'worker', label: 'test worker' },
      { role: 'reviewer', label: 'test reviewer' },
      { role: 'desktop', label: 'test desktop' }
    ])
  })

  it('keeps at most 200 characters of a long session label', () => {
    const { ctx, epicId } = planned()
    const long = { ...ctx, session: { ...ctx.session, label: `${'L'.repeat(200)}overflow` } }
    expect(addComment(long, { epicId, body: 'x' }).author.label).toBe('L'.repeat(LIMITS.label))
  })
})

describe('addComment records', () => {
  it('appends a comment.added event naming the comment and its author', () => {
    const { ctx, epicId, alpha } = planned()
    const comment = addComment(ctx, { epicId, ticketId: alpha, body: 'note' })
    const event = ctx.db.get('SELECT kind, epic_id, run_id, ticket_id, session_id, payload_json FROM events ORDER BY seq DESC LIMIT 1')
    expect(event).toEqual({
      kind: 'comment.added',
      epic_id: epicId,
      run_id: null,
      ticket_id: alpha,
      session_id: ctx.session.id,
      payload_json: JSON.stringify({ commentId: comment.id, author: { role: 'orchestrator', label: 'test orchestrator' } })
    })
  })

  it('queues the export of a comment on a saved epic, keyed by the comment id', () => {
    const { ctx, epicId } = planned()
    const first = addComment(ctx, { epicId, body: 'one' })
    const second = addComment(ctx, { epicId, body: 'two' })
    expect(outboxOf(ctx)).toEqual([
      { kind: 'comment', epic_id: epicId, entity_id: first.id, state: 'pending' },
      { kind: 'comment', epic_id: epicId, entity_id: second.id, state: 'pending' }
    ])
  })

  it('keeps comments of a never-saved epic local until its first save', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Unsaved' })
    const comment = addComment(ctx, { epicId: epic.id, body: 'early thought' })
    expect(outboxOf(ctx)).toEqual([])
    expect(listComments(ctx, { epicId: epic.id }).map((item) => item.id)).toEqual([comment.id])
  })

  it('indexes the body for history search', () => {
    const { ctx, epicId, alpha } = planned()
    const comment = addComment(ctx, { epicId, ticketId: alpha, body: 'The flaky keychain test is quarantined' })
    expect(ctx.db.all("SELECT doc_type, doc_id, epic_id, run_id, ticket_id, title, body FROM search_index WHERE doc_type = 'comment'")).toEqual([
      {
        doc_type: 'comment',
        doc_id: comment.id,
        epic_id: epicId,
        run_id: null,
        ticket_id: alpha,
        title: 'Comment by test orchestrator',
        body: 'The flaky keychain test is quarantined'
      }
    ])
  })
})

describe('addComment validation', () => {
  it('rejects a ticket that is in neither the saved plan nor the draft of the epic', () => {
    const { ctx, epicId } = planned()
    const other = createSavedEpic(ctx, { title: 'Other' })
    const foreign = other.refMap['a'] ?? ''
    const error = captureError(() => addComment(ctx, { epicId, ticketId: foreign, body: 'x' }))
    expect(error).toEqual({
      code: 'not_found',
      message: `Ticket ${foreign} is not in the saved plan or draft of epic ${epicId}.`,
      details: { epicId, ticketId: foreign }
    })
    expect(rowCount(ctx)).toBe(0)
  })

  it('rejects an unknown epic and a completed epic, writing nothing', () => {
    const { ctx, epicId } = planned()
    const missing = captureError(() => addComment(ctx, { epicId: 'ep_0000000000000000000000zzzz', body: 'x' }))
    expect([missing.code, missing.message]).toEqual(['not_found', 'Epic ep_0000000000000000000000zzzz not found.'])
    ctx.db.run("UPDATE epics SET status = 'completed' WHERE id = ?", epicId)
    const completed = captureError(() => addComment(ctx, { epicId, body: 'x' }))
    expect([completed.code, completed.message]).toEqual([
      'completed_epic',
      'Completed epics are read-only. Create a new epic to extend this work.'
    ])
    expect([rowCount(ctx), eventKinds(ctx).includes('comment.added')]).toEqual([0, false])
  })

  it('requires comment.write and runs behind the branch guard', () => {
    const { ctx, epicId } = planned()
    const reader = withRole(ctx, 'reviewer', { capabilities: ['read'] })
    expect(captureError(() => addComment(reader, { epicId, body: 'x' })).message).toBe(
      'This reviewer session is not permitted to perform "comment.write".'
    )
    const moved = {
      ...ctx,
      assertBranch: () => {
        throw new DomainError('branch_changed', 'The checkout moved.')
      }
    }
    expect(captureError(() => addComment(moved, { epicId, body: 'x' })).code).toBe('branch_changed')
    expect(rowCount(ctx)).toBe(0)
  })
})

/** Inserts `count` comments on the epic straight into the table. */
function fillComments(ctx: TestCtx, epicId: string, count: number): void {
  ctx.db.run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO comments (id, epic_id, ticket_id, body, author_role, author_label, created_at)
     SELECT printf('cm_bulk%021d', i), ?, NULL, 'bulk', 'worker', 'w', '2026-01-01T00:00:00.000Z' FROM n`,
    count,
    epicId
  )
}

describe('addComment limits', () => {
  it('accepts the 10,000th comment of an epic and refuses the next one', () => {
    const { ctx, epicId } = planned()
    fillComments(ctx, epicId, LIMITS.commentsPerEpic - 1)
    expect(addComment(ctx, { epicId, body: 'last one' }).body).toBe('last one')
    const error = captureError(() => addComment(ctx, { epicId, body: 'one too many' }))
    expect(error).toEqual({
      code: 'capacity_exceeded',
      message: `Epic ${epicId} already holds 10000 comments, the most one epic can keep.`,
      details: { epicId, limit: 10_000 }
    })
    expect(rowCount(ctx)).toBe(10_000)
  })
})

describe('addComment idempotency', () => {
  it('returns the original comment for a repeated key and refuses a key reused for different text', () => {
    const { ctx, epicId, alpha } = planned()
    const first = addComment(ctx, { epicId, ticketId: alpha, body: 'once', idempotencyKey: 'k-1' })
    ctx.clock.advanceSeconds(30)
    expect(addComment(ctx, { epicId, ticketId: alpha, body: 'once', idempotencyKey: 'k-1' })).toEqual(first)
    const reused = captureError(() => addComment(ctx, { epicId, ticketId: alpha, body: 'twice', idempotencyKey: 'k-1' }))
    expect(reused.code).toBe('idempotency_mismatch')
    expect(rowCount(ctx)).toBe(1)
    expect(eventKinds(ctx).filter((kind) => kind === 'comment.added')).toHaveLength(1)
  })
})

describe('listComments', () => {
  it('lists every comment of the epic oldest first, or only one ticket’s', () => {
    const { ctx, epicId, alpha, beta } = planned()
    const onAlpha = addComment(ctx, { epicId, ticketId: alpha, body: 'a1' })
    ctx.clock.advanceSeconds(5)
    const onEpic = addComment(ctx, { epicId, body: 'e1' })
    const onBeta = addComment(ctx, { epicId, ticketId: beta, body: 'b1' })
    ctx.clock.set('2025-12-31T23:59:59.000Z')
    const earliest = addComment(ctx, { epicId, ticketId: alpha, body: 'a0' })
    const ids = (ticketId?: string): string[] => listComments(ctx, { epicId, ticketId }).map((item) => item.id)
    expect(ids()).toEqual([earliest.id, onAlpha.id, onEpic.id, onBeta.id])
    expect(ids(alpha)).toEqual([earliest.id, onAlpha.id])
    expect(ids(beta)).toEqual([onBeta.id])
    expect(listComments(ctx, { epicId, ticketId: beta })).toEqual([onBeta])
  })

  it('keeps comments of another epic out and lists an epic without comments as empty', () => {
    const { ctx, epicId } = planned()
    const other = createSavedEpic(ctx, { title: 'Other' })
    addComment(ctx, { epicId: other.epicId, body: 'elsewhere' })
    expect(listComments(ctx, { epicId })).toEqual([])
    expect(listComments(ctx, { epicId: other.epicId }).map((item) => item.body)).toEqual(['elsewhere'])
  })

  it('lists comments of a completed epic but not of an unknown one, and requires read', () => {
    const { ctx, epicId } = planned()
    addComment(ctx, { epicId, body: 'before completion' })
    ctx.db.run("UPDATE epics SET status = 'completed' WHERE id = ?", epicId)
    expect(listComments(ctx, { epicId }).map((item) => item.body)).toEqual(['before completion'])
    expect(captureError(() => listComments(ctx, { epicId: 'ep_0000000000000000000000zzzz' })).code).toBe('not_found')
    expect(captureError(() => listComments(withRole(ctx, 'worker', { capabilities: [] }), { epicId })).code).toBe('unauthorized')
  })
})

describe('enqueueUnexportedComments', () => {
  it('queues each comment that was never exported and is not already queued', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Unsaved' })
    const early = addComment(ctx, { epicId: epic.id, body: 'early' })
    const queued = addComment(ctx, { epicId: epic.id, body: 'queued' })
    const exported = addComment(ctx, { epicId: epic.id, body: 'exported' })
    ctx.db.run("INSERT INTO outbox (kind, epic_id, entity_id, state, created_at) VALUES ('comment', ?, ?, 'failed', 't')", epic.id, queued.id)
    ctx.db.run("INSERT INTO sync_state (kind, entity_id, exported_hash, updated_at) VALUES ('comment', ?, 'sha256:x', 't')", exported.id)
    enqueueUnexportedComments(ctx, epic.id)
    enqueueUnexportedComments(ctx, epic.id)
    expect(outboxOf(ctx)).toEqual([
      { kind: 'comment', epic_id: epic.id, entity_id: queued.id, state: 'failed' },
      { kind: 'comment', epic_id: epic.id, entity_id: early.id, state: 'pending' }
    ])
  })

  it('queues a comment again once its earlier entry is done without an export record', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Unsaved' })
    const comment = addComment(ctx, { epicId: epic.id, body: 'x' })
    ctx.db.run("INSERT INTO outbox (kind, epic_id, entity_id, state, created_at) VALUES ('comment', ?, ?, 'done', 't')", epic.id, comment.id)
    enqueueUnexportedComments(ctx, epic.id)
    expect(outboxOf(ctx).map((row) => row.state)).toEqual(['done', 'pending'])
  })
})
