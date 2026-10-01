import { describe, expect, it } from 'vitest'
import { errorOf, seedEpic } from '../../test/checkpointSeed'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { searchHistory } from './history'
import { indexComment, indexDocument } from './searchIndex'

function seedHistory(ctx: TestCtx): { alpha: string; beta: string } {
  const alpha = seedEpic(ctx, 'Driver selection')
  const beta = seedEpic(ctx, 'Packaging spike')
  indexDocument(ctx.db, {
    docType: 'ticket',
    docId: 'tk_schema',
    epicId: alpha,
    ticketId: 'tk_schema',
    title: 'Schema migration',
    body: 'Create the tables for the shared schema'
  })
  indexDocument(ctx.db, {
    docType: 'attempt',
    docId: 'at_lock',
    epicId: alpha,
    runId: 'rn_one',
    ticketId: 'tk_schema',
    title: 'DM-1 attempt 1 accepted',
    body: 'Migration lock verified across processes'
  })
  indexDocument(ctx.db, {
    docType: 'report',
    docId: 'rp_signing',
    epicId: beta,
    runId: 'rn_two',
    title: 'Sprint 1 report',
    body: 'macOS codesign failed: no identity in keychain'
  })
  return { alpha, beta }
}

function docIds(ctx: TestCtx, query: string, epicId?: string): string[] {
  return searchHistory(ctx, { query, epicId }).map((result) => result.docId).sort()
}

describe('searchHistory results', () => {
  it('finds tickets, attempt outcomes, and reports by keyword with snippets and epic titles', () => {
    const ctx = createTestCtx()
    const { alpha, beta } = seedHistory(ctx)
    expect(searchHistory(ctx, { query: 'tables' })).toEqual([
      {
        docType: 'ticket',
        docId: 'tk_schema',
        epicId: alpha,
        epicTitle: 'Driver selection',
        runId: null,
        ticketId: 'tk_schema',
        title: 'Schema migration',
        snippet: 'Create the [tables] for the shared schema'
      }
    ])
    expect(searchHistory(ctx, { query: 'keychain' })).toEqual([
      {
        docType: 'report',
        docId: 'rp_signing',
        epicId: beta,
        epicTitle: 'Packaging spike',
        runId: 'rn_two',
        ticketId: null,
        title: 'Sprint 1 report',
        snippet: 'macOS codesign failed: no identity in [keychain]'
      }
    ])
    expect(searchHistory(ctx, { query: 'verified' }).map((result) => [result.docType, result.runId])).toEqual([['attempt', 'rn_one']])
  })

  it('matches word prefixes, requires every term, and can stay within one epic', () => {
    const ctx = createTestCtx()
    const { alpha, beta } = seedHistory(ctx)
    expect(docIds(ctx, 'migr')).toEqual(['at_lock', 'tk_schema'])
    expect(docIds(ctx, 'migration lock')).toEqual(['at_lock'])
    expect(docIds(ctx, 'migration keychain')).toEqual([])
    expect(docIds(ctx, 'migr', alpha)).toEqual(['at_lock', 'tk_schema'])
    expect(docIds(ctx, 'migr', beta)).toEqual([])
  })

  it('reports an empty epic title for results whose epic is gone', () => {
    const ctx = createTestCtx()
    indexDocument(ctx.db, { docType: 'ticket', docId: 'tk_orphan', epicId: 'ep_missing', title: 'Orphan', body: 'lonely' })
    expect(searchHistory(ctx, { query: 'lonely' }).map((result) => result.epicTitle)).toEqual([''])
  })
})

describe('searchHistory comment results', () => {
  it('finds comments by body or author and identifies them as comments', () => {
    const ctx = createTestCtx()
    const { alpha } = seedHistory(ctx)
    indexComment(ctx.db, {
      id: 'cm_note',
      epicId: alpha,
      ticketId: 'tk_schema',
      body: 'Migration blocked until the fixture lands',
      author: { role: 'reviewer', label: 'Ada' }
    })
    expect(searchHistory(ctx, { query: 'fixture' })).toEqual([
      {
        docType: 'comment',
        docId: 'cm_note',
        epicId: alpha,
        epicTitle: 'Driver selection',
        runId: null,
        ticketId: 'tk_schema',
        title: 'Comment by Ada',
        snippet: 'Migration blocked until the [fixture] lands'
      }
    ])
    expect(docIds(ctx, 'ada')).toEqual(['cm_note'])
    expect(docIds(ctx, 'migration')).toEqual(['at_lock', 'cm_note', 'tk_schema'])
  })
})

describe('searchHistory query sanitizing', () => {
  it('returns nothing for blank or punctuation-only queries', () => {
    const ctx = createTestCtx()
    seedHistory(ctx)
    expect(['', '   ', '"*():^', '\t\n'].map((query) => searchHistory(ctx, { query }))).toEqual([[], [], [], []])
  })

  it('treats FTS operators and syntax as plain words instead of throwing', () => {
    const ctx = createTestCtx()
    seedHistory(ctx)
    const hostile = [
      'tables OR keychain',
      'NEAR(tables schema)',
      'title:schema',
      '"unbalanced',
      'tables AND',
      'NOT tables',
      '{title body}: tables x',
      "') DROP TABLE epics; --"
    ]
    expect(hostile.map((query) => docIds(ctx, query))).toEqual(hostile.map(() => []))
    const decorated = ['tables*', '(tables)', 'tab"les', '^tables', '-tables', 'TABLES', 'shared-schema']
    expect(decorated.map((query) => docIds(ctx, query))).toEqual(decorated.map(() => ['tk_schema']))
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM epics')?.n).toBe(2)
  })
})

describe('searchHistory limits and access', () => {
  function seedMany(ctx: TestCtx): void {
    const epicId = seedEpic(ctx, 'Bulk')
    for (let n = 0; n < 105; n += 1) {
      indexDocument(ctx.db, { docType: 'ticket', docId: `tk_${n}`, epicId, title: `Ticket ${n}`, body: 'common words' })
    }
  }

  it('returns 20 results by default and clamps the limit to 1..100', () => {
    const ctx = createTestCtx()
    seedMany(ctx)
    const counts = [undefined, 100, 500, 0, -5, 3.7, Number.NaN].map(
      (limit) => searchHistory(ctx, { query: 'common', limit }).length
    )
    expect(counts).toEqual([20, 100, 100, 1, 1, 3, 20])
  })

  it('requires read access', () => {
    const ctx = createTestCtx({ capabilities: [] })
    expect(errorOf(() => searchHistory(ctx, { query: 'anything' })).code).toBe('unauthorized')
  })
})
