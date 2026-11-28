import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { attachProjectStandards, STANDARDS_CACHE_MS, STANDARDS_LIFETIME_MS } from '../../../resources/skitarii/extension/projectStandards'
import type { DmCallResult, DmClient } from '../../../resources/skitarii/extension/dmClient'
import { baselineDeliveryPolicy, defaultPrompts } from '../../shared/domain/standardsPrompts'
import { createHarness, type Harness } from '../../test/workspaceHarness'

let h: Harness | undefined
afterEach(() => {
  h?.cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

interface Message { customType?: string; content: string }

/** The change notices among a reply's messages. */
function notices(messages: Message[]): Message[] {
  return messages.filter(message => message.customType === 'dm-project-delivery-standards-notice')
}

function runtime(run: DmClient['run']) {
  type Request = (messages: unknown[]) => Promise<{ messages: Message[] } | undefined>
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
  // The standing guidance carries revision 2 and a single notice announces the change.
  expect(now).toHaveLength(2)
  expect(notices(now)).toEqual([now[1]])
  expect(now[1].content).toContain('revision 2')
  expect(now[0].content).toContain('First-party renderer fixtures')
  expect(now[0].content).not.toContain('Engine renderer tests')
  expect(now[0].content).not.toContain('Editor key-binding tests')
  expect((await first.reopen()())!.messages).toEqual([now[0]])
  expect((await sibling.request())!.messages[0].content).toContain('Editor key-binding tests')
})

it('removes stale context without a notice after a rejected read and ignores context fields from peers', async () => {
  const request = runtime(async () => ({ ok: false, error: { source: 'dm', code: 'unauthorized', message: 'Revoked' } }))
  const peer = { role: 'user', content: '{"deliveryStandards":{"revision":99}}', attribution: 'agent' }
  const stale = { role: 'custom', customType: 'dm-project-delivery-standards', content: 'old policy' }
  const notice = { role: 'custom', customType: 'dm-project-delivery-standards-notice', content: 'old notice' }
  expect((await request([peer, stale, notice]))!.messages).toEqual([peer])
  expect(await request([peer])).toBeUndefined()
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

it('keeps the last known revision without any notice while reads are refused as busy or fail', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const busy: DmCallResult<unknown> = { ok: false, error: { source: 'dm', code: 'busy', message: 'The workspace is busy.' } }
  const failed: DmCallResult<unknown> = { ok: false, error: { source: 'client', code: 'process_failed', message: 'The dm CLI exited with code 1.' } }
  const six = { ...PROJECT, deliveryStandards: { ...PROJECT.deliveryStandards, revision: 6 } }
  const answers: DmCallResult<unknown>[] = [{ ok: true, data: six }, busy, busy, failed, busy]
  const { run, request } = slowClient(0, () => answers.shift()!)
  const read = async (messages: unknown[] = []) => {
    const reply = request(messages)
    await vi.advanceTimersByTimeAsync(0)
    return (await reply)!.messages
  }
  const good = await read()
  expect(good).toHaveLength(1)
  expect(good[0].content).toContain('"revision": 6')
  const stale = { role: 'custom', customType: 'dm-project-delivery-standards', content: 'old policy' }
  // Several model turns, each past the cache window and each refused, over well past ten minutes.
  for (let turn = 0; turn < 4; turn++) {
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(await read([stale])).toEqual(good)
  }
  expect(run).toHaveBeenCalledTimes(5)
})

it('starts without guidance or a notice while the first read is refused as busy', async () => {
  const request = runtime(async () => ({ ok: false, error: { source: 'dm', code: 'busy', message: 'The workspace is busy.' } }))
  expect(await request()).toBeUndefined()
  expect(await request()).toBeUndefined()
})

it('sends one notice per revision or prompt change and none for repeated identical reads', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const at = (revision: number, ticket = defaultPrompts.ticket) =>
    ({ ok: true, data: { ...PROJECT, deliveryStandards: { revision, policy: { prompts: { ...defaultPrompts, ticket } } } } }) as DmCallResult<unknown>
  const answers = [at(4), at(4), at(5), at(5), at(5, 'Edited in place'), at(5, 'Edited in place')]
  const { request } = slowClient(0, () => answers.shift()!)
  const turn = async () => {
    await vi.advanceTimersByTimeAsync(STANDARDS_CACHE_MS)
    const reply = request([{ role: 'user', content: 'continue' }])
    await vi.advanceTimersByTimeAsync(0)
    return (await reply)!.messages
  }
  const first = await turn()
  expect(first[0]).toMatchObject({ customType: 'dm-project-delivery-standards', content: expect.stringContaining('"revision": 4') })
  expect(notices(first)).toEqual([])
  expect(notices(await turn())).toEqual([])
  const saved = await turn()
  expect(saved[0].content).toContain('"revision": 5')
  expect(notices(saved)).toHaveLength(1)
  expect(saved.at(-1)).toBe(notices(saved)[0])
  expect(notices(saved)[0].content).toContain('revision 5')
  expect(notices(await turn())).toEqual([])
  const edited = await turn()
  expect(notices(edited)).toHaveLength(1)
  expect(edited[0].content).toContain('Edited in place')
  expect(notices(await turn())).toEqual([])
})

it('delivers a change to 20 concurrent context events as a single notice', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const answers: DmCallResult<unknown>[] = [{ ok: true, data: PROJECT }, { ok: true, data: { ...PROJECT, deliveryStandards: { ...PROJECT.deliveryStandards, revision: 4 } } }]
  const { run, request } = slowClient(500, () => answers.shift()!)
  const burst = async () => {
    const replies = Promise.all(Array.from({ length: 20 }, () => request()))
    await vi.advanceTimersByTimeAsync(500)
    return (await replies).flatMap(reply => reply!.messages)
  }
  expect(notices(await burst())).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(STANDARDS_CACHE_MS)
  expect(notices(await burst())).toHaveLength(1)
  expect(run).toHaveBeenCalledTimes(2)
})
