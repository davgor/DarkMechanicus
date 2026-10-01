/**
 * Headless MCP smoke test: launches the built stdio server (out/main/mcp.js) against a temporary
 * repository with the MCP SDK client, plans an epic, saves it, runs one ticket end to end, and
 * round-trips a ticket comment.
 * Usage: npm run build && npm run smoke:mcp
 * Optional: MCP_SMOKE_COMMAND=/path/to/runtime (for example the packaged app executable) and
 * MCP_SMOKE_SERVER=/path/to/mcp.js (for example <resources>/app.asar/out/main/mcp.js).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = process.env.MCP_SMOKE_SERVER ?? join(ROOT, 'out', 'main', 'mcp.js')

/** @param {Client} client @param {string} name @param {Record<string, unknown>} args */
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  const payload = /** @type {{ ok: boolean, data?: any, error?: { code: string, message: string } }} */ (
    result.structuredContent
  )
  if (!payload || !payload.ok) {
    throw new Error(`${name} failed: ${JSON.stringify(payload?.error ?? result)}`)
  }
  return payload.data
}

/** @param {Client} client */
async function planAndSave(client) {
  await call(client, 'initialize_repository', { name: 'smoke-repo' })
  const epic = await call(client, 'create_epic', { title: 'Smoke epic', successCriteria: ['It runs'] })
  const draft = await call(client, 'update_plan_draft', {
    epicId: epic.id,
    ops: [
      { op: 'add_ticket', ref: 'one', sprint: '1', ticket: { title: 'First step', acceptanceCriteria: ['Done'] } },
      { op: 'add_ticket', ref: 'two', sprint: '1', ticket: { title: 'Second step' } },
      { op: 'add_dependency', from: 'one', to: 'two' }
    ]
  })
  const saved = await call(client, 'save_plan', { epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  if (saved.status !== 'saved') {
    throw new Error(`expected saved, got ${saved.status}`)
  }
  return { epicId: epic.id, first: draft.refMap.one }
}

/** @param {Client} client @param {{ epicId: string, first: string }} plan */
async function runOneTicket(client, plan) {
  const run = await call(client, 'start_run', { epicId: plan.epicId, host: { label: 'smoke', type: 'smoke' } })
  const ready = await call(client, 'get_ready_tickets', { runId: run.id })
  if (ready.ready.length !== 1 || ready.ready[0].ticketId !== plan.first) {
    throw new Error(`unexpected ready set: ${JSON.stringify(ready.ready)}`)
  }
  const claim = await call(client, 'claim_ticket', { runId: run.id, ticketId: plan.first, worker: { label: 'smoke-worker' } })
  await call(client, 'submit_attempt', {
    attemptId: claim.attempt.id,
    claimToken: claim.packet.claimToken,
    outputs: { summary: 'smoke output' }
  })
  await call(client, 'accept_attempt', { attemptId: claim.attempt.id })
  return call(client, 'get_run', { runId: run.id })
}

/** @param {Client} client @param {{ epicId: string, first: string }} plan */
async function commentOnTicket(client, plan) {
  const added = await call(client, 'add_comment', { epicId: plan.epicId, ticketId: plan.first, body: 'Smoke **note**' })
  const listed = await call(client, 'list_comments', { epicId: plan.epicId, ticketId: plan.first })
  if (listed.length !== 1 || listed[0].id !== added.id || listed[0].body !== 'Smoke **note**') {
    throw new Error(`unexpected comments: ${JSON.stringify(listed)}`)
  }
  return listed.length
}

async function main() {
  const repo = mkdtempSync(join(tmpdir(), 'dm-mcp-smoke-'))
  const transport = new StdioClientTransport({
    command: process.env.MCP_SMOKE_COMMAND ?? process.execPath,
    args: [SERVER, '--repo', repo, '--allow-save', '--label', 'smoke'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stderr: 'pipe'
  })
  const client = new Client({ name: 'darkmechanicus-smoke', version: '1.0.0' })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    const prompts = await client.listPrompts()
    const plan = await planAndSave(client)
    const run = await runOneTicket(client, plan)
    const comments = await commentOnTicket(client, plan)
    console.log(
      JSON.stringify({ tools: tools.tools.length, prompts: prompts.prompts.length, runState: run.state, counts: run.counts, comments })
    )
  } finally {
    await client.close()
    rmSync(repo, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
