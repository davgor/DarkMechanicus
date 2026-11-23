import { testWorkspace } from '../main/desktop/__mocks__/projectWorkspaceFixture'
/**
 * Worlds for tests of the Dark Mechanicus source checkout (DM-189) and the cross-repository correction broker (DM-190).
 * Not shipped.
 *
 * - `markerCheckout` lays out the least a folder needs to pass as a Dark Mechanicus source checkout
 *   (`src/main/desktop/sourceCheckout.ts`): a `package.json` naming `dark-mechanicus`, its source marker files, a `.git`
 *   entry and, unless asked otherwise, a `project.json` project record. Nothing is cloned.
 * - `reportedSource` is a source project in memory: sprint 1 delivered through the real services and reported with two
 *   experiments drawn from its own sealed scorecard, `dm` aimed at the Dark Mechanicus source and `local` at itself.
 * - `machine` is a throwaway userData in a unique temp folder with the real folder registry and checkout store, and a
 *   workspace pool that opens each tracked folder's in-memory project.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Ctx } from '../core/context'
import { acceptAttempt, heartbeatAttempt } from '../core/services/attempts'
import type { Workspace } from '../core/workspace'
import { recordAttemptMetrics } from '../core/services/metricReports'
import { submitSprintReport } from '../core/services/reports'
import { parseInput, sprintReportInput } from '../core/schemas'
import { createCrossRepoCorrectionHandlers, type CrossRepoCorrectionHandlers } from '../main/desktop/crossRepoCorrections'
import { createFolderRegistry, type FolderRegistry } from '../main/desktop/folderRegistry'
import { createSourceCheckouts, type SourceCheckouts } from '../main/desktop/sourceCheckout'
import type { WorkspacePool } from '../main/desktop/workspacePool'
import type { SprintReportInput } from '../shared/domain/api'
import type { TicketContent } from '../shared/domain/bundle'
import type { RetroExperiment } from '../shared/domain/experiments'
import type { MetricReport } from '../shared/domain/metrics'
import type { SprintReportView } from '../shared/domain/views'
import { makeBundle, makeTicket, sid } from './bundles'
import { claim, startedRun, submitClaim } from './execution'
import { removeScratch } from './removeScratch'
import { createSequentialIds, createTestClock, createTestCtx, type TestCtx, withRole } from './testContext'

const SOURCE_PROJECT = 'pj_0000000000000000000000000s'
export const DM_PROJECT = 'pj_000000000000000000000000dm'
const T0 = '2026-11-15T09:00:00.000Z'
const MIN = 60_000
const FIXTURES = join(__dirname, '..', 'core', 'plan', 'fixtures', 'experiments')

/** What makes a folder the Dark Mechanicus source, beside its `.git` and `project.json`. */
const MARKER_FILES = ['src/core/workspace.ts', 'src/main/index.ts', 'src/preload/index.ts', 'src/mcp/server.ts', 'electron.vite.config.ts']

export function projectFileOf(folder: string): string {
  return join(folder, '.darkmechanicus', 'project.json')
}

/** Writes a valid project record for `projectId` into `folder`. */
export function writeProject(folder: string, projectId: string, name = 'DarkMechanicus'): void {
  const file = projectFileOf(folder)
  mkdirSync(dirname(file), { recursive: true })
  const record = { format: 'darkmechanicus.project', formatVersion: 1, projectId, name, keyPrefix: 'DM', createdAt: T0 }
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
}

interface MarkerOptions {
  /** The project record's id; null leaves the checkout without one (not set up). */
  projectId?: string | null
  /** Default true: an empty `.git` folder (the checkout test only looks for the entry). */
  git?: boolean
  packageName?: string
  /** Default true. */
  sources?: boolean
}

/** A folder laid out as a Dark Mechanicus source checkout; returns its canonical path. */
export function markerCheckout(folder: string, options: MarkerOptions = {}): string {
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: options.packageName ?? 'dark-mechanicus', version: '0.0.0' }))
  if (options.sources !== false) {
    for (const file of MARKER_FILES) {
      mkdirSync(dirname(join(folder, file)), { recursive: true })
      writeFileSync(join(folder, file), '// marker\n')
    }
  }
  if (options.git !== false) mkdirSync(join(folder, '.git'), { recursive: true })
  const projectId = options.projectId === undefined ? DM_PROJECT : options.projectId
  if (projectId !== null) writeProject(folder, projectId)
  return realpathSync.native(folder)
}

export interface Machine {
  root: string
  userData: string
  dmHome: string
  home: string
  associationFile: string
  registry: FolderRegistry
  checkouts: SourceCheckouts
  /** The installed app folders main reports. */
  installed: string[]
  /** The in-memory project each tracked folder opens (by canonical path). */
  projects: Map<string, Ctx>
  broker: CrossRepoCorrectionHandlers
  /** Errors the broker reported as unexpected (not DomainErrors). */
  unexpected: unknown[]
  association(): string | null
  cleanup(): void
}

/** A fresh machine in a unique temp folder; `cleanup` removes it. */
export function machine(): Machine {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-crossrepo-')))
  const userData = join(root, 'userData')
  const dmHome = join(root, 'dm-home')
  const home = join(root, 'home')
  const registry = createFolderRegistry({ file: join(userData, 'folders.json'), homeDir: home, dmHome })
  const installed: string[] = []
  const associationFile = join(userData, 'source-checkout.json')
  const checkouts = createSourceCheckouts({ file: associationFile, homeDir: home, dmHome, registry, installedAppDirs: () => installed, now: () => T0 })
  const projects = new Map<string, Ctx>()
  const pool: Pick<WorkspacePool, 'get'> = {
    get: (path) => {
      const ctx = projects.get(path)
      if (ctx === undefined) throw new Error(`No project is open at ${path}.`)
      return testWorkspace({ ctx: () => ctx, repoRoot: path } as Workspace)
    }
  }
  const unexpected: unknown[] = []
  const broker = createCrossRepoCorrectionHandlers({ registry, pool, checkouts, onUnexpectedError: (error) => unexpected.push(error) })
  return {
    root,
    userData,
    dmHome,
    home,
    associationFile,
    registry,
    checkouts,
    installed,
    projects,
    broker,
    unexpected,
    association: () => {
      try {
        return readFileSync(associationFile, 'utf8')
      } catch {
        return null
      }
    },
    cleanup: () => removeScratch(root)
  }
}

export interface ReportedSource {
  ctx: TestCtx
  desktop: TestCtx
  epicId: string
  runId: string
  report: SprintReportView
  xp: { dm: RetroExperiment; local: RetroExperiment }
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** Claims ticket `n`, reports `minutes` of host-measured active time and `tokens`, submits and accepts it. */
function deliver(ctx: TestCtx, runId: string, n: number, spent: { minutes: number; tokens: number }): string {
  const { minutes, tokens } = spent
  const worker = withRole(ctx, 'worker')
  const claimed = claim(ctx, runId, n)
  const attemptId = claimed.attempt.id
  const start = ctx.clock.nowMs()
  for (let left = minutes; left > 0; left -= 10) {
    ctx.clock.advanceSeconds(Math.min(10, left) * 60)
    heartbeatAttempt(worker, { attemptId, claimToken: claimed.packet.claimToken })
  }
  const actor = `omp:worker-${n}`
  const end = ctx.clock.nowMs()
  const reports: MetricReport[] = [
    {
      metric: 'active_ms',
      unit: 'milliseconds',
      source: { kind: 'host', actor },
      measurement: { state: 'observed', value: end - start },
      accumulation: 'delta',
      eventId: `span-${attemptId}`,
      observedAt: iso(end),
      attributes: { spanStart: iso(start), activeBasis: 'requests_and_tools' },
      usage: { coverage: 'self', parentActor: null }
    },
    { metric: 'tokens_total', unit: 'tokens', source: { kind: 'host', actor }, measurement: { state: 'observed', value: tokens }, accumulation: 'cumulative', sequence: 1, observedAt: iso(end), usage: { coverage: 'self', parentActor: null } }
  ]
  recordAttemptMetrics(withRole(ctx, 'orchestrator'), { attemptId, reports })
  ctx.clock.advanceSeconds(60)
  submitClaim(worker, claimed, {
    outputs: { summary: 'done', artifacts: [], commits: ['a'.repeat(40)], changedFiles: [], branch: `ticket-${n}` },
    evidence: { checks: [{ name: 'typecheck', status: 'passed', detail: 'ok' }], criteria: [{ criterionId: 'c1', met: true, note: 'checked' }], notes: '' }
  })
  ctx.clock.advanceSeconds(60)
  acceptAttempt(withRole(ctx, 'reviewer'), { attemptId, notes: 'reviewed', criteria: [{ criterionId: 'c1', met: true, note: 'checked' }] })
  ctx.clock.advanceSeconds(60)
  return attemptId
}

/** The checked-in complete experiment (`experiment-cases.json` `valid`), filled for this run, with `patch` over it. */
function experimentInput(values: Record<string, string>, patch: Record<string, unknown>): Record<string, unknown> {
  const text = readFileSync(join(FIXTURES, 'experiment-cases.json'), 'utf8').replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
  const { valid } = JSON.parse(text) as { valid: Record<string, unknown> }
  return { ...valid, ...patch }
}

const DM_WORK = [
  { title: 'Put the importer context into the claim packet', body: 'Add the importer record files and their schema locations to the context section of every claim packet that names src/core/repo/importer.ts.', size: 'small' },
  { title: 'Show the packet context in the ticket view', body: 'List the claim packet context entries under the ticket body in the desktop ticket view, one line per file with its schema.', size: 'micro' }
]

const LOCAL_WORK = [
  { title: 'Add an importer context note to the planner skill', body: "Add one paragraph to skills/planner.md naming the importer's record files and where their schemas live.", size: 'small' }
]

/**
 * A source project (own in-memory database) whose sprint 1 is delivered (tickets 1-3 accepted, the acceptance node
 * not, so the run is in progress) and reported with experiments `dm` (the Dark Mechanicus source) and `local`.
 */
export function reportedSource(projectId = SOURCE_PROJECT): ReportedSource {
  const ctx = createTestCtx({ clock: createTestClock(T0), projectId, ids: createSequentialIds() })
  const base = makeBundle([[1, 2, 3, 4]])
  const ticket = (n: number): TicketContent =>
    n === 4
      ? makeTicket(4, { kind: 'acceptance', title: 'Sprint 1 acceptance', size: 'medium', acceptanceCriteria: [{ id: 'c1', text: 'The sprint works end to end' }] })
      : makeTicket(n, { size: 'medium', acceptanceCriteria: [{ id: 'c1', text: 'It works' }], budget: { activeMs: 30 * MIN, tokens: 50_000 } })
  const run = startedRun(ctx, { bundle: { ...base, tickets: base.tickets.map((_, index) => ticket(index + 1)) } })
  ctx.clock.advanceSeconds(60)
  const attempts = [
    deliver(ctx, run.runId, 1, { minutes: 20, tokens: 30_000 }),
    deliver(ctx, run.runId, 2, { minutes: 30, tokens: 40_000 }),
    deliver(ctx, run.runId, 3, { minutes: 20, tokens: 20_000 })
  ]
  const values = { sprintId: sid(1), runId: run.runId, attempt1: attempts[0] ?? '' }
  const experiments = [
    experimentInput(values, { hypothesis: 'Hypothesis: the claim packet lacks the importer context, so every worker re-reads it.', destination: { kind: 'darkmechanicus_source' }, proposedWork: DM_WORK }),
    experimentInput(values, { proposedWork: LOCAL_WORK })
  ]
  const input = parseInput(sprintReportInput, { summary: 'Sprint 1 with two experiments.', retro: { wentWell: ['Tickets 1-3 landed'], experiments } }, 'report') as SprintReportInput
  const report = submitSprintReport(withRole(ctx, 'orchestrator'), { runId: run.runId, sprintId: sid(1), report: input })
  ctx.clock.advanceSeconds(60)
  const [dm, local] = report.report.retro?.experiments ?? []
  if (dm === undefined || local === undefined) throw new Error('the report stored fewer than two experiments')
  return { ctx, desktop: withRole(ctx, 'desktop'), epicId: run.epicId, runId: run.runId, report, xp: { dm, local } }
}

/** The Dark Mechanicus source project in memory, with the person's desktop session. */
export function dmProject(projectId = DM_PROJECT): TestCtx {
  const ctx = createTestCtx({ clock: createTestClock(T0), projectId, ids: createSequentialIds() })
  // Ids of another project's records never collide with the source's: offset this project's sequence.
  for (let i = 0; i < 500; i += 1) ctx.ids.next('epic')
  return withRole(ctx, 'desktop')
}

/** Every row of every table but the receipts and the source's own `correction.*` events, as JSON. */
export function historyOf(ctx: Ctx): string {
  const tables = ctx.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'correction_links' ORDER BY name")
  const dump: Record<string, unknown[]> = {}
  for (const { name } of tables) {
    const rows = ctx.db.all<Record<string, unknown>>(`SELECT * FROM "${name}"`)
    const kept = name === 'events' ? rows.filter((row) => !String(row.kind ?? '').startsWith('correction.')) : rows
    dump[name] = kept.map((row) => JSON.stringify(row)).sort()
  }
  return JSON.stringify(dump)
}

/** The epics of a project created by a cross-repository correction. */
export function correctionEpics(ctx: Ctx): { id: string; status: string; branch_json: string | null; current_revision_id: string | null; provenance_json: string }[] {
  return ctx.db.all("SELECT id, status, branch_json, current_revision_id, provenance_json FROM epics WHERE json_extract(provenance_json, '$.kind') = 'cross_repo_correction' ORDER BY created_at, id")
}
