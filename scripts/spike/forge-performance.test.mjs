import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { resolveLayout } from '../../src/core/repo/layout'
import { nodeFs } from '../../src/core/repo/nodeFs'
import { ownedPaths } from '../../src/core/repo/paths'
import { parseRecord, snapshotRecord } from '../../src/core/repo/portable'
import { openWorkspace } from '../../src/core/workspace'
import { seedProject, withFixture } from './forge-performance-fixture'
import { cpuSink, holdSummary, latencyStats, outcomeCounts } from './forge-performance-sinks'

it('shards at the portable bundle limit and cold-imports completed revisions, history and evidence', () => {
  let created
  withFixture((root) => {
    created = root
    const project = seedProject(join(root, 'profile'), 1001)
    const layout = resolveLayout(project.root)
    const paths = ownedPaths(layout)
    expect(project).toMatchObject({ tickets: 1001, epics: 2, revisions: 4, runs: 2, images: 2, comments: 64 })
    expect(existsSync(project.dbFile)).toBe(false)
    for (const epic of readdirSync(layout.epicsDir)) {
      const versions = readdirSync(paths.snapshotsDir(epic)).map((name) => {
        const file = join(paths.snapshotsDir(epic), name)
        return parseRecord(snapshotRecord, readFileSync(file, 'utf8'), file)
      })
      expect(versions.map(({ number }) => number)).toEqual([1, 2])
      expect(versions[1].baseRevisionId).toBe(versions[0].revisionId)
      expect(versions[0].bundle.tickets).toHaveLength(versions[1].bundle.tickets.length)
      expect(versions[1].bundle.tickets.length).toBeLessThanOrEqual(1000)
    }
    const workspace = openWorkspace({
      repoRoot: project.root, role: 'desktop', label: 'Profiler fixture check', transport: 'desktop', homeDir: join(root, 'home')
    })
    try {
      const { db } = workspace.ctx()
      expect(db.get("SELECT count(*) AS n FROM epics WHERE status = 'completed'")).toEqual({ n: 2 })
      expect(db.get("SELECT count(*) AS n FROM ticket_status WHERE status = 'completed'")).toEqual({ n: 1001 })
      expect(db.get("SELECT count(*) AS n FROM plan_revisions WHERE state = 'saved'")).toEqual({ n: 4 })
      expect(db.get("SELECT count(*) AS n FROM runs WHERE state = 'completed'")).toEqual({ n: 2 })
      expect(db.get('SELECT count(*) AS n FROM attempts')).toEqual({ n: 17 })
      expect(db.get('SELECT count(*) AS n FROM attachments WHERE missing = 0 AND length(data) > 131072')).toEqual({ n: 2 })
      expect(db.get('SELECT count(*) AS n FROM comments')).toEqual({ n: 64 })
      expect(db.get('SELECT id FROM kanban_cards')).toEqual({ id: project.cardId })
    } finally {
      workspace.close()
    }
  })
  expect(existsSync(created)).toBe(false)
})

function commitPortableChange(root, title) {
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' }).trim()
  git('add', '--', '.darkmechanicus')
  git('commit', '-m', title)
  return git('rev-parse', 'HEAD')
}

function changeEpicTitle(layout, title) {
  const [epicId] = readdirSync(layout.epicsDir)
  const path = ownedPaths(layout).epicStateFile(epicId)
  const state = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...state, title }))
  return epicId
}

const NO_BODY_READS = { historyReads: 0, historyBytes: 0, snapshotReads: 0, imageBytes: 0 }

function countPortableReads(runFiles) {
  const counts = { ...NO_BODY_READS }
  const fs = {
    ...nodeFs,
    readFile(path) {
      const text = nodeFs.readFile(path)
      if (basename(dirname(path)) === 'snapshots') counts.snapshotReads += 1
      if (runFiles.includes(path)) {
        counts.historyReads += 1
        counts.historyBytes += Buffer.byteLength(text, 'utf8')
      }
      return text
    },
    readFileBytes(path) {
      const data = nodeFs.readFileBytes(path)
      counts.imageBytes += data.byteLength
      return data
    }
  }
  return { fs, counts, reset: () => Object.assign(counts, NO_BODY_READS) }
}

it('keeps warm history and images unread when a same-branch commit changes only epic state', () => {
  withFixture((root) => {
    const project = seedProject(join(root, 'profile'), 20)
    const layout = resolveLayout(project.root)
    const paths = ownedPaths(layout)
    const initialCommit = commitPortableChange(project.root, 'Portable fixture')
    const runFiles = readdirSync(layout.historyDir).map((run) => paths.runHistoryFile(run))
    const runBytes = runFiles.reduce((sum, path) => sum + readFileSync(path).byteLength, 0)
    const { fs, counts, reset } = countPortableReads(runFiles)
    const workspace = openWorkspace({
      repoRoot: project.root, role: 'desktop', label: 'Profiler I/O check', transport: 'desktop', homeDir: join(root, 'home'), fs
    })
    try {
      expect(counts).toEqual({ historyReads: 1, historyBytes: runBytes, snapshotReads: 2, imageBytes: 131_110 })
      reset()
      // This matches the synchronous Workspace work invoked by the automatic desktop heartbeat.
      workspace.heartbeat()
      expect(counts).toEqual(NO_BODY_READS)
      const title = 'Epic title from a new Git commit'
      const epicId = changeEpicTitle(layout, title)
      expect(commitPortableChange(project.root, 'Update only the epic state')).not.toBe(initialCommit)
      workspace.heartbeat()
      expect(workspace.ctx().db.get('SELECT title FROM epics WHERE id = ?', epicId)).toEqual({ title })
      expect(counts).toEqual(NO_BODY_READS)
    } finally {
      workspace.close()
    }
  })
})

it('cleans up its owned fixture when generation throws', () => {
  let created
  expect(() => withFixture((root) => {
    created = root
    seedProject(join(root, 'invalid'), 10_001)
  })).toThrow('Fixture ticket count must be an integer from 1 through 10,000.')
  expect(existsSync(created)).toBe(false)
})

it('retains native probe evidence from distinct main, renderer and utility processes and two live timing sinks', () => {
  const path = new URL('../../docs/reports/forge-performance-data/probe.jsonl', import.meta.url)
  const rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const processes = rows.find(({ stage }) => stage === 'identity')
  const pids = [processes.main.pid, processes.renderer.pid, processes.owner.identity.pid]
  expect(pids.every((pid) => Number.isInteger(pid) && pid > 0)).toBe(true)
  expect(new Set(pids).size).toBe(3)
  expect(processes.main.electron).toBe(processes.owner.identity.electron)
  expect(processes.owner.identity).toMatchObject({ isMainThread: true, threadId: 0 })
  expect(processes.renderer.preload).toBe('function')
  for (const stage of ['desktop-contention', 'owner-contention']) {
    const { mainLoop, rendererLoop, ipc } = rows.find((row) => row.stage === stage)
    expect(mainLoop.count).toBeGreaterThan(0)
    expect(rendererLoop.count).toBeGreaterThan(0)
    expect(ipc).not.toHaveLength(0)
  }
})

it('summarizes view latency samples as parseable p50, p95 and max records', () => {
  const samples = Array.from({ length: 30 }, (_, index) => index + 1)
  const row = JSON.parse(JSON.stringify({ stage: 'revamp-view', view: 'plan', condition: 'idle', endToEnd: latencyStats(samples) }))
  expect(row.endToEnd).toEqual({ count: 30, p50Ms: 15, p95Ms: 29, maxMs: 30, minMs: 1, meanMs: 15.5 })
  expect(latencyStats([])).toEqual({ count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, minMs: 0, meanMs: 0 })
})

it('counts every CLI call result under its error code or ok', () => {
  const counts = outcomeCounts([{ ok: true }, { ok: false, code: 'busy' }, { ok: false, code: 'busy' }, { ok: false, code: null }, { ok: true }])
  expect(JSON.parse(JSON.stringify(counts))).toEqual({ ok: 2, busy: 2, no_json: 1 })
})

it('groups write-lock holds by caller tag with hold and acquire statistics', () => {
  const summary = holdSummary([
    { tag: 'reconcile', outcome: 'commit', acquireMs: 1, holdMs: 40 },
    { tag: 'flush', outcome: 'commit', acquireMs: 0, holdMs: 5 },
    { tag: 'flush', outcome: 'rollback', acquireMs: 2, holdMs: 7 },
    { tag: null, outcome: 'commit', acquireMs: 0, holdMs: 1 }
  ])
  const parsed = JSON.parse(JSON.stringify(summary))
  expect(Object.keys(parsed).sort()).toEqual(['flush', 'reconcile', 'untagged'])
  expect(parsed.flush).toMatchObject({ transactions: 2, rollbacks: 1, hold: { count: 2, maxMs: 7 }, acquire: { maxMs: 2 } })
  expect(parsed.reconcile.hold).toMatchObject({ p50Ms: 40, p95Ms: 40, maxMs: 40 })
})

it('samples host CPU busy percentage as a parseable record', async () => {
  const sink = cpuSink(20)
  await new Promise((resolve) => setTimeout(resolve, 120))
  const row = JSON.parse(JSON.stringify(sink.read()))
  sink.close()
  expect(row.samples).toBeGreaterThan(0)
  expect(row.meanBusyPct).toBeGreaterThanOrEqual(0)
  expect(row.maxBusyPct).toBeLessThanOrEqual(100)
})
