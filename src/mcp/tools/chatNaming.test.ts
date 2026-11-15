import { expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { withRig, callTool } from '../../test/mcpHarness'
import { createHarness } from '../../test/workspaceHarness'
import { registerChatNamingTools } from './chatNaming'
it('publishes the exact strict metadata union and refuses target selectors before the command runs', async () => {
  const h = createHarness()
  await h.open('desktop').initializeRepository({ name: 'Naming adapter' })
  const api = h.open('worker')
  try {
    await withRig(target => { const server = new McpServer({ name: 'naming-test', version: '1' }); registerChatNamingTools(server, target); return server }, Object.assign(api, { calls: [] }), async rig => {
      const listed = (await rig.client.listTools()).tools
      expect(listed.map(tool => tool.name)).toEqual(['name_chat'])
      expect(listed[0]?.inputSchema).toMatchObject({ type: 'object', anyOf: expect.any(Array) })
      for (const args of [{ title: 'Intent label', folder: 'elsewhere' }, { title: 'Intent label', chatId: 'another' }, { title: 'Intent label', error: 'ambiguous' }, { title: 'This contains far too many words' }, {}]) {
        expect((await callTool(rig, 'name_chat', args)).payload).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      }
      expect((await callTool(rig, 'name_chat', { title: 'Intent label' })).payload).toMatchObject({ ok: false, error: { code: 'desktop_unavailable' } })
    })
  } finally { api.close(); h.cleanup() }
})
