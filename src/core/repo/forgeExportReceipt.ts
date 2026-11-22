import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { contentHash, prettyJson } from '../canonical'
import { openDatabase } from '../db/database'
import { fail } from '../errors'
import { writeFileSafely } from './finalizer'
import { readProject } from './initialize'
import { checkpointOf } from './migrationCheckpoint'
import { assertContained } from './paths'
import type { FsAdapter, RepoLayout } from './types'

const receiptSchema = z.strictObject({
  force: z.literal(true), source: z.string(), member: z.string(), projectId: z.string(),
  checkpointHash: z.string(), databaseHash: z.string(), portableHash: z.string()
})
const ownerSchema = receiptSchema.pick({ force: true, source: true, member: true, projectId: true })
type ExportEnv = { fs: FsAdapter; layout: RepoLayout; source: string }

export function recordForgeExportOwner(env: ExportEnv, projectId: string): void {
  writeFileSafely(env, join(env.layout.localDir, 'forge-owner.json'), prettyJson({ force: true, source: env.source, member: env.layout.root, projectId }))
}

function hasPayload(env: ExportEnv, dir: string): boolean {
  return env.fs.readdir(dir).some(name => {
    const path = join(dir, name)
    assertContained(env.layout, env.fs, path)
    return env.fs.isDirectory(path) ? hasPayload(env, path) : true
  })
}

export function verifyForgeExportOwner(env: ExportEnv, projectId: string): void {
  const file = join(env.layout.localDir, 'forge-owner.json')
  assertContained(env.layout, env.fs, file)
  if (!env.fs.exists(file)) {
    if (!hasPayload(env, env.layout.dmDir)) return
    fail('conflict', 'The incomplete Forge export has no ownership marker; it was kept for inspection.')
  }
  const owner = ownerSchema.parse(JSON.parse(env.fs.readFile(file)))
  if (contentHash(owner) !== contentHash({ force: true, source: env.source, member: env.layout.root, projectId })) {
    fail('conflict', 'The incomplete Forge export belongs to another source; it was kept for inspection.')
  }
}

function portableHash({ fs, layout }: ExportEnv): string {
  const files: [string, string][] = []
  function visit(path: string): void {
    assertContained(layout, fs, path)
    if (fs.isDirectory(path)) {
      for (const name of fs.readdir(path).sort()) visit(join(path, name))
    } else files.push([relative(layout.dmDir, path), createHash('sha256').update(fs.readFileBytes(path)).digest('hex')])
  }
  for (const name of fs.readdir(layout.dmDir).filter(name => name !== 'local').sort()) visit(join(layout.dmDir, name))
  return contentHash(files)
}

function currentReceipt(env: ExportEnv) {
  const { fs, layout, source } = env
  const project = readProject(layout, fs) ?? fail('conflict', 'The prepared Forge project is missing.')
  const checkpoint = join(layout.localDir, 'migration-records.json')
  assertContained(layout, fs, checkpoint)
  assertContained(layout, fs, layout.dbFile)
  if (!fs.exists(layout.dbFile)) fail('conflict', 'The prepared Forge database is missing.')
  const db = openDatabase(layout.dbFile)
  try {
    const tables = checkpointOf(db).tables.map(table => ({ ...table, rows: table.rows.map(row => contentHash(row)).sort() }))
    return { force: true as const, source, member: layout.root, projectId: project.projectId,
      checkpointHash: contentHash(fs.readFile(checkpoint)), databaseHash: contentHash(tables), portableHash: portableHash(env) }
  } finally { db.close() }
}

/** Stored inside the unpublished staging directory, so the destination rename publishes
 * both the complete export and the exact identity/content proof needed after process death. */
export function recordForgeExport(env: ExportEnv): void {
  writeFileSafely(env, join(env.layout.localDir, 'forge-export.json'), prettyJson(currentReceipt(env)))
}

export function verifyForgeExport(env: ExportEnv, projectId: string): void {
  const file = join(env.layout.localDir, 'forge-export.json')
  assertContained(env.layout, env.fs, file)
  if (!env.fs.exists(file)) fail('conflict', 'The prepared Forge export has no ownership receipt; the source was kept.')
  const receipt = receiptSchema.parse(JSON.parse(env.fs.readFile(file)))
  if (receipt.projectId !== projectId || contentHash(receipt) !== contentHash(currentReceipt(env))) {
    fail('conflict', 'The prepared Forge export changed or belongs to another source; the source was kept.')
  }
}
