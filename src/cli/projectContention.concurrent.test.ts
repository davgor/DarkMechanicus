import { buildSync } from 'esbuild'
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { openDatabase, type Db } from '../core/db/database'
import { bindAgentMailEndpoint, provisionAgentMailEndpoint } from '../core/services/agentMail'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { dropAcceptanceNodes } from '../test/acceptanceNodes'
import { issued } from '../test/execution'
import type { Workspace } from '../core/workspace'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const WRITER_BUSY = 'DM_FIXTURE_SQLITE_BUSY'
const WAL_READY = 'DM_FIXTURE_WAL_READY'
const REPORT_COMMITTED = 'DM_FIXTURE_REPORT_COMMITTED'
const CLOSE_BUSY = 'DM_FIXTURE_CLOSE_BUSY'
let bundleDir: string
let cliPath: string

const SQLITE_TRACE = `
      const { readFileSync, writeSync } = require('node:fs');
      const dbPrototype = require('node:sqlite').DatabaseSync.prototype;
      const sqliteExec = dbPrototype.exec;
      const sqlitePrepare = dbPrototype.prepare;
      const mode = process.env.DM_CONTENTION_FIXTURE;
      const busyTimeout = db => sqlitePrepare.call(db, 'PRAGMA busy_timeout').get().timeout;
      const emit = (marker, value) => writeSync(2, marker + (value === undefined ? '' : ' ' + value) + '\\n');
      let tested = false;
      let wroteReport = false;
      let committedReport = false;
      function contentionProbe(db) {
        const timeout = busyTimeout(db);
        sqliteExec.call(db, 'PRAGMA busy_timeout = 0');
        try {
          sqliteExec.call(db, 'BEGIN IMMEDIATE');
          sqliteExec.call(db, 'ROLLBACK');
          throw new Error('Fixture expected a competing project writer');
        } catch (error) {
          if (error.errcode !== 5) throw error;
          emit(${JSON.stringify(WRITER_BUSY)});
        } finally {
          sqliteExec.call(db, 'PRAGMA busy_timeout = ' + timeout);
        }
      }
      dbPrototype.exec = function(sql) {
        const begins = sql === 'BEGIN IMMEDIATE';
        if (begins && mode === 'probe' && !tested) {
          tested = true;
          contentionProbe(this);
        }
        let result;
        try { result = sqliteExec.call(this, sql); }
        catch (error) {
          if (begins && error.errcode === 5) {
            if (committedReport) emit(${JSON.stringify(CLOSE_BUSY)}, busyTimeout(this));
            else emit(${JSON.stringify(WRITER_BUSY)});
          }
          throw error;
        }
        if (sql === 'PRAGMA journal_mode = WAL') emit(${JSON.stringify(WAL_READY)});
        if (sql === 'COMMIT' && wroteReport && !committedReport) {
          committedReport = true;
          emit(${JSON.stringify(REPORT_COMMITTED)});
          readFileSync(0);
        }
        return result;
      };
      if (mode === 'audit-close') dbPrototype.prepare = function(sql) {
        const stmt = sqlitePrepare.call(this, sql);
        if (sql.startsWith('INSERT INTO idempotency')) {
          const sqliteRun = stmt.run;
          stmt.run = function(...args) {
            const result = sqliteRun.apply(this, args);
            wroteReport = true;
            return result;
          };
        }
        return stmt;
      };
`

beforeAll(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'dm-contention-cli-'))
  cliPath = join(bundleDir, 'cli.js')
  const knowledge = Object.fromEntries(globSync('skills/knowledge/**/*.md', { cwd: ROOT }).map((file) =>
    [`../../../${file.replaceAll('\\', '/')}`, readFileSync(join(ROOT, file), 'utf8')]))
  buildSync({
    entryPoints: [join(ROOT, 'src', 'cli', 'main.ts')], outfile: cliPath,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.md': 'text' },
    define: { 'import.meta.glob': 'dmFixtureKnowledge' },
    banner: { js: `
      require = require('node:module').createRequire(${JSON.stringify(join(ROOT, 'package.json'))});
      const dmFixtureKnowledge = () => (${JSON.stringify(knowledge)});
      ${SQLITE_TRACE}
    ` }
  })
})

afterAll(() => {
  if (bundleDir !== undefined) rmSync(bundleDir, { recursive: true, force: true })
})

/** Adapts child-process events to promises on the project's ES2022 target. */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class WorkerCli {
  private readonly children = new Set<ChildProcess>()

  constructor(private readonly fixture: Harness) {}

  private start(token: string, command: string, json: string, mode?: 'probe' | 'audit-close') {
    return spawn(process.execPath, [cliPath, '--repo', this.fixture.root, 'call', command, mode === 'audit-close' ? json : '-'], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'], cwd: this.fixture.root, env: {
        ...process.env, DARKMECHANICUS_HOME: this.fixture.homeDir, DM_SESSION_TOKEN: token, DM_CONTENTION_FIXTURE: mode
      }
    }) as ChildProcessWithoutNullStreams // The first three descriptors are explicitly piped above.
  }

  call(token: string, command: string, args: object, mode?: 'probe' | 'audit-close') {
    const json = JSON.stringify(args)
    const child = this.start(token, command, json, mode)
    this.children.add(child)
    const { promise: outcome, resolve, reject } = deferred<{ code: number; envelope: unknown }>()
    void outcome.catch(() => undefined)
    const writing = deferred<void>()
    void writing.promise.catch(() => undefined)
    const closing = deferred<void>()
    void closing.promise.catch(() => undefined)
    const committed = deferred<void>()
    void committed.promise.catch(() => undefined)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.includes(WAL_READY) && stderr.includes(WRITER_BUSY)) writing.resolve()
      if (stderr.includes(CLOSE_BUSY)) closing.resolve()
      if (stderr.includes(REPORT_COMMITTED)) committed.resolve()
    })
    child.on('error', reject)
    child.stdin.on('error', reject)
    child.on('close', (code) => {
      this.children.delete(child)
      closing.reject(new Error('CLI exited before audit contention'))
      try {
        if (code === null) throw new Error('CLI stopped')
        const envelope: unknown = JSON.parse(stdout)
        writing.reject(new Error(`${command} exited before reaching the first project write transaction`))
        committed.reject(new Error(`${command} exited before committing the fixture report`))
        resolve({ code, envelope })
      } catch {
        const error = new Error(`CLI did not return one JSON envelope for ${command}: ${stderr.replaceAll(token, '[redacted]')}`)
        writing.reject(error)
        committed.reject(error)
        reject(error)
      }
    })
    if (mode !== 'audit-close') child.stdin.end(json)
    return {
      child, outcome, writing: writing.promise, committed: committed.promise, closing: closing.promise,
      allowAuditClose: () => child.stdin.end()
    }
  }

  async close() {
    await Promise.all([...this.children].map(child => {
      const { promise, resolve } = deferred<void>()
      child.once('close', () => resolve())
      child.kill()
      return promise
    }))
  }
}

async function fixture(harness: Harness) {
  harness.clock.set(new Date().toISOString())
  const desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'Concurrent workers', mode: 'db' })
  const epic = await desktop.createEpic({ title: 'Exercise the worker transport' })
  await dropAcceptanceNodes(desktop, epic.id)
  const draft = await desktop.updatePlanDraft({ epicId: epic.id, ops: [
    { op: 'add_ticket', ref: 'read', sprint: '1', ticket: { title: 'List ticket comments' } },
    { op: 'add_ticket', ref: 'write', sprint: '1', ticket: { title: 'Report the other attempt' } }
  ] })
  const comments = { epicId: epic.id, ticketId: draft.refMap.read! }
  await desktop.addComment({ ...comments, body: 'Committed comment' })
  const workers = await Promise.all(['one', 'two'].map(async (name) => {
    const { token, grant } = await desktop.issueGrant({ role: 'worker', label: name })
    const endpoint = provisionAgentMailEndpoint(desktop.ctx(), { chatId: `worker-${name}`, name })
    bindAgentMailEndpoint(desktop.ctx(), { endpointId: endpoint.id, grantId: grant.id })
    return { token, grantId: grant.id, endpointId: endpoint.id }
  }))
  return { desktop, epicId: epic.id, draft, comments, one: workers[0]!, two: workers[1]! }
}

function holdAuthorizedWrite(db: Db, ticketId: string) {
  db.exec('BEGIN IMMEDIATE')
  db.run('UPDATE comments SET body = ? WHERE ticket_id = ?', 'Uncommitted comment', ticketId)
}

async function beforeDeadline<T>(calls: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const stop = new AbortController()
  try {
    // A bounded failure guard only; the event is what orders the transaction release.
    return await Promise.race([calls, delay(timeoutMs, undefined, { signal: stop.signal }).then(() => { throw new Error(message) })])
  } finally {
    stop.abort()
  }
}

function whileHeld(calls: Promise<unknown>): Promise<unknown> {
  return beforeDeadline(calls, 4_000, 'CLI never observed SQLITE_BUSY at its first project write transaction after WAL open')
}

it('completes two audited worker reads after the authorized project writer commits', async () => {
  const harness = createHarness()
  const cli = new WorkerCli(harness)
  try {
    const { desktop, comments, one, two } = await fixture(harness)
    const db = desktop.ctx().db
    holdAuthorizedWrite(db, comments.ticketId)
    const cap = cli.call(one.token, 'get_capabilities', {}, 'probe')
    const list = cli.call(two.token, 'list_comments', comments, 'probe')
    const responses = Promise.all([cap.outcome, list.outcome])
    await whileHeld(Promise.all([cap.writing, list.writing])).finally(() => db.exec('COMMIT'))
    const [capabilities, listed] = await responses
    expect(capabilities).toMatchObject({ code: 0, envelope: { ok: true, data: {
      initialized: true, role: 'worker', capabilities: expect.arrayContaining(['read', 'attempt.heartbeat']),
      mailbox: { bound: true, endpointId: one.endpointId }
    } } })
    expect(listed).toMatchObject({ code: 0, envelope: { ok: true, data: [{ body: 'Uncommitted comment', ...comments }] } })
    for (const worker of [one, two]) {
      expect(db.get('SELECT role, ended_at FROM sessions WHERE grant_id = ?', worker.grantId))
        .toEqual({ role: 'worker', ended_at: expect.any(String) })
    }
  } finally {
    await cli.close()
    harness.cleanup()
  }
})

it('keeps the embedded CLI deadline separate from the long-lived desktop connection', async () => {
  const harness = createHarness()
  vi.useFakeTimers({ toFake: ['performance'] })
  try {
    const desktop = harness.open('desktop')
    await desktop.initializeRepository({ name: 'Embedded sessions', mode: 'db' })
    const cli = harness.open('reader', { transport: 'cli' })
    vi.advanceTimersByTime(10_001)
    expect(cli.ctx().db.get('PRAGMA busy_timeout')).toEqual({ timeout: 0 })
    expect(desktop.ctx().db.get('PRAGMA busy_timeout')).toEqual({ timeout: 5_000 })
  } finally {
    vi.useRealTimers()
    harness.cleanup()
  }
})

it.concurrent('waits past the former CLI deadline and commits a blocked report once', async () => {
  const harness = createHarness()
  const cli = new WorkerCli(harness)
  try {
    const { desktop, comments, one } = await fixture(harness)
    const db = desktop.ctx().db
    holdAuthorizedWrite(db, comments.ticketId)
    const call = cli.call(one.token, 'add_comment', { ...comments, body: 'Queued report', idempotencyKey: 'blocked-report' })
    try {
      const progress = once(call.child, 'message')
      await call.writing
      const [message] = await beforeDeadline(progress, 2_000, 'CLI did not notify its supervisor')
      expect(message).toBe('dm.sqlite.writer-busy')
      await delay(10_100)
      expect(db.get('SELECT key FROM idempotency WHERE key = ?', 'blocked-report')).toBeUndefined()
    } finally {
      db.exec('ROLLBACK')
    }
    expect(await call.outcome).toMatchObject({ code: 0, envelope: { ok: true, data: { body: 'Queued report' } } })
    expect(db.get('SELECT count(*) AS n FROM comments WHERE body = ?', 'Queued report')).toEqual({ n: 1 })
  } finally {
    await cli.close()
    harness.cleanup()
  }
})

it.concurrent('finishes a contested audit close without replaying the committed report', async () => {
  const harness = createHarness()
  const cli = new WorkerCli(harness)
  try {
    const { desktop, comments, one } = await fixture(harness)
    const db = desktop.ctx().db
    const input = { ...comments, body: 'Committed before audit close', idempotencyKey: 'audit-close-report' }
    const call = cli.call(one.token, 'add_comment', input, 'audit-close')
    await call.committed
    db.exec('BEGIN IMMEDIATE')
    try {
      call.allowAuditClose()
      await call.closing
    } finally {
      db.exec('ROLLBACK')
    }
    expect(await call.outcome).toMatchObject({ code: 0, envelope: { ok: true, data: { body: input.body } } })
    expect(db.all('SELECT ended_at FROM sessions WHERE grant_id = ?', one.grantId)).toEqual([{ ended_at: expect.any(String) }])
    expect(db.get('SELECT count(*) AS n FROM comments WHERE body = ?', input.body)).toEqual({ n: 1 })
  } finally {
    await cli.close()
    harness.cleanup()
  }
})

async function liveClaims(harness: Harness, desktop: Workspace, epicId: string, draft: { draftRevision: number; refMap: Record<string, string> }) {
  await desktop.savePlan({ epicId, expectedDraftRevision: draft.draftRevision })
  const orchestrator = harness.open('orchestrator')
  const { id: runId } = await orchestrator.startRun({ epicId })
  const claim = async (ref: 'read' | 'write') => {
    const { attempt, packet } = issued(await orchestrator.claimTicket({
      runId, ticketId: draft.refMap[ref]!, worker: { label: ref }, leaseSeconds: 45
    }))
    return { attemptId: attempt.id, claimToken: packet.claimToken }
  }
  return { running: await claim('read'), reporting: await claim('write') }
}

it('preserves a live heartbeat, one idempotent report and claim fencing across overlapping worker calls', async () => {
  const harness = createHarness()
  const cli = new WorkerCli(harness)
  let holder: Db | undefined
  try {
    const { desktop, comments, one, two, epicId, draft } = await fixture(harness)
    const db = desktop.ctx().db
    const { running, reporting } = await liveClaims(harness, desktop, epicId, draft)
    const writer = holder = openDatabase(db.path, { synchronous: 'off' })
    holdAuthorizedWrite(writer, comments.ticketId)
    const progress = cli.call(one.token, 'heartbeat_attempt', { ...running, leaseSeconds: 90, progress: { note: 'Work advanced' } }, 'probe')
    const reportInput = { ...reporting, idempotencyKey: 'one-report', outputs: { summary: 'Exactly one report' } }
    const submitted = cli.call(two.token, 'submit_attempt', reportInput, 'probe')
    const replay = cli.call(two.token, 'submit_attempt', reportInput, 'probe')
    const read = cli.call(one.token, 'list_comments', comments, 'probe')
    const calls = [progress, submitted, replay, read]
    await whileHeld(Promise.all(calls.map(call => call.writing))).finally(() => writer.exec('COMMIT'))
    const [heartbeat, firstReport, replayed, listed] = await Promise.all(calls.map(call => call.outcome))
    expect(heartbeat).toMatchObject({ code: 0, envelope: { ok: true, data: { id: running.attemptId, state: 'running' } } })
    expect(firstReport).toMatchObject({ code: 0, envelope: { ok: true, data: { id: reporting.attemptId, state: 'submitted' } } })
    expect(replayed).toEqual(firstReport)
    expect(listed).toMatchObject({ code: 0, envelope: { ok: true, data: [{ body: 'Uncommitted comment', ...comments }] } })
    await expect(cli.call(two.token, 'heartbeat_attempt', reporting).outcome).resolves.toMatchObject({
      code: 1, envelope: { ok: false, error: { code: 'stale_claim' } }
    })
    await expect(cli.call(one.token, 'heartbeat_attempt', { ...running, claimToken: reporting.claimToken }).outcome).resolves.toMatchObject({
      code: 1, envelope: { ok: false, error: { code: 'stale_claim' } }
    })
    const event = `SELECT e.kind, e.payload_json, s.grant_id FROM events e JOIN sessions s ON s.id = e.session_id
      WHERE json_extract(e.payload_json, '$.attemptId') = ? AND e.kind = ?`
    expect(db.all(event, running.attemptId, 'attempt.progress')).toEqual([{
      kind: 'attempt.progress', payload_json: expect.stringContaining('Work advanced'), grant_id: one.grantId
    }])
    expect(db.all(event, reporting.attemptId, 'attempt.submitted')).toEqual([{
      kind: 'attempt.submitted', payload_json: JSON.stringify({ attemptId: reporting.attemptId }), grant_id: two.grantId
    }])
    expect(db.all("SELECT key FROM idempotency WHERE command = 'submitAttempt'")).toEqual([{ key: reportInput.idempotencyKey }])
    const lease = db.get<{ state: string; seconds: number }>(
      'SELECT state, unixepoch(lease_expires_at) - unixepoch(heartbeat_at) AS seconds FROM attempts WHERE id = ?', running.attemptId)
    expect(lease).toEqual({ state: 'running', seconds: 90 })
  } finally {
    await cli.close()
    holder?.close()
    harness.cleanup()
  }
})
