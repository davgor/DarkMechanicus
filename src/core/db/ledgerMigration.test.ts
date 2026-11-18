/**
 * DM-170 c1: the metric observation ledger migration opens repositories written before it without changing saved
 * plan or report content hashes, and newer storage (a newer database or a newer observation record format) is
 * refused without changing anything. The legacy records are real files copied from an older checkout.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { MetricObservation } from '../../shared/domain/space'
import { createRepoEnv, createStubGit, flush, importerDeps, initProject, type RepoEnv } from '../../test/repoEnv'
import { domainErrorOf } from '../../test/repoFixtures'
import { createTestCtx } from '../../test/testContext'
import { contentHash, prettyJson } from '../canonical'
import { reconcileRepository } from '../repo/importer'
import { ownedPaths } from '../repo/paths'
import { buildRunHistoryRecord, buildSnapshotRecord } from '../repo/portable'
import { listObservations, recordObservations } from '../services/observations'
import { parseObservation } from '../space/contract'
import { type Db, openDatabase } from './database'
import { MIGRATIONS, migrate, readSchemaVersion, SCHEMA_VERSION } from './migrations'

const LEGACY_DIR = fileURLToPath(new URL('../repo/__mocks__/legacy/', import.meta.url))
const FIXTURE_FILE = fileURLToPath(new URL('../space/fixtures/observations.json', import.meta.url))
const EPIC = 'ep_01m3txy30qavmd5wewct90804g'
const REVISION = 'rv_01m3txzpv9ws6fbj6p211ghkn9'
const RUN = 'rn_01m3txzt9wj79mxsq50f5ktf1q'
const ATTEMPT = 'at_01m3ty3wbx2tfbac4r970t19dn'

/** The migration that creates the ledger, found by what it does rather than by number. */
const LEDGER = MIGRATIONS.find((migration) => migration.sql.includes('CREATE TABLE metric_observations'))?.version ?? Number.NaN
const COPIED = ['epics', 'plan_revisions', 'ticket_status', 'runs', 'attempts', 'sprint_reports', 'checkpoints', 'outbox', 'sync_state']

function legacyText(...parts: string[]): string {
  return readFileSync(join(LEGACY_DIR, ...parts), 'utf8').replace(/\r\n/g, '\n')
}

/** An initialized repository whose tracked records are the legacy fixtures, as after a clone. */
function legacyClone(): RepoEnv {
  const env = createRepoEnv({ root: '/legacy' })
  initProject(env)
  const paths = ownedPaths(env.layout)
  env.fs.put(join(env.layout.dmDir, 'project.json'), legacyText('project.json'))
  env.fs.put(paths.epicPointerFile(EPIC), legacyText('epics', EPIC, 'current.json'))
  env.fs.put(paths.epicStateFile(EPIC), legacyText('epics', EPIC, 'state.json'))
  env.fs.put(paths.snapshotFile(EPIC, REVISION), legacyText('epics', EPIC, 'snapshots', `${REVISION}.json`))
  env.fs.put(paths.runHistoryFile(RUN), legacyText('history', RUN, 'run.json'))
  return env
}

function dump(db: Db): string {
  return JSON.stringify(COPIED.map((table) => db.all(`SELECT * FROM ${table} ORDER BY 1`)))
}

function columnsOf(db: Db, table: string): Set<string> {
  return new Set(db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name))
}

/** A database at the version before the ledger, holding the imported legacy rows. */
function preLedgerDb(): Db {
  const source = legacyClone()
  reconcileRepository(importerDeps(source, createStubGit()))
  const old = openDatabase(':memory:')
  migrate(old, MIGRATIONS.filter((migration) => migration.version < LEDGER))
  for (const table of COPIED) {
    const existing = columnsOf(old, table)
    for (const row of source.db.all<Record<string, string | number | null>>(`SELECT * FROM ${table}`)) {
      const columns = Object.keys(row).filter((column) => existing.has(column))
      old.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...columns.map((c) => row[c] ?? null))
    }
  }
  return old
}

function tokenObservation(ticketId: string | null) {
  return {
    metric: 'tokens_total',
    unit: 'tokens',
    scope: { level: 'attempt', epicId: EPIC, sprintId: null, runId: RUN, ticketId, attemptId: ATTEMPT },
    source: { kind: 'host', actor: 'claude-code-adapter' },
    measurement: { state: 'observed', value: 52000 },
    accumulation: 'delta',
    sequence: null,
    observedAt: '2026-01-01T00:00:00.000Z',
    attributes: {},
    evidence: []
  }
}

describe('DM-170 c1: the ledger migration opens existing repositories unchanged', () => {
  it('is part of this build, before or at SCHEMA_VERSION', () => {
    expect(Number.isInteger(LEDGER)).toBe(true)
    expect(LEDGER).toBeLessThanOrEqual(SCHEMA_VERSION)
  })

  it('migrating a pre-ledger database keeps every row, plan and report content hash, and adds an empty ledger', () => {
    const old = preLedgerDb()
    expect(readSchemaVersion(old)).toBe(LEDGER - 1)
    const before = dump(old)
    const outboxSeq = old.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'outbox'")?.seq
    expect(migrate(old, MIGRATIONS.filter((migration) => migration.version <= LEDGER))).toEqual({ from: LEDGER - 1, to: LEDGER })
    expect(dump(old)).toBe(before)
    expect(old.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'outbox'")?.seq).toBe(outboxSeq)
    const revision = old.get<{ content_hash: string; bundle_json: string }>('SELECT content_hash, bundle_json FROM plan_revisions WHERE id = ?', REVISION)
    expect(contentHash(JSON.parse(revision?.bundle_json ?? 'null'))).toBe(revision?.content_hash)
    const report = old.get<{ content_hash: string; content_json: string }>('SELECT content_hash, content_json FROM sprint_reports')
    expect(contentHash(JSON.parse(report?.content_json ?? 'null'))).toBe(report?.content_hash)
    expect(old.get<{ n: number }>('SELECT COUNT(*) AS n FROM metric_observations')?.n).toBe(0)
    expect(old.all('PRAGMA foreign_key_check')).toEqual([])
  })

  it('after migrating to SCHEMA_VERSION the legacy snapshot and run records serialize byte for byte', () => {
    const old = preLedgerDb()
    expect(migrate(old)).toEqual({ from: LEDGER - 1, to: SCHEMA_VERSION })
    expect(prettyJson(buildSnapshotRecord(old, REVISION))).toBe(legacyText('epics', EPIC, 'snapshots', `${REVISION}.json`))
    expect(prettyJson(buildRunHistoryRecord(old, RUN))).toBe(legacyText('history', RUN, 'run.json'))
    expect(migrate(old)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION })
  })

  it('recording and exporting an observation leaves the legacy snapshot and run files byte for byte', () => {
    const env = legacyClone()
    reconcileRepository(importerDeps(env, createStubGit()))
    const ticketId = env.db.get<{ ticket_id: string }>('SELECT ticket_id FROM attempts WHERE id = ?', ATTEMPT)?.ticket_id ?? null
    recordObservations(createTestCtx({ db: env.db, clock: env.clock }), [tokenObservation(ticketId)])
    expect(flush(env).failed).toBe(0)
    const paths = ownedPaths(env.layout)
    expect(env.fs.readdir(paths.observationsDir(EPIC))).toHaveLength(1)
    expect(env.fs.get(paths.snapshotFile(EPIC, REVISION))).toBe(legacyText('epics', EPIC, 'snapshots', `${REVISION}.json`))
    expect(env.fs.get(paths.runHistoryFile(RUN))).toBe(legacyText('history', RUN, 'run.json'))
  })

  it('observation records written before the newer ledger fields parse to the same content hash, adding no fields', () => {
    const fixtures = (JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as { observations: MetricObservation[] }).observations
    expect(fixtures.length).toBeGreaterThan(0)
    for (const fixture of fixtures) {
      const parsed = parseObservation(fixture)
      expect(contentHash(parsed)).toBe(contentHash(fixture))
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(fixture).sort())
    }
  })
})

describe('DM-170 c1: newer storage is refused safely', () => {
  it('a database newer than SCHEMA_VERSION is refused with incompatible_schema and left as it was', () => {
    const newer = openDatabase(':memory:')
    migrate(newer)
    newer.run("INSERT INTO meta (key, value) VALUES ('probe', 'kept')")
    newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    const error = domainErrorOf(() => migrate(newer))
    expect(error.code).toBe('incompatible_schema')
    expect(error.details).toEqual({ found: SCHEMA_VERSION + 1, supported: SCHEMA_VERSION })
    expect(readSchemaVersion(newer)).toBe(SCHEMA_VERSION + 1)
    expect(newer.get<{ value: string }>("SELECT value FROM meta WHERE key = 'probe'")?.value).toBe('kept')
  })

  it('an observation record of a newer formatVersion is rejected on import and nothing of it is stored', () => {
    const source = legacyClone()
    reconcileRepository(importerDeps(source, createStubGit()))
    const ticketId = source.db.get<{ ticket_id: string }>('SELECT ticket_id FROM attempts WHERE id = ?', ATTEMPT)?.ticket_id ?? null
    recordObservations(createTestCtx({ db: source.db, clock: source.clock }), [tokenObservation(ticketId)])
    flush(source)
    const paths = ownedPaths(source.layout)
    const [name] = source.fs.readdir(paths.observationsDir(EPIC))
    const record = JSON.parse(source.fs.get(join(paths.observationsDir(EPIC), name ?? '')) ?? '{}') as { formatVersion: number; observation: MetricObservation }
    expect(record.formatVersion).toBe(1)

    const clone = legacyClone()
    const file = ownedPaths(clone.layout).observationFile(EPIC, record.observation.observationId)
    clone.fs.put(file, prettyJson({ ...record, formatVersion: record.formatVersion + 1 }))
    const result = reconcileRepository(importerDeps(clone, createStubGit()))
    expect(result.rejected.map((item) => item.path)).toEqual([`.darkmechanicus/epics/${EPIC}/observations/${record.observation.observationId}.json`])
    expect(listObservations(clone.db)).toEqual([])
    expect(result.imported).toEqual(expect.arrayContaining([EPIC, RUN]))
  })
})
