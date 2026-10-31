/**
 * One-time move of the connected agents from the legacy `userData/agents.json` into the `agents`
 * table. The `app_meta` key `legacyAgentsImported` records the outcome, so it runs once per database.
 */
import { readFileSync, rmSync } from 'node:fs'
import { z } from 'zod'
import type { Db } from '../../core/db/database'
import { AGENT_KINDS } from '../../shared/desktop/agentKinds'
import { writeBuiltInAgent } from './agentRegistry'

/** The filesystem surface the importer uses; tests inject fakes and faults through it. */
export interface LegacyImportFs {
  /** Throws an error with `code: 'ENOENT'` for a missing file. */
  readFile(path: string): string
  /** Deletes the file; a missing file is not an error. */
  removeFile(path: string): void
}

const MARKER_KEY = 'legacyAgentsImported'

type Marker = 'imported' | 'none' | 'unreadable'

const legacyFileSchema = z.object({
  version: z.literal(1),
  agents: z.array(z.unknown())
})

const legacyEntrySchema = z.object({
  kind: z.enum(AGENT_KINDS),
  executablePath: z.string().min(1),
  version: z.string().nullable(),
  connectedVia: z.enum(['found', 'downloaded']),
  connectedAt: z.string(),
  lastProbed: z.string()
})

type LegacyEntry = z.infer<typeof legacyEntrySchema>

const nodeImportFs: LegacyImportFs = {
  readFile: (path) => readFileSync(path, 'utf8'),
  removeFile: (path) => {
    rmSync(path, { force: true })
  }
}

type ReadResult = { kind: 'missing' } | { kind: 'unreadable'; reason: string } | { kind: 'valid'; entries: LegacyEntry[] }

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function readLegacyFile(fs: LegacyImportFs, file: string): ReadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFile(file))
  } catch (error: unknown) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'unreadable', reason: String(error) }
  }
  const shape = legacyFileSchema.safeParse(parsed)
  if (!shape.success) {
    return { kind: 'unreadable', reason: 'not a version 1 agents file' }
  }
  // Invalid entries are dropped, as the JSON registry did when it loaded them.
  const entries = shape.data.agents.flatMap((item) => {
    const entry = legacyEntrySchema.safeParse(item)
    return entry.success ? [entry.data] : []
  })
  return { kind: 'valid', entries }
}

function setMarker(db: Db, marker: Marker): void {
  db.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', MARKER_KEY, marker)
}

/**
 * Imports `file` into `db` once. Never throws: an unreadable file or a failed transaction is logged
 * and leaves the file in place (a failed transaction is retried on the next start).
 */
export function importLegacyAgents(options: {
  db: Db
  file: string
  fs?: LegacyImportFs
  log: (line: string) => void
}): void {
  const { db, file, log } = options
  const fs = options.fs ?? nodeImportFs
  try {
    const marker = db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', MARKER_KEY)?.value
    if (marker !== undefined) {
      // A crash between the commit and the delete leaves the file behind; finish the delete only.
      if (marker === 'imported') {
        fs.removeFile(file)
      }
      return
    }
    const result = readLegacyFile(fs, file)
    if (result.kind === 'missing') {
      setMarker(db, 'none')
      return
    }
    if (result.kind === 'unreadable') {
      setMarker(db, 'unreadable')
      log(`Left unreadable ${file} in place and imported no agents: ${result.reason}`)
      return
    }
    db.tx(() => {
      // DO NOTHING skips kinds already present and repeated kinds (the first entry wins).
      for (const entry of result.entries) {
        writeBuiltInAgent(db, entry, false)
      }
      setMarker(db, 'imported')
    })
    fs.removeFile(file)
  } catch (error: unknown) {
    log(`Importing connected agents from ${file} failed: ${String(error)}`)
  }
}
