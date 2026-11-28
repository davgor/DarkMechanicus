import { describe, expect, it } from 'vitest'
import {
  type LearningDraft,
  learningLinkProblems,
  type LearningReplacementContent
} from '../../shared/domain/learnings'
import type { SessionRole } from '../../shared/domain/views'
import { captureError } from '../../test/authoring'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { contentHash } from '../canonical'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { encodeBase32 } from '../ids'
import { getLearning, listLearnings, replaceLearning, retireLearning } from './learnings'

const id = (prefix: string, n: number): string => `${prefix}_${encodeBase32(BigInt(n), 26)}`
const SOURCE = { runId: id('rn', 901), sprintId: id('sp', 902), cardId: id('kc', 903), attemptId: id('ka', 904) }
const HASH = `sha256:${'a'.repeat(64)}`
const AGENT_ROLES: SessionRole[] = ['planner', 'orchestrator', 'worker', 'reviewer', 'reader']

function draft(overrides: Partial<LearningDraft> = {}): LearningDraft {
  return {
    title: 'Run the migration tests',
    rule: 'Run the migration upgrade tests before submitting a schema change.',
    check: 'The attempt evidence lists the migration test run.',
    applicability: { roles: ['worker'], events: ['ticket.claimed'], paths: ['src/core/db/**'] },
    evidence: [{ kind: 'rejected_attempt', sourceId: 'at_rejected-1', contentHash: HASH }],
    replaces: null,
    ...overrides
  }
}

const REPLACEMENT: LearningReplacementContent = {
  title: 'Run migration and import tests',
  rule: 'Run the migration upgrade and import tests before submitting a schema change.',
  check: 'The attempt evidence lists both test runs.',
  applicability: { roles: ['worker', 'orchestrator'], events: [], paths: ['src/core/db/**', 'src/core/repo/**'] }
}

/** Stores a published learning and its `published` history entry, as publication will. */
function seed(ctx: TestCtx, n: number, definition: LearningDraft = draft()): string {
  // Far above the test context's sequential ids, which number the replacements a test creates.
  const learningId = id('lr', 10_000 + n)
  ctx.db.run(
    `INSERT INTO learning_records (id, run_id, sprint_id, card_id, attempt_id, definition_json, definition_hash, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    learningId, SOURCE.runId, SOURCE.sprintId, SOURCE.cardId, SOURCE.attemptId,
    JSON.stringify(definition), contentHash(definition), ctx.clock.nowIso()
  )
  ctx.db.run(
    `INSERT INTO learning_events (learning_id, kind, reason, revision, actor_role, actor_label, run_id, sprint_id, card_id, attempt_id, at)
     VALUES (?, 'published', 'Approved learning card', 1, 'desktop', 'test desktop', ?, ?, ?, ?, ?)`,
    learningId, SOURCE.runId, SOURCE.sprintId, SOURCE.cardId, SOURCE.attemptId, ctx.clock.nowIso()
  )
  ctx.clock.advanceSeconds(60)
  return learningId
}

function human(): TestCtx {
  return withRole(createTestCtx(), 'desktop')
}

const rows = (ctx: TestCtx): unknown[] => ctx.db.all('SELECT * FROM learning_records ORDER BY id')
const events = (ctx: TestCtx): unknown[] => ctx.db.all('SELECT * FROM learning_events ORDER BY seq')
/** The workspace events another window's feed routes (`kind`, `session_id` and the id payload). */
const changeEvents = (ctx: TestCtx): unknown[] =>
  ctx.db.all<{ kind: string; session_id: string; payload_json: string }>("SELECT kind, session_id, payload_json FROM events WHERE kind LIKE 'kanban.learning%' ORDER BY seq")
    .map((row) => ({ kind: row.kind, sessionId: row.session_id, payload: JSON.parse(row.payload_json) as unknown }))

describe('reading learnings', () => {
  it.each(['desktop', ...AGENT_ROLES] as SessionRole[])('lets a %s session list and get stored guidance with its provenance', (role) => {
    const ctx = human()
    const learningId = seed(ctx, 1)
    const reader = withRole(ctx, role)
    const [listed] = listLearnings(reader, {})
    expect(listed).toMatchObject({
      id: learningId,
      ...draft(),
      source: SOURCE,
      state: 'active',
      replacedBy: null,
      revision: 1,
      definitionHash: contentHash(draft())
    })
    const detail = getLearning(reader, { learningId })
    expect(detail.learning).toEqual(listed)
    expect(detail.history).toEqual([
      expect.objectContaining({ learningId, kind: 'published', reason: 'Approved learning card', revision: 1, source: SOURCE, relatedId: null })
    ])
  })

  it('fails with not_found for an unknown learning', () => {
    expect(captureError(() => getLearning(human(), { learningId: id('lr', 77) })).code).toBe('not_found')
  })
})

describe('human-only mutations', () => {
  it.each(AGENT_ROLES)('refuses a %s session retirement and replacement and changes nothing', (role) => {
    const ctx = human()
    const learningId = seed(ctx, 1)
    const before = [rows(ctx), events(ctx)]
    const agent = withRole(ctx, role, { allowSave: true })
    expect(captureError(() => retireLearning(agent, { learningId, expectedRevision: 1, reason: 'Agent says stale' })).code).toBe('unauthorized')
    expect(captureError(() => replaceLearning(agent, { learningId, expectedRevision: 1, reason: 'Agent rewrite', replacement: REPLACEMENT })).code).toBe('unauthorized')
    expect([rows(ctx), events(ctx)]).toEqual(before)
  })
})

describe('retireLearning', () => {
  it('retires at the matching revision with the reason, keeps the definition and appends history', () => {
    const ctx = human()
    const learningId = seed(ctx, 1)
    const definition = ctx.db.get('SELECT definition_json, definition_hash FROM learning_records')
    const retired = retireLearning(ctx, { learningId, expectedRevision: 1, reason: 'The migration suite was merged into import tests' })
    expect(retired).toMatchObject({ state: 'retired', retiredReason: 'The migration suite was merged into import tests', replacedBy: null, revision: 2, evidence: draft().evidence, source: SOURCE })
    expect(ctx.db.get('SELECT definition_json, definition_hash FROM learning_records')).toEqual(definition)
    expect(getLearning(ctx, { learningId }).history.map((entry) => [entry.kind, entry.revision, entry.actor.role])).toEqual([
      ['published', 1, 'desktop'],
      ['retired', 2, 'desktop']
    ])
    // DM-983: one `kanban.*` workspace event, which every window routes to its Learnings refresh token.
    expect(changeEvents(ctx)).toEqual([{ kind: 'kanban.learning_retired', sessionId: ctx.session.id, payload: { learningId, cardId: SOURCE.cardId, replacementId: null } }])
  })

  it('excludes retired learnings from the default list but keeps them on request', () => {
    const ctx = human()
    const kept = seed(ctx, 1)
    const gone = seed(ctx, 2)
    retireLearning(ctx, { learningId: gone, expectedRevision: 1, reason: 'Obsolete' })
    expect(listLearnings(ctx, {}).map((learning) => learning.id)).toEqual([kept])
    expect(listLearnings(ctx, { state: 'retired' }).map((learning) => learning.id)).toEqual([gone])
    expect(listLearnings(ctx, { state: 'all' }).map((learning) => learning.id)).toEqual([gone, kept])
  })

  it('rejects a stale revision with conflict and an already retired learning with invalid_state', () => {
    const ctx = human()
    const learningId = seed(ctx, 1)
    retireLearning(ctx, { learningId, expectedRevision: 1, reason: 'First person retires it' })
    const before = [rows(ctx), events(ctx), changeEvents(ctx)]
    const stale = captureError(() => retireLearning(ctx, { learningId, expectedRevision: 1, reason: 'Second person, stale view' }))
    expect(stale).toMatchObject({ code: 'conflict', details: { learningId, currentRevision: 2 } })
    expect(captureError(() => retireLearning(ctx, { learningId, expectedRevision: 2, reason: 'Again' })).code).toBe('invalid_state')
    expect([rows(ctx), events(ctx), changeEvents(ctx)]).toEqual(before)
  })

  it('replays the original result for a repeated idempotency key', () => {
    const ctx = human()
    const learningId = seed(ctx, 1)
    const input = { learningId, expectedRevision: 1, reason: 'Obsolete', idempotencyKey: 'retire-1' }
    const first = retireLearning(ctx, input)
    expect(retireLearning(ctx, input)).toEqual(first)
    expect(events(ctx)).toHaveLength(2)
    expect(changeEvents(ctx)).toHaveLength(1)
  })
})

describe('replaceLearning', () => {
  it('creates a linked new version with the new content and the original evidence, and retires the predecessor', () => {
    const ctx = human()
    const learningId = seed(ctx, 1)
    const original = ctx.db.get('SELECT definition_json, definition_hash, run_id, sprint_id, card_id, attempt_id FROM learning_records')
    const { retired, replacement } = replaceLearning(ctx, { learningId, expectedRevision: 1, reason: 'Import tests catch the same defect', replacement: REPLACEMENT })
    expect(replacement).toMatchObject({
      ...REPLACEMENT,
      evidence: draft().evidence,
      source: SOURCE,
      replaces: learningId,
      state: 'active',
      revision: 1
    })
    expect(replacement.id).not.toBe(learningId)
    expect(retired).toMatchObject({ id: learningId, state: 'retired', replacedBy: replacement.id, retiredReason: 'Import tests catch the same defect', revision: 2, ...draft() })
    expect(ctx.db.get('SELECT definition_json, definition_hash, run_id, sprint_id, card_id, attempt_id FROM learning_records WHERE id = ?', learningId)).toEqual(original)
    expect(learningLinkProblems([retired, replacement])).toEqual([])
    expect(listLearnings(ctx, {}).map((learning) => learning.id)).toEqual([replacement.id])
    expect(getLearning(ctx, { learningId }).history.map((entry) => [entry.kind, entry.relatedId, entry.revision])).toEqual([
      ['published', null, 1],
      ['replaced', replacement.id, 2]
    ])
    expect(getLearning(ctx, { learningId: replacement.id }).history).toEqual([
      expect.objectContaining({ kind: 'created_by_replacement', relatedId: learningId, reason: 'Import tests catch the same defect', revision: 1, source: SOURCE })
    ])
  })

  it('rejects stale concurrent edits with conflict and creates nothing', () => {
    const ctx = human()
    const learningId = seed(ctx, 1)
    const { replacement } = replaceLearning(ctx, { learningId, expectedRevision: 1, reason: 'First edit', replacement: REPLACEMENT })
    const before = [rows(ctx), events(ctx), changeEvents(ctx)]
    const second = { ...REPLACEMENT, title: 'A competing edit' }
    expect(captureError(() => replaceLearning(ctx, { learningId, expectedRevision: 1, reason: 'Second edit', replacement: second }))).toMatchObject({
      code: 'conflict',
      details: { learningId, currentRevision: 2 }
    })
    expect(captureError(() => replaceLearning(ctx, { learningId: replacement.id, expectedRevision: 3, reason: 'Wrong revision', replacement: second })).code).toBe('conflict')
    expect([rows(ctx), events(ctx), changeEvents(ctx)]).toEqual(before)
  })

  it('refuses a replacement that repeats the content unchanged', () => {
    const ctx = human()
    const learningId = seed(ctx, 1)
    const { title, rule, check, applicability } = draft()
    expect(captureError(() => replaceLearning(ctx, { learningId, expectedRevision: 1, reason: 'Nothing new', replacement: { title, rule, check, applicability } })).code).toBe('invalid_input')
    expect(rows(ctx)).toHaveLength(1)
  })
})

describe('learning change events (DM-983)', () => {
  it('appends one kanban.learning_replaced event naming both learnings for a replacement', () => {
    const ctx = human()
    const learningId = seed(ctx, 1)
    const { replacement } = replaceLearning(ctx, { learningId, expectedRevision: 1, reason: 'Sharper rule', replacement: REPLACEMENT })
    expect(changeEvents(ctx)).toEqual([
      { kind: 'kanban.learning_replaced', sessionId: ctx.session.id, payload: { learningId, cardId: SOURCE.cardId, replacementId: replacement.id } }
    ])
  })
})

describe('append-only searchable history', () => {
  it('refuses any update or deletion of a history entry', () => {
    const ctx = human()
    const learningId = seed(ctx, 1)
    retireLearning(ctx, { learningId, expectedRevision: 1, reason: 'Obsolete' })
    expect(() => ctx.db.run("UPDATE learning_events SET reason = 'rewritten'")).toThrow('Learning history is append-only')
    expect(() => ctx.db.run('DELETE FROM learning_events')).toThrow('Learning history is append-only')
    expect(events(ctx)).toHaveLength(2)
  })

  it('finds learnings by every query word across content, source links and history reasons', () => {
    const ctx = human()
    const migration = seed(ctx, 1)
    const lint = seed(ctx, 2, draft({ title: 'Lint changed files', rule: 'Run oxlint over the changed files.', check: 'Lint output is attached.' }))
    retireLearning(ctx, { learningId: lint, expectedRevision: 1, reason: 'Superseded by the CI gate' })
    expect(listLearnings(ctx, { state: 'all', query: 'MIGRATION upgrade' }).map((learning) => learning.id)).toEqual([migration])
    expect(listLearnings(ctx, { state: 'all', query: 'superseded gate' }).map((learning) => learning.id)).toEqual([lint])
    expect(listLearnings(ctx, { state: 'all', query: SOURCE.cardId }).map((learning) => learning.id)).toEqual([lint, migration])
    expect(listLearnings(ctx, { state: 'all', query: 'at_rejected-1' })).toHaveLength(2)
    expect(listLearnings(ctx, { state: 'all', query: 'migration superseded' })).toEqual([])
    expect(listLearnings(ctx, { query: 'superseded' })).toEqual([])
  })
})

describe('management input schemas', () => {
  const valid = { learningId: id('lr', 1), expectedRevision: 1, reason: 'Obsolete', replacement: REPLACEMENT }
  const accepts = (schema: keyof typeof COMMAND_SCHEMAS, input: unknown): boolean => COMMAND_SCHEMAS[schema].safeParse(input).success

  it('accepts well-formed reads and changes', () => {
    expect(accepts('listLearnings', {})).toBe(true)
    expect(accepts('listLearnings', { state: 'retired', query: 'lint', limit: 200 })).toBe(true)
    expect(accepts('getLearning', { learningId: valid.learningId })).toBe(true)
    expect(accepts('retireLearning', { learningId: valid.learningId, expectedRevision: 1, reason: 'Obsolete' })).toBe(true)
    expect(accepts('replaceLearning', valid)).toBe(true)
  })

  it.each([
    ['no reason', { ...valid, reason: undefined }],
    ['an empty reason', { ...valid, reason: '' }],
    ['a multi-line reason', { ...valid, reason: 'one\ntwo' }],
    ['an over-long reason', { ...valid, reason: 'x'.repeat(501) }],
    ['no revision', { ...valid, expectedRevision: undefined }],
    ['a negative revision', { ...valid, expectedRevision: -1 }],
    ['a malformed id', { ...valid, learningId: 'lr_1' }],
    ['replacement evidence', { ...valid, replacement: { ...REPLACEMENT, evidence: draft().evidence } }],
    ['a replacement link', { ...valid, replacement: { ...REPLACEMENT, replaces: id('lr', 2) } }],
    ['an authority field', { ...valid, authority: 'approve' }],
    ['an unsafe path', { ...valid, replacement: { ...REPLACEMENT, applicability: { ...REPLACEMENT.applicability, paths: ['../etc'] } } }],
    ['a desktop role', { ...valid, replacement: { ...REPLACEMENT, applicability: { ...REPLACEMENT.applicability, roles: ['desktop'] } } }]
  ])('rejects a replacement with %s', (_label, input) => {
    expect(accepts('replaceLearning', input)).toBe(false)
  })

  it('rejects a retirement without a reason or with an unknown field, and an unknown list state', () => {
    expect(accepts('retireLearning', { learningId: valid.learningId, expectedRevision: 1 })).toBe(false)
    expect(accepts('retireLearning', { learningId: valid.learningId, expectedRevision: 1, reason: 'x', replacedBy: id('lr', 2) })).toBe(false)
    expect(accepts('listLearnings', { state: 'draft' })).toBe(false)
    expect(accepts('listLearnings', { limit: 201 })).toBe(false)
  })
})
