import { expect, it } from 'vitest'
import { createMcpServer } from '../server'
import { callTool, withRig } from '../../test/mcpHarness'
import { createStubApi } from '../../test/stubApi'

it('teaches the escalation rule at connection and requires both facts before submitting a question', async () => {
  const api = createStubApi({ askHuman: async () => ({ questionId: 'test', state: 'queued' }) })
  await withRig(target => createMcpServer(target, { name: 'dm', version: '1' }, { role: 'worker', allowSave: false }), api, async rig => {
    expect(rig.client.getInstructions()).toContain('human is currently not engaging with you')
    for (const args of [{}, { humanEngaged: true, responseRequired: true }, { humanEngaged: false, responseRequired: false }]) {
      expect((await callTool(rig, 'ask_human', { question: 'Which target?', ...args })).payload).toMatchObject({
        ok: false, error: { code: 'invalid_input' }
      })
    }
    expect(api.calls).toEqual([])
    expect((await callTool(rig, 'ask_human', { question: 'Which target?', responseRequired: true, humanEngaged: false })).payload)
      .toMatchObject({ ok: true, data: { state: 'queued' } })
  })
})
