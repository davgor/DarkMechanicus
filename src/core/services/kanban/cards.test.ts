import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { KanbanAttemptState, KanbanCardView, KanbanLane } from '../../../shared/domain/kanban'
import { captureError, TWO_TICKETS } from '../../../test/authoring'
import { pngBytes } from '../../../test/images'
import { createTestCtx, type TestCtx, withRole } from '../../../test/testContext'
import { updatePlanDraft } from '../drafts'
import { createStagedAttachment } from '../attachments'
import { createEpic } from '../epics'
import { createKanbanCard, getKanbanCard, listKanbanCards, updateKanbanCard } from './cards'

/** A database holding nothing yet, with a planner session (planners may write cards). */
function plannerCtx(): TestCtx {
  return createTestCtx({ role: 'planner' })
}

function cardRow(ctx: TestCtx, cardId: string): Record<string, unknown> | undefined {
  return ctx.db.get('SELECT * FROM kanban_cards WHERE id = ?', cardId)
}

function cardCount(ctx: TestCtx): number {
  return ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM kanban_cards')?.n ?? -1
}

function kanbanEvents(ctx: TestCtx): { card_id: string; kind: string; actor_role: string; payload: unknown }[] {
  return ctx.db
    .all<{ card_id: string; kind: string; actor_role: string; payload_json: string }>(
      'SELECT card_id, kind, actor_role, payload_json FROM kanban_events ORDER BY created_at, id'
    )
    .map((row) => ({ card_id: row.card_id, kind: row.kind, actor_role: row.actor_role, payload: JSON.parse(row.payload_json) }))
}

function workspaceEvents(ctx: TestCtx): { kind: string; epic_id: string | null; payload: Record<string, unknown> }[] {
  return ctx.db
    .all<{ kind: string; epic_id: string | null; payload_json: string }>(
      "SELECT kind, epic_id, payload_json FROM events WHERE kind LIKE 'kanban.%' ORDER BY seq"
    )
    .map((row) => ({ kind: row.kind, epic_id: row.epic_id, payload: JSON.parse(row.payload_json) as Record<string, unknown> }))
}

let attemptCounter = 0

/** Seeds an attempt row directly: claims belong to a later ticket, so the fixture writes what a claim would. */
function seedAttempt(
  ctx: TestCtx,
  cardId: string,
  { state, number = 1, reviewComment = null }: { state: KanbanAttemptState; number?: number; reviewComment?: string | null }
): string {
  attemptCounter += 1
  const id = `ka_${String(attemptCounter).padStart(26, '0')}`
  ctx.db.run(
    `INSERT INTO kanban_attempts (id, card_id, number, state, claim_secret, review_comment, created_at)
     VALUES (?, ?, ?, ?, 'hashed-secret', ?, ?)`,
    id,
    cardId,
    number,
    state,
    reviewComment,
    ctx.clock.nowIso()
  )
  return id
}

/** Moves a card to `lane` directly (the transitions that do it belong to a later ticket). */
function moveTo(ctx: TestCtx, cardId: string, lane: KanbanLane, completedAt: string | null = null): void {
  ctx.db.run('UPDATE kanban_cards SET lane = ?, completed_at = ? WHERE id = ?', lane, completedAt, cardId)
}

describe('createKanbanCard', () => {
  it('stores a Backlog card with the first key, authored by the calling session, and returns its full view', () => {
    const ctx = plannerCtx()
    ctx.clock.set('2026-10-31T09:00:00.000Z')
    const card = createKanbanCard(ctx, {
      title: 'Fix the flaky upload test',
      body: 'It times out **sometimes**.',
      acceptanceCriteria: ['The test passes 50 runs in a row', { text: 'No retry is added' }],
      expectedArtifacts: ['src/upload.test.ts'],
      references: [{ kind: 'file', label: 'upload', location: 'src/upload.ts', hash: null, remoteOnly: false }],
      priority: 'high',
      size: 'small'
    })
    expect(card).toEqual({
      id: card.id,
      key: 'DM-1',
      title: 'Fix the flaky upload test',
      lane: 'backlog',
      priority: 'high',
      updatedAt: '2026-10-31T09:00:00.000Z',
      playPending: false,
      openAttempt: null,
      kickBackCount: 0,
      summary: null,
      body: 'It times out **sometimes**.',
      acceptanceCriteria: [
        { id: 'c1', text: 'The test passes 50 runs in a row' },
        { id: 'c2', text: 'No retry is added' }
      ],
      expectedArtifacts: ['src/upload.test.ts'],
      references: [{ kind: 'file', label: 'upload', location: 'src/upload.ts', hash: null, remoteOnly: false }],
      size: 'small',
      createdBy: { role: 'planner', label: 'test planner' },
      createdAt: '2026-10-31T09:00:00.000Z',
      completedAt: null,
      revision: 1,
      attempts: []
    } satisfies KanbanCardView)
    expect(card.id).toMatch(/^kc_[0-9a-hjkmnp-tv-z]{26}$/)
    expect(cardRow(ctx, card.id)).toMatchObject({ key: 'DM-1', lane: 'backlog', created_by_role: 'planner', revision: 1 })
  })
})

describe('createKanbanCard defaults, keys and events', () => {
  it('fills the defaults: an empty body and lists, normal priority and no size', () => {
    const ctx = plannerCtx()
    const card = createKanbanCard(ctx, { title: 'Bare' })
    expect([card.body, card.acceptanceCriteria, card.expectedArtifacts, card.references, card.priority, card.size]).toEqual([
      '',
      [],
      [],
      [],
      'normal',
      null
    ])
  })

  it('takes the next key of the shared sequence, after plan tickets and earlier cards', () => {
    const ctx = plannerCtx()
    const epic = createEpic(ctx, { title: 'Planned' })
    updatePlanDraft(ctx, { epicId: epic.id, ops: TWO_TICKETS })
    const draft = ctx.db.get<{ bundle_json: string }>('SELECT bundle_json FROM drafts WHERE epic_id = ?', epic.id)
    // The draft's bundle as the draft service stored it.
    const bundle = JSON.parse(draft?.bundle_json ?? '{"tickets":[]}') as PlanBundle
    expect(bundle.tickets.length).toBeGreaterThan(0)
    const highest = Math.max(...bundle.tickets.map((ticket) => Number(ticket.key.split('-')[1])))
    expect(createKanbanCard(ctx, { title: 'First card' }).key).toBe(`DM-${highest + 1}`)
    expect(createKanbanCard(ctx, { title: 'Second card' }).key).toBe(`DM-${highest + 2}`)
  })

  it('appends a created kanban event and a workspace event with the card id and no epic', () => {
    const ctx = plannerCtx()
    const card = createKanbanCard(ctx, { title: 'Evented' })
    expect(kanbanEvents(ctx)).toEqual([{ card_id: card.id, kind: 'created', actor_role: 'planner', payload: { revision: 1 } }])
    expect(workspaceEvents(ctx)).toEqual([{ kind: 'kanban.created', epic_id: null, payload: { cardId: card.id, key: 'DM-1' } }])
  })
})

describe('createKanbanCard refusals and replays', () => {
  it('refuses reader and worker sessions and stores nothing; the desktop and an orchestrator may create', () => {
    const ctx = plannerCtx()
    for (const role of ['reader', 'worker', 'reviewer'] as const) {
      expect(captureError(() => createKanbanCard(withRole(ctx, role), { title: 'Not mine' })).code).toBe('unauthorized')
    }
    expect(cardCount(ctx)).toBe(0)
    expect(kanbanEvents(ctx)).toEqual([])
    expect(createKanbanCard(withRole(ctx, 'desktop'), { title: 'Person' }).createdBy.role).toBe('desktop')
    expect(createKanbanCard(withRole(ctx, 'orchestrator'), { title: 'Agent' }).createdBy.role).toBe('orchestrator')
  })

  it('applies a repeated request with the same idempotency key once', () => {
    const ctx = plannerCtx()
    const first = createKanbanCard(ctx, { title: 'Once', idempotencyKey: 'card-1' })
    const again = createKanbanCard(ctx, { title: 'Once', idempotencyKey: 'card-1' })
    expect(again).toEqual(first)
    expect(cardCount(ctx)).toBe(1)
    expect(captureError(() => createKanbanCard(ctx, { title: 'Other', idempotencyKey: 'card-1' })).code).toBe('idempotency_mismatch')
  })

  it('checks the branch before writing', () => {
    const ctx = createTestCtx({
      role: 'planner',
      assertBranch: () => {
        throw new Error('branch moved')
      }
    })
    expect(() => createKanbanCard(ctx, { title: 'Wrong branch' })).toThrow('branch moved')
    expect(cardCount(ctx)).toBe(0)
  })
})

describe('updateKanbanCard', () => {
  it('edits a Backlog card with no attempt, bumping its revision and keeping the key and author', () => {
    const ctx = plannerCtx()
    const card = createKanbanCard(ctx, { title: 'Draft', acceptanceCriteria: ['Old'], size: 'large' })
    ctx.clock.advanceSeconds(60)
    const updated = updateKanbanCard(withRole(ctx, 'desktop'), {
      cardId: card.id,
      expectedRevision: 1,
      title: 'Edited',
      body: 'Now with a body',
      acceptanceCriteria: ['Old', 'New'],
      priority: 'critical',
      size: null
    })
    expect(updated).toMatchObject({
      id: card.id,
      key: card.key,
      title: 'Edited',
      body: 'Now with a body',
      acceptanceCriteria: [
        { id: 'c1', text: 'Old' },
        { id: 'c2', text: 'New' }
      ],
      priority: 'critical',
      size: null,
      revision: 2,
      createdBy: { role: 'planner', label: 'test planner' },
      createdAt: card.createdAt,
      updatedAt: '2026-01-01T00:01:00.000Z'
    })
    expect(getKanbanCard(ctx, { cardId: card.id })).toEqual(updated)
    expect(kanbanEvents(ctx).map((event) => [event.kind, event.actor_role, event.payload])).toEqual([
      ['created', 'planner', { revision: 1 }],
      ['updated', 'desktop', { revision: 2, fields: ['title', 'body', 'acceptanceCriteria', 'priority', 'size'] }]
    ])
    expect(workspaceEvents(ctx).map((event) => [event.kind, event.epic_id, event.payload.cardId])).toEqual([
      ['kanban.created', null, card.id],
      ['kanban.updated', null, card.id]
    ])
  })

  it('leaves the fields it is not given unchanged', () => {
    const ctx = plannerCtx()
    const card = createKanbanCard(ctx, { title: 'Keep', body: 'Body', expectedArtifacts: ['a.ts'], priority: 'low', size: 'micro' })
    const updated = updateKanbanCard(ctx, { cardId: card.id, expectedRevision: 1, title: 'Renamed' })
    expect(updated).toEqual({ ...card, title: 'Renamed', revision: 2 })
  })
})

describe('updateKanbanCard lists', () => {
  it('replaces the expected artifacts and references, and records both as edited fields', () => {
    const ctx = plannerCtx()
    const old = { kind: 'url' as const, label: 'Old', location: 'https://old.example', hash: null, remoteOnly: true }
    const card = createKanbanCard(ctx, { title: 'Point', expectedArtifacts: ['old.ts'], references: [old] })
    const references = [{ kind: 'file' as const, label: 'Upload test', location: 'src/upload.test.ts', hash: null, remoteOnly: false }]
    const updated = updateKanbanCard(ctx, { cardId: card.id, expectedRevision: 1, expectedArtifacts: ['src/upload.ts', 'src/upload.test.ts'], references })
    expect([updated.title, updated.expectedArtifacts, updated.references, updated.revision]).toEqual(['Point', ['src/upload.ts', 'src/upload.test.ts'], references, 2])
    expect(kanbanEvents(ctx).at(-1)?.payload).toEqual({ revision: 2, fields: ['expectedArtifacts', 'references'] })
  })
})

describe('updateKanbanCard refusals', () => {
  it('returns invalid_state for a Backlog card that has an attempt, whatever its state', () => {
    const ctx = plannerCtx()
    const card = createKanbanCard(ctx, { title: 'Claimed once' })
    seedAttempt(ctx, card.id, { state: 'failed' })
    const refusal = captureError(() => updateKanbanCard(ctx, { cardId: card.id, expectedRevision: 1, title: 'Too late' }))
    expect(refusal.code).toBe('invalid_state')
    expect(cardRow(ctx, card.id)).toMatchObject({ title: 'Claimed once', revision: 1 })
  })

  it.each(['in_progress', 'ready_for_review', 'done'] as const)('returns invalid_state for a card in %s', (lane) => {
    const ctx = plannerCtx()
    const card = createKanbanCard(ctx, { title: 'Moved on' })
    moveTo(ctx, card.id, lane)
    expect(captureError(() => updateKanbanCard(ctx, { cardId: card.id, expectedRevision: 1, title: 'x' })).code).toBe('invalid_state')
    expect(cardRow(ctx, card.id)).toMatchObject({ title: 'Moved on', revision: 1 })
  })

  it('returns conflict for a stale expectedRevision and changes nothing', () => {
    const ctx = plannerCtx()
    const card = createKanbanCard(ctx, { title: 'Contended' })
    updateKanbanCard(ctx, { cardId: card.id, expectedRevision: 1, title: 'First edit' })
    const stale = captureError(() => updateKanbanCard(ctx, { cardId: card.id, expectedRevision: 1, title: 'Second edit' }))
    expect(stale).toMatchObject({ code: 'conflict', details: { cardId: card.id, currentRevision: 2 } })
    expect(cardRow(ctx, card.id)).toMatchObject({ title: 'First edit', revision: 2 })
    expect(kanbanEvents(ctx).map((event) => event.kind)).toEqual(['created', 'updated'])
  })

  it('returns not_found for an unknown card and unauthorized for a reader or worker', () => {
    const ctx = plannerCtx()
    const card = createKanbanCard(ctx, { title: 'Guarded' })
    expect(captureError(() => updateKanbanCard(ctx, { cardId: 'kc_0000000000000000000000zzzz', expectedRevision: 1 })).code).toBe('not_found')
    for (const role of ['reader', 'worker'] as const) {
      expect(captureError(() => updateKanbanCard(withRole(ctx, role), { cardId: card.id, expectedRevision: 1, title: 'x' })).code).toBe('unauthorized')
    }
    expect(cardRow(ctx, card.id)).toMatchObject({ title: 'Guarded', revision: 1 })
  })

  it.each(['', '   \n\t'])('refuses the blank title %j with invalid_input and changes nothing', (title) => {
    const ctx = plannerCtx()
    const card = createKanbanCard(ctx, { title: 'Named' })
    const refusal = captureError(() => updateKanbanCard(ctx, { cardId: card.id, expectedRevision: 1, title }))
    expect([refusal.code, refusal.message]).toEqual(['invalid_input', 'A Kanban card needs a title.'])
    expect(cardRow(ctx, card.id)).toMatchObject({ title: 'Named', revision: 1 })
    expect(kanbanEvents(ctx).map((event) => event.kind)).toEqual(['created'])
  })
})

const DONE_SUMMARY = { outcome: 'Shipped', commits: ['abc1234'], completedAt: '2026-01-02T00:00:00.000Z', approvedBy: 'Ada' }

/**
 * A board with four Backlog cards created a second apart (Normal has a pending play), Running (kicked back once, now on
 * its second attempt, with evidence), Review me (submitted) and Done. Returns the Backlog ids by priority, then age.
 */
function seedBoard(ctx: TestCtx): string[] {
  const lowOld = createKanbanCard(ctx, { title: 'Low, old', priority: 'low', body: 'secret body', acceptanceCriteria: ['c'] })
  ctx.clock.advanceSeconds(1)
  const normal = createKanbanCard(ctx, { title: 'Normal' })
  ctx.clock.advanceSeconds(1)
  const critical = createKanbanCard(ctx, { title: 'Critical', priority: 'critical' })
  ctx.clock.advanceSeconds(1)
  const normalNewer = createKanbanCard(ctx, { title: 'Normal, newer' })
  const running = createKanbanCard(ctx, { title: 'Running' })
  moveTo(ctx, running.id, 'in_progress')
  seedAttempt(ctx, running.id, { state: 'rejected', reviewComment: 'Missing the test' })
  seedAttempt(ctx, running.id, { state: 'running', number: 2 })
  ctx.db.run("UPDATE kanban_attempts SET evidence_json = '{\"checks\":[]}' WHERE card_id = ?", running.id)
  const review = createKanbanCard(ctx, { title: 'Review me' })
  moveTo(ctx, review.id, 'ready_for_review')
  seedAttempt(ctx, review.id, { state: 'submitted' })
  const done = createKanbanCard(ctx, { title: 'Done' })
  moveTo(ctx, done.id, 'done', DONE_SUMMARY.completedAt)
  ctx.db.run('UPDATE kanban_cards SET summary_json = ? WHERE id = ?', JSON.stringify(DONE_SUMMARY), done.id)
  ctx.db.run('UPDATE kanban_cards SET play_requested_at = ? WHERE id = ?', ctx.clock.nowIso(), normal.id)
  return [critical.id, normal.id, normalNewer.id, lowOld.id]
}

describe('listKanbanCards lanes', () => {
  it('groups cards into the four lanes, open lanes by priority then age', () => {
    const ctx = plannerCtx()
    const backlogIds = seedBoard(ctx)

    const board = listKanbanCards(withRole(ctx, 'reader'), {})

    const titles = Object.fromEntries(Object.entries(board.lanes).map(([lane, cards]) => [lane, cards.map((card) => card.title)]))
    expect(titles).toEqual({
      backlog: ['Critical', 'Normal', 'Normal, newer', 'Low, old'],
      in_progress: ['Running'],
      ready_for_review: ['Review me'],
      done: ['Done']
    })
    expect(board.lanes.backlog.map((card) => card.id)).toEqual(backlogIds)
    expect([board.doneTotal, board.doneNextCursor]).toEqual([1, null])
  })

  it('carries only summary fields, never the body, criteria, evidence or a kick-back comment', () => {
    const ctx = plannerCtx()
    seedBoard(ctx)

    const board = listKanbanCards(ctx, {})

    const all = Object.values(board.lanes).flat()
    for (const card of all) {
      expect(Object.keys(card).sort()).toEqual(
        ['id', 'key', 'kickBackCount', 'lane', 'openAttempt', 'playPending', 'priority', 'summary', 'title', 'updatedAt'].sort()
      )
    }
    const json = JSON.stringify(board)
    for (const hidden of ['secret body', 'checks', 'Missing the test', 'acceptanceCriteria']) {
      expect(json).not.toContain(hidden)
    }
    const byTitle = new Map(all.map((card) => [card.title, card]))
    expect(byTitle.get('Running')).toMatchObject({ openAttempt: { number: 2, state: 'running' }, kickBackCount: 1, playPending: false })
    expect(byTitle.get('Review me')).toMatchObject({ openAttempt: { number: 1, state: 'submitted' }, kickBackCount: 0 })
    expect(byTitle.get('Normal')).toMatchObject({ playPending: true, openAttempt: null })
    expect(byTitle.get('Done')).toMatchObject({ summary: DONE_SUMMARY, openAttempt: null })
    expect(byTitle.get('Low, old')?.summary).toBeNull()
  })
})

describe('listKanbanCards Done paging', () => {
  it('pages 25 done cards newest first: 20, then the last 5 with the cursor', () => {
    const ctx = plannerCtx()
    const doneIds: string[] = []
    for (let index = 0; index < 25; index += 1) {
      const card = createKanbanCard(ctx, { title: `Done ${index}` })
      // Completion order differs from creation order, so the page must follow completedAt.
      const minute = (index * 7) % 25
      moveTo(ctx, card.id, 'done', `2026-02-01T00:${String(minute).padStart(2, '0')}:00.000Z`)
      doneIds.push(card.id)
    }
    createKanbanCard(ctx, { title: 'Still open' })
    const newestFirst = [...doneIds].sort((a, b) => {
      const at = (id: string): string => String(cardRow(ctx, id)?.completed_at)
      return at(b).localeCompare(at(a))
    })

    const first = listKanbanCards(ctx, {})
    expect(first.lanes.done.map((card) => card.id)).toEqual(newestFirst.slice(0, 20))
    expect(first.doneTotal).toBe(25)
    expect(first.doneNextCursor).not.toBeNull()
    expect(first.lanes.backlog.map((card) => card.title)).toEqual(['Still open'])

    const second = listKanbanCards(ctx, { doneCursor: first.doneNextCursor ?? '' })
    expect(second.lanes.done.map((card) => card.id)).toEqual(newestFirst.slice(20))
    expect([second.doneTotal, second.doneNextCursor]).toEqual([25, null])
    expect(second.lanes.backlog.map((card) => card.title)).toEqual(['Still open'])
  })

  it('honours doneLimit, keeps cards that finished at the same moment in one stable order, and pages to the end', () => {
    const ctx = plannerCtx()
    for (let index = 0; index < 5; index += 1) {
      const card = createKanbanCard(ctx, { title: `Tied ${index}` })
      moveTo(ctx, card.id, 'done', '2026-03-01T00:00:00.000Z')
    }
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = listKanbanCards(ctx, { doneLimit: 2, ...(cursor === undefined ? {} : { doneCursor: cursor }) })
      expect(page.lanes.done.length).toBeLessThanOrEqual(2)
      seen.push(...page.lanes.done.map((card) => card.title))
      cursor = page.doneNextCursor ?? undefined
      pages += 1
    } while (cursor !== undefined && pages < 10)
    expect(pages).toBe(3)
    expect([...seen].sort()).toEqual(['Tied 0', 'Tied 1', 'Tied 2', 'Tied 3', 'Tied 4'])
  })
})

describe('listKanbanCards refusals', () => {
  it('refuses a cursor it did not issue', () => {
    const ctx = plannerCtx()
    const forged = Buffer.from(JSON.stringify(['yesterday', '../etc'])).toString('base64url')
    for (const doneCursor of ['not-a-cursor', forged, '']) {
      expect(captureError(() => listKanbanCards(ctx, { doneCursor })).code).toBe('invalid_input')
    }
  })

  it.each([['a single value', 'x'], ['an object', { at: '2026-01-02T00:00:00.000Z' }], ['a triple', ['2026-01-02T00:00:00.000Z', 'kc_0000000000000000000000000a', 'x']]])(
    'refuses a cursor that decodes to %s instead of a pair',
    (_label, decoded) => {
      const ctx = plannerCtx()
      const doneCursor = Buffer.from(JSON.stringify(decoded)).toString('base64url')
      const refusal = captureError(() => listKanbanCards(ctx, { doneCursor }))
      expect([refusal.code, refusal.message]).toEqual([
        'invalid_input',
        'doneCursor is not a cursor listKanbanCards returned. Omit it to start from the newest Done card.'
      ])
    }
  )

  it('requires read', () => {
    const ctx = plannerCtx()
    expect(captureError(() => listKanbanCards(withRole(ctx, 'worker', { capabilities: [] }), {})).code).toBe('unauthorized')
  })
})

/** What a fresh claim leaves empty on an attempt view. */
const UNREPORTED_ATTEMPT = {
  machineId: null,
  leaseExpiresAt: null,
  heartbeatAt: null,
  progressNote: null,
  outputs: null,
  evidence: null,
  reviewComment: null,
  submittedAt: null,
  decidedAt: null
}

describe('getKanbanCard', () => {
  it('returns the full card with its body, criteria and every attempt oldest first, never the claim secret', () => {
    const ctx = plannerCtx()
    const card = createKanbanCard(ctx, { title: 'Full', body: 'All of it', acceptanceCriteria: ['Works'] })
    moveTo(ctx, card.id, 'in_progress')
    const rejected = seedAttempt(ctx, card.id, { state: 'rejected', reviewComment: 'Add the test' })
    const outputs = { summary: 'First try', artifacts: [], commits: [], changedFiles: [], branch: null }
    const evidence = { checks: [], criteria: [], notes: 'none' }
    ctx.db.run(
      `UPDATE kanban_attempts SET outputs_json = ?, evidence_json = ?, submitted_at = ?, decided_at = ? WHERE id = ?`,
      JSON.stringify(outputs),
      JSON.stringify(evidence),
      '2026-01-01T00:10:00.000Z',
      '2026-01-01T00:20:00.000Z',
      rejected
    )
    ctx.clock.advanceSeconds(3600)
    const open = seedAttempt(ctx, card.id, { state: 'claimed', number: 2 })

    const view = getKanbanCard(withRole(ctx, 'worker'), { cardId: card.id })

    expect(view).toMatchObject({
      id: card.id,
      body: 'All of it',
      acceptanceCriteria: [{ id: 'c1', text: 'Works' }],
      lane: 'in_progress',
      openAttempt: { number: 2, state: 'claimed' },
      kickBackCount: 1
    })
    expect(view.attempts).toEqual([
      {
        ...UNREPORTED_ATTEMPT,
        id: rejected,
        cardId: card.id,
        number: 1,
        state: 'rejected',
        outputs,
        evidence,
        reviewComment: 'Add the test',
        createdAt: '2026-01-01T00:00:00.000Z',
        submittedAt: '2026-01-01T00:10:00.000Z',
        decidedAt: '2026-01-01T00:20:00.000Z'
      },
      { ...UNREPORTED_ATTEMPT, id: open, cardId: card.id, number: 2, state: 'claimed', createdAt: '2026-01-01T01:00:00.000Z' }
    ])
    expect(JSON.stringify(view)).not.toContain('hashed-secret')
  })
})

describe('getKanbanCard refusals', () => {
  it('returns not_found for an unknown card and requires read', () => {
    const ctx = plannerCtx()
    const card = createKanbanCard(ctx, { title: 'Here' })
    expect(captureError(() => getKanbanCard(ctx, { cardId: 'kc_0000000000000000000000zzzz' })).code).toBe('not_found')
    expect(captureError(() => getKanbanCard(withRole(ctx, 'worker', { capabilities: [] }), { cardId: card.id })).code).toBe('unauthorized')
  })
})

describe('card reference images', () => {
  const stage = (ctx: TestCtx, seed: number, purpose: 'evidence' | 'reference' = 'reference'): string =>
    createStagedAttachment(ctx, { bytes: pngBytes(40, 30, seed), label: `shot ${seed}`, purpose }).id
  const owned = (ctx: TestCtx, cardId: string): string[] =>
    ctx.db.all<{ id: string }>("SELECT id FROM attachments WHERE owner_kind = 'kanban_card' AND owner_id = ? ORDER BY id", cardId).map((row) => row.id)

  it('claims the ids on create, and get_kanban_card returns their references', () => {
    const ctx = plannerCtx()
    const ids = [stage(ctx, 1), stage(ctx, 2)]
    const card = createKanbanCard(ctx, { title: 'With mockups', attachments: ids })
    expect(card.attachments?.map((ref) => ref.id)).toEqual([...ids].sort())
    expect(owned(ctx, card.id)).toEqual([...ids].sort())
    expect(getKanbanCard(ctx, { cardId: card.id }).attachments).toEqual(card.attachments)
    expect(card.attachments?.[0]).toMatchObject({ mime: 'image/png', width: 40, height: 30, purpose: 'reference' })
  })

  it('leaves the view without an attachments key when there are none', () => {
    const ctx = plannerCtx()
    const card = createKanbanCard(ctx, { title: 'Plain' })
    expect('attachments' in card).toBe(false)
  })

  it('get_kanban_card flags a card image whose bytes are not stored, and only that one', () => {
    const ctx = plannerCtx()
    const ids = [stage(ctx, 1), stage(ctx, 2)].sort()
    const card = createKanbanCard(ctx, { title: 'With mockups', attachments: ids })
    ctx.db.run('UPDATE attachments SET data = NULL, missing = 1 WHERE id = ?', ids[0])
    const attachments = getKanbanCard(ctx, { cardId: card.id }).attachments
    expect(attachments?.[0]).toEqual({ ...card.attachments?.[0], missing: true })
    expect(attachments?.[1]).toEqual(card.attachments?.[1])
    expect(attachments?.[1]).not.toHaveProperty('missing')
  })

})

describe('card reference images on update', () => {
  const stage = (ctx: TestCtx, seed: number, purpose: 'evidence' | 'reference' = 'reference'): string =>
    createStagedAttachment(ctx, { bytes: pngBytes(40, 30, seed), label: `shot ${seed}`, purpose }).id
  const owned = (ctx: TestCtx, cardId: string): string[] =>
    ctx.db.all<{ id: string }>("SELECT id FROM attachments WHERE owner_kind = 'kanban_card' AND owner_id = ? ORDER BY id", cardId).map((row) => row.id)

  it('replaces the list on update: a dropped id is a deleted row, an omitted list keeps them, a new id is claimed', () => {
    const ctx = plannerCtx()
    const [a, b] = [stage(ctx, 1), stage(ctx, 2)] as [string, string]
    const card = createKanbanCard(ctx, { title: 'Edit me', attachments: [a, b] })
    const kept = updateKanbanCard(ctx, { cardId: card.id, expectedRevision: 1, title: 'Edit me again' })
    expect(kept.attachments).toHaveLength(2)
    const c = stage(ctx, 3)
    const edited = updateKanbanCard(ctx, { cardId: card.id, expectedRevision: 2, attachments: [b, c] })
    expect(edited.attachments?.map((ref) => ref.id)).toEqual([b, c].sort())
    expect(ctx.db.get('SELECT id FROM attachments WHERE id = ?', a)).toBeUndefined()
    const emptied = updateKanbanCard(ctx, { cardId: card.id, expectedRevision: 3, attachments: [] })
    expect('attachments' in emptied).toBe(false)
    expect(owned(ctx, card.id)).toEqual([])
    const events = kanbanEvents(ctx).filter((event) => event.kind === 'updated')
    expect(events[0]?.payload).toEqual({ revision: 2, fields: ['title'] })
    expect(events[1]?.payload).toEqual({ revision: 3, fields: ['attachments'] })
  })

  it('refuses an evidence-purpose image, a foreign-owned one, an unknown one and a repeat, storing nothing', () => {
    const ctx = plannerCtx()
    const other = createKanbanCard(ctx, { title: 'Other', attachments: [stage(ctx, 1)] })
    const foreign = owned(ctx, other.id)[0] ?? ''
    const evidence = stage(ctx, 2, 'evidence')
    const fine = stage(ctx, 3)
    const before = cardCount(ctx)
    expect(captureError(() => createKanbanCard(ctx, { title: 'x', attachments: [evidence] })).code).toBe('invalid_input')
    expect(captureError(() => createKanbanCard(ctx, { title: 'x', attachments: [foreign] })).code).toBe('conflict')
    expect(captureError(() => createKanbanCard(ctx, { title: 'x', attachments: ['im_0000000000000000000000zzzz'] })).code).toBe('not_found')
    expect(captureError(() => createKanbanCard(ctx, { title: 'x', attachments: [fine, fine] })).code).toBe('invalid_input')
    expect(cardCount(ctx)).toBe(before)
    const card = createKanbanCard(ctx, { title: 'Target', attachments: [fine] })
    expect(captureError(() => updateKanbanCard(ctx, { cardId: card.id, expectedRevision: 1, attachments: [fine, evidence] })).code).toBe('invalid_input')
    expect(owned(ctx, card.id)).toEqual([fine])
    expect(getKanbanCard(ctx, { cardId: card.id }).revision).toBe(1)
  })
})
