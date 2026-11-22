import { join } from 'node:path'
import { z } from 'zod'
import { fail } from '../errors'
import { writeFileSafely } from './finalizer'
import { layoutUnder, resolveLayout } from './layout'
import { rebuildCheckpoint } from './migrationCheckpoint'
import { nodeFs as fs } from './nodeFs'
import { assertContained } from './paths'
import type { StorageMode } from './storageMode'
import type { RepoLayout } from './types'

const receiptSchema = z.strictObject({ source: z.string(), member: z.string(), mode: z.enum(['repo', 'db']) })
const PORTABLE = ['epics', 'history', 'profiles', 'kanban', 'knowledge', 'observations', 'project.json']

function readReceipt(receipt: string, source: string, member: string) {
  const saved = receiptSchema.parse(JSON.parse(fs.readFile(receipt)))
  if (saved.source !== source || saved.member !== member) fail('conflict', 'The Forge migration backup belongs to another source.')
  return saved
}

function movePortable(original: RepoLayout, destination: RepoLayout, backup: RepoLayout): void {
  for (const name of PORTABLE) {
    const from = join(original.dmDir, name)
    const to = join(backup.dmDir, name)
    assertContained(original, fs, from)
    assertContained(destination, fs, to)
    if (!fs.exists(from)) continue
    if (fs.exists(to)) fail('conflict', 'Both original and backup portable records exist; the source was kept for inspection.')
    fs.rename(from, to)
  }
}

/** The original SQLite handle can remain open on Windows. Keep it ignored and fenced;
 * reconstruct its verified checkpoint privately, then retire unlocked portable paths one at a time. */
export function retireForcedStore(home: string, source: string, member: string, mode?: StorageMode): void {
  const destination = resolveLayout(member)
  const backup = layoutUnder(member, 'repo', join(destination.localDir, 'pre-forge-source'))
  const receipt = join(backup.localDir, 'retirement.json')
  assertContained(destination, fs, receipt)
  if (fs.exists(receipt)) {
    const saved = readReceipt(receipt, source, member)
    if (mode && mode !== saved.mode) fail('conflict', 'The Forge migration backup has a different storage mode.')
    mode = saved.mode
  }
  if (!mode) return
  const original = resolveLayout(source, { mode, homeDir: home })
  const env = { fs, layout: destination }
  fs.mkdirp(backup.localDir)
  writeFileSafely(env, receipt, JSON.stringify({ source, member, mode }))
  const checkpoint = join(destination.localDir, 'migration-records.json')
  assertContained(destination, fs, checkpoint)
  assertContained(destination, fs, backup.dbFile)
  rebuildCheckpoint(backup.dbFile, fs.readFile(checkpoint)).close()
  if (fs.exists(original.machineFile)) {
    assertContained(original, fs, original.machineFile)
    writeFileSafely(env, backup.machineFile, fs.readFile(original.machineFile))
  }
  // This durable fence survives deletion or replacement of the public pointer.
  writeFileSafely({ fs, layout: original }, join(original.localDir, 'forge-retired.json'), JSON.stringify({ member }))
  movePortable(original, destination, backup)
  // Keep .gitignore and local/ in place until every original private byte can be removed safely.
}

/** Preserve the retired physical database too. Windows refuses this rename while any
 * source handle remains open; callers may resume after closing those handles. */
export function archiveRetiredForgeStore(home: string, source: string, member: string): void {
  const destination = resolveLayout(member)
  const backup = layoutUnder(member, 'repo', join(destination.localDir, 'pre-forge-source'))
  const receipt = join(backup.localDir, 'retirement.json')
  assertContained(destination, fs, receipt)
  if (!fs.exists(receipt)) return
  const saved = readReceipt(receipt, source, member)
  const original = resolveLayout(source, { mode: saved.mode, homeDir: home })
  if (!fs.exists(original.dmDir)) return
  const marker = join(original.localDir, 'forge-retired.json')
  assertContained(original, fs, marker)
  if (!fs.exists(marker) || JSON.parse(fs.readFile(marker)).member !== member) fail('conflict', 'The destination already contains a ticket store.')
  const archive = join(backup.localDir, 'retired-open-store')
  assertContained(destination, fs, archive)
  if (fs.exists(archive)) fail('conflict', 'A retained source archive already exists; inspect both stores before restoring.')
  if (!fs.exists(backup.projectFile) || !fs.exists(backup.dbFile)) fail('conflict', 'The original private backup is incomplete; the retained source was kept.')
  try { fs.rename(original.dmDir, archive) }
  catch { fail('conflict', 'Close every session using the original code repository, then retry the storage move. Its retired database remains safely archived in place.') }
}
