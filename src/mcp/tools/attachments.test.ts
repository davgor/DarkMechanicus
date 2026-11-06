import { describe, expect, it } from 'vitest'
import type { CommandName } from '../../shared/domain/api'
import { areaServer, callTool, type McpRig, sampleId, withRig } from '../../test/mcpHarness'
import { createCannedApi, type StubApi } from '../../test/stubApi'
import { registerAttachmentTools } from './attachments'

const ATTACHMENT = sampleId('attachment')
const MARKER = { marker: 'canned' }

function inRig<T>(api: StubApi, body: (rig: McpRig) => Promise<T>): Promise<T> {
  return withRig(areaServer(registerAttachmentTools), api, body)
}

interface Case {
  tool: string
  args: Record<string, unknown>
  method: CommandName
  input: unknown
}

const CASES: Case[] = [
  {
    tool: 'add_attachment',
    args: { path: 'C:/shots/login.png', label: 'Login screen', purpose: 'evidence' },
    method: 'addAttachment',
    input: { path: 'C:/shots/login.png', label: 'Login screen', purpose: 'evidence' }
  },
  {
    tool: 'get_attachment',
    args: { attachmentId: ATTACHMENT, as: 'file' },
    method: 'getAttachment',
    input: { attachmentId: ATTACHMENT, as: 'file' }
  },
  {
    tool: 'get_attachment',
    args: { attachmentId: ATTACHMENT, as: 'metadata' },
    method: 'getAttachment',
    input: { attachmentId: ATTACHMENT, as: 'metadata' }
  }
]

describe('attachment tools map to the command layer', () => {
  it.each(CASES)('$tool ($args.as) calls $method', async ({ tool, args, method, input }) => {
    const api = createCannedApi({ [method]: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, tool, args)
      expect(outcome.isError).toBe(false)
      expect(outcome.payload).toEqual({ ok: true, data: MARKER })
      expect(api.calls).toEqual([{ name: method, input }])
    })
  })
})

describe('attachment tool inputs', () => {
  it.each([
    ['a missing purpose', { path: 'C:/shots/a.png', label: 'A' }, 'purpose'],
    ['an unknown purpose', { path: 'C:/shots/a.png', label: 'A', purpose: 'decoration' }, 'purpose']
  ])('add_attachment rejects %s before anything runs', async (_label, args, problem) => {
    const api = createCannedApi({ addAttachment: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'add_attachment', args)
      expect(outcome.isError).toBe(true)
      expect(outcome.text).toContain(problem)
      expect(api.calls).toEqual([])
    })
  })

  it('drops a caller-supplied width, height or mime: only the file decides them', async () => {
    const api = createCannedApi({ addAttachment: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'add_attachment', {
        path: 'C:/shots/a.png',
        label: 'A',
        purpose: 'evidence',
        width: 9000,
        height: 9000,
        mime: 'image/svg+xml'
      })
      expect(outcome.isError).toBe(false)
      expect(api.calls).toEqual([{ name: 'addAttachment', input: { path: 'C:/shots/a.png', label: 'A', purpose: 'evidence' } }])
    })
  })

  it('get_attachment rejects an id that is not an attachment id', async () => {
    const api = createCannedApi({ getAttachment: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, 'get_attachment', { attachmentId: sampleId('attempt'), as: 'file' })
      expect(outcome.isError).toBe(true)
      expect(api.calls).toEqual([])
    })
  })
})

describe('attachment tool listing', () => {
  it('publishes both tools with their required inputs and annotations', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const { tools } = await rig.client.listTools()
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
      expect(Object.keys(byName).sort()).toEqual(['add_attachment', 'get_attachment'])
      expect(byName['add_attachment']?.inputSchema.required).toEqual(['path', 'label', 'purpose'])
      expect(byName['get_attachment']?.inputSchema.required).toEqual(['attachmentId', 'as'])
      expect(byName['add_attachment']?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false })
      expect(byName['get_attachment']?.annotations).toMatchObject({ readOnlyHint: true })
    })
  })
})
