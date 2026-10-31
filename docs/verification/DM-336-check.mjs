/**
 * DM-336 sprint acceptance: checks c1 to c4 against the BUILT MCP server (out/main/mcp.js), in scratch
 * repositories with temporary Dark Mechanicus homes. The person's desktop commands (queueTransfer,
 * resolveEpicConflict) run in a desktop Workspace opened from the source with tsx, as in
 * scripts/linear-transfer-smoke.mjs, because no MCP tool offers them.
 *
 * c1 needs main's build: DM336_MAIN_SERVER=<main worktree>/out/main/mcp.js (main at 022734c, built in a throwaway
 * `git worktree add --detach <tmp> 022734c`).
 *
 * Run from the repository root after `npm run build`:
 *   DM336_MAIN_SERVER=/tmp/…/out/main/mcp.js node docs/verification/DM-336-check.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { tsImport } from 'tsx/esm/api'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = join(ROOT, 'out', 'main', 'mcp.js')
const MAIN_SERVER = process.env.DM336_MAIN_SERVER

const { openWorkspace } = await tsImport('../../src/core/workspace.ts', import.meta.url)
const { planOneSprintEpic } = await tsImport('../../src/test/linearTransferDriver.ts', import.meta.url)
const { MCP_MESSAGE_MAX_BYTES } = await tsImport('../../src/mcp/transport.ts', import.meta.url)
const { READBACK_LIMITS } = await tsImport('../../src/core/schemas.ts', import.meta.url)

/** @param {string} line */
const say = (line) => console.log(line)

/** @param {Client} client @param {string} name @param {object} [args] */
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 })
  const payload = /** @type {any} */ (result.structuredContent)
  if (!payload || !payload.ok) {
    throw Object.assign(new Error(`${name} failed: ${JSON.stringify(payload?.error ?? result)}`), { code: payload?.error?.code, dmError: payload?.error })
  }
  return payload.data
}

/** @param {Promise<any>} promise */
async function outcome(promise) {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    const e = /** @type {any} */ (error)
    return { ok: false, code: e.code ?? e.dmError?.code, message: e.dmError?.message ?? e.message, details: e.dmError?.details ?? e.details }
  }
}

/** @param {{ ok: boolean, code?: string, message?: string, details?: unknown, value?: any }} result @param {(value: any) => unknown} [show] */
function shown(result, show = (value) => value) {
  return result.ok ? `ok -> ${JSON.stringify(show(result.value))}` : `error ${result.code}: ${result.message} ${JSON.stringify(result.details ?? {})}`
}

/** @param {Client} client */
function dmOver(client) {
  return {
    createEpic: (/** @type {object} */ input) => call(client, 'create_epic', input),
    getPlan: (/** @type {object} */ input) => call(client, 'get_plan', input),
    updatePlanDraft: (/** @type {object} */ input) => call(client, 'update_plan_draft', input),
    savePlan: (/** @type {object} */ input) => call(client, 'save_plan', input)
  }
}

/** @type {Array<() => Promise<void> | void>} */
const cleanups = []

/** A server over stdio on `repo`, as an orchestrator that may save. @param {string} server @param {string} repo @param {string} home @param {string} label */
async function serve(server, repo, home, label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server, '--repo', repo, '--role', 'orchestrator', '--allow-save', '--label', label],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DARKMECHANICUS_HOME: home },
    stderr: 'pipe'
  })
  const client = new Client({ name: label, version: '1.0.0' })
  await client.connect(transport)
  let open = true
  const close = async () => {
    if (open) {
      open = false
      await client.close()
    }
  }
  cleanups.push(close)
  return { client, close }
}

/** @param {string} prefix */
function scratch(prefix) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** @param {string} repo */
function dbFile(repo) {
  return join(repo, '.darkmechanicus', 'local', 'state.sqlite')
}

/** Runs sqlite3 on a scratch database (a WAL database needs its -shm, so not -readonly) and prints the command and its output. @param {string} repo */
function schemaOf(repo) {
  const sql = "PRAGMA user_version; SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'transfer%' ORDER BY name;"
  const out = execFileSync('sqlite3', [dbFile(repo), sql], { encoding: 'utf8' }).trim()
  say(`$ sqlite3 ${dbFile(repo)} "${sql}"`)
  for (const line of out.split('\n')) say(`  ${line}`)
  const [version = '', ...tables] = out.split('\n')
  return { userVersion: Number(version), tables }
}

/** Copies A's tracked records into B, like a pull. @param {string} from @param {string} to */
function pullTracked(from, to) {
  const source = join(from, '.darkmechanicus')
  const copied = []
  for (const entry of readdirSync(source)) {
    if (entry === 'local') continue
    cpSync(join(source, entry), join(to, '.darkmechanicus', entry), { recursive: true, force: true })
    copied.push(entry)
  }
  return copied
}

/** Every tracked file under `.darkmechanicus/` (all but `local/`) with its sha256. @param {string} repo */
function trackedFiles(repo) {
  const base = join(repo, '.darkmechanicus')
  /** @type {Record<string, string>} */
  const files = {}
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      const rel = relative(base, path)
      if (rel === 'local') continue
      if (statSync(path).isDirectory()) walk(path)
      else files[rel] = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
    }
  }
  walk(base)
  return files
}

/** @param {Record<string, string>} files @param {string} epicId */
function epicFiles(files, epicId) {
  return Object.fromEntries(Object.entries(files).filter(([path]) => path.includes(epicId)))
}

/** The saved plan and epic one machine holds. @param {Client} client @param {string} epicId */
async function stateOf(client, epicId) {
  const plan = await call(client, 'get_plan', { epicId, view: 'saved' })
  const data = await call(client, 'get_epic', { epicId })
  const epic = data.epic ?? data
  return {
    savedRevision: { id: plan.revisionId, number: plan.revisionNumber },
    workTickets: plan.bundle.tickets.filter((/** @type {any} */ item) => item.kind !== 'acceptance').map((/** @type {any} */ item) => item.title),
    conflict: epic.conflict ?? null
  }
}

/** @param {any} status @param {string} epicId */
function conflictsFor(status, epicId) {
  return (status.conflicts ?? []).filter((/** @type {any} */ item) => item.epicId === epicId)
}

async function migrationFromMain() {
  say('## c1 (DM-337): main V10 database opened by this build')
  assert.ok(MAIN_SERVER, 'Set DM336_MAIN_SERVER to main\'s built out/main/mcp.js')
  const repo = scratch('dm336-main-v10-repo-')
  const home = scratch('dm336-main-v10-home-')
  const main = await serve(MAIN_SERVER, repo, home, 'dm336-main-022734c')
  const mainCaps = await call(main.client, 'get_capabilities')
  say(`main build: ${MAIN_SERVER} (${mainCaps.server.name} ${mainCaps.server.version}, schema ${mainCaps.schemaVersion}) on ${repo}`)
  await call(main.client, 'initialize_repository', { name: 'dm336-main-v10' })
  const epic = await call(main.client, 'create_epic', { title: 'Created by main at V10', successCriteria: ['Survives V11'] })
  const epicId = epic.id ?? epic.epic?.id
  say(`main build: initialize_repository, create_epic ${epicId}`)
  await main.close()
  const atMain = schemaOf(repo)
  assert.equal(atMain.userVersion, 10)
  assert.deepEqual(atMain.tables, [])

  const sprint = await serve(SERVER, repo, home, 'dm336-sprint-build')
  const caps = await call(sprint.client, 'get_capabilities')
  say(`this build: ${SERVER} (${caps.server.name} ${caps.server.version}, schema ${caps.schemaVersion}) on the same repository`)
  const kept = await call(sprint.client, 'get_epic', { epicId })
  say(`this build get_epic ${epicId}: title ${JSON.stringify((kept.epic ?? kept).title)}`)
  const transfer = await outcome(call(sprint.client, 'get_transfer', { epicId }))
  say(`this build get_transfer ${epicId}: ${shown(transfer)}`)
  await sprint.close()
  const after = schemaOf(repo)
  assert.equal(after.userVersion, 11)
  assert.deepEqual(after.tables, ['transfer_items', 'transfers'])

  say('\nfresh scratch repository opened by this build:')
  const freshRepo = scratch('dm336-fresh-repo-')
  const freshHome = scratch('dm336-fresh-home-')
  const fresh = await serve(SERVER, freshRepo, freshHome, 'dm336-fresh')
  await call(fresh.client, 'initialize_repository', { name: 'dm336-fresh' })
  await fresh.close()
  const freshSchema = schemaOf(freshRepo)
  assert.equal(freshSchema.userVersion, 11)
  assert.deepEqual(freshSchema.tables, ['transfer_items', 'transfers'])
}

async function pulledRecordsConflict() {
  say('\n## c2 (DM-338): a pulled revision and a local epic change')
  const repoA = scratch('dm336-machine-a-repo-')
  const homeA = scratch('dm336-machine-a-home-')
  const repoB = scratch('dm336-machine-b-repo-')
  const homeB = scratch('dm336-machine-b-home-')
  const { client: a } = await serve(SERVER, repoA, homeA, 'dm336-machine-a')
  await call(a, 'initialize_repository', { name: 'dm336-pulled-records' })
  const dmA = dmOver(a)
  const epicId = await planOneSprintEpic(dmA)
  const r1 = await stateOf(a, epicId)
  say(`machine A: saved epic ${epicId}: ${JSON.stringify(r1)}`)
  await call(a, 'flush_portable_state')
  say(`pull A -> B: copied ${JSON.stringify(pullTracked(repoA, repoB))}`)
  const { client: b } = await serve(SERVER, repoB, homeB, 'dm336-machine-b')
  const first = await call(b, 'reconcile_repository')
  say(`machine B reconcile_repository: imported ${JSON.stringify(first.imported)}, conflicts ${JSON.stringify(first.conflicts)}`)
  assert.deepEqual((await stateOf(b, epicId)).savedRevision, r1.savedRevision)

  // Machine A saves a new revision and flushes it.
  const planA = await dmA.getPlan({ epicId, view: 'saved' })
  const ticketA = planA.bundle.tickets.find((/** @type {any} */ item) => item.title === 'Prepare')
  const editA = await dmA.updatePlanDraft({ epicId, ops: [{ op: 'update_ticket', ticket: ticketA.id, patch: { title: 'Prepare (saved on A)' } }] })
  const savedA = await dmA.savePlan({ epicId, expectedDraftRevision: editA.draftRevision })
  const flushA = await call(a, 'flush_portable_state')
  const r2 = await stateOf(a, epicId)
  say(`machine A save_plan: ${savedA.status} ${savedA.revisionId} (revision ${savedA.revisionNumber}); flush ${JSON.stringify(flushA)}; A holds ${JSON.stringify(r2)}`)

  // Machine B edits its draft of the same epic, still on revision 1.
  const dmB = dmOver(b)
  const planB = await dmB.getPlan({ epicId, view: 'saved' })
  const ticketB = planB.bundle.tickets.find((/** @type {any} */ item) => item.title === 'Deliver')
  const editB = await dmB.updatePlanDraft({ epicId, ops: [{ op: 'update_ticket', ticket: ticketB.id, patch: { title: 'Deliver (saved on B)' } }] })

  // The pull lands, then B saves before any reconcile imports it: B's save is a local epic change waiting to be exported.
  say(`pull A -> B: copied ${JSON.stringify(pullTracked(repoA, repoB))}`)
  const pulled = epicFiles(trackedFiles(repoA), epicId)
  const savedB = await outcome(dmB.savePlan({ epicId, expectedDraftRevision: editB.draftRevision }))
  say(`machine B save_plan (local change): ${shown(savedB, (value) => ({ status: value.status, revisionId: value.revisionId, revisionNumber: value.revisionNumber }))}`)
  assert.ok(savedB.ok)
  const storageWaiting = await call(b, 'get_storage_status')
  say(`machine B get_storage_status: pending ${JSON.stringify(storageWaiting.pending ?? storageWaiting.outbox ?? null)}, conflicts for the epic ${JSON.stringify(conflictsFor(storageWaiting, epicId))}`)

  const flushB = await call(b, 'flush_portable_state')
  say(`machine B flush_portable_state: ${JSON.stringify(flushB)}`)
  const afterFlush = epicFiles(trackedFiles(repoB), epicId)
  say(`machine B tracked files of the epic after the flush (sha256/16): ${JSON.stringify(afterFlush)}`)
  say(`  identical to machine A's pulled files: ${JSON.stringify(afterFlush) === JSON.stringify(pulled)}`)
  assert.deepEqual(afterFlush, pulled)
  assert.equal(flushB.failed, 1)
  assert.match(flushB.errors.join(' '), /has not imported/)

  const held = await call(b, 'reconcile_repository')
  say(`machine B reconcile_repository: imported ${JSON.stringify(held.imported)}, conflicts ${JSON.stringify(held.conflicts)}`)
  assert.equal(held.conflicts.length, 1)
  const statusHeld = await call(b, 'get_storage_status')
  say(`machine B get_storage_status conflicts for the epic: ${JSON.stringify(conflictsFor(statusHeld, epicId))}`)
  const heldState = await stateOf(b, epicId)
  say(`machine B holds: ${JSON.stringify(heldState)}`)
  assert.equal(conflictsFor(statusHeld, epicId)[0]?.resolvable, true)
  assert.deepEqual(epicFiles(trackedFiles(repoB), epicId), pulled)

  // No agent can choose: the MCP server offers no tool for it, and the command refuses any session but the desktop's.
  const tools = (await b.listTools()).tools.map((tool) => tool.name)
  say(`machine B MCP tools naming a conflict: ${JSON.stringify(tools.filter((name) => /conflict|resolve/i.test(name)))} (of ${tools.length} tools)`)
  const agent = openWorkspace({ repoRoot: repoB, role: 'orchestrator', label: 'DM-336 machine B agent', transport: 'in_process', homeDir: homeB })
  say(`machine B orchestrator resolveEpicConflict keep tracked: ${shown(await outcome(agent.resolveEpicConflict({ epicId, keep: 'tracked' })))}`)
  agent.close()

  const desktopB = openWorkspace({ repoRoot: repoB, role: 'desktop', label: 'DM-336 machine B desktop', transport: 'desktop', homeDir: homeB })
  cleanups.push(() => desktopB.close())
  const resolved = await outcome(desktopB.resolveEpicConflict({ epicId, keep: 'tracked' }))
  say(`machine B desktop resolveEpicConflict keep tracked (the person): ${shown(resolved)}`)
  assert.ok(resolved.ok)
  assert.deepEqual(resolved.value.abandonedRevisionIds, [savedB.value.revisionId])

  const afterState = await stateOf(b, epicId)
  say(`machine B holds: ${JSON.stringify(afterState)}`)
  assert.deepEqual(afterState.savedRevision, r2.savedRevision)
  assert.deepEqual(afterState.workTickets, r2.workTickets)
  const afterFiles = epicFiles(trackedFiles(repoB), epicId)
  say(`machine B tracked files of the epic still identical to machine A's: ${JSON.stringify(afterFiles) === JSON.stringify(pulled)}`)
  assert.deepEqual(afterFiles, pulled)
  const flushAfter = await call(b, 'flush_portable_state')
  const reconcileAfter = await call(b, 'reconcile_repository')
  const statusAfter = await call(b, 'get_storage_status')
  say(`machine B flush_portable_state: ${JSON.stringify(flushAfter)}; reconcile_repository: imported ${JSON.stringify(reconcileAfter.imported)}, unchanged includes epic ${reconcileAfter.unchanged.includes(epicId)}, conflicts ${JSON.stringify(reconcileAfter.conflicts)}; storage conflicts for the epic ${JSON.stringify(conflictsFor(statusAfter, epicId))}`)
  assert.equal(flushAfter.failed, 0)
  assert.deepEqual(reconcileAfter.conflicts, [])
  assert.deepEqual(epicFiles(trackedFiles(repoB), epicId), pulled)
}

/**
 * Speaks JSON-RPC lines to the built server's stdin directly, so a line can exceed the limit.
 * @param {string} repo @param {string} home
 */
function rawServer(repo, home) {
  const child = spawn(process.execPath, [SERVER, '--repo', repo, '--role', 'orchestrator', '--label', 'dm336-raw'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DARKMECHANICUS_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  /** @type {Map<string | number, (message: any) => void>} */
  const waiting = new Map()
  let buffer = ''
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() === '') continue
      const message = JSON.parse(line)
      waiting.get(message.id)?.(message)
    }
  })
  cleanups.push(() => {
    child.kill()
  })
  return {
    child,
    stderr: () => stderr,
    /** @param {string | number} id */
    reply: (id) => new Promise((resolve) => waiting.set(id, resolve)),
    /** @param {string} line */
    send: (line) => new Promise((resolve, reject) => child.stdin.write(`${line}\n`, (error) => (error ? reject(error) : resolve(undefined))))
  }
}

async function oversizedMessage() {
  say('\n## c3 (DM-339): an oversized stdin message to the built server')
  const repo = scratch('dm336-transport-repo-')
  const home = scratch('dm336-transport-home-')
  const server = rawServer(repo, home)
  const init = server.reply(1)
  await server.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dm336-raw', version: '1.0.0' } } }))
  const initialized = /** @type {any} */ (await init)
  say(`initialize -> ${initialized.result.serverInfo.name} ${initialized.result.serverInfo.version}`)
  await server.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))

  const pad = 'x'.repeat(MCP_MESSAGE_MAX_BYTES)
  const cases = [
    { label: 'id first', id: 2, line: `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_capabilities","arguments":{"pad":"${pad}"}}}` },
    { label: 'id last, as the SDK client writes it', id: 'big-3', line: `{"method":"tools/call","params":{"name":"get_capabilities","arguments":{"pad":"${pad}"}},"jsonrpc":"2.0","id":"big-3"}` }
  ]
  let next = 10
  for (const item of cases) {
    const bytes = Buffer.byteLength(item.line)
    const refused = server.reply(item.id)
    const nextId = next++
    const served = server.reply(nextId)
    await server.send(item.line)
    await server.send(JSON.stringify({ jsonrpc: '2.0', id: nextId, method: 'tools/call', params: { name: 'get_capabilities', arguments: {} } }))
    const error = /** @type {any} */ (await refused)
    say(`request ${JSON.stringify(item.id)} (${item.label}): ${bytes} bytes against MCP_MESSAGE_MAX_BYTES ${MCP_MESSAGE_MAX_BYTES} -> ${JSON.stringify(error)}`)
    assert.ok(bytes > MCP_MESSAGE_MAX_BYTES)
    assert.ok(error.error && !error.result)
    const ok = /** @type {any} */ (await served)
    const data = ok.result?.structuredContent?.data
    say(`next request ${nextId} get_capabilities -> ok ${ok.result?.structuredContent?.ok}, server ${data?.server?.name} ${data?.server?.version}, schema ${data?.schemaVersion}`)
    assert.equal(ok.result?.structuredContent?.ok, true)
  }
  // The limit is inclusive: a line of exactly MCP_MESSAGE_MAX_BYTES bytes is read (whatever the tool then says of it).
  const shell = (/** @type {string} */ fill) => `{"jsonrpc":"2.0","id":30,"method":"tools/call","params":{"name":"get_capabilities","arguments":{"pad":"${fill}"}}}`
  const exact = shell('x'.repeat(MCP_MESSAGE_MAX_BYTES - Buffer.byteLength(shell(''))))
  const atLimit = server.reply(30)
  await server.send(exact)
  const read = /** @type {any} */ (await atLimit)
  const readShown = read.error ? `JSON-RPC error ${read.error.code}` : `result ok ${read.result?.structuredContent?.ok}, isError ${read.result?.isError ?? false}`
  say(`request 30: exactly ${Buffer.byteLength(exact)} bytes -> read and answered (${readShown}; not the -32600 refusal)`)
  assert.equal(Buffer.byteLength(exact), MCP_MESSAGE_MAX_BYTES)
  assert.notEqual(read.error?.code, -32600)
  const list = server.reply(20)
  await server.send(JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/list' }))
  say(`tools/list after both refusals -> ${(/** @type {any} */ (await list)).result.tools.length} tools; server still running: ${server.child.exitCode === null}`)
  const logged = server.stderr().split('\n').filter((line) => /byte|limit|refus/i.test(line))
  if (logged.length > 0) say(`server stderr: ${JSON.stringify(logged.map((line) => line.slice(0, 300)))}`)
}

/** @param {number} n @param {string} prefix @param {number} [descriptionChars] */
function issues(n, prefix, descriptionChars = 0) {
  return Array.from({ length: n }, (_, at) => ({
    linearId: `${prefix}-${at + 1}`,
    identifier: `ENG-${prefix}-${at + 1}`,
    milestoneId: null,
    title: `Issue ${at + 1}`,
    description: 'x'.repeat(descriptionChars),
    priority: 0,
    labels: [],
    stateType: 'unstarted'
  }))
}

async function readbackTotal() {
  say('\n## c3 (DM-339): the merged read-back over READBACK_LIMITS.totalChars, through the built server')
  const repo = scratch('dm336-readback-repo-')
  const home = scratch('dm336-readback-home-')
  const { client } = await serve(SERVER, repo, home, 'dm336-readback')
  await call(client, 'initialize_repository', { name: 'dm336-readback' })
  const epicId = await planOneSprintEpic(dmOver(client))
  const desktop = openWorkspace({ repoRoot: repo, role: 'desktop', label: 'DM-336 readback desktop', transport: 'desktop', homeDir: home })
  cleanups.push(() => desktop.close())
  say(`desktop queueTransfer: ${shown(await outcome(desktop.queueTransfer({ epicId })), (value) => value?.status)}`)
  await call(client, 'start_transfer', { epicId, idempotencyKey: 'dm336-start' })
  say(`start_transfer: transfer now ${(await call(client, 'get_transfer', { epicId })).status}`)

  const perPart = 15
  const descriptionChars = 500_000
  let total = 2 // the merged read-back's own braces, roughly
  let part = 0
  for (; ; part += 1) {
    const readback = { issues: issues(perPart, `p${part}`, descriptionChars) }
    const chars = JSON.stringify(readback).length
    assert.ok(chars <= READBACK_LIMITS.partChars)
    if (total + chars > READBACK_LIMITS.totalChars) break
    const result = await outcome(call(client, 'submit_transfer_readback', { epicId, readback, final: false }))
    total += chars
    say(`part ${part + 1}: ${chars} characters of JSON (merged about ${total}) -> ${shown(result, (value) => ({ status: value.status, received: value.received }))}`)
    assert.ok(result.ok)
  }
  const over = { issues: issues(perPart, `p${part}`, descriptionChars) }
  const overChars = JSON.stringify(over).length
  say(`part ${part + 1}: ${overChars} characters of JSON, within the ${READBACK_LIMITS.partChars} per-part cap; merged it would be about ${total + overChars} against totalChars ${READBACK_LIMITS.totalChars}`)
  const refused = await outcome(call(client, 'submit_transfer_readback', { epicId, readback: over, final: false }))
  say(`submit_transfer_readback part ${part + 1} (not final): ${shown(refused)}`)
  assert.equal(refused.code, 'invalid_input')
  assert.deepEqual(refused.details, { limit: 'totalChars', max: READBACK_LIMITS.totalChars })
  const small = await outcome(call(client, 'submit_transfer_readback', { epicId, readback: { issues: issues(1, 'small') }, final: false }))
  say(`a small part after the refusal (the parts sent before are kept): ${shown(small, (value) => ({ status: value.status, received: value.received }))}`)
  assert.ok(small.ok)
  const finalOver = await outcome(call(client, 'submit_transfer_readback', { epicId, readback: over, final: true }))
  say(`the same oversized part as the final part: ${shown(finalOver)}`)
  assert.equal(finalOver.code, 'invalid_input')
  const fresh = await outcome(call(client, 'submit_transfer_readback', { epicId, readback: { issues: issues(1, 'after-final') }, final: false }))
  say(`a new part after the refused final part (stored parts cleared, so it starts a new read-back): ${shown(fresh, (value) => ({ status: value.status, received: value.received }))}`)
  assert.ok(fresh.ok)
  assert.equal(fresh.value.received.issues, 1)
}

async function servedGuide() {
  say('\n## c4 (DM-340): the served guide and SKILLS_VERSION')
  const repo = scratch('dm336-guide-repo-')
  const home = scratch('dm336-guide-home-')
  const { client } = await serve(SERVER, repo, home, 'dm336-guide')
  const caps = await call(client, 'get_capabilities')
  say(`get_capabilities: server ${caps.server.name} ${caps.server.version}, skillsVersion ${caps.skillsVersion}`)
  assert.equal(caps.skillsVersion, '1.6.2')
  const prompt = await client.getPrompt({ name: 'darkmechanicus-linear-transfer' })
  const text = prompt.messages.map((message) => (message.content.type === 'text' ? message.content.text : '')).join('\n')
  const line = text.split('\n').find((candidate) => candidate.includes('An accepted final part ends the read-back')) ?? ''
  say(`prompts/get darkmechanicus-linear-transfer (${text.length} characters), the final-part line:\n  ${line}`)
  assert.ok(line.includes('the stored parts are still cleared'))
  assert.ok(!text.includes('A final part always ends the read-back, whatever the result'))
  say(`  old wording "A final part always ends the read-back, whatever the result" present: ${text.includes('A final part always ends the read-back, whatever the result')}`)
}

async function main() {
  try {
    await migrationFromMain()
    await pulledRecordsConflict()
    await oversizedMessage()
    await readbackTotal()
    await servedGuide()
    say('\nall assertions passed')
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
