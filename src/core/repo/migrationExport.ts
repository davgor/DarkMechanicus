import { prettyJson } from '../canonical'
import type { Clock } from '../clock'
import type { Db } from '../db/database'
import { loadStoredAttachment, placementOfAttachment, writeAttachmentFile } from './attachmentFiles'
import { writeFileSafely } from './finalizer'
import { ownedPaths } from './paths'
import {
  buildCommentRecord, buildEpicPointerRecord, buildEpicStateRecord, buildKanbanCardRecord,
  buildKanbanEventRecord, buildProfileRecord, buildRunHistoryRecord, buildSnapshotRecord,
  trackedCommentHash, trackedEpicHash, trackedKanbanCardHash, trackedKanbanEventHash, trackedProfileHash, trackedRunHash
} from './portable'
import type { FsAdapter, RepoLayout } from './types'

interface ExportDeps { db: Db; fs: FsAdapter; layout: RepoLayout; clock: Clock }

class MigrationExporter {
  readonly paths
  constructor(readonly deps: ExportDeps) { this.paths = ownedPaths(deps.layout) }

  write(path: string, record: unknown): string {
    const text = prettyJson(record)
    writeFileSafely(this.deps, path, text)
    return text
  }

  synced(kind: string, id: string, hash: string, generation = 1): void {
    this.deps.db.run(`INSERT INTO sync_state (kind, entity_id, exported_hash, imported_hash, generation, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, entity_id) DO UPDATE SET
      exported_hash = excluded.exported_hash, imported_hash = excluded.imported_hash,
      generation = excluded.generation, conflict = NULL`, kind, id, hash, hash, generation, this.deps.clock.nowIso())
  }
}

function exportEpics(writer: MigrationExporter): Set<string> {
  const { db } = writer.deps
  const { paths } = writer
  const savedEpics = new Set<string>()
  for (const epic of db.all<{ id: string; current_revision_id: string | null; updated_at: string }>('SELECT id, current_revision_id, updated_at FROM epics ORDER BY id')) {
    // Unsaved plans, and their comments, remain machine-local just as they do in ordinary repo mode.
    if (epic.current_revision_id === null) continue
    savedEpics.add(epic.id)
    for (const revision of db.all<{ id: string }>("SELECT id FROM plan_revisions WHERE epic_id = ? AND state = 'saved' ORDER BY number", epic.id)) {
      writer.write(paths.snapshotFile(epic.id, revision.id), buildSnapshotRecord(db, revision.id))
    }
    const generation = db.get<{ generation: number }>("SELECT generation FROM sync_state WHERE kind = 'epic' AND entity_id = ?", epic.id)?.generation || 1
    const meta = { generation, updatedAt: epic.updated_at }
    const state = writer.write(paths.epicStateFile(epic.id), buildEpicStateRecord(db, epic.id, meta))
    const pointer = writer.write(paths.epicPointerFile(epic.id), buildEpicPointerRecord(buildSnapshotRecord(db, epic.current_revision_id), meta))
    writer.synced('epic', epic.id, trackedEpicHash(pointer, state), generation)
  }
  return savedEpics
}

function exportOtherRecords(writer: MigrationExporter, savedEpics: ReadonlySet<string>): void {
  const { db } = writer.deps
  const { paths } = writer
  for (const row of db.all<{ id: string }>('SELECT id FROM runs ORDER BY id')) {
    writer.synced('run', row.id, trackedRunHash(writer.write(paths.runHistoryFile(row.id), buildRunHistoryRecord(db, row.id))))
  }
  for (const row of db.all<{ id: string; epic_id: string }>('SELECT id, epic_id FROM comments ORDER BY id')) {
    if (savedEpics.has(row.epic_id)) writer.synced('comment', row.id, trackedCommentHash(writer.write(paths.commentFile(row.epic_id, row.id), buildCommentRecord(db, row.id))))
  }
  for (const row of db.all<{ name: string }>('SELECT name FROM profiles ORDER BY name')) {
    writer.synced('profile', row.name, trackedProfileHash(writer.write(paths.profileFile(row.name), buildProfileRecord(db, row.name))))
  }
  for (const row of db.all<{ id: string }>('SELECT id FROM kanban_cards ORDER BY id')) {
    writer.synced('kanban_card', row.id, trackedKanbanCardHash(writer.write(paths.kanbanCardFile(row.id), buildKanbanCardRecord(db, row.id, { generation: 1 }))))
  }
  for (const row of db.all<{ id: string; card_id: string }>('SELECT id, card_id FROM kanban_events ORDER BY id')) {
    writer.synced('kanban_event', row.id, trackedKanbanEventHash(writer.write(paths.kanbanEventFile(row.card_id, row.id), buildKanbanEventRecord(db, row.id))))
  }
}

function exportImages(writer: MigrationExporter, savedEpics: ReadonlySet<string>): void {
  const { db } = writer.deps
  const { paths } = writer
  for (const row of db.all<{ id: string }>('SELECT id FROM attachments WHERE owner_id IS NOT NULL ORDER BY id')) {
    const attachment = loadStoredAttachment(db, row.id)
    const placement = placementOfAttachment(db, attachment)
    // An unsaved epic has no portable pointer to import its images against yet.
    if (placement.folder.kind === 'epic' && !savedEpics.has(placement.folder.id)) continue
    writeAttachmentFile(writer.deps, attachment, placement)
    writer.write(paths.attachmentSidecarFile(placement.folder, attachment.id), {
      id: attachment.id, sha256: attachment.sha256, createdBy: attachment.createdBy, createdAt: attachment.createdAt
    })
    writer.synced('attachment', attachment.id, attachment.sha256)
  }
}

/** Uses existing portable formats without saving drafts, incrementing revisions, or replaying historical events. */
export function exportMigrationRecords(deps: ExportDeps): void {
  const writer = new MigrationExporter(deps)
  const savedEpics = exportEpics(writer)
  exportOtherRecords(writer, savedEpics)
  exportImages(writer, savedEpics)
}
