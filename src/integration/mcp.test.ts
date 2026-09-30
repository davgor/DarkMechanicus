import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMcpServer } from '../mcp/server'
import type { SessionRole } from '../shared/domain/views'
import { createHarness, type Harness } from '../test/workspaceHarness'

interface Payload {
  ok: boolean
  data?: Record<string, unknown>
  error?: { code: string; message: string }
}

/** A client talking to an MCP server over a Workspace opened for the same role and save flag. */
async function connect(harness: Harness, role: SessionRole, allowSave: boolean): Promise<Client> {
  const workspace = harness.open(role, { allowSave })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(workspace, { name: 'darkmechanicus', version: 'test' }, { role, allowSave })
  await server.connect(serverTransport)
  const client = new Client({ name: 'integration-test', version: '1.0.0' })
  await client.connect(clientTransport)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Payload> {
  const result = await client.callTool({ name, arguments: args })
  return result.structuredContent as unknown as Payload
}

function data<T>(payload: Payload): T {
  expect(payload.error).toBeUndefined()
  return payload.data as T
}

describe('MCP tools over the real Workspace', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('lets an agent plan, save, and read back an epic headlessly', async () => {
    const client = await connect(harness, 'orchestrator', true)
    data(await call(client, 'initialize_repository', { name: 'agent-repo' }))
    const epic = data<{ id: string }>(await call(client, 'create_epic', { title: 'Agent epic', successCriteria: ['Works'] }))
    const first = data<{ ticketId: string; draftRevision: number }>(
      await call(client, 'create_ticket', { epicId: epic.id, ticket: { title: 'Foundation', acceptanceCriteria: ['Built'] } })
    )
    const second = data<{ ticketId: string; draftRevision: number }>(
      await call(client, 'create_ticket', {
        epicId: epic.id,
        ticket: { title: 'Feature' },
        requires: [first.ticketId],
        expectedDraftRevision: first.draftRevision
      })
    )
    const validation = data<{ valid: boolean }>(await call(client, 'validate_plan', { epicId: epic.id, view: 'draft' }))
    expect(validation.valid).toBe(true)
    const saved = data<{ status: string; revisionNumber: number }>(
      await call(client, 'save_plan', { epicId: epic.id, expectedDraftRevision: second.draftRevision })
    )
    expect([saved.status, saved.revisionNumber]).toEqual(['saved', 1])
    const plan = data<{ bundle: { edges: { from: string; to: string }[] } }>(
      await call(client, 'get_plan', { epicId: epic.id, view: 'saved' })
    )
    expect(plan.bundle.edges).toEqual([{ from: first.ticketId, to: second.ticketId }])
  })
})

describe('MCP errors over the real Workspace', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('returns structured errors for rule violations and malformed input', async () => {
    const client = await connect(harness, 'planner', false)
    const listed = (await client.listTools()).tools.map((tool) => tool.name)
    expect([listed.includes('create_ticket'), listed.includes('save_plan')]).toEqual([true, false])
    const notReady = await call(client, 'list_epics')
    expect(notReady.error?.code).toBe('not_initialized')
    data(await call(client, 'initialize_repository', {}))
    const epic = data<{ id: string }>(await call(client, 'create_epic', { title: 'Planner epic' }))
    const draft = data<{ draftRevision: number }>(
      await call(client, 'create_ticket', { epicId: epic.id, ticket: { title: 'Only ticket' } })
    )
    const denied = await call(client, 'save_plan', { epicId: epic.id, expectedDraftRevision: draft.draftRevision })
    expect(denied.error?.code).toBe('unauthorized')
    const malformed = await client.callTool({ name: 'get_epic', arguments: { epicId: 'not-an-id' } })
    expect(malformed.isError).toBe(true)
    expect(malformed.structuredContent).toEqual({
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'Invalid arguments for get_epic: epicId: Expected a stable id such as tk_…',
        details: { tool: 'get_epic', issues: [{ path: 'epicId', message: 'Expected a stable id such as tk_…' }] }
      }
    })
  })
})

describe('MCP comment tools over the real Workspace', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('lets a worker comment on a ticket and an orchestrator read it back', async () => {
    const orchestrator = await connect(harness, 'orchestrator', true)
    data(await call(orchestrator, 'initialize_repository', { name: 'comment-repo' }))
    const epic = data<{ id: string }>(await call(orchestrator, 'create_epic', { title: 'Commented epic' }))
    const ticket = data<{ ticketId: string; draftRevision: number }>(
      await call(orchestrator, 'create_ticket', { epicId: epic.id, ticket: { title: 'Only ticket' } })
    )
    data(await call(orchestrator, 'save_plan', { epicId: epic.id, expectedDraftRevision: ticket.draftRevision }))
    const worker = await connect(harness, 'worker', false)
    const note = data<{ id: string }>(
      await call(worker, 'add_comment', { epicId: epic.id, ticketId: ticket.ticketId, body: 'Blocked: the fixture is missing' })
    )
    const listed = data<{ id: string; ticketId: string; author: { role: string; label: string } }[]>(
      await call(orchestrator, 'list_comments', { epicId: epic.id })
    )
    expect(listed.map((comment) => [comment.id, comment.ticketId, comment.author])).toEqual([
      [note.id, ticket.ticketId, { role: 'worker', label: 'worker session' }]
    ])
    const found = data<{ docType: string; docId: string }[]>(await call(orchestrator, 'search_history', { query: 'fixture' }))
    expect(found.map((hit) => [hit.docType, hit.docId])).toEqual([['comment', note.id]])
  })
})
