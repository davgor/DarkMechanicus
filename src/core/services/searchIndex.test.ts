import { describe, expect, it } from 'vitest'
import { createTestDb } from '../../test/testContext'
import type { Db } from '../db/database'
import { indexComment, indexDocument, type SearchDocument } from './searchIndex'

function doc(overrides: Partial<SearchDocument> = {}): SearchDocument {
  return {
    docType: 'ticket',
    docId: 'tk_1',
    epicId: 'ep_1',
    title: 'Planning the migration',
    body: 'Move the database layer over',
    ...overrides
  }
}

function hits(db: Db, query: string): string[] {
  return db
    .all<{ doc_type: string; doc_id: string }>(
      'SELECT doc_type, doc_id FROM search_index WHERE search_index MATCH ? ORDER BY doc_type, doc_id',
      query
    )
    .map((row) => `${row.doc_type}:${row.doc_id}`)
}

describe('indexDocument storage', () => {
  it('stores every field of the document', () => {
    const db = createTestDb()
    indexDocument(db, doc({ runId: 'rn_1', ticketId: 'tk_1' }))
    expect(db.all('SELECT * FROM search_index')).toEqual([
      {
        doc_type: 'ticket',
        doc_id: 'tk_1',
        epic_id: 'ep_1',
        run_id: 'rn_1',
        ticket_id: 'tk_1',
        title: 'Planning the migration',
        body: 'Move the database layer over'
      }
    ])
  })

  it('stores absent run and ticket references as null', () => {
    const db = createTestDb()
    indexDocument(db, doc())
    expect(db.all('SELECT run_id, ticket_id FROM search_index')).toEqual([{ run_id: null, ticket_id: null }])
    indexDocument(db, doc({ docId: 'tk_2', runId: null, ticketId: null }))
    expect(db.all('SELECT COUNT(*) AS n FROM search_index WHERE run_id IS NULL')).toEqual([{ n: 2 }])
  })

  it('accepts empty title and body', () => {
    const db = createTestDb()
    indexDocument(db, doc({ title: '', body: '' }))
    expect(db.all('SELECT title, body FROM search_index')).toEqual([{ title: '', body: '' }])
  })

  it('stores punctuation and quotes verbatim', () => {
    const db = createTestDb()
    const title = `Fix "quotes" & 'apostrophes'; DROP TABLE x --`
    indexDocument(db, doc({ title }))
    expect(db.get<{ title: string }>('SELECT title FROM search_index')?.title).toBe(title)
  })
})

describe('indexDocument search', () => {
  it('makes title and body words searchable', () => {
    const db = createTestDb()
    indexDocument(db, doc())
    expect(hits(db, 'migration')).toEqual(['ticket:tk_1'])
    expect(hits(db, 'database')).toEqual(['ticket:tk_1'])
    expect(hits(db, 'unrelated')).toEqual([])
  })

  it('matches case-insensitively and by stem', () => {
    const db = createTestDb()
    indexDocument(db, doc())
    expect(hits(db, 'PLAN')).toEqual(['ticket:tk_1'])
    expect(hits(db, 'layers')).toEqual(['ticket:tk_1'])
  })

  it('can restrict a search to the title column', () => {
    const db = createTestDb()
    indexDocument(db, doc({ docId: 'a', title: 'plan', body: 'nothing' }))
    indexDocument(db, doc({ docId: 'b', title: 'nothing', body: 'plan' }))
    expect(hits(db, 'title:plan')).toEqual(['ticket:a'])
    expect(hits(db, 'plan')).toEqual(['ticket:a', 'ticket:b'])
  })

  it('does not index the reference columns', () => {
    const db = createTestDb()
    indexDocument(db, doc({ docId: 'uniqueidvalue', epicId: 'epicidvalue', ticketId: 'ticketidvalue' }))
    expect(hits(db, 'uniqueidvalue')).toEqual([])
    expect(hits(db, 'epicidvalue')).toEqual([])
    expect(hits(db, 'ticketidvalue')).toEqual([])
  })
})

describe('indexDocument upsert', () => {
  it('replaces an earlier version of the same document', () => {
    const db = createTestDb()
    indexDocument(db, doc({ title: 'Old headline', body: 'obsolete text' }))
    indexDocument(db, doc({ title: 'Fresh headline', body: 'current text' }))
    expect(db.all('SELECT COUNT(*) AS n FROM search_index')).toEqual([{ n: 1 }])
    expect(hits(db, 'obsolete')).toEqual([])
    expect(hits(db, 'current')).toEqual(['ticket:tk_1'])
    expect(hits(db, 'fresh')).toEqual(['ticket:tk_1'])
  })

  it('updates the reference columns when re-indexing', () => {
    const db = createTestDb()
    indexDocument(db, doc({ epicId: 'ep_1', runId: 'rn_1' }))
    indexDocument(db, doc({ epicId: 'ep_2', runId: null }))
    expect(db.all('SELECT epic_id, run_id FROM search_index')).toEqual([{ epic_id: 'ep_2', run_id: null }])
  })

  it('keeps documents of other types and ids', () => {
    const db = createTestDb()
    indexDocument(db, doc({ docType: 'epic', docId: 'shared', title: 'epic version' }))
    indexDocument(db, doc({ docType: 'ticket', docId: 'shared', title: 'ticket version' }))
    indexDocument(db, doc({ docType: 'ticket', docId: 'other', title: 'other version' }))
    indexDocument(db, doc({ docType: 'ticket', docId: 'shared', title: 'ticket revised' }))
    expect(hits(db, 'version')).toEqual(['epic:shared', 'ticket:other'])
    expect(hits(db, 'revised')).toEqual(['ticket:shared'])
    expect(hits(db, 'ticket')).toEqual(['ticket:shared'])
  })
})

const COMMENT = {
  id: 'cm_1',
  epicId: 'ep_1',
  ticketId: 'tk_7',
  body: 'Blocked until the **keychain** fix lands',
  author: { role: 'worker' as const, label: 'worker-3' }
}

describe('indexComment', () => {
  it('indexes a ticket comment by body and author under its epic and ticket', () => {
    const db = createTestDb()
    indexComment(db, COMMENT)
    expect(db.all('SELECT * FROM search_index')).toEqual([
      {
        doc_type: 'comment',
        doc_id: 'cm_1',
        epic_id: 'ep_1',
        run_id: null,
        ticket_id: 'tk_7',
        title: 'Comment by worker-3',
        body: 'Blocked until the **keychain** fix lands'
      }
    ])
    expect(hits(db, 'keychain')).toEqual(['comment:cm_1'])
    expect(hits(db, 'worker')).toEqual(['comment:cm_1'])
  })

  it('indexes an epic-level comment without a ticket, once per comment id', () => {
    const db = createTestDb()
    indexComment(db, { ...COMMENT, ticketId: null })
    indexComment(db, { ...COMMENT, ticketId: null })
    expect(db.all('SELECT doc_id, ticket_id FROM search_index')).toEqual([{ doc_id: 'cm_1', ticket_id: null }])
  })
})
