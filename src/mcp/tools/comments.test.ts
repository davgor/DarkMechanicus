import { describe, expect, it } from 'vitest'
import type { CommandName } from '../../shared/domain/api'
import { areaServer, callTool, type McpRig, sampleId, withRig } from '../../test/mcpHarness'
import { createCannedApi, type StubApi } from '../../test/stubApi'
import { registerCommentTools } from './comments'

const EPIC = sampleId('epic')
const TICKET = sampleId('ticket', 7)
const MARKER = { marker: 'canned' }

function inRig<T>(api: StubApi, body: (rig: McpRig) => Promise<T>): Promise<T> {
  return withRig(areaServer(registerCommentTools), api, body)
}

interface Case {
  tool: string
  args: Record<string, unknown>
  method: CommandName
  input: unknown
}

const CASES: Case[] = [
  {
    tool: 'add_comment',
    args: { epicId: EPIC, body: 'Decision: ship behind a flag.' },
    method: 'addComment',
    input: { epicId: EPIC, body: 'Decision: ship behind a flag.' }
  },
  {
    tool: 'add_comment',
    args: { epicId: EPIC, ticketId: TICKET, body: 'Blocked on **DM-3**', idempotencyKey: 'note-1' },
    method: 'addComment',
    input: { epicId: EPIC, ticketId: TICKET, body: 'Blocked on **DM-3**', idempotencyKey: 'note-1' }
  },
  { tool: 'list_comments', args: { epicId: EPIC }, method: 'listComments', input: { epicId: EPIC } },
  {
    tool: 'list_comments',
    args: { epicId: EPIC, ticketId: TICKET },
    method: 'listComments',
    input: { epicId: EPIC, ticketId: TICKET }
  }
]

describe('comment tools map to the command layer', () => {
  it.each(CASES)('$tool calls $method', async ({ tool, args, method, input }) => {
    const api = createCannedApi({ [method]: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, tool, args)
      expect(outcome.isError).toBe(false)
      expect(outcome.payload).toEqual({ ok: true, data: MARKER })
      expect(api.calls).toEqual([{ name: method, input }])
    })
  })
})

describe('add_comment input', () => {
  it('accepts a 20,000-character body', async () => {
    const api = createCannedApi({ addComment: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'add_comment', { epicId: EPIC, body: 'x'.repeat(20_000) })
      expect(outcome.isError).toBe(false)
      expect(api.calls.map((call) => call.name)).toEqual(['addComment'])
    })
  })

  it.each([
    ['a body of 20,001 characters', { epicId: EPIC, body: 'x'.repeat(20_001) }, 'A comment is at most 20000 characters'],
    ['a blank body', { epicId: EPIC, body: '  \n ' }, 'A comment needs some text'],
    ['a missing body', { epicId: EPIC }, 'body'],
    ['a ticket key instead of an id', { epicId: EPIC, ticketId: 'DM-3', body: 'x' }, 'ticketId']
  ])('rejects %s before anything runs', async (_label, args, problem) => {
    const api = createCannedApi({ addComment: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'add_comment', args)
      expect(outcome.isError).toBe(true)
      expect(outcome.text).toContain(problem)
      expect(api.calls).toEqual([])
    })
  })

  it('drops a caller-supplied author: the session signs the comment', async () => {
    const api = createCannedApi({ addComment: MARKER })
    await inRig(api, async (rig) => {
      await callTool(rig, 'add_comment', { epicId: EPIC, body: 'x', author: { role: 'desktop', label: 'Ada' } })
      expect(api.calls).toEqual([{ name: 'addComment', input: { epicId: EPIC, body: 'x' } }])
    })
  })
})

describe('comment tool listing', () => {
  it('publishes both tools with their required inputs and annotations', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const { tools } = await rig.client.listTools()
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
      expect(Object.keys(byName).sort()).toEqual(['add_comment', 'list_comments'])
      expect(byName['add_comment']?.inputSchema.required).toEqual(['epicId', 'body'])
      expect(byName['list_comments']?.inputSchema.required).toEqual(['epicId'])
      expect(byName['add_comment']?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false })
      expect(byName['list_comments']?.annotations).toMatchObject({ readOnlyHint: true })
      expect(byName['add_comment']?.description).toContain('blocker')
      expect(byName['list_comments']?.description).toContain('task data')
    })
  })
})
