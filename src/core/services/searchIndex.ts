import type { CommentView } from '../../shared/domain/views'
import type { Db } from '../db/database'

type SearchDocType = 'epic' | 'ticket' | 'attempt' | 'report' | 'comment'

export interface SearchDocument {
  docType: SearchDocType
  docId: string
  epicId: string
  runId?: string | null
  ticketId?: string | null
  title: string
  body: string
}

const INSERT_DOCUMENT = `INSERT INTO search_index (doc_type, doc_id, epic_id, run_id, ticket_id, title, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)`

function insertDocument(db: Db, doc: SearchDocument): void {
  db.run(INSERT_DOCUMENT, doc.docType, doc.docId, doc.epicId, doc.runId ?? null, doc.ticketId ?? null, doc.title, doc.body)
}

/** Upserts one full-text search document (delete + insert; FTS5 has no primary key). */
export function indexDocument(db: Db, doc: SearchDocument): void {
  db.run('DELETE FROM search_index WHERE doc_type = ? AND doc_id = ?', doc.docType, doc.docId)
  insertDocument(db, doc)
}

/**
 * Upserts many documents of one type, as `indexDocument` does each: one DELETE for all of them (each DELETE scans the
 * whole index, since FTS5 cannot index `doc_id`), then one INSERT each.
 */
export function indexDocuments(db: Db, docType: SearchDocType, docs: readonly Omit<SearchDocument, 'docType'>[]): void {
  db.run(
    'DELETE FROM search_index WHERE doc_type = ? AND doc_id IN (SELECT value FROM json_each(?))',
    docType,
    JSON.stringify(docs.map((doc) => doc.docId))
  )
  for (const doc of docs) {
    insertDocument(db, { ...doc, docType })
  }
}

/** Indexes a comment's Markdown under its epic (and ticket), titled with its author. */
export function indexComment(db: Db, comment: Pick<CommentView, 'id' | 'epicId' | 'ticketId' | 'body' | 'author'>): void {
  indexDocument(db, {
    docType: 'comment',
    docId: comment.id,
    epicId: comment.epicId,
    ticketId: comment.ticketId,
    title: `Comment by ${comment.author.label}`,
    body: comment.body
  })
}
