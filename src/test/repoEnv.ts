/** In-memory repository + database environments for finalizer/importer tests. Not shipped. */
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Db } from '../core/db/database'
import type { IdGenerator } from '../core/ids'
import { createFileHashCache } from '../core/repo/fileHashes'
import { flushOutbox, type FinalizerDeps, type FlushOutcome } from '../core/repo/finalizer'
import type { ImporterDeps } from '../core/repo/importer'
import { initializeRepository } from '../core/repo/initialize'
import { resolveLayout } from '../core/repo/layout'
import type { GitAdapter, RepoLayout } from '../core/repo/types'
import type { PlanBundle } from '../shared/domain/bundle'
import { makeBundle } from './bundles'
import { createMemoryFs, type MemoryFs } from './memoryFs'
import { createSaveHook, insertEpic, insertOutbox, insertRevision, type RecordingSaveHook } from './repoFixtures'
import { createSequentialIds, createTestClock, createTestDb, type TestClock } from './testContext'

export interface RepoEnv extends FinalizerDeps {
  root: string
  layout: RepoLayout
  fs: MemoryFs
  db: Db
  clock: TestClock
  hook: RecordingSaveHook
}

export function createRepoEnv(options: { root?: string; fs?: MemoryFs; clock?: TestClock } = {}): RepoEnv {
  const root = resolve(options.root ?? '/repo')
  const layout = resolveLayout(root)
  const fs = options.fs ?? createMemoryFs()
  fs.mkdirp(layout.dmDir)
  const db = createTestDb()
  const clock = options.clock ?? createTestClock()
  return { root, layout, fs, db, clock, hook: createSaveHook(db, clock) }
}

interface StagedRevision {
  epicId: string
  revisionId: string
  number: number
  bundle?: PlanBundle
  baseRevisionId?: string | null
}

/** Records a pending revision and its snapshot outbox entry, like a Save request. */
export function stageRevision(env: RepoEnv, input: StagedRevision): number {
  if (env.db.get('SELECT id FROM epics WHERE id = ?', input.epicId) === undefined) {
    insertEpic(env.db, { id: input.epicId })
  }
  insertRevision(env.db, {
    id: input.revisionId,
    epicId: input.epicId,
    number: input.number,
    bundle: input.bundle ?? makeBundle([[1, 2]], [[1, 2]]),
    baseRevisionId: input.baseRevisionId ?? null,
    createdAt: env.clock.nowIso()
  })
  return insertOutbox(env.db, { kind: 'snapshot', epicId: input.epicId, revisionId: input.revisionId })
}

export function flush(env: RepoEnv): FlushOutcome {
  return flushOutbox(env, env.hook)
}

/** Stages and flushes one revision; returns the flush outcome. */
export function saveRevision(env: RepoEnv, input: StagedRevision): FlushOutcome {
  stageRevision(env, input)
  return flush(env)
}

interface StubGit extends GitAdapter {
  setBranch(branch: string | null): void
}

/** GitAdapter stub whose HEAD branch tests can move; CLI methods report an empty, clean repo. */
export function createStubGit(initial: string | null = 'main'): StubGit {
  let branch = initial
  return {
    head: () => ({ branch, commit: 'a'.repeat(40), detached: branch === null }),
    setBranch: (next) => {
      branch = next
    },
    countUncommitted: async () => 0,
    listLocalBranches: async () => [],
    listFiles: async () => [],
    showFile: async () => null,
    isAncestor: async () => null,
    commitParents: async () => null
  }
}

/** Initializes `.darkmechanicus/` (project, gitignore, machine) with deterministic ids. */
export function initProject(env: RepoEnv, ids: IdGenerator = createSequentialIds()): string {
  return initializeRepository({ layout: env.layout, fs: env.fs, ids, clock: env.clock }, { name: 'Demo' }).machineId
}

/** Copies tracked records (everything under `.darkmechanicus/` except `local/`), like a clone or pull. */
export function copyTracked(source: RepoEnv, target: RepoEnv): void {
  for (const [path, text] of source.fs.files()) {
    const rel = relative(source.layout.dmDir, path)
    const tracked = !rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== 'local'
    if (tracked) {
      target.fs.put(join(target.layout.dmDir, rel), text)
    }
  }
}

/** Importer dependencies with a fresh file hash cache, kept by callers that reuse the result across reconciles. */
export function importerDeps(env: RepoEnv, git: GitAdapter, machineId = 'mc_00000000000000000000000077'): ImporterDeps {
  const sessionId = 'ss_0000000000000000000000desk'
  return { db: env.db, layout: env.layout, fs: env.fs, clock: env.clock, machineId, git, sessionId, fileHashes: createFileHashCache() }
}

const DOMAIN_TABLES = ['epics', 'plan_revisions', 'drafts', 'ticket_status', 'runs', 'attempts', 'sprint_reports', 'checkpoints', 'row_checks', 'comments']

/** Every row of the durable domain tables, for "nothing changed" assertions. */
export function dumpDomain(db: Db): Record<string, unknown[]> {
  return Object.fromEntries(DOMAIN_TABLES.map((table) => [table, db.all(`SELECT * FROM ${table} ORDER BY 1`)]))
}
