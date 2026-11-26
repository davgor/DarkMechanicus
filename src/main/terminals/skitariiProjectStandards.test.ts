import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { attachProjectStandards, STANDARDS_CACHE_MS, STANDARDS_LIFETIME_MS, STANDARDS_STALE_MS } from '../../../resources/skitarii/extension/projectStandards'
import type { DmCallResult, DmClient } from '../../../resources/skitarii/extension/dmClient'
import { baselineDeliveryPolicy, defaultPrompts } from '../../shared/domain/standardsPrompts'
import { createHarness, type Harness } from '../../test/workspaceHarness'

let h: Harness | undefined
afterEach(() => {
  h?.cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function runtime(run: DmClient['run']) {
  type Request = (messages: unknown[]) => Promise<{ messages: {content: string}[] } | undefined>
  let request: Request | undefined
  attachProjectStandards({ on(event, handler) {
    if (event === 'context') request = messages => Promise.resolve(handler(
      { type: 'context', messages }, { hasUI: false, ui: {} })) as ReturnType<Request>
  } }, { run })
  return (messages: unknown[] = []) => request!(messages)
}

it('reads each member on the first model request and delivers a save to a running chat once the cache window passes', async () => {
  h = createHarness()
  // Only the extension's clock moves: the harness keeps real time, and each save is read after the 60 s cache window.
  let skew = 0
  const realNow = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew)
  const later = () => { skew += STANDARDS_CACHE_MS }
  const member = async (name: string) => {
    const root = join(h!.root, name)
    mkdirSync(root)
    const desktop = h!.open('desktop', { root, mode: 'repo' })
    await desktop.initializeRepository({ name })
    const { token } = await desktop.issueGrant({ role: 'planner', label: name, allowSave: true })
    const client = h!.open('reader', { root, transport: 'cli', grantToken: token })
    const run: DmClient['run'] = async (command, args, signal, options) => {
      expect([command, args, signal, options]).toEqual(['get_project', {}, undefined, { lifetimeMs: STANDARDS_LIFETIME_MS }])
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
  later()
  const prior = (await first.request())!.messages
  const payload = JSON.parse(prior[0].content.slice(prior[0].content.indexOf('{')))
  expect(payload).toMatchObject({ revision: 1, prompts: { ...defaultPrompts, planned: 'Engine renderer tests' } })
  await first.save(1, 'First-party renderer fixtures')
  later()
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

const PROJECT = { projectId: 'member-a', deliveryStandards: { revision: 3, policy: { prompts: defaultPrompts } } }

/** A fake client whose every `get_project` answers `next()` after `delayMs` of fake time, counting its spawns. */
function slowClient(delayMs: number, next: () => DmCallResult<unknown>) {
  const run = vi.fn<DmClient['run']>(() => new Promise(resolve => { setTimeout(() => resolve(next()), delayMs) }))
  return { run, request: runtime(run) }
}

it('shares one get_project among 20 concurrent context events, and spawns none for a burst within 60 s', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const { run, request } = slowClient(500, () => ({ ok: true, data: PROJECT }))
  const burst = () => Promise.all(Array.from({ length: 20 }, () => request()))
  const first = burst()
  await vi.advanceTimersByTimeAsync(500)
  const replies = await first
  expect(run).toHaveBeenCalledTimes(1)
  expect(run).toHaveBeenCalledWith('get_project', {}, undefined, { lifetimeMs: STANDARDS_LIFETIME_MS })
  expect(replies[0]!.messages).toHaveLength(1)
  expect(replies[0]!.messages[0].content).toContain('"revision": 3')
  for (const reply of replies) expect(reply).toEqual(replies[0])
  await vi.advanceTimersByTimeAsync(STANDARDS_CACHE_MS - 1)
  expect(await burst()).toEqual(replies)
  expect(run).toHaveBeenCalledTimes(1)
  // Past the window the next burst refreshes, once.
  await vi.advanceTimersByTimeAsync(1)
  const refreshed = burst()
  await vi.advanceTimersByTimeAsync(500)
  expect(await refreshed).toEqual(replies)
  expect(run).toHaveBeenCalledTimes(2)
})

it('injects guidance under 10 minutes old when a refresh fails, and the failure notice once it is older', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const failed: DmCallResult<unknown> = { ok: false, error: { source: 'client', code: 'process_failed', message: 'The dm CLI exited with code 1.' } }
  const answers: DmCallResult<unknown>[] = [{ ok: true, data: PROJECT }, failed, failed]
  const { run, request } = slowClient(0, () => answers.shift()!)
  const read = async (messages: unknown[] = []) => {
    const reply = request(messages)
    await vi.advanceTimersByTimeAsync(0)
    return (await reply)!.messages
  }
  const good = await read()
  expect(good[0].content).toContain('"revision": 3')
  await vi.advanceTimersByTimeAsync(2 * 60_000)
  const stale = { role: 'custom', customType: 'dm-project-delivery-standards', content: 'old policy' }
  expect(await read([stale])).toEqual(good)
  expect(run).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(STANDARDS_STALE_MS - 2 * 60_000)
  const notice = await read()
  expect(run).toHaveBeenCalledTimes(3)
  expect(notice).toHaveLength(1)
  expect(notice[0].content).toContain('could not read the current Delivery Standards')
})
