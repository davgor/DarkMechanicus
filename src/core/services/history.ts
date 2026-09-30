import type { SearchResultView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

interface SearchRow {
  doc_type: SearchResultView['docType']
  doc_id: string
  epic_id: string
  epic_title: string
  run_id: string | null
  ticket_id: string | null
  title: string
  snippet: string
}

/**
 * Turns free text into a safe FTS5 expression: every term is reduced to letters, digits, `_`, and
 * `-`, quoted as a phrase, and prefix-matched (`"term"*`); terms are ANDed. Operators such as OR,
 * NEAR, column filters, and stray quotes become plain words, so user input can never be FTS syntax.
 */
function matchExpression(query: string): string {
  return query
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((term) => term !== '')
    .map((term) => `"${term}"*`)
    .join(' ')
}

function clampLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_LIMIT
  return Number.isFinite(value) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(value))) : DEFAULT_LIMIT
}

/** Keyword search over indexed epics, tickets, attempt outcomes, and sprint reports (best match first). */
export function searchHistory(
  ctx: Ctx,
  input: { query: string; limit?: number; epicId?: string }
): SearchResultView[] {
  requireCapability(ctx.session, 'read')
  const match = matchExpression(input.query)
  if (match === '') {
    return []
  }
  const epicId = input.epicId ?? null
  const rows = ctx.db.all<SearchRow>(
    `SELECT search_index.doc_type AS doc_type, search_index.doc_id AS doc_id, search_index.epic_id AS epic_id,
       IFNULL(epics.title, '') AS epic_title, search_index.run_id AS run_id, search_index.ticket_id AS ticket_id,
       search_index.title AS title, snippet(search_index, 6, '[', ']', '…', 12) AS snippet
     FROM search_index LEFT JOIN epics ON epics.id = search_index.epic_id
     WHERE search_index MATCH ? AND (? IS NULL OR search_index.epic_id = ?)
     ORDER BY rank LIMIT ?`,
    match,
    epicId,
    epicId,
    clampLimit(input.limit)
  )
  return rows.map((row) => ({
    docType: row.doc_type,
    docId: row.doc_id,
    epicId: row.epic_id,
    epicTitle: row.epic_title,
    runId: row.run_id,
    ticketId: row.ticket_id,
    title: row.title,
    snippet: row.snippet
  }))
}
