/**
 * Linear transfer smoke test: launches the built stdio MCP server (out/main/mcp.js) as an orchestrator against a
 * fresh temporary repository and drives the scripted transfer agent of src/test/linearTransferDriver.ts against
 * the fake Linear MCP server of src/test/fakeLinearMcp.ts:
 * - a two-sprint epic is queued and transferred; the agent crashes between creating the fourth issue and
 *   recording it, resumes from `next` and adopts that issue by its marker;
 * - a wrong milestone and an unexpected issue are injected, reported, fixed by an update and a move, and the
 *   verified read-back completes the epic; start_run and a new queue are then refused;
 * - a one-sprint epic is transferred, the transfer canceled and queued again, and every item adopted.
 * Queueing and canceling are the person's desktop commands, which no MCP tool offers, so a desktop session on
 * the same repository (the Workspace from the source, loaded with tsx) performs them. The Dark Mechanicus home
 * directory is a temporary one too. Prints each step and the resulting Linear layout.
 * Usage: npm run build && node scripts/linear-transfer-smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { tsImport } from 'tsx/esm/api'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'out', 'main', 'mcp.js')

const { openWorkspace } = await tsImport('../src/core/workspace.ts', import.meta.url)
const { createFakeLinear, callLinear } = await tsImport('../src/test/fakeLinearMcp.ts', import.meta.url)
const { TransferDriver, planOneSprintEpic, planTwoSprintEpic } = await tsImport('../src/test/linearTransferDriver.ts', import.meta.url)

/** @param {string} line */
function step(line) {
  console.log(`- ${line}`)
}

/** Calls a Dark Mechanicus tool; a failure is thrown with its code. @param {Client} client @param {string} name @param {object} [args] */
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  const payload = /** @type {{ ok: boolean, data?: any, error?: { code: string, message: string } }} */ (result.structuredContent)
  if (!payload || !payload.ok) {
    throw Object.assign(new Error(`${name} failed: ${JSON.stringify(payload?.error ?? result)}`), { code: payload?.error?.code })
  }
  return payload.data
}

/** @param {Promise<unknown>} promise */
async function codeOf(promise) {
  try {
    await promise
    return 'ok'
  } catch (error) {
    return /** @type {{ code?: string }} */ (error).code ?? String(error)
  }
}

/** The orchestrator's tools as the driver's TransferApi and the fixtures' PlanApi. @param {Client} client */
function dmOver(client) {
  return {
    getCapabilities: () => call(client, 'get_capabilities'),
    getTransfer: (/** @type {object} */ input) => call(client, 'get_transfer', input),
    startTransfer: (/** @type {object} */ input) => call(client, 'start_transfer', input),
    recordTransferItem: (/** @type {object} */ input) => call(client, 'record_transfer_item', input),
    submitTransferReadback: (/** @type {object} */ input) => call(client, 'submit_transfer_readback', input),
    createEpic: (/** @type {object} */ input) => call(client, 'create_epic', input),
    getPlan: (/** @type {object} */ input) => call(client, 'get_plan', input),
    updatePlanDraft: (/** @type {object} */ input) => call(client, 'update_plan_draft', input),
    savePlan: (/** @type {object} */ input) => call(client, 'save_plan', input)
  }
}

/** @typedef {{ dm: ReturnType<typeof dmOver>, client: Client, desktop: any, fake: any, linear: Client }} Env */

/** @param {Env} env @param {string} epicId @param {string} session @param {(step: any) => boolean} [interrupt] */
function driverFor(env, epicId, session, interrupt) {
  return new TransferDriver({ dm: env.dm, linear: env.linear, epicId, teamKey: 'ENG', session, ...(interrupt ? { interrupt } : {}) })
}

/** Transfers the two-sprint epic with a crash between the fourth issue's create and its record, then resumes. @param {Env} env */
async function interruptedTransfer(env) {
  const epicId = await planTwoSprintEpic(env.dm)
  assert.equal((await env.desktop.queueTransfer({ epicId })).status, 'queued')
  step(`queued the transfer of the two-sprint epic ${epicId} in the desktop session`)
  const crash = (/** @type {any} */ at) => at.phase === 'created' && at.kind === 'issue' && at.recordedIssues === 3
  const interrupted = await driverFor(env, epicId, 'first', crash).transfer().catch((/** @type {Error} */ error) => error)
  assert.equal(interrupted.constructor.name, 'TransferInterrupted')
  const stopped = await env.dm.getTransfer({ epicId })
  const recordedIssues = stopped.recorded.filter((/** @type {any} */ item) => item.kind === 'issue').length
  step(`crashed: ${interrupted.message} Recorded issues: ${recordedIssues}; issues in Linear: ${env.fake.dump().issues.length}; next starts at ${stopped.next[0]}`)
  const resumed = await driverFor(env, epicId, 'resumed').transfer()
  const { packet } = stopped
  assert.deepEqual(resumed.adopted, [packet.issues[3].ref])
  assert.equal(env.fake.dump().issues.length, packet.issues.length)
  step(`resumed (resumed: ${resumed.resumed}): adopted ${resumed.adopted.join(', ')} by its marker, created ${resumed.created.length} more items; Linear holds ${env.fake.dump().issues.length} issues for ${packet.issues.length} in the packet`)
  return { epicId, packet }
}

/** Injects a wrong milestone and an unexpected issue, then verifies, fixes and verifies again. @param {Env} env @param {{ epicId: string, packet: any }} transfer */
async function fixedReadback(env, { epicId, packet }) {
  const recorded = new Map((await env.dm.getTransfer({ epicId })).recorded.map((/** @type {any} */ item) => [item.ref, item.linearId]))
  const wire = packet.issues.find((/** @type {any} */ item) => item.title === 'Wire the screen to the API')
  await callLinear(env.linear, 'update_issue', { id: recorded.get(wire.ref), milestoneId: recorded.get(packet.milestones[1].ref) })
  const stray = await callLinear(env.linear, 'create_issue', { teamId: 'team-eng', projectId: recorded.get('project'), title: 'Stray note', description: 'Added by hand.' })
  step(`injected: the issue of ${wire.key} moved to the sprint 2 milestone; ${stray.identifier} added to the project by hand`)
  const log = await driverFor(env, epicId, 'verifier').verify()
  for (const result of log.results) {
    const shown = result.mismatches.map((/** @type {any} */ item) => `${item.field} ${item.key ?? item.ref}: expected ${JSON.stringify(item.expected)}, got ${JSON.stringify(item.actual)}`)
    step(`read-back ${result.status} (${JSON.stringify(result.received)})${shown.length ? `: ${shown.join('; ')}` : ''}`)
  }
  step(`fixes: ${log.fixes.join('; ')}`)
  assert.deepEqual(log.results.map((/** @type {any} */ result) => result.status), ['rejected', 'verified'])
  assert.deepEqual(log.results[0].mismatches.map((/** @type {any} */ item) => item.field), ['milestone', 'unexpected'])
  const epic = await call(env.client, 'get_epic', { epicId })
  assert.equal(epic.status, 'completed')
  step(`epic ${epic.status}: ${epic.outcome.summary}`)
  const startRun = await codeOf(call(env.client, 'start_run', { epicId, host: { label: 'smoke', type: 'smoke' } }))
  const queueAgain = await codeOf(env.desktop.queueTransfer({ epicId }))
  assert.deepEqual([startRun, queueAgain], ['completed_epic', 'completed_epic'])
  step(`refused after completion: start_run ${startRun}; queueTransfer ${queueAgain}`)
}

/** The one-sprint epic: transferred, canceled, queued again and adopted item by item. @param {Env} env */
async function cancelAndRequeue(env) {
  const epicId = await planOneSprintEpic(env.dm)
  await env.desktop.queueTransfer({ epicId })
  const first = await driverFor(env, epicId, 'first').transfer()
  step(`transferred the one-sprint epic ${epicId}: created ${first.created.length} items`)
  const canceled = await env.desktop.cancelTransfer({ epicId })
  const refused = await codeOf(env.dm.startTransfer({ epicId }))
  step(`canceled in the desktop session (${canceled.status}, ${canceled.recorded.length} recorded); start_transfer now ${refused}`)
  await env.desktop.queueTransfer({ epicId })
  const again = await driverFor(env, epicId, 'requeued').transfer()
  assert.deepEqual([again.created, again.adopted], [[], first.created])
  step(`queued again: created ${again.created.length}, adopted ${again.adopted.length} of ${first.created.length} items by marker (relations by listing)`)
  const log = await driverFor(env, epicId, 'verifier').verify()
  assert.deepEqual(log.results.map((/** @type {any} */ result) => result.status), ['verified'])
  step(`read-back ${log.results[0].status}`)
}

/** @param {string} repo @param {string} home */
async function connect(repo, home) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, '--repo', repo, '--role', 'orchestrator', '--allow-save', '--label', 'linear-transfer-smoke'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DARKMECHANICUS_HOME: home },
    stderr: 'pipe'
  })
  const client = new Client({ name: 'darkmechanicus-linear-smoke', version: '1.0.0' })
  await client.connect(transport)
  return client
}

async function main() {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-linear-smoke-repo-')))
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-linear-smoke-home-')))
  const client = await connect(repo, home)
  const fake = createFakeLinear()
  /** @type {any} */
  let desktop = null
  try {
    const dm = dmOver(client)
    const capabilities = await dm.getCapabilities()
    step(`connected to ${SERVER} (${capabilities.server.name} ${capabilities.server.version}, schema ${capabilities.schemaVersion}, role ${capabilities.role})`)
    await call(client, 'initialize_repository', { name: 'linear-smoke' })
    desktop = openWorkspace({ repoRoot: repo, role: 'desktop', label: 'Linear smoke desktop', transport: 'desktop', homeDir: home })
    const env = { dm, client, desktop, fake, linear: await fake.connect() }
    await fixedReadback(env, await interruptedTransfer(env))
    await cancelAndRequeue(env)
    console.log('\nLinear layout:')
    console.log(fake.layout())
  } finally {
    desktop?.close()
    await fake.close()
    await client.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
