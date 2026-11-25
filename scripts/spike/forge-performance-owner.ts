import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { openDatabase, type TransactionHold } from '../../src/core/db/database'
import { nodeFs } from '../../src/core/repo/nodeFs'
import { openWorkspace, type Workspace } from '../../src/core/workspace'
import { snapshotRecord, parseRecord } from '../../src/core/repo/portable'
import type { ProfileProject } from './forge-performance-fixture'
import { absoluteNow, identity, loopSink } from './forge-performance-sinks'

export type OwnerAction = 'open' | 'heartbeat' | 'reconcile' | 'card' | 'close' | 'preview' | 'inspect' | 'mutate'
export type OwnerRequest = { id: number; action: OwnerAction; project: ProfileProject; paths?: string[] }
export interface OwnerReply {
  id: number
  elapsedMs: number
  identity: ReturnType<typeof identity>
  loop: { count: number; maxGapMs: number }
  memory: NodeJS.MemoryUsage
  reads: { text: number; bytes: number; stamps: number; realpaths: number; stats: number }
  /** Depth-0 write transactions committed or rolled back while this request ran (`Db` hold observer). */
  holds: TransactionHold[]
  result?: unknown
  error?: string
}

function previewSnapshots(paths: string[]) {
  const hash = createHash('sha256')
  for (const path of paths) {
    const record = parseRecord(snapshotRecord, readFileSync(path, 'utf8'), path)
    hash.update(record.contentHash)
  }
  return { snapshots: paths.length, digest: hash.digest('hex') }
}

function inspect(workspace: Workspace) {
  const { db } = workspace.ctx()
  const writerExists = db.get("SELECT name FROM sqlite_schema WHERE name = 'dm_perf_writer'") !== undefined
  return {
    cards: db.get('SELECT count(*) AS n FROM kanban_cards'),
    writer: writerExists ? db.get('SELECT group_concat(value) AS writes FROM dm_perf_writer') : null,
    session: db.get('SELECT last_seen_at, ended_at FROM sessions WHERE id = ?', workspace.sessionId()),
    desktopHeartbeat: db.get("SELECT last_seen_at FROM sessions WHERE label = 'Desktop' AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1")
  }
}

// This branch is launched by system Node with an IPC channel. It owns the only deliberately held transaction.
if (process.argv[2] === 'writer') {
  const db = openDatabase(process.argv[3]!)
  db.exec('BEGIN IMMEDIATE')
  db.exec('CREATE TABLE IF NOT EXISTS dm_perf_writer (value TEXT NOT NULL)')
  db.run('INSERT INTO dm_perf_writer VALUES (?)', 'external writer committed once')
  process.send?.({ phase: 'locked', atMs: absoluteNow(), identity: identity() })
  const release = () => {
    db.exec('COMMIT')
    db.close()
    process.send?.({ phase: 'released', atMs: absoluteNow(), identity: identity() }, () => process.disconnect?.())
  }
  const duration = Number(process.argv[4])
  if (duration < 0) process.once('message', release)
  else setTimeout(release, duration)
}

// Electron utility process, with the same sync Workspace API and production DB defaults.
const parent = (process as NodeJS.Process & { parentPort?: Electron.ParentPort }).parentPort
if (parent) {
  const workspaces = new Map<string, Workspace>()
  const sink = loopSink()
  const homeDir = process.env['DARKMECHANICUS_HOME']
  const counters = { text: 0, bytes: 0, stamps: 0, realpaths: 0, stats: 0 }
  const holds: TransactionHold[] = []
  // `stats` counts every metadata call that reaches the filesystem: stamps, sizes, existence and type checks.
  const fs = {
    ...nodeFs,
    readFile(path: string) { counters.text += 1; return nodeFs.readFile(path) },
    readFileBytes(path: string) { counters.bytes += 1; return nodeFs.readFileBytes(path) },
    fileStamp(path: string) { counters.stamps += 1; counters.stats += 1; return nodeFs.fileStamp(path) },
    fileSize(path: string) { counters.stats += 1; return nodeFs.fileSize(path) },
    exists(path: string) { counters.stats += 1; return nodeFs.exists(path) },
    isDirectory(path: string) { counters.stats += 1; return nodeFs.isDirectory(path) },
    isSymlink(path: string) { counters.stats += 1; return nodeFs.isSymlink(path) },
    realpath(path: string) { counters.realpaths += 1; return nodeFs.realpath(path) }
  }
  function workspace(project: ProfileProject): Workspace {
    let current = workspaces.get(project.root)
    if (!current) {
      current = openWorkspace({
        repoRoot: project.root, role: 'desktop', label: 'Profiler utility', transport: 'desktop', homeDir, fs,
        onTransaction: (hold) => holds.push(hold)
      })
      workspaces.set(project.root, current)
    }
    return current
  }
  const actions: Record<Exclude<OwnerAction, 'preview' | 'close'>, (current: Workspace, project: ProfileProject) => unknown> = {
    open: (current) => ({ sessionId: current.sessionId() }),
    heartbeat: (current) => {
      current.heartbeat()
      return { sessionId: current.sessionId() }
    },
    reconcile: (current) => current.reconcileRepository(),
    card: (current, project) => current.getKanbanCard({ cardId: project.cardId }),
    inspect: (current) => inspect(current),
    mutate: (current) => current.createKanbanCard({ title: 'Profiler command write' })
  }
  async function execute({ action, project, paths }: OwnerRequest): Promise<unknown> {
    if (action === 'preview') return previewSnapshots(paths ?? [])
    if (action === 'close') {
      workspaces.get(project.root)?.close()
      workspaces.delete(project.root)
      return { openWorkspaces: workspaces.size }
    }
    return actions[action](workspace(project), project)
  }
  let queue = Promise.resolve()
  parent.on('message', ({ data }: { data: OwnerRequest }) => {
    queue = queue.then(async () => {
      sink.read()
      holds.length = 0
      for (const key of Object.keys(counters) as (keyof typeof counters)[]) counters[key] = 0
      const start = performance.now()
      let result: unknown
      let error: string | undefined
      try {
        result = await execute(data)
      } catch (caught: unknown) {
        error = String(caught)
      }
      const elapsedMs = performance.now() - start
      // Flush the first timer after the sync work before sampling.
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      const response: OwnerReply = {
        id: data.id, identity: identity(), elapsedMs, loop: sink.read(), memory: process.memoryUsage(),
        reads: { ...counters }, holds: holds.splice(0), result, error
      }
      parent.postMessage(response)
    })
  })
  parent.postMessage({ identity: identity() })
}
