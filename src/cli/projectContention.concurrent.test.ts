import { buildSync } from 'esbuild'
import { spawn, type ChildProcess } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { openDatabase, type Db } from '../core/db/database'
import { bindAgentMailEndpoint, provisionAgentMailEndpoint } from '../core/services/agentMail'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { dropAcceptanceNodes } from '../test/acceptanceNodes'
import { issued } from '../test/execution'
import type { Workspace } from '../core/workspace'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const WRITER_ENTER = 'DM_FIXTURE_BEGIN_IMMEDIATE'
const WAL_READY = 'DM_FIXTURE_WAL_READY'
let bundleDir: string
let cliPath: string

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
      const { writeSync } = require('node:fs');
      const dbPrototype = require('node:sqlite').DatabaseSync.prototype;
      const sqliteExec = dbPrototype.exec;
      dbPrototype.exec = function(sql) {
        if (sql === 'BEGIN IMMEDIATE') writeSync(2, ${JSON.stringify(WRITER_ENTER + '\n')});
        const result = sqliteExec.call(this, sql);
        if (sql === 'PRAGMA journal_mode = WAL') writeSync(2, ${JSON.stringify(WAL_READY + '\n')});
        return result;
      };
    ` }
  })
})

afterAll(() => {
  if (bundleDir !== undefined) rmSync(bundleDir, { recursive: true, force: true })
})

class WorkerCli {
  private readonly children = new Set<ChildProcess>()

  constructor(private readonly fixture: Harness) {}

  call(token: string, command: string, args: object) {
    const child = spawn(process.execPath, [cliPath, '--repo', this.fixture.root, 'call', command, '-'], {
      cwd: this.fixture.root, env: { ...process.env, DARKMECHANICUS_HOME: this.fixture.homeDir, DM_SESSION_TOKEN: token }
    })
    this.children.add(child)
    const { promise: outcome, resolve, reject } = Promise.withResolvers<{ code: number; envelope: unknown }>()
    // An early setup failure is also surfaced by writing; attach a handler in case the fixture aborts before reading outcome.
    void outcome.catch(() => undefined)
    const writing = Promise.withResolvers<void>()
    void writing.promise.catch(() => undefined)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.includes(WAL_READY) && stderr.includes(WRITER_ENTER)) writing.resolve()
    })
    child.on('error', reject)
    child.stdin.on('error', reject)
    child.on('close', (code) => {
      this.children.delete(child)
      if (code === null) {
        const error = new Error(`CLI stopped before ${command} returned`)
        writing.reject(error)
        return reject(error)
      }
      try {
        const envelope: unknown = JSON.parse(stdout)
        writing.reject(new Error(`${command} exited before reaching the first project write transaction`))
        resolve({ code, envelope })
      } catch {
        const error = new Error(`CLI did not return one JSON envelope for ${command}: ${stderr.replaceAll(token, '[redacted]')}`)
        writing.reject(error)
        reject(error)
      }
    })
    child.stdin.end(JSON.stringify(args))
    return { outcome, writing: writing.promise }
  }

  async close() {
    await Promise.all([...this.children].map(child => {
      const { promise, resolve } = Promise.withResolvers<void>()
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

async function whileHeld<T>(calls: Promise<T>): Promise<T> {
  const stop = new AbortController()
  try {
    // A bounded failure guard only; the event is what orders the transaction release.
    return await Promise.race([calls, delay(4_000, undefined, { signal: stop.signal }).then(() => {
      throw new Error('CLI never reached its first project write transaction after WAL open')
    })])
  } finally {
    stop.abort()
  }
}

it('completes two audited worker reads after the authorized project writer commits', async () => {
  const harness = createHarness()
  const cli = new WorkerCli(harness)
  try {
    const { desktop, comments, one, two } = await fixture(harness)
    const db = desktop.ctx().db
    holdAuthorizedWrite(db, comments.ticketId)
    const cap = cli.call(one.token, 'get_capabilities', {})
    const list = cli.call(two.token, 'list_comments', comments)
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

it('reports persistent project writer contention once, without a false success or report mutation', async () => {
  const harness = createHarness()
  const cli = new WorkerCli(harness)
  try {
    const { desktop, comments, one } = await fixture(harness)
    const db = desktop.ctx().db
    holdAuthorizedWrite(db, comments.ticketId)
    const call = cli.call(one.token, 'add_comment', { ...comments, body: 'Must not commit', idempotencyKey: 'blocked-report' })
    const stop = new AbortController()
    try {
      await whileHeld(call.writing)
      const result = await Promise.race([call.outcome, delay(12_000, undefined, { signal: stop.signal }).then(() => {
        throw new Error('CLI exceeded the storage contention budget after WAL open, at its first write transaction')
      })])
      expect(result).toMatchObject({ code: 1, envelope: { ok: false, error: {
        code: 'busy', message: expect.stringMatching(/project database.+(try|retry)/i)
      } } })
      expect(JSON.stringify(result)).not.toContain(harness.root)
      expect(JSON.stringify(result)).not.toContain(one.token)
      expect(db.get('SELECT count(*) AS n FROM sessions WHERE grant_id = ?', one.grantId)).toEqual({ n: 0 })
    } finally {
      stop.abort()
      db.exec('ROLLBACK')
    }
    expect(await desktop.listComments(comments)).toMatchObject([{ body: 'Committed comment' }])
    expect(await desktop.listComments(comments)).toHaveLength(1)
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
    const progress = cli.call(one.token, 'heartbeat_attempt', { ...running, leaseSeconds: 90, progress: { note: 'Work advanced' } })
    const reportInput = { ...reporting, idempotencyKey: 'one-report', outputs: { summary: 'Exactly one report' } }
    const submitted = cli.call(two.token, 'submit_attempt', reportInput)
    const replay = cli.call(two.token, 'submit_attempt', reportInput)
    const read = cli.call(one.token, 'list_comments', comments)
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
