/**
 * Imports an old-style `/board` (already read and parsed) into Dark Mechanicus: each open board epic
 * that no earlier import brought in becomes a Backlog epic whose plan is an unsaved draft. Nothing is
 * saved, exported or committed; the person reviews each draft and presses Save.
 *
 * An earlier import is recognized by the source it recorded (see `../board/imports.ts`): an import note
 * in the intent of any saved revision or the draft of an epic, or a board ticket reference on one of
 * its tickets. Every revision counts, so editing the note out later does not hide the import.
 */
import type { BoardImportView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import { boardImportView, boardReferenceSource, boardSourceKeys, openBoardEpicImport, recordedBoardSources } from '../board/imports'
import type { BoardEpic, BoardParse } from '../board/parse'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import type { Ctx } from '../context'
import { parseInput } from '../schemas'
import { updatePlanDraft } from './drafts'
import { createEpic } from './epics'
import { requestWithoutKey, withIdempotency } from './idempotency'

/** Every plan an epic has had: its saved revisions and its draft. */
const PLANS_SQL = 'SELECT epic_id, bundle_json FROM plan_revisions UNION ALL SELECT epic_id, bundle_json FROM drafts'

interface IntentRow {
  epic_id: string
  intent: string | null
}

interface ReferenceRow {
  epic_id: string
  location: string | null
}

/** Each recorded board source and the oldest epic that records it. */
function recordedSources(ctx: Ctx): Map<string, string> {
  const intents = ctx.db.all<IntentRow>(
    `SELECT p.epic_id, json_extract(p.bundle_json, '$.epic.intent') AS intent FROM (${PLANS_SQL}) p
     WHERE json_extract(p.bundle_json, '$.epic.intent') LIKE '%Imported from%/board%'`
  )
  const references = ctx.db.all<ReferenceRow>(
    `SELECT p.epic_id, json_extract(r.value, '$.location') AS location
     FROM (${PLANS_SQL}) p, json_each(p.bundle_json, '$.tickets') t, json_each(t.value, '$.references') r
     WHERE json_extract(r.value, '$.kind') = 'file' AND json_extract(r.value, '$.label') LIKE 'Board ticket %'`
  )
  const keysByEpic = new Map<string, string[]>()
  const record = (epicId: string, keys: string[]): void => {
    keysByEpic.set(epicId, [...(keysByEpic.get(epicId) ?? []), ...keys])
  }
  for (const row of intents) {
    record(row.epic_id, recordedBoardSources(row.intent ?? ''))
  }
  for (const row of references) {
    const key = boardReferenceSource(row.location ?? '')
    record(row.epic_id, key === null ? [] : [key])
  }
  const sources = new Map<string, string>()
  const oldestFirst = ctx.db.all<{ id: string }>('SELECT id FROM epics ORDER BY created_at, id')
  for (const { id } of oldestFirst) {
    for (const key of keysByEpic.get(id) ?? []) {
      if (!sources.has(key)) {
        sources.set(key, id)
      }
    }
  }
  return sources
}

/**
 * Finds the epic an earlier import created from a board epic, or null. The recorded sources are read
 * once, on the first question, so a board without open epics never scans the plans.
 */
function importFinder(ctx: Ctx): (epic: BoardEpic) => string | null {
  let sources: Map<string, string> | null = null
  return (epic) => {
    sources ??= recordedSources(ctx)
    for (const key of boardSourceKeys(epic)) {
      const epicId = sources.get(key)
      if (epicId !== undefined) {
        return epicId
      }
    }
    return null
  }
}

/**
 * Creates the epic and fills its draft. The inputs pass the command schemas first: board text is
 * untrusted, and the parser's limits are checked again where they matter.
 */
function createFromBoard(ctx: Ctx, epic: BoardEpic): string {
  const { createEpic: input, ops } = openBoardEpicImport(epic)
  const created = createEpic(ctx, parseInput(COMMAND_SCHEMAS.createEpic, input, `board epic ${epic.boardId}`))
  const draft = parseInput(COMMAND_SCHEMAS.updatePlanDraft, { epicId: created.id, ops }, `board epic ${epic.boardId}`)
  updatePlanDraft(ctx, draft)
  return created.id
}

/** What importing `board` would do, changing nothing. Without a database nothing was imported yet. */
export function previewBoardImport(ctx: Ctx | null, board: BoardParse): BoardImportView {
  if (ctx !== null) {
    requireCapability(ctx.session, 'read')
  }
  const importedAs = ctx === null ? () => null : importFinder(ctx)
  return boardImportView(board, (epic) => {
    const epicId = importedAs(epic)
    return epicId === null ? { state: 'new', epicId: null } : { state: 'imported', epicId }
  })
}

/**
 * Creates every open board epic that was not imported before, all in one transaction, so a failure
 * creates nothing and a concurrent import sees all of it or none. A repeated idempotency key returns
 * the first result.
 */
export function importBoard(ctx: Ctx, board: BoardParse, input: { idempotencyKey?: string }): BoardImportView {
  requireCapability(ctx.session, 'epic.create')
  const scope = { command: 'importBoard', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => {
    const importedAs = importFinder(ctx)
    return boardImportView(board, (epic) => {
      const earlier = importedAs(epic)
      return earlier === null ? { state: 'created', epicId: createFromBoard(ctx, epic) } : { state: 'imported', epicId: earlier }
    })
  })
}
