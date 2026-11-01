/**
 * DM-284 sprint acceptance: checks c1, c4, c5, c6, c7 and the prompt half of c8 against the BUILT MCP server
 * (out/main/mcp.js) in a scratch repository with a temporary Dark Mechanicus home. The human-only steps
 * (queueTransfer, cancelTransfer, queueRun) run in a desktop Workspace opened from the source with tsx, as in
 * scripts/linear-transfer-smoke.mjs. Linear is the in-memory fake from src/test/fakeLinearMcp.ts.
 *
 * Run from the repository root after `npm run build`: node docs/verification/DM-284-transfer-check.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { tsImport } from 'tsx/esm/api'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = join(ROOT, 'out', 'main', 'mcp.js')

const { openWorkspace } = await tsImport('../../src/core/workspace.ts', import.meta.url)
const { createFakeLinear, callLinear } = await tsImport('../../src/test/fakeLinearMcp.ts', import.meta.url)
const { TransferDriver, planOneSprintEpic, planTwoSprintEpic } = await tsImport('../../src/test/linearTransferDriver.ts', import.meta.url)

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
    const value = await promise
    return { ok: true, value }
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

/** c7 and the prompt half of c8; c1 quotes the planner and worker prompts. @param {Client} client */
async function listings(client) {
  say('## c7: tools/list (transfer tools and their annotations)')
  const { tools } = await client.listTools()
  for (const name of ['get_transfer', 'start_transfer', 'record_transfer_item', 'submit_transfer_readback']) {
    const tool = tools.find((item) => item.name === name)
    assert.ok(tool, `${name} is listed`)
    say(`${name}: ${JSON.stringify(tool.annotations)}`)
  }
  const queueOrCancel = tools.filter((tool) => /queue|cancel/i.test(tool.name)).map((tool) => tool.name)
  say(`tools whose name contains queue or cancel: ${JSON.stringify(queueOrCancel)} (of ${tools.length} tools)`)
  const transferTools = tools.filter((tool) => /transfer/i.test(tool.name)).map((tool) => tool.name)
  say(`every tool whose name contains transfer: ${JSON.stringify(transferTools)}`)
  assert.deepEqual(transferTools.filter((name) => /queue|cancel/i.test(name)), [])
  assert.deepEqual(queueOrCancel, ['cancel_run'])

  say('\n## c8: prompts/list')
  const { prompts } = await client.listPrompts()
  const names = prompts.map((prompt) => prompt.name)
  say(names.join('\n'))
  assert.ok(names.includes('darkmechanicus-linear-transfer'))

  say('\n## c1: planner and worker prompts served by the built server (matching lines)')
  for (const name of ['darkmechanicus-planner', 'darkmechanicus-worker']) {
    const prompt = await client.getPrompt({ name })
    const text = prompt.messages.map((message) => (message.content.type === 'text' ? message.content.text : '')).join('\n')
    say(`### ${name}`)
    for (const line of text.split('\n')) {
      if (/plan states|plan-stated|Standards|\*\*Tests\*\*/.test(line)) say(`> ${line}`)
    }
  }
}

/** c4 and c5 on a one-sprint fixture epic. @param {any} env */
async function startRecordAndLock(env) {
  const { dm, client, desktop } = env
  const epicId = await planOneSprintEpic(dm)
  say(`\n## c4: fixture epic ${epicId} (one sprint, saved)`)
  say(`get_transfer before queueing: ${shown(await outcome(dm.getTransfer({ epicId })))}`)
  const early = await outcome(dm.startTransfer({ epicId, idempotencyKey: 'c4-start-early' }))
  say(`start_transfer before the desktop queues: ${shown(early)}`)
  assert.equal(early.ok, false)
  say(`desktop queueTransfer: ${shown(await outcome(desktop.queueTransfer({ epicId })))}`)
  const started = await dm.startTransfer({ epicId, idempotencyKey: 'c4-start' })
  say(`start_transfer after queueing: transfer now ${(await dm.getTransfer({ epicId })).status}; recorded ${started.recorded.length}; next = ${JSON.stringify(started.next)}`)
  const [first, second] = started.next
  const r1 = await outcome(dm.recordTransferItem({ epicId, ref: first, linearId: 'lin-prj-1', url: 'https://linear.fake/acme/project/c4-prj-1', idempotencyKey: 'c4-rec-1' }))
  say(`record_transfer_item ${first}: ${shown(r1, (value) => value)}`)
  const r2 = await outcome(dm.recordTransferItem({ epicId, ref: second, linearId: 'lin-ms-1', idempotencyKey: 'c4-rec-2' }))
  say(`record_transfer_item ${second}: ${shown(r2, (value) => value)}`)
  const after = await dm.getTransfer({ epicId })
  say(`get_transfer after two records: recorded = ${JSON.stringify(after.recorded.map((item) => item.ref))}; next = ${JSON.stringify(after.next)}`)
  assert.deepEqual(after.next, started.next.slice(2))
  say(`next equals the first next minus its first two refs, in order: ${JSON.stringify(after.next) === JSON.stringify(started.next.slice(2))}`)

  say(`\n## c5: the same epic while its transfer is ${after.status}`)
  const { bundle } = await dm.getPlan({ epicId, view: 'saved' })
  const ticket = bundle.tickets.find((item) => item.kind !== 'acceptance')
  const edit = await dm.updatePlanDraft({ epicId, ops: [{ op: 'update_ticket', ticket: ticket.id, patch: { title: `${ticket.title} (edited)` } }] })
  say(`update_plan_draft (an unsaved edit to save): draftRevision ${edit.draftRevision}`)
  say(`queue_run (desktop queueRun) while open: ${shown(await outcome(desktop.queueRun({ epicId })))}`)
  say(`save_plan while open: ${shown(await outcome(dm.savePlan({ epicId, expectedDraftRevision: edit.draftRevision })))}`)
  say(`desktop cancelTransfer: ${shown(await outcome(desktop.cancelTransfer({ epicId })))}`)
  const saved = await outcome(dm.savePlan({ epicId, expectedDraftRevision: edit.draftRevision }))
  say(`save_plan after cancel: ${shown(saved)}`)
  const queued = await outcome(desktop.queueRun({ epicId }))
  say(`queue_run (desktop queueRun) after cancel: ${shown(queued, (value) => ({ runId: value?.id ?? value?.runId, state: value?.state ?? value?.status }))}`)
  assert.ok(saved.ok && queued.ok)
}

/** c6 on a two-sprint fixture epic: one wrong priority, then the corrected read-back. @param {any} env */
async function wrongPriority(env) {
  const { dm, client, desktop, linear } = env
  const epicId = await planTwoSprintEpic(dm)
  say(`\n## c6: fixture epic ${epicId} (two sprints, saved)`)
  await desktop.queueTransfer({ epicId })
  const driver = () => new TransferDriver({ dm, linear, epicId, teamKey: 'ENG', session: `c6-${Math.random()}` })
  const placed = await driver().transfer()
  say(`transferred to the fake Linear: created ${placed.created.length} items`)
  const view = await dm.getTransfer({ epicId })
  const issue = view.packet.issues.find((item) => item.title === 'Build the screen')
  const linearId = view.recorded.find((item) => item.ref === issue.ref).linearId
  const wrong = issue.priority === 1 ? 4 : 1
  await callLinear(linear, 'update_issue', { id: linearId, priority: wrong })
  say(`injected: priority of ${issue.key} set to ${wrong} in Linear (packet priority ${issue.priority})`)
  const log = await driver().verify()
  for (const result of log.results) {
    const mismatches = result.mismatches.map((item) => ({ field: item.field, key: item.key, ref: item.ref, expected: item.expected, actual: item.actual }))
    say(`read-back ${result.status}: received ${JSON.stringify(result.received)}; mismatches ${JSON.stringify(mismatches)}`)
  }
  say(`fixes: ${log.fixes.join('; ')}`)
  assert.deepEqual(log.results.map((result) => result.status), ['rejected', 'verified'])
  assert.deepEqual(log.results[0].mismatches.map((item) => [item.field, item.key]), [['priority', issue.key]])
  const epic = await call(client, 'get_epic', { epicId })
  const items = epic.outcome?.transfer?.items ?? []
  say(`get_epic: status ${epic.status}; outcome.summary ${JSON.stringify(epic.outcome?.summary)}`)
  say(`outcome.transfer: projectUrl ${epic.outcome.transfer.projectUrl}; items ${items.length}; first three ${JSON.stringify(items.slice(0, 3))}`)
  assert.equal(epic.status, 'completed')
  assert.ok(items.length > 0)
  const comments = await call(client, 'list_comments', { epicId })
  const list = Array.isArray(comments) ? comments : (comments.comments ?? comments.items ?? [])
  const last = list[list.length - 1]
  say(`summary comment (last of ${list.length}):\n${last?.body}`)
}

async function main() {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm284-scratch-repo-')))
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm284-scratch-home-')))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, '--repo', repo, '--role', 'orchestrator', '--allow-save', '--label', 'dm284-acceptance'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DARKMECHANICUS_HOME: home },
    stderr: 'pipe'
  })
  const client = new Client({ name: 'dm284-acceptance', version: '1.0.0' })
  await client.connect(transport)
  const fake = createFakeLinear()
  /** @type {any} */
  let desktop = null
  try {
    const dm = dmOver(client)
    const capabilities = await dm.getCapabilities()
    say(`connected to ${SERVER} (${capabilities.server.name} ${capabilities.server.version}, schema ${capabilities.schemaVersion}, role ${capabilities.role}); scratch repo ${repo}`)
    await listings(client)
    await call(client, 'initialize_repository', { name: 'dm284-scratch' })
    desktop = openWorkspace({ repoRoot: repo, role: 'desktop', label: 'DM-284 desktop', transport: 'desktop', homeDir: home })
    const env = { dm, client, desktop, linear: await fake.connect() }
    await startRecordAndLock(env)
    await wrongPriority(env)
    say('\nall assertions passed')
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
