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

/** Upserts one full-text search document (delete + insert; FTS5 has no primary key). */
export function indexDocument(db: Db, doc: SearchDocument): void {
  db.run('DELETE FROM search_index WHERE doc_type = ? AND doc_id = ?', doc.docType, doc.docId)
  db.run(
    `INSERT INTO search_index (doc_type, doc_id, epic_id, run_id, ticket_id, title, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    doc.docType,
    doc.docId,
    doc.epicId,
    doc.runId ?? null,
    doc.ticketId ?? null,
    doc.title,
    doc.body
  )
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
