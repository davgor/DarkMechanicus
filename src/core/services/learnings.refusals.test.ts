/**
 * DM-934: a stored learning that breaks the record contract is an internal fault, never shown as a learning, and a
 * replacement whose new content breaks the draft contract is refused with the reason, changing nothing.
 */
import { describe, expect, it } from 'vitest'
import { captureError } from '../../test/authoring'
import { learningDraft, seedLearning } from '../../test/learningRecords'
import { createTestCtx, withRole } from '../../test/testContext'
import { getLearning, listLearnings, replaceLearning } from './learnings'

describe('stored learnings that break the record contract', () => {
  it('fails as internal instead of returning a malformed learning', () => {
    const ctx = withRole(createTestCtx(), 'desktop')
    const learningId = seedLearning(ctx.db, 1, learningDraft({ title: '' }), ctx.clock.nowIso())
    expect(captureError(() => getLearning(ctx, { learningId }))).toMatchObject({
      code: 'internal',
      message: `Stored learning ${learningId} does not match the learning record contract.`
    })
    expect(captureError(() => listLearnings(ctx, {})).code).toBe('internal')
  })
})

describe('replacement content', () => {
  it('refuses new content that breaks the draft contract and leaves the learning active', () => {
    const ctx = withRole(createTestCtx(), 'desktop')
    const learningId = seedLearning(ctx.db, 1, learningDraft(), ctx.clock.nowIso())
    const { title: _title, evidence: _evidence, replaces: _replaces, ...rest } = learningDraft()
    const error = captureError(() =>
      replaceLearning(ctx, { learningId, expectedRevision: 1, reason: 'Sharper title', replacement: { ...rest, title: 'two\nlines' } })
    )
    expect(error).toMatchObject({ code: 'invalid_input', message: 'Invalid replacement: Must be one non-empty line without control characters' })
    expect(getLearning(ctx, { learningId }).learning).toMatchObject({ state: 'active', revision: 1 })
    expect(listLearnings(ctx, { state: 'all' })).toHaveLength(1)
  })
})
