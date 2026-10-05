import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Workspace } from '../core/workspace'
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

const REVIEW_CAPABILITY = {
  workType: 'review',
  reasoning: { level: 'deep', rationale: 'Independent verification' },
  skills: ['security-review'],
  modalities: ['text'],
  tools: ['repo_read', 'test_execution'],
  context: { estimatedInputTokens: 30000, requiredArtifacts: [] },
  constraints: { environments: [], dataLocation: null, maxDurationMinutes: null, maxCostUsd: null },
  preferences: { quality: 'high', latency: null, cost: null, autonomy: null, modelOverride: null }
}

describe('named capability profiles over MCP', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('lets a planner save a profile and start a ticket from it', async () => {
    const client = await connect(harness, 'planner', false)
    data(await call(client, 'initialize_repository', { name: 'profile-repo' }))
    expect(data<unknown[]>(await call(client, 'list_profiles'))).toEqual([])
    data(await call(client, 'save_profile', { name: 'deep-review', description: 'Careful review', capability: REVIEW_CAPABILITY }))
    const profile = data<{ capability: unknown; revision: number }>(await call(client, 'get_profile', { name: 'deep-review' }))
    expect(profile).toMatchObject({ capability: REVIEW_CAPABILITY, revision: 1 })
    const stale = await call(client, 'save_profile', { name: 'deep-review', capability: REVIEW_CAPABILITY })
    expect(stale.error?.code).toBe('conflict')
    const epic = data<{ id: string }>(await call(client, 'create_epic', { title: 'Review epic' }))
    const created = data<{ ticketId: string }>(
      await call(client, 'create_ticket', { epicId: epic.id, ticket: { title: 'Review the importer', capability: profile.capability } })
    )
    const ticket = data<{ ticket: { capability: unknown } }>(
      await call(client, 'get_ticket', { epicId: epic.id, ticketId: created.ticketId, view: 'draft' })
    )
    expect(ticket.ticket.capability).toEqual(REVIEW_CAPABILITY)
  })

  it('refuses a worker that tries to save a profile', async () => {
    const orchestrator = harness.open('orchestrator')
    await orchestrator.initializeRepository({ name: 'profile-repo' })
    const client = await connect(harness, 'worker', false)
    const denied = await call(client, 'save_profile', { name: 'deep-review', capability: REVIEW_CAPABILITY })
    expect(denied.error).toEqual({ code: 'unauthorized', message: 'This worker session is not permitted to perform "profile.write".', details: { role: 'worker', capability: 'profile.write', tool: 'save_profile' } })
  })
})

describe('resume_run over MCP for a run paused for sign-in', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  /** An orchestrator MCP client with a running run, and the desktop's own session on the same repository. */
  async function runningRun(): Promise<{ orchestrator: Client; desktop: Workspace; runId: string }> {
    const orchestrator = await connect(harness, 'orchestrator', true)
    data(await call(orchestrator, 'initialize_repository', { name: 'signed-out-repo' }))
    const epic = data<{ id: string }>(await call(orchestrator, 'create_epic', { title: 'Sign-in pause' }))
    const ticket = data<{ draftRevision: number }>(await call(orchestrator, 'create_ticket', { epicId: epic.id, ticket: { title: 'Only ticket' } }))
    data(await call(orchestrator, 'save_plan', { epicId: epic.id, expectedDraftRevision: ticket.draftRevision }))
    const run = data<{ id: string; state: string }>(await call(orchestrator, 'start_run', { epicId: epic.id }))
    expect(run.state).toBe('running')
    return { orchestrator, desktop: harness.open('desktop'), runId: run.id }
  }

  it('fails with unauthorized naming the desktop app, and only the desktop resumes the run', async () => {
    const { orchestrator, desktop, runId } = await runningRun()
    await desktop.pauseRun({ runId, reason: 'signed_out' })

    const refused = await call(orchestrator, 'resume_run', { runId })

    expect(refused.error).toEqual({
      code: 'unauthorized',
      message: 'This run is paused because its agent was signed out. The person resumes it in the desktop app, with Resume run.',
      details: { role: 'orchestrator', capability: 'run.resume_signed_out' }
    })
    expect(data<{ state: string; pauseReason: string }>(await call(orchestrator, 'get_run', { runId }))).toMatchObject({
      state: 'paused',
      pauseReason: 'signed_out'
    })
    expect(await desktop.resumeRun({ runId })).toMatchObject({ state: 'running', pauseReason: null })
  })

  it('still resumes a run paused for any other reason', async () => {
    const { orchestrator, runId } = await runningRun()
    data(await call(orchestrator, 'pause_run', { runId, reason: 'lunch' }))

    expect(data<{ state: string; pauseReason: string | null }>(await call(orchestrator, 'resume_run', { runId }))).toMatchObject({
      state: 'running',
      pauseReason: null
    })
  })

  it('refuses it as well after the desktop marked a run paused for another reason as signed out', async () => {
    const { orchestrator, desktop, runId } = await runningRun()
    data(await call(orchestrator, 'pause_run', { runId, reason: 'lunch' }))
    await desktop.pauseRun({ runId, reason: 'signed_out' })

    expect((await call(orchestrator, 'resume_run', { runId })).error?.code).toBe('unauthorized')
    expect(await desktop.resumeRun({ runId })).toMatchObject({ state: 'running' })
  })
})
