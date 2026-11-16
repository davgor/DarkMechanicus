import { describe, expect, it } from 'vitest'
import { areaServer, callTool, withRig } from '../../test/mcpHarness'
import { createCannedApi } from '../../test/stubApi'
import { createMcpServer } from '../server'
import { registerKnowledgeTools } from './knowledge'

const CONTEXT = {
  facts: [{ id: 'repo.fact', type: 'convention', title: 'A fact', layer: 'repo', body: 'Body.' }],
  omitted: [],
  usedTokens: 4,
  budgetTokens: 1500,
  diagnostics: [],
  layers: { builtin: { count: 0 }, overall: { configured: false, path: null, count: 0 }, repo: { path: '/repo/k', count: 1 } }
}

describe('get_context', () => {
  it('is listed for an orchestrator as a read tool', async () => {
    const build = (api: Parameters<typeof createMcpServer>[0]) =>
      createMcpServer(api, { name: 'darkmechanicus', version: '1.2.3' }, { role: 'orchestrator', allowSave: false })
    await withRig(build, createCannedApi({}), async (rig) => {
      const { tools } = await rig.client.listTools()
      const tool = tools.find((item) => item.name === 'get_context')
      expect(tool?.annotations?.readOnlyHint).toBe(true)
    })
  })

  it('returns the envelope from getContext', async () => {
    const api = createCannedApi({ getContext: CONTEXT })
    await withRig(areaServer(registerKnowledgeTools), api, async (rig) => {
      const outcome = await callTool(rig, 'get_context', { event: 'ticket.claimed', paths: ['src/a.ts'] })
      expect(outcome.isError).toBe(false)
      expect(outcome.payload).toEqual({ ok: true, data: CONTEXT })
      expect(api.calls).toEqual([{ name: 'getContext', input: { event: 'ticket.claimed', paths: ['src/a.ts'] } }])
    })
  })

  it('refuses a call with neither event nor topics without calling the command', async () => {
    const api = createCannedApi({ getContext: CONTEXT })
    await withRig(areaServer(registerKnowledgeTools), api, async (rig) => {
      const outcome = await callTool(rig, 'get_context', { paths: ['src/a.ts'] })
      expect(outcome.isError).toBe(true)
      expect(outcome.payload).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      expect(api.calls).toEqual([])
    })
  })
})
