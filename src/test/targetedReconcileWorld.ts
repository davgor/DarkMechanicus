/**
 * A real git repository whose `.darkmechanicus/` records another machine (an in-memory source) writes, and target
 * databases that reconcile it: for the targeted-reconcile tests. Not shipped.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ReconcileResultView } from '../shared/domain/views'
import type { Db } from '../core/db/database'
import { createFileHashCache, type FileHashCache } from '../core/repo/fileHashes'
import { createGitAdapter } from '../core/repo/git'
import { type ImporterDeps, reconcileRepository } from '../core/repo/importer'
import { resolveLayout } from '../core/repo/layout'
import { nodeFs } from '../core/repo/nodeFs'
import type { FsAdapter, GitAdapter, RepoLayout } from '../core/repo/types'
import { gitIn, scratchDir } from './gitScratch'
import { createRepoEnv, initProject, type RepoEnv } from './repoEnv'
import { createTestClock, createTestDb, type TestClock } from './testContext'

const TARGET_MACHINE = 'mc_0000000000000000000000000t'

/** An `FsAdapter` over the real disk that records every file body read below `.darkmechanicus/`. */
interface CountingFs extends FsAdapter {
  /** Paths relative to `.darkmechanicus/`, forward slashes, in read order. */
  reads: string[]
}

function countingFs(dmDir: string): CountingFs {
  const reads: string[] = []
  const note = (path: string): void => {
    const rel = relative(dmDir, path)
    if (!rel.startsWith('..') && !isAbsolute(rel)) reads.push(rel.split(sep).join('/'))
  }
  return {
    ...nodeFs,
    reads,
    readFile: (path) => {
      note(path)
      return nodeFs.readFile(path)
    },
    readFileBytes: (path) => {
      note(path)
      return nodeFs.readFileBytes(path)
    }
  }
}

/** One database reconciling the shared checkout, with its own clock, file hash cache and counting filesystem. */
export interface Target {
  db: Db
  clock: TestClock
  fs: CountingFs
  fileHashes: FileHashCache
  reconcile(full?: boolean): ReconcileResultView
  /** Reconciles with dependencies the test adjusts (another git adapter, say). */
  reconcileWith(change: (deps: ImporterDeps) => ImporterDeps, full?: boolean): ReconcileResultView
}

export interface TargetedWorld {
  root: string
  layout: RepoLayout
  git: GitAdapter
  source: RepoEnv
  /** Writes the source's records the checkout does not hold yet, and removes those the source no longer has. */
  mirror(): void
  commit(message?: string): string
  git_(...args: string[]): string
  target(): Target
  cleanup(): void
}

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function sourceRecords(source: RepoEnv): Map<string, string> {
  const records = new Map<string, string>()
  for (const [path, text] of source.fs.files()) {
    const rel = relative(source.layout.dmDir, path)
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep)[0] === 'local') continue
    records.set(rel.split(sep).join('/'), text)
  }
  return records
}

function createTarget(world: { root: string; layout: RepoLayout; git: GitAdapter }, now: () => string): Target {
  const db = createTestDb()
  const clock = createTestClock()
  const fs = countingFs(world.layout.dmDir)
  const fileHashes = createFileHashCache()
  const base = (): ImporterDeps => {
    clock.set(now())
    return { db, layout: world.layout, fs, clock, machineId: TARGET_MACHINE, git: world.git, sessionId: null, fileHashes }
  }
  return {
    db, clock, fs, fileHashes,
    reconcile: (full = false) => reconcileRepository(base(), undefined, { full }),
    reconcileWith: (change, full = false) => reconcileRepository(change(base()), undefined, { full })
  }
}

/** A temporary repository with `main` checked out and the source's project record committed. */
export function createTargetedWorld(): TargetedWorld {
  const scratch = scratchDir('dm-perf-dm-961-')
  const root = join(scratch.path, 'repo')
  mkdirSync(root)
  gitIn(root, 'init', '-q', '-b', 'main')
  gitIn(root, 'config', 'core.autocrlf', 'false')
  const layout = resolveLayout(root)
  const git = createGitAdapter(root)
  const source = createRepoEnv({ root: join(scratch.path, 'source-mem'), clock: createTestClock('2026-06-01T00:00:00.000Z') })
  initProject(source)
  const mirrored = new Map<string, string>()
  const mirror = (): void => {
    const records = sourceRecords(source)
    for (const [rel, text] of records) {
      if (mirrored.get(rel) !== text) writeFile(join(layout.dmDir, rel), text)
      mirrored.set(rel, text)
    }
  }
  mirror()
  const commit = (message = 'records'): string => {
    gitIn(root, 'add', '-A')
    gitIn(root, 'commit', '-q', '--allow-empty', '-m', message)
    return gitIn(root, 'rev-parse', 'HEAD').trim()
  }
  commit('project')
  return {
    root, layout, git, source, mirror, commit,
    git_: (...args) => gitIn(root, ...args),
    target: () => createTarget({ root, layout, git }, () => source.clock.nowIso()),
    cleanup: () => {
      scratch.cleanup()
    }
  }
}

/** Disk edits behind the importer's back. */
export const disk = {
  remove(world: TargetedWorld, rel: string): void {
    rmSync(join(world.layout.dmDir, rel), { recursive: true, force: true })
  },
  rename(world: TargetedWorld, from: string, to: string): void {
    const target = join(world.layout.dmDir, to)
    if (!existsSync(join(world.layout.dmDir, from)) || existsSync(target)) return
    mkdirSync(dirname(target), { recursive: true })
    renameSync(join(world.layout.dmDir, from), target)
  },
  write(world: TargetedWorld, rel: string, text: string): void {
    writeFile(join(world.layout.dmDir, rel), text)
  },
  read(world: TargetedWorld, rel: string): string {
    return readFileSync(join(world.layout.dmDir, rel), 'utf8')
  }
}

const COMPARED_TABLES = [
  'sync_state', 'epics', 'plan_revisions', 'ticket_status', 'runs', 'attempts', 'comments', 'kanban_cards', 'kanban_events',
  'kanban_attempts', 'profiles', 'metric_observations'
]

/** The rows a targeted and a full reconcile must leave alike. */
export function comparedState(db: Db): Record<string, unknown[]> {
  return Object.fromEntries(COMPARED_TABLES.map((table) => [table, db.all(`SELECT * FROM ${table} ORDER BY 1, 2`)]))
}

/** A reconcile result without `unchanged`, which lists only the records a targeted reconcile read. */
export function comparedResult(result: ReconcileResultView): Omit<ReconcileResultView, 'unchanged'> {
  const { unchanged: _unchanged, ...rest } = result
  return rest
}
