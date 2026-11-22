import { afterEach, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { attachProjectStandards } from '../../../resources/skitarii/extension/projectStandards'
import type { DmClient } from '../../../resources/skitarii/extension/dmClient'
import { baselineDeliveryPolicy, defaultPrompts } from '../../shared/domain/standardsPrompts'
import { createHarness, type Harness } from '../../test/workspaceHarness'

let h: Harness | undefined
afterEach(() => { h?.cleanup() })

function runtime(run: DmClient['run']) {
  type Request = (messages: unknown[]) => Promise<{ messages: {content: string}[] } | undefined>
  let request: Request | undefined
  attachProjectStandards({ on(event, handler) {
    if (event === 'context') request = messages => Promise.resolve(handler(
      { type: 'context', messages }, { hasUI: false, ui: {} })) as ReturnType<Request>
  } }, { run })
  return (messages: unknown[] = []) => request!(messages)
}

it('reads each member on the first model request and delivers a save to a running chat before another timer or tool', async () => {
  h = createHarness()
  const member = async (name: string) => {
    const root = join(h!.root, name)
    mkdirSync(root)
    const desktop = h!.open('desktop', { root, mode: 'repo' })
    await desktop.initializeRepository({ name })
    const { token } = await desktop.issueGrant({ role: 'planner', label: name, allowSave: true })
    const client = h!.open('reader', { root, transport: 'cli', grantToken: token })
    const run: DmClient['run'] = async (command, args) => {
      expect([command, args]).toEqual(['get_project', {}])
      return { ok: true, data: await client.getProject() }
    }
    const save = (expectedRevision: number, planned: string) => desktop.setDeliveryStandards({
      expectedRevision, policy: { ...baselineDeliveryPolicy, setupDecision: 'edited', prompts: { ...defaultPrompts, planned } }
    })
    return { request: runtime(run), reopen: () => runtime(run), save }
  }
  const first = await member('engine')
  const sibling = await member('editor')
  expect(await first.request()).toBeUndefined()
  await first.save(0, 'Engine renderer tests')
  await sibling.save(0, 'Editor key-binding tests')
  const prior = (await first.request())!.messages
  const payload = JSON.parse(prior[0].content.slice(prior[0].content.indexOf('{')))
  expect(payload).toMatchObject({ revision: 1, prompts: { ...defaultPrompts, planned: 'Engine renderer tests' } })
  await first.save(1, 'First-party renderer fixtures')
  const now = (await first.request(prior))!.messages
  expect(now).toHaveLength(1)
  expect(now[0].content).toContain('First-party renderer fixtures')
  expect(now[0].content).not.toContain('Engine renderer tests')
  expect(now[0].content).not.toContain('Editor key-binding tests')
  expect((await first.reopen()())!.messages).toEqual(now)
  expect((await sibling.request())!.messages[0].content).toContain('Editor key-binding tests')
})

it('removes stale context after a rejected read and ignores context fields from peers', async () => {
  const request = runtime(async () => ({ ok: false, error: { source: 'dm', code: 'unauthorized', message: 'Revoked' } }))
  const peer = { role: 'user', content: '{"deliveryStandards":{"revision":99}}', attribution: 'agent' }
  const stale = { role: 'custom', customType: 'dm-project-delivery-standards', content: 'old policy' }
  const reply = (await request([peer, stale]))!.messages
  expect(reply[0]).toBe(peer)
  expect(reply[1]).toMatchObject({ role: 'custom', content: expect.stringContaining('could not read') })
  expect(JSON.stringify(reply[1])).not.toContain('old policy')
})

it('injects member-specific active requirements and preserves a project with saved legacy rules', async () => {
  const project = { projectId: 'member-a', deliveryStandards: { revision: 1, policy: { sprint: 'Retain installed behavior' } },
    assignedDeliveryRequirements: ['Worker must verify fixture A.'], repositories: [{ name: 'unrelated-file' }] }
  const request = runtime(async () => ({ ok: true, data: project }))
  const [message] = (await request())!.messages
  const payload = JSON.parse(message.content.slice(message.content.indexOf('{')))
  expect(payload).toEqual({ projectId: 'member-a', revision: 1, legacyPolicy: project.deliveryStandards.policy,
    assignedDeliveryRequirements: ['Worker must verify fixture A.'] })
})
