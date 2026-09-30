import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import type { Workspace } from '../workspace'

interface Seeded {
  epicId: string
  ticketId: string
}

async function seedSavedEpic(agent: Workspace): Promise<Seeded> {
  await agent.initializeRepository({ name: 'comment-repo' })
  const epic = await agent.createEpic({ title: 'Comment epic' })
  const draft = await agent.updatePlanDraft({
    epicId: epic.id,
    ops: [{ op: 'add_ticket', ref: 'one', sprint: '1', ticket: { title: 'Only ticket' } }]
  })
  await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  return { epicId: epic.id, ticketId: draft.refMap['one'] ?? '' }
}

async function failureOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
  } catch (error: unknown) {
    const { code, message } = error as { code: string; message: string }
    return { code, message }
  }
  return { code: 'ok', message: '' }
}

let harness: Harness

beforeEach(() => {
  harness = createHarness()
})

afterEach(() => {
  harness.cleanup()
})

describe('comment commands', () => {
  it('adds ticket and epic comments and lists them', async () => {
    const agent = harness.open('worker')
    const orchestrator = harness.open('orchestrator')
    const { epicId, ticketId } = await seedSavedEpic(orchestrator)
    const onTicket = await agent.addComment({ epicId, ticketId, body: 'Blocked on the fixture' })
    harness.clock.advanceSeconds(1)
    const onEpic = await orchestrator.addComment({ epicId, body: 'Decision: keep the flag' })
    expect(onTicket).toMatchObject({ epicId, ticketId, author: { role: 'worker', label: 'worker session' } })
    expect(onEpic).toMatchObject({ epicId, ticketId: null, author: { role: 'orchestrator', label: 'orchestrator session' } })
    expect(await agent.listComments({ epicId })).toEqual([onTicket, onEpic])
    expect(await agent.listComments({ epicId, ticketId })).toEqual([onTicket])
  })

  it('accepts a 20,000-character body and rejects 20,001 characters or a blank body', async () => {
    const agent = harness.open('orchestrator')
    const { epicId } = await seedSavedEpic(agent)
    const longest = await agent.addComment({ epicId, body: 'x'.repeat(20_000) })
    expect(longest.body).toHaveLength(20_000)
    expect(await failureOf(agent.addComment({ epicId, body: 'x'.repeat(20_001) }))).toEqual({
      code: 'invalid_input',
      message: 'Invalid addComment input at body: A comment is at most 20000 characters'
    })
    expect(await failureOf(agent.addComment({ epicId, body: ' \n\t ' }))).toEqual({
      code: 'invalid_input',
      message: 'Invalid addComment input at body: A comment needs some text'
    })
    expect((await agent.listComments({ epicId })).map((comment) => comment.id)).toEqual([longest.id])
  })

})

describe('comment command input', () => {
  it('never takes the author from the input and rejects malformed ids', async () => {
    const agent = harness.open('orchestrator')
    const { epicId, ticketId } = await seedSavedEpic(agent)
    const raw = agent.addComment as (input: unknown) => Promise<unknown>
    const forged = await failureOf(raw({ epicId, body: 'x', author: { role: 'desktop', label: 'Ada' } }))
    expect(forged.code).toBe('invalid_input')
    expect(forged.message).toContain('author')
    expect((await failureOf(agent.addComment({ epicId, ticketId: 'DM-1', body: 'x' }))).code).toBe('invalid_input')
    expect((await failureOf(agent.listComments({ epicId: '../etc', ticketId }))).code).toBe('invalid_input')
    expect(await agent.listComments({ epicId })).toEqual([])
  })

})

describe('comment command exports', () => {
  it('exports a comment right after adding it, and earlier comments with the first save', async () => {
    const agent = harness.open('orchestrator')
    await agent.initializeRepository({ name: 'comment-repo' })
    const epic = await agent.createEpic({ title: 'Comment epic' })
    const record = (id: string): Record<string, unknown> | null => {
      const file = join(harness.root, '.darkmechanicus', 'epics', epic.id, 'comments', `${id}.json`)
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null
    }
    const early = await agent.addComment({ epicId: epic.id, body: 'Before the first save' })
    expect(record(early.id)).toBeNull()
    const draft = await agent.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'One' } }] })
    await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
    expect(record(early.id)).toMatchObject({ format: 'darkmechanicus.comment', id: early.id, body: 'Before the first save' })
    const later = await agent.addComment({ epicId: epic.id, body: 'After the save' })
    expect(record(later.id)).toMatchObject({ id: later.id, epicId: epic.id, ticketId: null, body: 'After the save' })
    expect((await agent.getStorageStatus()).outbox).toEqual({ pending: 0, failed: 0, lastError: null })
  })

  it('rebuilds comments from the tracked records after the local database is deleted', async () => {
    const agent = harness.open('reviewer')
    const orchestrator = harness.open('orchestrator')
    const { epicId, ticketId } = await seedSavedEpic(orchestrator)
    await agent.addComment({ epicId, ticketId, body: 'Reviewed: the **fixture** is flaky' })
    await orchestrator.addComment({ epicId, body: 'Decision: retry once' })
    const before = await agent.listComments({ epicId })
    agent.close()
    orchestrator.close()
    const database = join(harness.root, '.darkmechanicus', 'local', 'state.sqlite')
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${database}${suffix}`, { force: true })
    }
    expect(existsSync(database)).toBe(false)
    const rebuilt = harness.open('desktop')
    expect(await rebuilt.listComments({ epicId })).toEqual(before)
    expect(await rebuilt.listComments({ epicId, ticketId })).toEqual(before.slice(0, 1))
    const found = await rebuilt.searchHistory({ query: 'fixture' })
    expect(found.map((hit) => [hit.docType, hit.docId, hit.ticketId])).toEqual([['comment', before[0]?.id, ticketId]])
  })

  it('validates input before checking that the repository is initialized', async () => {
    const agent = harness.open('orchestrator')
    const epicId = 'ep_0000000000000000000000000z'
    expect((await failureOf(agent.addComment({ epicId, body: '' }))).code).toBe('invalid_input')
    expect((await failureOf(agent.addComment({ epicId, body: 'x' }))).code).toBe('not_initialized')
  })
})
