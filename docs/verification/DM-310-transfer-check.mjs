/**
 * DM-310 sprint acceptance: checks c1 and c2 against the BUILT MCP server (out/main/mcp.js), in scratch
 * repositories with temporary Dark Mechanicus homes. The person's desktop commands (queueTransfer,
 * cancelTransfer) run in a desktop Workspace opened from the source with tsx, as in
 * scripts/linear-transfer-smoke.mjs.
 *
 * c1 stages two machines: repository A and repository B, each with its own server, home and local database.
 * A "pull" copies A's tracked records (everything under .darkmechanicus/ except local/) into B, as a clone or
 * pull would. A saves a newer revision and starts a run while B holds an open transfer of the epic.
 *
 * Run from the repository root after `npm run build`: node docs/verification/DM-310-transfer-check.mjs
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { tsImport } from 'tsx/esm/api'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = join(ROOT, 'out', 'main', 'mcp.js')

const { openWorkspace } = await tsImport('../../src/core/workspace.ts', import.meta.url)
const { planOneSprintEpic } = await tsImport('../../src/test/linearTransferDriver.ts', import.meta.url)

/** @param {string} line */
const say = (line) => console.log(line)

/** @param {Client} client @param {string} name @param {object} [args] */
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
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
function shown(result, show = (value) => value?.status) {
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

/** A server over stdio on `repo`, as an orchestrator that may save. @param {string} repo @param {string} home @param {string} label */
async function serve(repo, home, label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, '--repo', repo, '--role', 'orchestrator', '--allow-save', '--label', label],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DARKMECHANICUS_HOME: home },
    stderr: 'pipe'
  })
  const client = new Client({ name: label, version: '1.0.0' })
  await client.connect(transport)
  cleanups.push(() => client.close())
  return client
}

/** @param {string} prefix */
function scratch(prefix) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
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

/** @param {any} status @param {string} epicId */
function conflictsFor(status, epicId) {
  return (status.conflicts ?? []).filter((/** @type {any} */ item) => item.epicId === epicId)
}

/** The saved plan and epic one machine holds. @param {Client} client @param {string} epicId */
async function stateOf(client, epicId) {
  const plan = await call(client, 'get_plan', { epicId, view: 'saved' })
  const data = await call(client, 'get_epic', { epicId })
  const epic = data.epic ?? data
  return {
    savedRevision: { id: plan.revisionId, number: plan.revisionNumber },
    workTickets: plan.bundle.tickets.filter((/** @type {any} */ item) => item.kind !== 'acceptance').map((/** @type {any} */ item) => item.title),
    epicStatus: epic.status,
    run: epic.run ? { id: epic.run.id, state: epic.run.state ?? epic.run.status } : null,
    conflict: epic.conflict ?? null
  }
}

async function importHold() {
  say('## c1 (DM-311): a pulled revision and run for an epic with an open transfer')
  const repoA = scratch('dm310-machine-a-repo-')
  const homeA = scratch('dm310-machine-a-home-')
  const repoB = scratch('dm310-machine-b-repo-')
  const homeB = scratch('dm310-machine-b-home-')
  const a = await serve(repoA, homeA, 'dm310-machine-a')
  const caps = await call(a, 'get_capabilities')
  say(`machine A: ${SERVER} (${caps.server.name} ${caps.server.version}, schema ${caps.schemaVersion}) on ${repoA}`)
  await call(a, 'initialize_repository', { name: 'dm310-import-hold' })
  const dmA = dmOver(a)
  const epicId = await planOneSprintEpic(dmA)
  const r1 = await stateOf(a, epicId)
  say(`machine A: saved epic ${epicId}: ${JSON.stringify(r1)}`)
  await call(a, 'flush_portable_state')
  say(`pull A -> B: copied ${JSON.stringify(pullTracked(repoA, repoB))}`)

  const b = await serve(repoB, homeB, 'dm310-machine-b')
  const first = await call(b, 'reconcile_repository')
  say(`machine B reconcile_repository: imported ${JSON.stringify(first.imported)}, conflicts ${JSON.stringify(first.conflicts)}`)
  const before = await stateOf(b, epicId)
  say(`machine B holds: ${JSON.stringify(before)}`)
  assert.deepEqual(before.savedRevision, r1.savedRevision)
  const desktopB = openWorkspace({ repoRoot: repoB, role: 'desktop', label: 'DM-310 machine B desktop', transport: 'desktop', homeDir: homeB })
  cleanups.push(() => desktopB.close())
  say(`machine B desktop queueTransfer (the person): ${shown(await outcome(desktopB.queueTransfer({ epicId })))}`)

  const { bundle } = await dmA.getPlan({ epicId, view: 'saved' })
  const ticket = bundle.tickets.find((/** @type {any} */ item) => item.kind !== 'acceptance')
  const edit = await dmA.updatePlanDraft({ epicId, ops: [{ op: 'update_ticket', ticket: ticket.id, patch: { title: `${ticket.title} (edited on A)` } }] })
  const saved = await dmA.savePlan({ epicId, expectedDraftRevision: edit.draftRevision })
  say(`machine A save_plan: ${saved.status}`)
  const run = await call(a, 'start_run', { epicId })
  const r2 = await stateOf(a, epicId)
  say(`machine A start_run: run ${run.id ?? run.run?.id}; machine A holds: ${JSON.stringify(r2)}`)
  assert.ok(r1.savedRevision.id && r2.savedRevision.id && r2.savedRevision.id !== r1.savedRevision.id && r2.run?.id)
  await call(a, 'flush_portable_state')
  say(`pull A -> B: copied ${JSON.stringify(pullTracked(repoA, repoB))}`)

  const held = await call(b, 'reconcile_repository')
  say(`machine B reconcile_repository with the transfer queued: imported ${JSON.stringify(held.imported)}, unchanged ${JSON.stringify(held.unchanged)}, rejected ${JSON.stringify(held.rejected)}`)
  say(`  conflicts: ${JSON.stringify(held.conflicts)}`)
  const heldState = await stateOf(b, epicId)
  say(`machine B holds: ${JSON.stringify(heldState)}`)
  const statusHeld = await call(b, 'get_storage_status')
  say(`machine B get_storage_status conflicts for the epic: ${JSON.stringify(conflictsFor(statusHeld, epicId))}`)
  say(`machine B get_transfer: ${shown(await outcome(call(b, 'get_transfer', { epicId })))}`)
  assert.equal(held.conflicts.length, 1)
  assert.deepEqual(heldState.savedRevision, r1.savedRevision)
  assert.equal(heldState.run, null)

  say(`machine B desktop cancelTransfer (the person): ${shown(await outcome(desktopB.cancelTransfer({ epicId })))}`)
  const after = await call(b, 'reconcile_repository')
  say(`machine B reconcile_repository after cancel: imported ${JSON.stringify(after.imported)}, conflicts ${JSON.stringify(after.conflicts)}`)
  const afterState = await stateOf(b, epicId)
  say(`machine B holds: ${JSON.stringify(afterState)}`)
  const statusAfter = await call(b, 'get_storage_status')
  say(`machine B get_storage_status conflicts for the epic: ${JSON.stringify(conflictsFor(statusAfter, epicId))}`)
  assert.deepEqual(afterState.savedRevision, r2.savedRevision)
  assert.equal(afterState.run?.id, r2.run?.id)
  assert.deepEqual(after.conflicts, [])
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

async function readbackCaps() {
  say('\n## c2 (DM-312): read-back size caps')
  const repo = scratch('dm310-readback-repo-')
  const home = scratch('dm310-readback-home-')
  const client = await serve(repo, home, 'dm310-readback')
  await call(client, 'initialize_repository', { name: 'dm310-readback' })
  const epicId = await planOneSprintEpic(dmOver(client))
  const desktop = openWorkspace({ repoRoot: repo, role: 'desktop', label: 'DM-310 readback desktop', transport: 'desktop', homeDir: home })
  cleanups.push(() => desktop.close())
  say(`desktop queueTransfer: ${shown(await outcome(desktop.queueTransfer({ epicId })))}`)
  await call(client, 'start_transfer', { epicId, idempotencyKey: 'dm310-start' })
  say(`start_transfer: transfer now ${(await call(client, 'get_transfer', { epicId })).status}`)

  const oversized = { issues: issues(17, 'big', 500_000) }
  say(`oversized part: 17 issues with 500,000-character descriptions, ${JSON.stringify(oversized).length} characters of JSON (cap 8,000,000)`)
  const big = await outcome(call(client, 'submit_transfer_readback', { epicId, readback: oversized, final: false }))
  say(`submit_transfer_readback (oversized part): ${shown(big)}`)
  assert.equal(big.code, 'invalid_input')

  const p1 = await outcome(call(client, 'submit_transfer_readback', { epicId, readback: { issues: issues(600, 'a') }, final: false }))
  say(`submit_transfer_readback part 1 (600 issues, not final): ${shown(p1, (value) => value?.status ?? value)}`)
  assert.ok(p1.ok)
  const p2 = await outcome(call(client, 'submit_transfer_readback', { epicId, readback: { issues: issues(600, 'b') }, final: false }))
  say(`submit_transfer_readback part 2 (600 more issues, not final; cap 1,100): ${shown(p2)}`)
  assert.equal(p2.code, 'invalid_input')
}

async function main() {
  try {
    await importHold()
    await readbackCaps()
    say('\nall assertions passed')
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
